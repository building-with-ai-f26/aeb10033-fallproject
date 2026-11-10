// Scrapbook Kitchen: Build 1 prototype server.
// Run: node server.js   then open http://localhost:3000
// Uses only built-in Node.js modules (Node 22+). No npm install needed.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ---- Settings (secrets come from .env, never from this file) ----
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {
  // No .env file: the check below explains what to do.
}
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-5.5";
const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024; // 40 MB, plenty for ~10 resized screenshots

if (!API_KEY || API_KEY.includes("replace-with-your-key")) {
  console.error("Missing OPENROUTER_API_KEY. Copy .env.example to .env and add your OpenRouter key.");
  process.exit(1);
}

// ---- Storage: one JSON file plus a folder of images, both git-ignored ----
const DATA_DIR = path.join(__dirname, "data");
const IMAGE_DIR = path.join(DATA_DIR, "images");
const RECIPES_FILE = path.join(DATA_DIR, "recipes.json");
fs.mkdirSync(IMAGE_DIR, { recursive: true });

function loadRecipes() {
  if (!fs.existsSync(RECIPES_FILE)) return [];
  // If this file is ever damaged, fail loudly instead of starting over and overwriting it.
  return JSON.parse(fs.readFileSync(RECIPES_FILE, "utf8"));
}

function saveRecipes(recipes) {
  fs.writeFileSync(RECIPES_FILE, JSON.stringify(recipes, null, 2));
}

// ---- The AI step: screenshots/text in, structured recipe out ----
const PROMPT = `You turn photos and screenshots of recipes into a clean, structured recipe.

The user may send several screenshots of ONE recipe, in order. They often overlap: the same lines can appear at the bottom of one screenshot and the top of the next. Merge them into one recipe and include each ingredient and step only once.

Sources include social media captions, recipe websites, cookbook pages, and handwritten recipe cards.

Rules:
- Ignore everything that is not part of the recipe: ads, phone status bars, app buttons, comments, ratings, and calls to action (like "comment for the link").
- Copy quantities and wording faithfully. Do not invent ingredients, amounts, times, or steps that are not shown. Use an empty string for any field that is not shown.
- Keep ingredient sections (like "Sauce" or "Topping") as separate groups. Use an empty group name if the recipe has no sections. If a sub-recipe is written as a paragraph, make it its own ingredient group and add its method as steps.
- Write @mentions as plain words: "1 cup @somebrand flour" becomes "1 cup flour (somebrand)".
- Write steps in order without numbers. If a step continues across screenshots or pages, join it into one step.
- If you are not sure how to read a word or number (especially handwriting), give your best reading AND add a short note to "uncertain", like "Ingredient 3: '1/3 cup' or '1/2 cup' sugar?". Also note anything cut off or hidden that you could not recover from another screenshot. Never silently guess.
- "uncertain" is a checklist for the user, so only include things they should double-check. Do not include notes about what you did (like merging overlapping screenshots) or about fields that simply aren't shown.
- source_name: who or where the recipe came from, as shown (creator, account, website, cookbook, or a person named in a handwritten note). For a website, use its name or domain here.
- source_url: a complete link to the specific recipe page (starting with http) only if one is fully visible. A bare domain is not a link. Otherwise "".
- tags: 4 to 8 short lowercase tags for search: the meal type (breakfast, lunch, dinner, dessert, snack, side, drink, baking), "meal" for any main dish, "quick" if it takes about 30 minutes or less in total, the main ingredients or flavors (like chicken or chocolate), and the cuisine if obvious.
- notes: short tips from the source that are not steps (like substitutions). Use "" if none.
- If the images do not contain a recipe, set is_recipe to false and explain why in "uncertain".`;

const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_recipe", "title", "source_name", "source_url", "servings", "total_time",
    "ingredient_groups", "steps", "tags", "notes", "uncertain"],
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
    notes: { type: "string" },
    uncertain: { type: "array", items: { type: "string" } },
  },
};

