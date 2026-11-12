# AGENTS.md — Coding Agent Operating Manual

> Give this file to your coding agent and check that it is using these instructions. Keep the stack, commands, and ground rules current.

## 1. Project Overview
- **What this repo builds:** Scrapbook Kitchen, a personal recipe saver. You upload screenshots or photos of a recipe (social media posts, websites, cookbooks, handwritten cards) or paste text; AI turns them into a clean recipe you review, save as "want to try" or "favorite," and search later.
- **Primary user & core workflow:** See the living PRD in `docs/index.html`.
- **Tech stack:** Node.js 22+ using only built-in modules (no npm packages) / one HTML page with plain JavaScript / OpenRouter API (default model `anthropic/claude-haiku-5.5`) / recipes stored in `data/recipes.json` and screenshots in `data/images/` (both git-ignored).
- **Main files:** `server.js` (server, AI prompt, link reading, save, search, photos) and `public/index.html` (the page).

### Project structure
```
server.js            Node server: routes, AI prompt + recipe format, link reading, search, photo files
public/index.html    The whole app page (HTML, CSS, plain JavaScript), including PostHog analytics
docs/index.html      Product Page on GitHub Pages: PRD, build log, PostHog snippet
docs/*.png           Screenshots shown on the Product Page
tests/               Verification notes (automated tests go here)
data/                Private, git-ignored, created on first run:
  recipes.json         saved recipes
  chapters.json        chapters you added (built-in chapters live in server.js)
  images/              screenshots, website photos, uploaded photos, and cropped covers
.env                 Private keys (git-ignored); copy from .env.example
```

### Main API routes (all in `server.js`)
- `POST /api/extract`: screenshots, text, or a link → AI → draft recipe (nothing saved yet)
- `GET/POST /api/recipes`: list and search, or save a reviewed recipe
- `PATCH /api/recipes/:id`: change chapter or status
- `PUT/DELETE /api/recipes/:id/cover`, `POST /api/recipes/:id/screenshots`, `DELETE /api/recipes/:id/screenshots/:file`: photos and covers
- `GET/POST /api/chapters`: list or add chapters

## 2. Commands
- **Install dependencies:** None. Needs Node.js 22+.
- **Set up keys:** `cp .env.example .env`, then add a real `OPENROUTER_API_KEY`. Optional: `POSTHOG_KEY` (the public `phc_` project key) turns on analytics in the local app.
- **Run locally:** `node server.js`, then open http://localhost:3000
- **Run deterministic tests:** None yet.
- **Run model evals:** None yet (Build 4).

## 3. Non-Negotiable Engineering Rules
1. **Plan before coding:** Before touching multiple files, propose a brief plan and wait for approval.
2. **Small batches:** Make small, focused changes that can be reviewed and explained by a human in a single Pull Request.
3. **Explainability:** Avoid unnecessary abstractions or dependencies. Help the human builder understand the main components, what changed, why it matters, what could break, and how it was checked.
4. **Verify changes:** Run relevant checks. For a reproducible logic bug, use a failing test to demonstrate the fix when practical. Record manual checks and known limitations; follow the selected Build 4 evaluation track.
5. **Zero secrets in code:** Never hardcode API keys, tokens, or credentials. Always read from environment variables (`.env`) and update `.env.example` when new variables are needed.
6. **Stop when looping:** If a fix fails twice in a row, stop, summarize what failed, and ask the human before trying a third approach.
