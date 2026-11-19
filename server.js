// Scrapbook Kitchen: Build 1 prototype server.
// Run: node server.js   then open http://localhost:3000
// Uses only built-in Node.js modules (Node 22+). No npm install needed.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { searchRecipe } = require("./search.js");
const { shortTime } = require("./recipe-time.js");
const { safeFetch, BlockedLinkError } = require("./safe-fetch.js");

// ---- Settings (secrets come from .env, never from this file) ----
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {
  // No .env file: the check below explains what to do.
}
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-5.5";
const PORT = Number(process.env.PORT) || 3000;
// Locally only this computer can open the app (127.0.0.1). Render sets HOST=0.0.0.0 so the internet can reach it.
const HOST = process.env.HOST || "127.0.0.1";
// Supabase holds accounts (and soon recipes and photos). The publishable key is meant to be public;
// what protects data is each person's sign-in token plus the lock rules in supabase/schema.sql.
// The dashboard sometimes shows the URL ending in /rest/v1/; only the https://<project>.supabase.co part is needed.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
// Most AI recipe reads one account can do in 24 hours, so a leaked password can't run up the bill.
const DAILY_AI_LIMIT = Number(process.env.DAILY_AI_LIMIT) || 30;
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024; // 40 MB, plenty for ~10 resized screenshots
// Optional analytics. The PostHog project key (phc_...) is public, but it lives in .env so it's set in one place.
const POSTHOG_KEY = process.env.POSTHOG_KEY || "";
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";

if (!API_KEY || API_KEY.includes("replace-with-your-key")) {
  console.error("Missing OPENROUTER_API_KEY. Copy .env.example to .env and add your OpenRouter key.");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY. Add them to .env (see .env.example).");
  process.exit(1);
}

// ---- Storage: recipes, chapters, and photos all live in Supabase
// (see the Database and Photos sections below). Nothing is saved on this computer or on Render.

// ---- Cookbook chapters: every recipe lives in exactly one ----
// Built-in chapters are listed here. Chapters you add in the app are saved in the Supabase "chapters" table.
// The AI and the page both use the combined list.
const BUILT_IN_CHAPTERS = [
  { name: "Breakfast", emoji: "🥞", hint: "breakfast and brunch foods, like pancakes, eggs, muffins, and donuts" },
  { name: "Dinners", emoji: "🍝", hint: "main dishes for lunch or dinner" },
  { name: "Sides", emoji: "🥗", hint: "side dishes, like vegetables, potatoes, and stuffing" },
  { name: "Breads", emoji: "🍞", hint: "breads, rolls, and biscuits" },
  { name: "Desserts", emoji: "🍰", hint: "sweets, like cookies, cakes, pies, and tarts" },
  { name: "Snacks", emoji: "🥨", hint: "snacks and appetizers" },
  { name: "Drinks", emoji: "🥤", hint: "drinks and smoothies" },
];
const STATUSES = ["want_to_try", "favorite", "tried_ok"]; // tried_ok = "Tried, just OK"

// ---- The AI step: screenshots/text in, structured recipe out ----
// Built fresh for each recipe, so chapters you add are included.
function buildPrompt(chapters) {
  return `You turn photos and screenshots of recipes into a clean, structured recipe.

The user may send several screenshots of ONE recipe, in order. They often overlap: the same lines can appear at the bottom of one screenshot and the top of the next. Merge them into one recipe and include each ingredient and step only once.

Sources include social media captions, recipe websites, cookbook pages, and handwritten recipe cards.

Rules:
- Ignore everything that is not part of the recipe: ads, phone status bars, app buttons, comments, ratings, and calls to action (like "comment for the link").
- Copy quantities and wording faithfully. Do not invent ingredients, amounts, or steps that are not shown. Use an empty string for any field that is not shown (except total_time, below).
- total_time: the total time as shown. If it is not shown, estimate it from the steps (including baking, chilling, and rising) and write it like "about 40 min (estimated)".
- Keep ingredient sections (like "Sauce" or "Topping") as separate groups. Use an empty group name if the recipe has no sections. If a sub-recipe is written as a paragraph, make it its own ingredient group and add its method as steps.
- Write @mentions as plain words: "1 cup @somebrand flour" becomes "1 cup flour (somebrand)".
- Write steps in order without numbers. If a step continues across screenshots or pages, join it into one step.
- If you are not sure how to read a word or number (especially handwriting), give your best reading AND add a short note to "uncertain", like "Ingredient 3: '1/3 cup' or '1/2 cup' sugar?". Also note anything cut off or hidden that you could not recover from another screenshot. Never silently guess.
- "uncertain" is a checklist for the user, so only include things they should double-check. Do not include notes about what you did (like merging overlapping screenshots) or about fields that simply aren't shown.
- source_name: who or where the recipe came from, as shown (creator, account, website, cookbook, or a person named in a handwritten note). For a website, use its name or domain here.
- source_url: a complete link to the specific recipe page (starting with http) only if one is fully visible. A bare domain is not a link. Otherwise "".
- tags: 4 to 8 short lowercase tags for search: the meal type (breakfast, lunch, dinner, dessert, snack, side, drink, baking), "meal" for any main dish, "quick" only if the total time (shown or estimated) is 30 minutes or less, the main ingredients or flavors (like chicken or chocolate), and the cuisine if obvious.
- chapter: the ONE cookbook chapter this recipe belongs in most. Choose from:
${chapters.map((c) => `  - ${c.name}${c.hint ? `: ${c.hint}` : ""}`).join("\n")}
- notes: short tips from the source that are not steps (like substitutions). Use "" if none.
- If the images do not contain a recipe, set is_recipe to false and explain why in "uncertain".`;
}

