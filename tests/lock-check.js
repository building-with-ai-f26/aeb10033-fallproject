// Lock test for SECURITY.md: can a second account reach the first account's recipes and photos?
//
// Run: node tests/lock-check.js
// (Not part of `node --test`: it needs two real accounts, the internet, and your passwords.)
//
// It signs in as account A (the owner) to pick one recipe and one photo, then signs in as
// account B and tries to read, change, and open them, both through the live app and directly
// against Supabase with B's own sign-in. Every attempt should say REFUSED.
// It changes nothing as long as the locks hold: the "change" attempts re-save A's recipe exactly
// as it already is, and the "add" attempt would only create one recipe titled "lock test" in A's
// account if that lock were broken (then delete it and fix the lock).

const path = require("node:path");
const readline = require("node:readline");

process.loadEnvFile(path.join(__dirname, "..", ".env"));
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const APP_URL = (process.env.APP_URL || "https://aeb10033-fallproject.onrender.com").replace(/\/+$/, "");

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

async function signIn(label) {
  const email = (await ask(`Account ${label} email: `)).trim();
  const password = await ask(`Account ${label} password (hidden): `, true);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Couldn't sign in as account ${label}. Check the email and password.`);
  const session = await res.json();
  return { id: session.user.id, token: session.access_token };
}

const supabaseHeaders = (user, extra = {}) => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${user.token}`, "Content-Type": "application/json", ...extra });
const appHeaders = (user, extra = {}) => ({ Cookie: `sk_access=${user.token}`, "Content-Type": "application/json", ...extra });

const results = [];
function record(attempt, refused, detail) {
  results.push({ attempt, refused, detail });
  console.log(`${refused ? "REFUSED ✅" : "LEAK ❌   "}  ${attempt}  (${detail})`);
}

async function main() {
  console.log(`Lock test: account B tries to reach account A's data.\nLive app: ${APP_URL}\n`);
  const a = await signIn("A (owner, has recipes)");
  const b = await signIn("B (second account)");
  if (a.id === b.id) throw new Error("Those are the same account. Use two different accounts.");

  // Pick one of A's recipes that has a photo
  const rows = await (await fetch(`${SUPABASE_URL}/rest/v1/recipes?select=data`, { headers: supabaseHeaders(a) })).json();
  const target = rows.map((r) => r.data).find((r) => r.cover || r.images?.length) || rows[0]?.data;
  if (!target) throw new Error("Account A has no recipes to test with.");
  const photo = target.cover || target.images?.[0];
  console.log(`\nTarget: one of A's recipes (id ${target.id.slice(0, 8)}…)${photo ? " and its photo" : ""}\n`);

  // --- Through the live app, signed in as B ---
  let res = await fetch(`${APP_URL}/api/recipes`, { headers: appHeaders(b) });
  const bList = res.ok ? await res.json() : [];
  record("App: B's recipe list includes A's recipe", res.ok && !bList.some((r) => r.id === target.id), `status ${res.status}, B sees ${bList.length} recipe(s)`);

  res = await fetch(`${APP_URL}/api/recipes/${target.id}`, { method: "PATCH", headers: appHeaders(b), body: JSON.stringify({ status: target.status }) });
  record("App: B changes A's recipe", res.status === 404, `status ${res.status}`);

  if (photo) {
    res = await fetch(`${APP_URL}/images/${photo}`, { headers: appHeaders(b) });
    record("App: B opens A's photo", res.status === 404, `status ${res.status}`);
  }

  // --- Directly against Supabase with B's sign-in (skipping the app entirely) ---
  res = await fetch(`${SUPABASE_URL}/rest/v1/recipes?select=id&id=eq.${target.id}`, { headers: supabaseHeaders(b) });
  const found = res.ok ? await res.json() : [];
  record("Supabase: B reads A's recipe", res.ok && found.length === 0, `status ${res.status}, ${found.length} row(s)`);

  res = await fetch(`${SUPABASE_URL}/rest/v1/recipes?id=eq.${target.id}`, {
    method: "PATCH",
    headers: supabaseHeaders(b, { Prefer: "return=representation" }),
    body: JSON.stringify({ data: target }), // exactly what's already there
  });
  const changed = res.ok ? await res.json() : [];
  record("Supabase: B changes A's recipe", changed.length === 0, `status ${res.status}, ${changed.length} row(s) changed`);

  res = await fetch(`${SUPABASE_URL}/rest/v1/recipes`, {
    method: "POST",
    headers: supabaseHeaders(b, { Prefer: "return=minimal" }),
    body: JSON.stringify({ id: crypto.randomUUID(), user_id: a.id, data: { title: "lock test" } }),
  });
  record("Supabase: B adds a recipe into A's account", !res.ok, `status ${res.status}`);

  if (photo) {
    res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/photos/${a.id}/${photo}`, { headers: supabaseHeaders(b) });
    record("Supabase: B opens A's photo", !res.ok, `status ${res.status}`);
  }
  res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/photos`, { method: "POST", headers: supabaseHeaders(b), body: JSON.stringify({ prefix: a.id, limit: 5 }) });
  const listed = res.ok ? await res.json() : [];
  record("Supabase: B lists A's photo folder", listed.length === 0, `status ${res.status}, ${listed.length} file(s)`);

  const leaks = results.filter((r) => !r.refused).length;
  console.log(`\n${results.length - leaks} of ${results.length} attempts refused.${leaks ? ` ${leaks} LEAK(S): fix before shipping!` : " The lock holds."}`);
  process.exit(leaks ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