// ---- Reading a recipe from a website link ----
// An error whose message is safe and useful to show the user (sent as a 400, not a 500).
class UserError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
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
    res = await fetch(url, {
      headers: {
        // Some recipe sites turn away requests that don't look like a normal browser.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        Accept: "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
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
    if (recipe) {
      const keep = ["name", "author", "description", "recipeYield", "prepTime", "cookTime", "totalTime",
        "recipeIngredient", "recipeInstructions", "recipeCategory", "recipeCuisine", "keywords"];
      return Object.fromEntries(keep.filter((k) => recipe[k] !== undefined).map((k) => [k, recipe[k]]));
    }
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

async function readRecipeLink(link) {
  const html = await fetchPage(link);
  const site = new URL(link).hostname.replace(/^www\./, "");
  const structured = findStructuredRecipe(html);
  if (structured) {
    console.log(`[link] ${site}: found the recipe's structured data`);
    return `Recipe from the website ${site} (structured recipe data from the page; times may be written like PT1H30M, which means 1 hr 30 min):\n\n${JSON.stringify(structured, null, 1)}`;
  }
  console.log(`[link] ${site}: no structured data, using the page text`);
  return `Text of a recipe web page from ${site} (ignore menus, ads, comments, and the story before the recipe):\n\n${pageText(html)}`;
}

async function extractRecipe({ images, text, model }) {
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
        { role: "system", content: PROMPT },
        { role: "user", content },
      ],
      response_format: { type: "json_schema", json_schema: { name: "recipe", strict: true, schema: RECIPE_SCHEMA } },
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

// ---- Search: every word you type must appear in the title, ingredients, tags, source, or notes ----
function matchesSearch(recipe, query) {
  const searchable = [
    recipe.title,
    recipe.source_name,
    recipe.notes,
    ...recipe.tags,
    ...recipe.ingredient_groups.flatMap((g) => [g.name, ...g.items]),
  ].join(" ").toLowerCase();

  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => {
    // "desserts" should still find "dessert"
    const singular = word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
    return searchable.includes(singular);
  });
}

// Keep only the fields we expect, so edited recipes are always saved in the same shape.
function cleanRecipe(r) {
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
    notes: str(r.notes),
  };
}

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

// ---- Routes ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // The page itself
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(res);
    }

    // Saved original screenshots (basename() stops paths like ../../.env)
    if (req.method === "GET" && url.pathname.startsWith("/images/")) {
      const file = path.join(IMAGE_DIR, path.basename(url.pathname));
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: "Not found" });
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      return fs.createReadStream(file).pipe(res);
    }

    // Link/screenshots/text -> AI -> recipe draft for review (nothing is saved yet)
    if (req.method === "POST" && url.pathname === "/api/extract") {
      const { images = [], text = "", link = "", model } = await readJson(req);
      const pasted = String(text).trim();
      const recipeLink = String(link).trim();
      if (!images.every(isJpegDataUrl)) return sendJson(res, 400, { error: "Images must be JPEG data URLs." });
      if (!images.length && !pasted && !recipeLink) {
        return sendJson(res, 400, { error: "Add a recipe link, a screenshot, or some recipe text." });
      }

      const parts = [];
      if (recipeLink) {
        try {
          parts.push(await readRecipeLink(recipeLink));
        } catch (err) {
          // If the site blocks us but you also gave screenshots or text, use those and keep the link as the source.
          if (!(err instanceof UserError) || (!pasted && !images.length)) throw err;
          console.log(`[link] couldn't read the page, using your text/screenshots instead: ${err.message}`);
        }
      }
      if (pasted) parts.push(`Recipe text pasted by the user:\n\n${pasted}`);
      const result = await extractRecipe({ images, text: parts.join("\n\n---\n\n"), model: model || MODEL });
      if (recipeLink) result.recipe.source_url = recipeLink; // the link you pasted is the source
      return sendJson(res, 200, result);
    }

    // List and search saved recipes
    if (req.method === "GET" && url.pathname === "/api/recipes") {
      const q = url.searchParams.get("q") || "";
      const status = url.searchParams.get("status") || "";
      const results = loadRecipes()
        .filter((r) => (!status || r.status === status) && matchesSearch(r, q))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return sendJson(res, 200, results);
    }

    // Save a reviewed recipe and its original screenshots
    if (req.method === "POST" && url.pathname === "/api/recipes") {
      const { recipe = {}, images = [] } = await readJson(req);
      const clean = cleanRecipe(recipe);
      if (!clean.title) return sendJson(res, 400, { error: "A recipe needs a title." });
      if (!images.every(isJpegDataUrl)) return sendJson(res, 400, { error: "Images must be JPEG data URLs." });

      const id = crypto.randomUUID();
      const imageFiles = images.map((dataUrl, i) => {
        const name = `${id}-${i + 1}.jpg`;
        fs.writeFileSync(path.join(IMAGE_DIR, name), Buffer.from(dataUrl.slice(JPEG_PREFIX.length), "base64"));
        return name;
      });

      const saved = {
        id,
        ...clean,
        status: recipe.status === "favorite" ? "favorite" : "want_to_try",
        images: imageFiles,
        created_at: new Date().toISOString(),
      };
      const all = loadRecipes();
      all.push(saved);
      saveRecipes(all);
      console.log(`[save] "${saved.title}" (${saved.status}, ${imageFiles.length} image(s))`);
      return sendJson(res, 201, saved);
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

// 127.0.0.1 = only this computer can open the app
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Scrapbook Kitchen running at http://localhost:${PORT} (model: ${MODEL})`);
});