function recipeSchema(chapterList) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["is_recipe", "title", "source_name", "source_url", "servings", "total_time",
      "ingredient_groups", "steps", "tags", "chapter", "notes", "uncertain"],
    properties: {
      is_recipe: { type: "boolean" },
      title: { type: "string" },
      source_name: { type: "string" },
      source_url: { type: "string" },
      servings: { type: "string" },
      total_time: { type: "string" },
      ingredient_groups: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "items"],
          properties: { name: { type: "string" }, items: { type: "array", items: { type: "string" } } },
        },
      },
      steps: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      chapter: { type: "string", enum: chapterList },
      notes: { type: "string" },
      uncertain: { type: "array", items: { type: "string" } },
    },
  };
}

// ---- Reading a recipe from a website link ----
// An error whose message is safe and useful to show the user (sent as a 400, not a 500).
class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Social media pages need a login and usually keep the recipe in the video.
const SOCIAL_SITES = /(^|\.)(instagram\.com|tiktok\.com|facebook\.com|fb\.watch|youtube\.com|youtu\.be|pinterest\.com|x\.com|twitter\.com|threads\.net)$/i;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

async function fetchPage(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new UserError("That doesn't look like a link. It should start with https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UserError("Only website links (starting with https://) can be read.");
  }
  if (SOCIAL_SITES.test(url.hostname)) {
    throw new UserError("Social media links can't be read yet (they need a login, and the recipe is often in the video). Take screenshots of the post instead.");
  }

  let res;
  try {
    // safeFetch refuses links to private addresses (see safe-fetch.js)
    res = await safeFetch(url, {
      headers: {
        // Some recipe sites turn away requests that don't look like a normal browser.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (err instanceof BlockedLinkError) throw new UserError(err.message);
    if (err.name === "TimeoutError") throw new UserError("That website took too long to respond. Try again, or use screenshots.");
    throw new UserError("Couldn't reach that website. Check the link, or use screenshots.");
  }
  if (res.status === 404) {
    throw new UserError("That page wasn't found. Check that the link is complete.");
  }
  if (!res.ok) {
    throw new UserError(`This website blocks apps from reading its pages (error ${res.status}). Copy the recipe text from the page, paste it in the text box (keep the link too, so it's saved as the source), and try again.`);
  }
  if (!(res.headers.get("content-type") || "").includes("text/html")) {
    throw new UserError("That link isn't a web page. Paste the link to the recipe's page.");
  }

  // Read the page, but stop at 5 MB so a huge page can't overload the app.
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_PAGE_BYTES) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Most recipe sites include a hidden, machine-readable copy of the recipe (schema.org "Recipe")
// for search engines. If it's there, it's cleaner than the page text: no ads, no life story.
function findStructuredRecipe(html) {
  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, raw] of blocks) {
    let data;
    try {
      data = JSON.parse(raw.trim());
    } catch {
      continue; // some sites have broken blocks; skip them
    }
    const recipe = findRecipeObject(data);
    if (recipe) return recipe;
  }
  return null;
}

function findRecipeObject(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeObject(item);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const types = [].concat(node["@type"]);
    if (types.includes("Recipe")) return node;
    if (node["@graph"]) return findRecipeObject(node["@graph"]);
  }
  return null;
}

// Fallback when a page has no structured recipe: its visible text, without code and menus.
function pageText(html) {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|aside|iframe|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, 40000); // about 10,000 tokens, roughly $0.001
}

