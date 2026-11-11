# Intent.md — Optional PRD Draft (Build 1)

Use this as a scratchpad if helpful. Publish the required PRD and Build 1 log on `docs/index.html`; this file is not a separate hand-in.

**Build 1 due:** Monday, Nov 9, 2026 at noon, New York time  
**Builder:** Arden Bochner

---

## 1. Who is it for?
*Name a specific person or role you have direct access to (not a broad demographic). Who will actually test and use this before Demo Day?*

- **Target user:** Me first, plus a family member and my class pod. More broadly, it's for home cooks and bakers who get inspired by recipes and videos they find online or in books, and want to be able to find them again.
- **How I will reach them to test it:** I use it myself every week and will recruit testers directly.

## 2. What job does it do?
*Describe the concrete recurring problem from work, school, or life, and what "done" looks like for the user.*

- **Current painful workflow (before):** I save several recipes a week, mostly by saving videos on social media, but I often never go back to them. The recipes I love and use again and again, I email to myself as links. About once a week I try to find something I saved. I often forget I saved it, can't find the video again, or remember seeing something amazing but can't remember what it was.
- **New workflow with this product (after):** When I find a recipe, I upload one or more screenshots or photos (of a social media post, a recipe website, a cookbook page, or a handwritten family recipe), or paste a recipe website link or recipe text. AI turns it into a clean recipe with a title, ingredients, steps, and where it came from. I review and fix the result, then save it as "want to try" or "favorite" with a link back to the original image or post. Later, I search my saved recipes by keyword ("brownie", "chicken", "stuffing") or by description ("quick dinner", "chocolate desserts"), pull one up, and cook from it. The job is done when I've captured the recipe and can cook from it.
- **Why this is useful** *(used weekly / saves real time / worth paying for)*: I'd use it every week, both to save recipes and to look for one. It keeps every recipe in one searchable place, so I stop losing the ones I wanted to try. It's a free personal app, and I'll cover the small AI costs myself.

## 3. What is in and out of scope?

- **One core workflow:** Upload one or more images (or paste a link or text) → AI extracts the recipe → I review and fix it → save it as "want to try" or "favorite" with its source attached → browse it by cookbook chapter (like Dinners or Desserts) or search by keyword or description, and cook from it. I'll start on my laptop because the app runs locally through Week 4, even though I'd normally do this from my phone.
*You have six weeks. List the features, integrations, and polish you are deliberately NOT building.*

- [ ] Not building: Meal planning
- [ ] Not building: Grocery lists
- [ ] Not building: Calendars

**Later builds (wanted, but not part of this core workflow):**

- Analyzing the video and audio from a social media video link to pull out the recipe
- Scaling servings and converting units
- Nutrition information
- Sharing recipes
- More ways to organize beyond "want to try" and "favorite"

## 4. Rough Local Prototype
*What did you spike this week to test the core idea, and what did you learn from throwing it at the problem?*

- **Local run command / branch / screenshot:** `node server.js`, then open http://localhost:3000 (branch `build-1-prototype`). Screenshot: [add yours]
- **What worked vs. what surprised me:**
  - I tested 3 real recipes (11 screenshots): a handwritten soda bread recipe, a social media caption, and an ad-heavy recipe website. The cheap model (`claude-haiku-5.5`) got every ingredient and step right for all three, for about $0.002 per recipe.
  - Surprise: none of my recipes fit on one screen. They took 3–5 screenshots each, so the app had to accept several images per recipe and merge overlapping ones.
  - Surprise: handwritten family recipes are a real source I hadn't planned for. The AI reads them well but marks words it's unsure of so I can check them.
  - The stronger model (`claude-sonnet-5.5`) cost about 15 times as much ($0.026 per recipe) and wasn't noticeably better on the handwritten recipe.
  - Screenshots rarely include a link, so the source is usually a name (a creator, website, or person). Linking back to the original video means pasting the link myself.
