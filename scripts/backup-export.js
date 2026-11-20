// Manual backup: copies YOUR recipes, chapters, and photos from Supabase onto this computer.
// (Supabase's free plan has no automatic backups, so run this before any risky change.)
//
// Run: node scripts/backup-export.js
//
// - It only READS from Supabase. It never changes or deletes anything there.
// - It signs in as you (asks for your email and password; the password isn't shown or saved),
//   so the lock rules only let it see YOUR account's data.
// - It writes to data/backups/<date and time>/ (data/ is git-ignored, so backups never reach GitHub):
//     recipes.json   every recipe row in your account
//     chapters.json  every chapter row in your account
//     photos/        every photo in your private folder

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

process.loadEnvFile(path.join(__dirname, "..", ".env"));
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";

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
async function call(apiPath, { method = "GET", token, body } = {}) {
  const res = await fetch(SUPABASE_URL + apiPath, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${apiPath.split("?")[0]} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to .env first.");

  const email = (await ask("Your Scrapbook Kitchen email: ")).trim();
  const password = await ask("Your password (hidden): ", true);
  const session = await (await call("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } })
    .catch(() => { throw new Error("Couldn't sign in. Check the email and password."); })).json();
  const token = session.access_token;
  const userId = session.user.id;

  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  const outDir = path.join(__dirname, "..", "data", "backups", stamp);
  fs.mkdirSync(path.join(outDir, "photos"), { recursive: true });

  // Recipes and chapters: every row this account is allowed to read
  for (const table of ["recipes", "chapters"]) {
    const rows = await (await call(`/rest/v1/${table}?select=*`, { token })).json();
    fs.writeFileSync(path.join(outDir, `${table}.json`), JSON.stringify(rows, null, 2));
    console.log(`Saved ${rows.length} ${table}.`);
  }

  // Photos: list this account's folder 1000 at a time, then download each one
  const names = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await (await call("/storage/v1/object/list/photos", {
      method: "POST", token, body: { prefix: userId, limit: 1000, offset },
    })).json();
    names.push(...page.filter((f) => f.id).map((f) => f.name)); // folders have no id
    if (page.length < 1000) break;
  }
  console.log(`Downloading ${names.length} photos (this can take a minute)...`);
  for (const [i, name] of names.entries()) {
    process.stdout.write(`\r  ${i + 1} of ${names.length}`);
    const res = await call(`/storage/v1/object/authenticated/photos/${userId}/${encodeURIComponent(name)}`, { token });
    fs.writeFileSync(path.join(outDir, "photos", path.basename(name)), Buffer.from(await res.arrayBuffer()));
  }
  console.log(`\nSaved ${names.length} photos.\n\nBackup is in ${path.relative(process.cwd(), outDir) || outDir}`);
}

main().catch((err) => {
  console.error(`\nBackup stopped: ${err.message}`);
  process.exit(1);
});