// Returns the text to send to the AI, plus the web address of the recipe's photo (if the page has one).
async function readRecipeLink(link) {
  const html = await fetchPage(link);
  const site = new URL(link).hostname.replace(/^www\./, "");
  const structured = findStructuredRecipe(html);
  const photoUrl = findPhotoUrl(html, structured, link);
  if (structured) {
    console.log(`[link] ${site}: found the recipe's structured data${photoUrl ? " and a photo" : ""}`);
    const keep = ["name", "author", "description", "recipeYield", "prepTime", "cookTime", "totalTime",
      "recipeIngredient", "recipeInstructions", "recipeCategory", "recipeCuisine", "keywords"];
    const trimmed = Object.fromEntries(keep.filter((k) => structured[k] !== undefined).map((k) => [k, structured[k]]));
    return {
      text: `Recipe from the website ${site} (structured recipe data from the page; times may be written like PT1H30M, which means 1 hr 30 min):\n\n${JSON.stringify(trimmed, null, 1)}`,
      photoUrl,
    };
  }
  console.log(`[link] ${site}: no structured data, using the page text${photoUrl ? " (found a photo)" : ""}`);
  return {
    text: `Text of a recipe web page from ${site} (ignore menus, ads, comments, and the story before the recipe):\n\n${pageText(html)}`,
    photoUrl,
  };
}

// ---- Cover photos from recipe websites ----
// The recipe's own photo is usually in its structured data ("image"). If not, most pages
// name a preview photo for social media sharing: <meta property="og:image" content="...">.
function findPhotoUrl(html, structured, pageLink) {
  let candidate = firstImageUrl(structured?.image);
  if (!candidate) {
    for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
      if (/(property|name)=["'](og:image|og:image:url|twitter:image)["']/i.test(tag)) {
        candidate = (tag.match(/content=["']([^"']+)["']/i)?.[1] || "").replace(/&amp;/g, "&");
        if (candidate) break;
      }
    }
  }
  if (!candidate) return "";
  try {
    const url = new URL(candidate, pageLink); // some pages use a path like /photo.jpg
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

// "image" can be a link, a list of links, or an object (or list of objects) with a "url".
function firstImageUrl(image) {
  if (!image) return "";
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return firstImageUrl(image[0]);
  return typeof image.url === "string" ? image.url : "";
}

const PHOTO_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif" };
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// Download a recipe photo into your photo folder and return its file name, or "" if that didn't work.
// A missing photo never stops a recipe from saving; the card just keeps its emoji cover.
async function downloadPhoto(user, photoUrl, recipeId) {
  try {
    const url = new URL(photoUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    const res = await safeFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" },
      signal: AbortSignal.timeout(15000),
    });
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    const ext = PHOTO_TYPES[type];
    if (!res.ok || !ext) {
      console.log(`[photo] skipped ${url.hostname} (status ${res.status}, type ${res.headers.get("content-type")})`);
      return "";
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_PHOTO_BYTES) {
        console.log(`[photo] skipped ${url.hostname} (larger than 10 MB)`);
        return "";
      }
      chunks.push(chunk);
    }
    const name = coverFileName(recipeId, ext);
    await savePhoto(user, name, Buffer.concat(chunks), type);
    console.log(`[photo] saved ${name} (${Math.round(size / 1024)} KB)`);
    return name;
  } catch (err) {
    console.log(`[photo] couldn't download the photo: ${err.message}`);
    return "";
  }
}

