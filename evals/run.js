// Model evals: run every test case in evals/cases/ through the app's real AI step and save the results.
//
// Run:  node evals/run.js <label>          e.g.  node evals/run.js before
//       node evals/run.js <label> 03       only cases whose folder name starts with "03"
//
// - It SPENDS AI MONEY: one AI call per case (about $0.002–0.01 each with Claude Haiku).
//   It shows how many calls it will make and waits for "yes" (add --yes to skip the question).
// - It reads nothing from and saves nothing to Supabase. Results go to evals/results/<label>.json and .md.
// - Photos are shrunk to a 2000px JPEG with macOS `sips`, the same size the app's page sends.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");
const { buildExtractText, extractRecipe, BUILT_IN_CHAPTERS, MODEL } = require("../server.js");

const CASES_DIR = path.join(__dirname, "cases");
const RESULTS_DIR = path.join(__dirname, "results");
const SCORES_DIR = path.join(__dirname, "scores"); // hand scores: scores/<label>.json, kept apart so a rerun never erases them

// ---- Loading cases ----
function loadCases(filter) {
  return fs.readdirSync(CASES_DIR)
    .filter((name) => !name.startsWith("_") && (!filter || name.startsWith(filter)))
    .filter((name) => fs.existsSync(path.join(CASES_DIR, name, "case.json")))
    .sort()
    .map((name) => {
      const dir = path.join(CASES_DIR, name);
      const c = JSON.parse(fs.readFileSync(path.join(dir, "case.json"), "utf8"));
      const text = c.text_file ? fs.readFileSync(path.join(dir, c.text_file), "utf8") : c.text || "";
      return { id: name, dir, ...c, text, images: c.images || [], expect: c.expect || {} };
    });
}

// Shrink a photo to a JPEG (longest side at most 2000px) and return it as a data URL, like the page does.
function toJpegDataUrl(file) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sk-eval-")), "photo.jpg");
  const size = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
  const longest = Math.max(...[...size.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1])));
  const resize = longest > 2000 ? ["-Z", "2000"] : [];
  execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", ...resize, file, "--out", out], { stdio: "ignore" });
  return `data:image/jpeg;base64,${fs.readFileSync(out).toString("base64")}`;
}

// ---- Automatic checks against the answer key (they help scoring; a person still scores each rule) ----
const FRACTIONS = { "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4", "⅛": "1/8" };
const normalize = (s) => String(s).toLowerCase()
  .replace(/[½⅓⅔¼¾⅛]/g, (f) => ` ${FRACTIONS[f]}`)
  .replace(/[–—]/g, "-") // long dashes count as a hyphen ("50–60" = "50-60")
  .replace(/\s+/g, " ").trim();

function recipeText(r) {
  return normalize([r.title, ...(r.ingredient_groups || []).flatMap((g) => [g.name, ...g.items]), ...(r.steps || []), r.notes].join("\n"));
}

function autoChecks(recipe, expect) {
  const checks = [];
  const all = recipeText(recipe);
  if (expect.is_recipe !== undefined) {
    checks.push({ check: `is_recipe is ${expect.is_recipe}`, pass: recipe.is_recipe === expect.is_recipe });
  }
  for (const want of expect.must_include || []) {
    checks.push({ check: `includes "${want}"`, pass: all.includes(normalize(want)) });
  }
  for (const bad of expect.must_not_include || []) {
    checks.push({ check: `does not include "${bad}"`, pass: !all.includes(normalize(bad)) });
  }
  const count = (recipe.ingredient_groups || []).reduce((n, g) => n + g.items.length, 0);
  if (expect.ingredients !== undefined) checks.push({ check: `${expect.ingredients} ingredients (got ${count})`, pass: count === expect.ingredients });
  const steps = (recipe.steps || []).length;
  if (expect.steps !== undefined) checks.push({ check: `${expect.steps} steps (got ${steps})`, pass: steps === expect.steps });
  if (expect.should_flag) checks.push({ check: "flags something to double-check", pass: (recipe.uncertain || []).length > 0 });
  return checks;
}

// ---- Writing the scorecard ----
function recipeMarkdown(r) {
  if (!r) return "_No recipe (error)._";
  const lines = [`**${r.title || "(no title)"}** · is_recipe: ${r.is_recipe} · servings: ${r.servings || "–"} · time: ${r.total_time || "–"} · chapter: ${r.chapter || "–"}`];
  lines.push(`Source: ${r.source_name || "–"} ${r.source_url || ""} · Tags: ${(r.tags || []).join(", ") || "–"}`, "");
  for (const g of r.ingredient_groups || []) {
    if (g.name) lines.push(`_${g.name}_`);
    for (const item of g.items) lines.push(`- ${item}`);
  }
  lines.push("");
  (r.steps || []).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  if (r.notes) lines.push("", `Notes: ${r.notes}`);
  if ((r.uncertain || []).length) lines.push("", "Double-check:", ...r.uncertain.map((u) => `- ${u}`));
  return lines.join("\n");
}

