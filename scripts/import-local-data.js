// One-time copy of your old local recipes (data/recipes.json), chapters (data/chapters.json),
// and photos (data/images) into your Supabase account, so they show up after signing in.
//
// Run: node scripts/import-local-data.js
//
// - It only READS the local files. It never changes or deletes them, so they stay as a backup.
// - It signs in as you (asks for your email and password; the password isn't shown or saved),
//   so the lock rules put every recipe in YOUR account.
// - It shows what it will add and waits for you to type "yes".
// - Safe to run twice: recipes, chapters, and photos already in your account are skipped.
// - Only photos that your account's recipes use are uploaded, into your own private folder.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

process.loadEnvFile(path.join(__dirname, "..", ".env"));
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const DATA_DIR = path.join(__dirname, "..", "data");

// Ask a question in the terminal. hidden = don't show what's typed (for the password).
function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(text); };
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

// A plain fetch call to Supabase. Throws with Supabase's message if it fails.
async function call(apiPath, { method = "GET", token, body, prefer } = {}) {
  const res = await fetch(SUPABASE_URL + apiPath, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${apiPath.split("?")[0]} failed (${res.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function readLocal(file) {
  const full = path.join(DATA_DIR, file);
  return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, "utf8")) : [];
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to .env first.");
  const recipes = readLocal("recipes.json");
  const chapters = readLocal("chapters.json");
  console.log(`Found ${recipes.length} recipes and ${chapters.length} added chapter(s) on this computer.\n`);
  const IMAGE_DIR = path.join(DATA_DIR, "images");

  const email = (await ask("Your Scrapbook Kitchen email: ")).trim();
  const password = await ask("Your password (hidden): ", true);
  const session = await call("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } })
    .catch(() => { throw new Error("Couldn't sign in. Check the email and password."); });
  const token = session.access_token;
  const userId = session.user.id;

  // What's already in the account, so running this twice doesn't add copies
  const accountRecipes = (await call("/rest/v1/recipes?select=data", { token })).map((row) => row.data);
  const haveIds = new Set(accountRecipes.map((r) => r.id));
  const haveChapters = new Set((await call("/rest/v1/chapters?select=name", { token })).map((c) => c.name.toLowerCase()));
  const newRecipes = recipes.filter((r) => !haveIds.has(r.id));
  const newChapters = chapters.filter((c) => !haveChapters.has(c.name.toLowerCase()));

  // Photos: every file named by a recipe in the account (or about to be), screenshots + cover,
  // that's on this computer but not yet uploaded
  const listPhotos = async () => (await call("/storage/v1/object/list/photos", {
    method: "POST", token, body: { prefix: userId, limit: 10000 },
  })).map((f) => f.name);
  const havePhotos = new Set(await listPhotos());
  const wanted = [...new Set([...accountRecipes, ...newRecipes].flatMap((r) => [...(r.images || []), r.cover].filter(Boolean)))];
  const notHere = wanted.filter((name) => !fs.existsSync(path.join(IMAGE_DIR, name)));
  const newPhotos = wanted.filter((name) => !havePhotos.has(name) && !notHere.includes(name));

  console.log(`\nWill add ${newRecipes.length} recipe(s), ${newChapters.length} chapter(s), and ${newPhotos.length} photo(s) to ${email}'s account.`);
  if (recipes.length !== newRecipes.length) console.log(`(${recipes.length - newRecipes.length} recipe(s) are already there and will be skipped.)`);
  if (wanted.length - newPhotos.length - notHere.length) console.log(`(${wanted.length - newPhotos.length - notHere.length} photo(s) are already there and will be skipped.)`);
  if (notHere.length) console.log(`(${notHere.length} photo(s) named by recipes aren't in data/images, so they can't be copied.)`);
  if (!newRecipes.length && !newChapters.length && !newPhotos.length) return console.log("Nothing to do.");
  if ((await ask('Type "yes" to continue: ')).trim().toLowerCase() !== "yes") return console.log("Stopped. Nothing was changed.");

  // Chapters first, so recipes in an added chapter (like Soups) have their chapter.
  if (newChapters.length) {
    await call("/rest/v1/chapters", { method: "POST", token, prefer: "return=minimal",
      body: newChapters.map((c) => ({ name: c.name, emoji: c.emoji || "📒" })) });
  }
  if (newRecipes.length) {
    await call("/rest/v1/recipes", { method: "POST", token, prefer: "return=minimal",
      body: newRecipes.map((r) => ({ id: r.id, data: r, created_at: r.created_at || new Date().toISOString() })) });
  }

  // Photos go one at a time (raw image bytes, not JSON)
  const types = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif" };
  for (const [i, name] of newPhotos.entries()) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/photos/${userId}/${name}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, "Content-Type": types[path.extname(name).toLowerCase()] || "image/jpeg" },
      body: fs.readFileSync(path.join(IMAGE_DIR, name)),
    });
    if (!res.ok) throw new Error(`Uploading ${name} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    process.stdout.write(`\rUploaded ${i + 1} of ${newPhotos.length} photos`);
  }
  if (newPhotos.length) process.stdout.write("\n");

  // Check: every local recipe and every available photo is now in the account
  const nowIds = new Set((await call("/rest/v1/recipes?select=id", { token })).map((r) => r.id));
  const missing = recipes.filter((r) => !nowIds.has(r.id));
  // (recipes saved after the first import are in the account, not in data/recipes.json; that's fine)
  console.log(`\nDone. Your account now has ${nowIds.size} recipe(s).`);
  console.log(missing.length ? `WARNING: ${missing.length} local recipe(s) are missing from the account.` : `All ${recipes.length} local recipes are in your account.`);
  const nowPhotos = new Set(await listPhotos());
  const missingPhotos = wanted.filter((name) => !notHere.includes(name) && !nowPhotos.has(name));
  console.log(missingPhotos.length ? `WARNING: ${missingPhotos.length} photo(s) are missing from the account.` : `All ${wanted.length - notHere.length} photos are in your account.`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