async function extractRecipe({ images, text, model, chapters }) {
  const content = [];
  if (text.trim()) content.push({ type: "text", text });
  if (images.length) content.push({ type: "text", text: `Extract the recipe from these ${images.length} screenshot(s), in order.` });
  for (const url of images) content.push({ type: "image_url", image_url: { url } });

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      temperature: 0,
      messages: [
        { role: "system", content: buildPrompt(chapters) },
        { role: "user", content },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "recipe", strict: true, schema: recipeSchema(chapters.map((c) => c.name)) },
      },
      usage: { include: true }, // ask OpenRouter to report the cost of this call
    }),
  });

  const body = await res.json();
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${body.error?.message || JSON.stringify(body)}`);

  const raw = body.choices?.[0]?.message?.content || "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The AI did not return a recipe. Try again or use clearer screenshots.");
  const recipe = JSON.parse(raw.slice(start, end + 1));

  const usage = {
    model: body.model || model,
    input_tokens: body.usage?.prompt_tokens,
    output_tokens: body.usage?.completion_tokens,
    cost_usd: body.usage?.cost,
  };
  console.log(`[extract] ${images.length} image(s) | ${usage.input_tokens} in / ${usage.output_tokens} out tokens | $${usage.cost_usd ?? "?"} | ${usage.model}`);
  return { recipe, usage };
}

// Keep only the fields we expect, so edited recipes are always saved in the same shape.
// chapterNames = this person's chapters; anything else becomes "" (Unsorted).
function cleanRecipe(r, chapterNames) {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  return {
    title: str(r.title),
    source_name: str(r.source_name),
    source_url: str(r.source_url),
    servings: str(r.servings),
    total_time: str(r.total_time),
    ingredient_groups: (Array.isArray(r.ingredient_groups) ? r.ingredient_groups : [])
      .map((g) => ({ name: str(g?.name), items: list(g?.items) }))
      .filter((g) => g.items.length),
    steps: list(r.steps),
    tags: list(r.tags).map((t) => t.toLowerCase()),
    chapter: chapterNames.includes(r.chapter) ? r.chapter : "", // "" shows as Unsorted
    notes: str(r.notes),
    my_notes: str(r.my_notes), // your own notes after cooking it, like what you changed
  };
}

// The parts of a saved recipe you can change with "Edit recipe". Photos, cover, status, and
// chapter have their own controls, so an edit never touches them.
const EDITABLE = ["title", "source_name", "source_url", "servings", "total_time",
  "ingredient_groups", "steps", "tags", "notes", "my_notes"];

// ---- Small HTTP helpers ----
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw new Error("Upload too large. Try fewer screenshots.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const JPEG_PREFIX = "data:image/jpeg;base64,";
function isJpegDataUrl(v) {
  return typeof v === "string" && v.startsWith(JPEG_PREFIX);
}

// ---- A recipe's photos ----
// "images" are its screenshots. "cover" is the picture on its board card: a separate cover photo
// (from the website or uploaded), or one of its screenshots. If cover is "", the card uses the
// first screenshot. no_cover: true means show the colorful emoji card instead.
async function saveJpeg(user, dataUrl, name) {
  return savePhoto(user, name, Buffer.from(dataUrl.slice(JPEG_PREFIX.length), "base64"), "image/jpeg");
}

// A new name each time, so the browser doesn't keep showing an old cover it remembered.
function coverFileName(recipeId, ext) {
  return `${recipeId}-cover-${Date.now().toString(36)}${ext}`;
}

// Delete the recipe's separate cover photo file (never one of its screenshots).
async function deleteCoverFile(user, recipe) {
  if (recipe.cover && !recipe.images.includes(recipe.cover)) await deletePhoto(user, recipe.cover);
}

// ---- Routes ----
// ---- Supabase: plain fetch calls to its web API (no npm package needed) ----
// token = the signed-in person's access token. Supabase checks it and applies the lock rules.
async function supabase(apiPath, { method = "GET", token, body, headers = {} } = {}) {
  const res = await fetch(SUPABASE_URL + apiPath, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

// ---- Sign-in: tokens live in cookies the page's JavaScript can't read (HttpOnly) ----
// sk_access proves who you are for about an hour; sk_refresh gets a new one for up to 30 days.
const REFRESH_SECONDS = 60 * 60 * 24 * 30;

function readCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return cookies;
}

// Secure = only sent over https. Render serves https; your Mac (http://localhost) doesn't.
function cookie(req, name, value, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function setSessionCookies(req, res, session) {
  res.setHeader("Set-Cookie", [
    cookie(req, "sk_access", session.access_token, session.expires_in || 3600),
    cookie(req, "sk_refresh", session.refresh_token, REFRESH_SECONDS),
  ]);
}

function clearSessionCookies(req, res) {
  res.setHeader("Set-Cookie", [cookie(req, "sk_access", "", 0), cookie(req, "sk_refresh", "", 0)]);
}

// Asking Supabase "who is this?" on every click would be slow, so remember answers for a minute.
const knownTokens = new Map(); // access token -> { user, until }
function remember(user) {
  if (knownTokens.size > 500) knownTokens.clear();
  knownTokens.set(user.token, { user, until: Date.now() + 60_000 });
  return user;
}

// Who is making this request? Returns { id, email, token }, or null if not signed in.
async function currentUser(req, res) {
  const { sk_access: access, sk_refresh: refresh } = readCookies(req);
  if (access) {
    const known = knownTokens.get(access);
    if (known && known.until > Date.now()) return known.user;
    const r = await supabase("/auth/v1/user", { token: access });
    if (r.ok) return remember({ id: r.data.id, email: r.data.email, token: access });
  }
  if (refresh) {
    // The hour is up: trade the refresh token for a fresh pair, so you stay signed in.
    const r = await supabase("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: refresh } });
    if (r.ok) {
      setSessionCookies(req, res, r.data);
      return remember({ id: r.data.user.id, email: r.data.user.email, token: r.data.access_token });
    }
  }
  return null;
}

// ---- Database: each person's recipes and chapters ----
// Every call sends the person's own token, so Supabase's lock rules only ever show or change
// their rows. Even if this code asked for someone else's recipe, the database would refuse.
async function db(user, apiPath, options = {}) {
  const r = await supabase(`/rest/v1/${apiPath}`, { ...options, token: user.token });
  if (!r.ok) throw new Error(`Database error (${r.status}): ${r.data?.message || "unknown"}`);
  return r.data;
}

// Each recipe row holds the whole recipe as JSON in "data", the same shape data/recipes.json used.
async function loadRecipes(user) {
  const rows = await db(user, "recipes?select=data");
  return rows.map((row) => row.data);
}

async function addRecipe(user, recipe) {
  await db(user, "recipes", { method: "POST", body: { id: recipe.id, data: recipe }, headers: { Prefer: "return=minimal" } });
}

// Load one recipe, change it, and save it back. Throws a 404 if it doesn't exist or isn't yours.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function changeRecipe(user, id, change) {
  if (!UUID.test(id)) throw new UserError("Recipe not found.", 404);
  const rows = await db(user, `recipes?select=data&id=eq.${id}`);
  if (!rows.length) throw new UserError("Recipe not found.", 404);
  const recipe = rows[0].data;
  await change(recipe);
  await db(user, `recipes?id=eq.${id}`, { method: "PATCH", body: { data: recipe }, headers: { Prefer: "return=minimal" } });
  return recipe;
}

// ---- Photos: a private Supabase Storage bucket, one folder per person ----
// Each photo is saved as photos/<user id>/<file name>. The storage lock rule in supabase/schema.sql
// only lets you read or change files in your own folder.
const PHOTO_NAME = /^[\w.-]+$/; // file names we create look like <recipe id>-1.jpg
function photoUrl(user, name) {
  if (!PHOTO_NAME.test(name)) throw new UserError("Not a photo name.", 404);
  return `${SUPABASE_URL}/storage/v1/object/photos/${user.id}/${name}`;
}

function storageHeaders(user, extra = {}) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${user.token}`, ...extra };
}

