# AGENTS.md — Coding Agent Operating Manual

> Give this file to your coding agent and check that it is using these instructions. Keep the stack, commands, and ground rules current.

## 1. Project Overview
- **What this repo builds:** Scrapbook Kitchen, a personal recipe saver. You upload screenshots or photos of a recipe (social media posts, websites, cookbooks, handwritten cards) or paste text; AI turns them into a clean recipe you review, save as "want to try," "favorite," or "tried, just OK," search later, and edit with your own notes after cooking.
- **Primary user & core workflow:** See the living PRD in `docs/index.html`.
- **Tech stack:** Node.js 22+ using only built-in modules (no npm packages) / one HTML page with plain JavaScript / OpenRouter API (default model `anthropic/claude-haiku-5.5`) / Supabase (invite-only sign-in, `recipes` and `chapters` tables with Row Level Security, and a private `photos` bucket, all called with plain `fetch`) / hosted on Render at https://aeb10033-fallproject.onrender.com.
- **Main files:** `server.js` (server, sign-in, AI prompt, link reading, database and photo calls), `safe-fetch.js` (refuses links to private addresses), `search.js` (search matching), `recipe-time.js` (short times on cards), and `public/index.html` (the page).
- **Security:** see `SECURITY.md` (what's locked, what was checked, known risks).

### Project structure
```
server.js            Node server: routes, AI prompt + recipe format, link reading, photo files
search.js            Search matching (whole words, also-matches, quick estimates)
recipe-time.js       Short recipe times for the board cards ("3 hours" -> "3 hr")
safe-fetch.js        Fetches pasted links and photos, refusing private addresses (SSRF protection)
public/index.html    The whole app page (HTML, CSS, plain JavaScript), including sign-in and PostHog analytics
docs/index.html      Product Page on GitHub Pages: PRD, build log, PostHog snippet
docs/*.png           Screenshots shown on the Product Page
tests/               Automated tests (node --test), lock-check.js (two-account lock test), notes
SECURITY.md          Security audit: what's locked, checked, fixed, and left
supabase/schema.sql  Supabase tables, photo bucket, and Row Level Security rules (run in the SQL Editor)
scripts/             One-time scripts (ask before running import-local-data.js: it changes saved data);
                     backup-export.js only reads (manual backup to data/backups/)
data/                Private, git-ignored: old local recipes, chapters, and photos from
                     before Supabase, kept as a backup (the app no longer uses it)
.env                 Private keys (git-ignored); copy from .env.example
```

### Main API routes (all in `server.js`)
- `POST /api/login`, `POST /api/logout`, `GET /api/me`: sign in and out (every other route needs a sign-in, except `/` and `/health`)
- `POST /api/extract`: screenshots, text, or a link → AI → draft recipe (nothing saved yet)
- `GET/POST /api/recipes`: list and search, or save a reviewed recipe
- `PATCH /api/recipes/:id`: change chapter, status, or total time, or save an edit (`{ edits: {...} }`, including `my_notes`)
- `PUT/DELETE /api/recipes/:id/cover`, `POST /api/recipes/:id/screenshots`, `DELETE /api/recipes/:id/screenshots/:file`: photos and covers
- `GET/POST /api/chapters`: list or add chapters

## 2. Commands
- **Install dependencies:** None. Needs Node.js 22+.
- **Set up keys:** `cp .env.example .env`, then add a real `OPENROUTER_API_KEY`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY`. Optional: `POSTHOG_KEY` (the public `phc_` project key) turns on analytics.
- **Set up Supabase (once):** paste `supabase/schema.sql` into the Supabase SQL Editor and run it. Accounts are added in Authentication → Users (public sign-up is off).
- **Run locally:** `node server.js`, then open http://localhost:3000
- **Run deterministic tests:** `node --test` (runs `tests/*.test.js`; no install needed)
- **Run model evals:** None yet (Build 4).
- **Lock test (manual, needs two accounts):** `node tests/lock-check.js`
- **Manual backup (read-only):** `node scripts/backup-export.js` copies your recipes, chapters, and photos to `data/backups/<date>/` (git-ignored). Run it before any data-changing step.

## 3. Non-Negotiable Engineering Rules
1. **Plan before coding:** Before touching multiple files, propose a brief plan and wait for approval.
2. **Small batches:** Make small, focused changes that can be reviewed and explained by a human in a single Pull Request.
3. **Explainability:** Avoid unnecessary abstractions or dependencies. Help the human builder understand the main components, what changed, why it matters, what could break, and how it was checked.
4. **Verify changes:** Run relevant checks. For a reproducible logic bug, use a failing test to demonstrate the fix when practical. Record manual checks and known limitations; follow the selected Build 4 evaluation track.
5. **Zero secrets in code:** Never hardcode API keys, tokens, or credentials. Always read from environment variables (`.env`) and update `.env.example` when new variables are needed.
6. **Stop when looping:** If a fix fails twice in a row, stop, summarize what failed, and ask the human before trying a third approach.
7. **Never run scripts that change saved data or spend AI money without asking first.** *(Born from a real mistake: during Build 2, the agent tried to run a "retag" script that would have rewritten every saved recipe and paid for an AI call on each one. I said no.)* Before any data-changing step, back up the data, say exactly what will change, and wait for a yes.
8. **Use the signed-in person's token for every Supabase call.** Never add the Supabase secret (`service_role`) key to the app: it skips Row Level Security, which is what keeps accounts apart.

## 4. Shipping
- **Where it runs:** Render web service `aeb10033-fallproject` (free plan, Virginia), deploying `main` automatically on every merge. Build command `node --version` (nothing to install); start command `node server.js`; health check `/health`.
- **Live settings** are Render environment variables, never files: `OPENROUTER_API_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `POSTHOG_KEY`, `HOST=0.0.0.0`, `NODE_VERSION=22`, optional `DAILY_AI_LIMIT`.
- **Flow:** feature branch → `node --test` → I test locally in the browser → I say "commit" → PR with the template → I merge → Render deploys → check `/health` and sign in on my phone.
- **Database changes:** edit `supabase/schema.sql` and say so in the PR; I run it in the Supabase SQL Editor before merging code that needs it. Never turn off Row Level Security.
- **Rollback:** in Render, Events → pick the last good deploy → Rollback. Data lives in Supabase, so rolling back code never loses recipes.
- **After shipping:** confirm `/health`, sign in on the live site, and check PostHog shows `live_app` events.

## 5. Ask Me First
Stop and ask before any of these, even if it seems like the obvious next step:
- Running a script that changes saved recipes, chapters, photos, or accounts (including import scripts), or that calls the AI in bulk
- Deleting or overwriting anything in Supabase, `data/`, or a git branch, stash, or history
- Changing `supabase/schema.sql`, Row Level Security rules, or Supabase dashboard settings (like turning sign-up on)
- Adding a new environment variable, secret, paid service, or npm package
- Committing, pushing, opening a PR, or merging (I say "commit" after testing)
- Stopping a process I started (like a server in my own Terminal)
- Putting anything personal on the public Product Page: emails, names, faces, the second test account's address