function loadScores(label) {
  const file = path.join(SCORES_DIR, `${label}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function writeScorecard(label, results, runAt) {
  const cost = results.reduce((sum, r) => sum + (r.usage?.cost_usd || 0), 0);
  const scores = loadScores(label);
  const RULES = ["r1", "r2", "r3", "r4"];
  const scored = results.filter((r) => scores[r.id]);
  const ruleTotal = (k) => scored.reduce((n, r) => n + scores[r.id][k], 0);
  const grand = RULES.reduce((n, k) => n + ruleTotal(k), 0);
  const md = [
    `# Eval results: ${label}`,
    "",
    `Run ${runAt} UTC · model \`${MODEL}\` · ${results.length} cases · AI cost $${cost.toFixed(4)}`,
    "",
    "Score each rule 0 (fails), 1 (partly), or 2 (meets it). Rules are in evals/README.md.",
    "",
    "| Case | Kind | Auto checks | R1 Faithful | R2 Complete | R3 Honest | R4 Clean | Total /8 |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map((r) => {
      const passed = r.checks.filter((c) => c.pass).length;
      const s = scores[r.id];
      const cells = s ? [...RULES.map((k) => s[k]), RULES.reduce((n, k) => n + s[k], 0)] : ["", "", "", "", ""];
      return `| ${r.id} | ${r.kind} | ${r.error ? "error" : `${passed}/${r.checks.length}`} | ${cells.join(" | ")} |`;
    }),
    ...(scored.length ? [`| **Total** | | | **${ruleTotal("r1")}/${scored.length * 2}** | **${ruleTotal("r2")}/${scored.length * 2}** | **${ruleTotal("r3")}/${scored.length * 2}** | **${ruleTotal("r4")}/${scored.length * 2}** | **${grand}/${scored.length * 8}** |`] : []),
    "",
    ...results.flatMap((r) => [
      `## ${r.id} (${r.kind})`,
      "",
      r.description || "",
      "",
      r.error ? `**Error:** ${r.error}` : "",
      scores[r.id] ? `**Score ${RULES.reduce((n, k) => n + scores[r.id][k], 0)}/8:** ${scores[r.id].why}` : "",
      ...r.checks.map((c) => `- ${c.pass ? "✅" : "❌"} ${c.check}`),
      "",
      recipeMarkdown(r.recipe),
      "",
    ]),
  ].join("\n");
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, `${label}.json`), JSON.stringify({ label, model: MODEL, run_at: runAt, results }, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIR, `${label}.md`), md);
  return cost;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

async function main() {
  const [label, filter] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!label || !/^[\w-]+$/.test(label)) throw new Error("Give the run a label, like: node evals/run.js before");
  const cases = loadCases(filter);
  if (!cases.length) throw new Error("No cases found in evals/cases/ (see evals/README.md).");

  // --rescore: no AI calls. Re-check saved results against the current answer keys and hand scores.
  if (process.argv.includes("--rescore")) {
    const saved = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${label}.json`), "utf8"));
    const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
    for (const r of saved.results) if (r.recipe && byId[r.id]) r.checks = autoChecks(r.recipe, byId[r.id].expect);
    writeScorecard(label, saved.results, saved.run_at || "earlier");
    return console.log(`Rescored evals/results/${label}.md (no AI calls).`);
  }

  console.log(`${cases.length} case(s), ${cases.length} AI call(s) with ${MODEL}. Results go to evals/results/${label}.md`);
  if (!process.argv.includes("--yes") && (await ask('Type "yes" to spend the AI calls: ')) !== "yes") return console.log("Stopped. Nothing was run.");

  const results = [];
  for (const c of cases) {
    process.stdout.write(`  ${c.id} ... `);
    const result = { id: c.id, kind: c.kind, description: c.description, checks: [] };
    try {
      const images = c.images.map((f) => toJpegDataUrl(path.join(c.dir, f)));
      const input = await buildExtractText({ link: c.link || "", text: c.text.trim(), hasImages: images.length > 0 });
      const { recipe, usage } = await extractRecipe({ images, text: input.text, model: MODEL, chapters: BUILT_IN_CHAPTERS });
      if (c.link) recipe.source_url = c.link; // same as the app
      Object.assign(result, { recipe, usage, checks: autoChecks(recipe, c.expect) });
      console.log(`${result.checks.filter((x) => x.pass).length}/${result.checks.length} auto checks`);
    } catch (err) {
      result.error = err.message;
      if (err.raw !== undefined) result.raw = err.raw; // what the AI actually sent back, to see why it failed
      console.log(`error: ${err.message}`);
    }
    results.push(result);
  }
  const cost = writeScorecard(label, results, new Date().toISOString().slice(0, 16).replace("T", " "));
  console.log(`\nDone. AI cost $${cost.toFixed(4)}. Scorecard: evals/results/${label}.md`);
}

main().catch((err) => {
  console.error(`\nEval stopped: ${err.message}`);
  process.exit(1);
});