async function savePhoto(user, name, bytes, type) {
  const res = await fetch(photoUrl(user, name), {
    method: "POST",
    headers: storageHeaders(user, { "Content-Type": type }),
    body: bytes,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Couldn't save the photo (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return name;
}

// Deleting is best-effort: a leftover file is harmless, so it never stops the change you made.
async function deletePhoto(user, name) {
  const res = await fetch(photoUrl(user, name), { method: "DELETE", headers: storageHeaders(user) }).catch((err) => err);
  if (!res.ok) console.log(`[photo] couldn't delete ${name} (${res.status || res.message})`);
}

// Built-in chapters plus the ones this person added, oldest first.
async function allChapters(user) {
  const custom = await db(user, "chapters?select=name,emoji&order=created_at");
  return [...BUILT_IN_CHAPTERS, ...custom];
}

async function chapterNames(user) {
  return (await allChapters(user)).map((c) => c.name);
}

// Count this account's AI reads in the last 24 hours; refuse past the limit, otherwise record one more.
async function useAiRead(user) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = await supabase(`/rest/v1/ai_reads?select=id&created_at=gte.${encodeURIComponent(since)}&limit=${DAILY_AI_LIMIT}`, { token: user.token });
  if (!recent.ok) throw new Error(`Couldn't check the daily AI limit (${recent.status}).`);
  if (recent.data.length >= DAILY_AI_LIMIT) {
    throw new UserError(`You've read ${DAILY_AI_LIMIT} recipes with AI in the last 24 hours, the daily limit. Try again tomorrow.`, 429);
  }
  const added = await supabase("/rest/v1/ai_reads", { method: "POST", token: user.token, body: {}, headers: { Prefer: "return=minimal" } });
  if (!added.ok) throw new Error(`Couldn't record the AI read (${added.status}).`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Standard protections on every response: don't guess file types (nosniff), don't let other
  // sites show this app inside a frame (stops "clickjacking"), and don't send our URLs to other sites.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  try {
    // Render checks this to know the app is running (no passcode, no data)
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true });

    // Sign in with email + password. Accounts are invite-only: they're added in the Supabase dashboard.
    if (req.method === "POST" && url.pathname === "/api/login") {
      const { email = "", password = "" } = await readJson(req);
      const r = await supabase("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: { email: String(email).trim(), password: String(password) },
      });
      if (!r.ok) {
        console.log(`[sign-in] refused (${r.status})`); // never log the email or password
        const status = r.status === 429 ? 429 : 401;
        return sendJson(res, status, { error: status === 429 ? "Too many tries. Wait a few minutes and try again." : "Wrong email or password." });
      }
      setSessionCookies(req, res, r.data);
      return sendJson(res, 200, { email: r.data.user.email });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const { sk_access: access } = readCookies(req);
      if (access) {
        knownTokens.delete(access);
        await supabase("/auth/v1/logout", { method: "POST", token: access }).catch(() => {}); // ends the session at Supabase too
      }
      clearSessionCookies(req, res);
      // Tell the browser to forget saved photos, so the next person on this computer can't see them
      res.setHeader("Clear-Site-Data", '"cache"');
      return sendJson(res, 200, { ok: true });
    }

    // Everything below needs a signed-in person, except the page itself (it shows the sign-in form).
    const isPage = req.method === "GET" && url.pathname === "/";
    const user = isPage ? null : await currentUser(req, res);
    if (!isPage && !user) return sendJson(res, 401, { error: "Please sign in." });

    if (req.method === "GET" && url.pathname === "/api/me") return sendJson(res, 200, { email: user.email });

    // The page itself, with the PostHog key and host from .env filled in
    if (req.method === "GET" && url.pathname === "/") {
      const page = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8")
        .replace('"__POSTHOG_KEY__"', JSON.stringify(POSTHOG_KEY))
        .replace('"__POSTHOG_HOST__"', JSON.stringify(POSTHOG_HOST));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    // Your photos, fetched from your own folder in Supabase Storage with your sign-in.
    // (The page's <img> tags send the sign-in cookie, so the page didn't need to change.)
    if (req.method === "GET" && url.pathname.startsWith("/images/")) {
      const name = decodeURIComponent(url.pathname.slice("/images/".length));
      const photo = await fetch(photoUrl(user, name).replace("/object/photos/", "/object/authenticated/photos/"), {
        headers: storageHeaders(user),
        signal: AbortSignal.timeout(30000),
      });
      if (!photo.ok) return sendJson(res, 404, { error: "Not found" });
      res.writeHead(200, {
        "Content-Type": photo.headers.get("content-type") || "image/jpeg",
        // The browser keeps the photo for a day (photos never change under the same name), but only
        // for this sign-in: "Vary: Cookie" makes it ask again when a different account is signed in.
        "Cache-Control": "private, max-age=86400",
        Vary: "Cookie",
      });
      return res.end(Buffer.from(await photo.arrayBuffer()));
    }

    // Link/screenshots/text -> AI -> recipe draft for review (nothing is saved yet)
    if (req.method === "POST" && url.pathname === "/api/extract") {
      // The AI model is always the one set in .env (MODEL); a request can't pick a pricier one.
      const { images = [], text = "", link = "" } = await readJson(req);
      const pasted = String(text).trim();
      const recipeLink = String(link).trim();
      if (!images.every(isJpegDataUrl)) return sendJson(res, 400, { error: "Images must be JPEG data URLs." });
      if (!images.length && !pasted && !recipeLink) {
        return sendJson(res, 400, { error: "Add a recipe link, a screenshot, or some recipe text." });
      }

      const parts = [];
      let photoUrl = "";
      if (recipeLink) {
        try {
          const page = await readRecipeLink(recipeLink);
          parts.push(page.text);
          photoUrl = page.photoUrl;
        } catch (err) {
          // If the site blocks us but you also gave screenshots or text, use those and keep the link as the source.
          if (!(err instanceof UserError) || (!pasted && !images.length)) throw err;
          console.log(`[link] couldn't read the page, using your text/screenshots instead: ${err.message}`);
        }
      }
      if (pasted) parts.push(`Recipe text pasted by the user:\n\n${pasted}`);
      await useAiRead(user);
      const chapters = await allChapters(user);
      const result = await extractRecipe({ images, text: parts.join("\n\n---\n\n"), model: MODEL, chapters });
      if (recipeLink) result.recipe.source_url = recipeLink; // the link you pasted is the source
      return sendJson(res, 200, { ...result, photo_url: photoUrl }); // the photo is downloaded only if you save
    }

    // List and search saved recipes
    if (req.method === "GET" && url.pathname === "/api/recipes") {
      const q = url.searchParams.get("q") || "";
      const status = url.searchParams.get("status") || "";
      // match is "best" (title, tags, chapter, or source) or "also" (only in ingredients or notes)
      const results = (await loadRecipes(user))
        .filter((r) => !status || r.status === status)
        .map((r) => ({ ...r, match: searchRecipe(r, q), short_time: shortTime(r.total_time) }))
        .filter((r) => r.match)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return sendJson(res, 200, results);
    }

    // Save a reviewed recipe and its original screenshots
    if (req.method === "POST" && url.pathname === "/api/recipes") {
      // Cover choice: cover_image (a photo you picked), photo_url (the website's photo),
      // no_cover (emoji card), or none of these (first screenshot).
      const { recipe = {}, images = [], photo_url = "", cover_image = "", no_cover = false } = await readJson(req);
      const clean = cleanRecipe(recipe, await chapterNames(user));
      if (!clean.title) return sendJson(res, 400, { error: "A recipe needs a title." });
      if (!images.every(isJpegDataUrl)) return sendJson(res, 400, { error: "Images must be JPEG data URLs." });
      if (cover_image && !isJpegDataUrl(cover_image)) return sendJson(res, 400, { error: "The cover photo must be a JPEG data URL." });

      const id = crypto.randomUUID();
      const imageFiles = await Promise.all(images.map((dataUrl, i) => saveJpeg(user, dataUrl, `${id}-${i + 1}.jpg`)));
      let cover = "";
      if (cover_image) cover = await saveJpeg(user, cover_image, coverFileName(id, ".jpg"));
      else if (photo_url && !no_cover) cover = await downloadPhoto(user, String(photo_url), id);

      const saved = {
        id,
        ...clean,
        status: STATUSES.includes(recipe.status) ? recipe.status : "want_to_try",
        images: imageFiles,
        cover,
        no_cover: Boolean(no_cover) && !cover_image,
        created_at: new Date().toISOString(),
      };
      await addRecipe(user, saved);
      console.log(`[save] "${saved.title}" (${saved.status}, ${imageFiles.length} image(s)${saved.cover ? ", cover photo" : ""})`);
      return sendJson(res, 201, saved);
    }

    // The chapter list, so the page shows the same chapters the AI uses
    if (req.method === "GET" && url.pathname === "/api/chapters") {
      return sendJson(res, 200, (await allChapters(user)).map(({ name, emoji }) => ({ name, emoji })));
    }

    // Add your own chapter (like Soups). Returns the updated chapter list.
    if (req.method === "POST" && url.pathname === "/api/chapters") {
      const { name = "", emoji = "" } = await readJson(req);
      const cleanName = String(name).trim().replace(/\s+/g, " ");
      if (!cleanName || cleanName.length > 30) return sendJson(res, 400, { error: "A chapter name needs 1 to 30 characters." });
      if ((await chapterNames(user)).some((n) => n.toLowerCase() === cleanName.toLowerCase())) {
        return sendJson(res, 400, { error: `You already have a "${cleanName}" chapter.` });
      }
      // Keep just the first emoji (or character) typed; default to a notebook.
      const firstSymbol = [...new Intl.Segmenter().segment(String(emoji).trim())][0]?.segment;
      await db(user, "chapters", { method: "POST", body: { name: cleanName, emoji: firstSymbol || "📒" }, headers: { Prefer: "return=minimal" } });
      console.log(`[chapter] added "${cleanName}"`);
      return sendJson(res, 201, (await allChapters(user)).map(({ name: n, emoji: e }) => ({ name: n, emoji: e })));
    }

    // Move a saved recipe to another chapter, change its status, fix its total time,
    // or save an edit ({ edits: { title, ingredient_groups, steps, my_notes, ... } }).
    const recipeRoute = url.pathname.match(/^\/api\/recipes\/([\w-]+)$/);
    if (req.method === "PATCH" && recipeRoute) {
      const { chapter, status, total_time, edits } = await readJson(req);
      if (edits !== undefined) {
        if (!edits || typeof edits !== "object") return sendJson(res, 400, { error: "Edits must be a recipe." });
        const clean = cleanRecipe(edits, []); // same tidying as a new recipe
        if (!clean.title) return sendJson(res, 400, { error: "A recipe needs a title." });
        const edited = await changeRecipe(user, recipeRoute[1], (r) => {
          for (const field of EDITABLE) r[field] = clean[field];
          r.edited_at = new Date().toISOString();
        });
        console.log(`[edit] "${edited.title}"`);
        return sendJson(res, 200, edited);
      }
      if (chapter !== undefined && !(await chapterNames(user)).includes(chapter)) return sendJson(res, 400, { error: "Unknown chapter." });
      if (status !== undefined && !STATUSES.includes(status)) return sendJson(res, 400, { error: "Unknown status." });
      if (total_time !== undefined && (typeof total_time !== "string" || total_time.length > 40)) {
        return sendJson(res, 400, { error: "The time must be text, 40 characters or less." });
      }
      const updated = await changeRecipe(user, recipeRoute[1], (r) => {
        if (chapter !== undefined) r.chapter = chapter;
        if (status !== undefined) r.status = status;
        if (total_time !== undefined) r.total_time = total_time.trim();
      });
      console.log(`[update] "${updated.title}" -> ${updated.chapter || "Unsorted"}, ${updated.status}`);
      return sendJson(res, 200, updated);
    }

    // Change a saved recipe's cover. Send ONE of:
    //   { image: "<JPEG data URL>" }  a photo you picked (add cropped: true if it's a crop of one of its photos)
    //   { screenshot: "<file name>" } one of its screenshots
    //   { photo_url: "https://..." }  a photo on the web
    //   { none: true }                no cover (the emoji card)
    const coverRoute = url.pathname.match(/^\/api\/recipes\/([\w-]+)\/cover$/);
    if (req.method === "PUT" && coverRoute) {
      const { image, screenshot, photo_url, none, cropped } = await readJson(req);
      let newCover = "";
      if (image !== undefined) {
        if (!isJpegDataUrl(image)) return sendJson(res, 400, { error: "The cover photo must be a JPEG data URL." });
      } else if (photo_url !== undefined) {
        newCover = await downloadPhoto(user, String(photo_url), coverRoute[1]);
        if (!newCover) return sendJson(res, 400, { error: "Couldn't download that photo." });
      } else if (screenshot === undefined && none !== true) {
        return sendJson(res, 400, { error: "Send an image, a screenshot, a photo_url, or none: true." });
      }

      const updated = await changeRecipe(user, coverRoute[1], async (r) => {
        if (screenshot !== undefined && !r.images.includes(screenshot)) throw new UserError("That screenshot isn't part of this recipe.");
        if (image !== undefined) newCover = await saveJpeg(user, image, coverFileName(r.id, ".jpg"));
        if (screenshot !== undefined) newCover = screenshot;
        // The old separate cover photo: a crop is just replaced (its original is still in the row);
        // anything else is kept as a regular photo (only ✕ deletes photos).
        if (r.cover && !r.images.includes(r.cover)) {
          if (r.cover_cropped) await deleteCoverFile(user, r);
          else r.images.unshift(r.cover);
        }
        r.cover = newCover;
        r.cover_cropped = image !== undefined && cropped === true;
        r.no_cover = none === true;
      });
      console.log(`[cover] "${updated.title}" -> ${updated.no_cover ? "emoji card" : updated.cover}`);
      return sendJson(res, 200, updated);
    }

    // Remove a saved recipe's separate cover photo; the cover goes back to its first screenshot
    if (req.method === "DELETE" && coverRoute) {
      const updated = await changeRecipe(user, coverRoute[1], async (r) => {
        await deleteCoverFile(user, r);
        r.cover = "";
        r.cover_cropped = false;
        r.no_cover = false;
      });
      console.log(`[cover] "${updated.title}" -> removed the cover photo`);
      return sendJson(res, 200, updated);
    }

    // Add photos or screenshots to a saved recipe (attached as-is; the AI doesn't re-read them).
    // If the recipe was showing its emoji card, the first new photo becomes the cover.
    const shotsRoute = url.pathname.match(/^\/api\/recipes\/([\w-]+)\/screenshots$/);
    if (req.method === "POST" && shotsRoute) {
      const { images = [] } = await readJson(req);
      if (!images.length || !images.every(isJpegDataUrl)) return sendJson(res, 400, { error: "Add at least one JPEG photo." });
      const updated = await changeRecipe(user, shotsRoute[1], async (r) => {
        const added = await Promise.all(images.map((dataUrl) => saveJpeg(user, dataUrl, `${r.id}-${crypto.randomUUID().slice(0, 8)}.jpg`)));
        if (r.no_cover) {
          r.cover = added[0];
          r.no_cover = false;
        }
        r.images.push(...added);
      });
      console.log(`[screenshots] "${updated.title}" +${images.length} (now ${updated.images.length})`);
      return sendJson(res, 201, updated);
    }

    // Remove one screenshot from a saved recipe
    const shotRoute = url.pathname.match(/^\/api\/recipes\/([\w-]+)\/screenshots\/([\w.-]+)$/);
    if (req.method === "DELETE" && shotRoute) {
      const file = shotRoute[2];
      const updated = await changeRecipe(user, shotRoute[1], async (r) => {
        if (!r.images.includes(file)) throw new UserError("That screenshot isn't part of this recipe.", 404);
        r.images = r.images.filter((f) => f !== file);
        if (r.cover === file) r.cover = ""; // it was the cover: fall back to the next screenshot
        await deletePhoto(user, file);
      });
      console.log(`[screenshots] "${updated.title}" removed ${file} (now ${updated.images.length})`);
      return sendJson(res, 200, updated);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    if (err instanceof UserError) {
      console.log(`[note] ${err.message}`);
    } else {
      console.error(err);
    }
    sendJson(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Scrapbook Kitchen running at http://localhost:${PORT} (model: ${MODEL}, analytics: ${POSTHOG_KEY ? "on" : "off"}, daily AI limit: ${DAILY_AI_LIMIT})`);
});
