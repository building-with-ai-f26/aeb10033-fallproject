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

async function extractRecipe({ images, text, model }) {
  const content = [];
  if (text.trim()) content.push({ type: "text", text: `Recipe text pasted by the user:\n\n${text}` });
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

    // Screenshots/text -> AI -> recipe draft for review (nothing is saved yet)
    if (req.method === "POST" && url.pathname === "/api/extract") {
      const { images = [], text = "", model } = await readJson(req);
      if (!images.every(isJpegDataUrl)) return sendJson(res, 400, { error: "Images must be JPEG data URLs." });
      if (!images.length && !String(text).trim()) {
        return sendJson(res, 400, { error: "Add at least one screenshot or some recipe text." });
      }
      return sendJson(res, 200, await extractRecipe({ images, text: String(text), model: model || MODEL }));
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
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

// 127.0.0.1 = only this computer can open the app
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Scrapbook Kitchen running at http://localhost:${PORT} (model: ${MODEL})`);
});
