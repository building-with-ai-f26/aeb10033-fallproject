// One-time: add nutrition per serving (calories, protein, carbs, fat) to your saved recipes
// that don't have it yet. New recipes get nutrition when the AI reads them; this fills in the old ones.
//
// Run: node scripts/add-nutrition.js
//
// It CHANGES SAVED RECIPES and SPENDS AI MONEY, so it asks twice:
//   1. Signs in as you (the password isn't shown or saved), lists the recipes it would fill,
//      and asks "yes" before any AI calls (one per recipe, well under a cent each).
//   2. Saves a backup of every recipe to data/backups/before-nutrition-<date>/recipes.json (git-ignored).
//   3. Shows every estimate and asks "yes" again before saving anything.
// It only adds the "nutrition" field. Nothing else in a recipe changes, and photos aren't touched.
// Safe to run twice: recipes that already have nutrition are skipped.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { estimateNutrition, MODEL } = require("../server.js"); // the same AI step and nutrition rules as the app

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
      resolve(answer.trim());
    });
  });
}

// A plain fetch call to Supabase with your sign-in, so the lock rules only allow YOUR recipes.
async function supabase(apiPath, token, { method = "GET", body, prefer } = {}) {
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

const show = (n) => n
  ? `${n.calories ?? "–"} cal · ${n.protein_g ?? "–"}g protein · ${n.carbs_g ?? "–"}g carbs · ${n.fat_g ?? "–"}g fat  [${n.estimated ? "estimated" : "from the recipe"}; ${n.serving || "no serving given"}]`
  : "(none: amounts too vague to estimate)";

async function main() {
  const email = await ask("Your Scrapbook Kitchen email: ");
  const password = await ask("Your password (hidden): ", true);
  const session = await supabase("/auth/v1/token?grant_type=password", null, { method: "POST", body: { email, password } })
    .catch(() => { throw new Error("Couldn't sign in. Check the email and password."); });
  const token = session.access_token;

  const rows = await supabase("/rest/v1/recipes?select=id,data", token);
  const todo = rows.filter((row) => !("nutrition" in row.data));
  console.log(`\nYou have ${rows.length} recipes; ${todo.length} have no nutrition yet:`);
  todo.forEach((row) => console.log(`  - ${row.data.title}`));
  if (!todo.length) return console.log("Nothing to do.");

  if ((await ask(`\nEstimate nutrition for these ${todo.length} with ${MODEL}? That's ${todo.length} AI calls. Type "yes": `)).toLowerCase() !== "yes") {
    return console.log("Stopped. Nothing was spent or changed.");
  }

  // Back up every recipe exactly as it is now, before anything changes
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  const backupDir = path.join(__dirname, "..", "data", "backups", `before-nutrition-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "recipes.json"), JSON.stringify(rows, null, 2));
  console.log(`\nBacked up all ${rows.length} recipes to ${path.relative(process.cwd(), backupDir)}/recipes.json\n`);

  const results = [];
  let cost = 0;
  for (const [i, row] of todo.entries()) {
    process.stdout.write(`  ${i + 1} of ${todo.length}: ${row.data.title} ... `);
    try {
      const { nutrition, usage } = await estimateNutrition(row.data);
      cost += usage.cost_usd || 0;
      results.push({ row, nutrition });
      console.log("done");
    } catch (err) {
      console.log(`skipped (${err.message})`);
    }
  }

  console.log(`\nAI cost: $${cost.toFixed(4)}. Here's what would be saved:\n`);
  results.forEach(({ row, nutrition }) => console.log(`  ${row.data.title}\n    ${show(nutrition)}`));
  if ((await ask(`\nSave nutrition to these ${results.length} recipes? Type "yes": `)).toLowerCase() !== "yes") {
    return console.log("Stopped. Nothing was saved. (The AI calls were already made.)");
  }

  for (const { row, nutrition } of results) {
    // Only the nutrition field is added; the rest of the recipe is saved back exactly as it was read.
    await supabase(`/rest/v1/recipes?id=eq.${row.id}`, token, {
      method: "PATCH", body: { data: { ...row.data, nutrition } }, prefer: "return=minimal",
    });
  }
  console.log(`\nSaved nutrition to ${results.length} recipes. The backup from before is in ${path.relative(process.cwd(), backupDir)}/`);
}

main().catch((err) => {
  console.error(`\nStopped: ${err.message}`);
  process.exit(1);
});
