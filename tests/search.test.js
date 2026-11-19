// Run: node --test
// Checks search with small made-up recipes (no AI, no saved data needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const { searchRecipe } = require("../search.js");

const recipe = (fields) => ({ title: "", chapter: "", source_name: "", notes: "", tags: [], ingredient_groups: [], ...fields });

const spaghettiOs = recipe({
  title: "SpaghettiOs with Mini Meatballs",
  chapter: "Dinners",
  tags: ["dinner", "meal", "pasta", "beef"],
  ingredient_groups: [{ name: "Meatballs", items: ["1/4 cup breadcrumbs", "1 lb ground beef"] }],
});
const sodaBread = recipe({ title: "Irish soda bread", chapter: "Breads", tags: ["baking", "bread"] });
const stuffing = recipe({
  title: "Bread and Celery Stuffing",
  chapter: "Sides",
  tags: ["side", "bread", "stuffing"],
  ingredient_groups: [{ name: "", items: ["2 cups chicken broth", "1 loaf white bread"] }],
});
const chickenPasta = recipe({ title: "Garlic Chicken Pasta", chapter: "Dinners", tags: ["dinner", "meal", "chicken", "quick"] });
const cookies = recipe({ title: "Chocolate Chip Cookies", chapter: "Desserts", tags: ["dessert", "chocolate", "cookies"] });
const tart = recipe({ title: "Fresh Fruit Tart", chapter: "Desserts", tags: ["dessert", "berries", "pastry"] });

test("a word matches whole words, not the middle of longer words", () => {
  assert.equal(searchRecipe(spaghettiOs, "bread"), null); // "breadcrumbs" isn't "bread"
  assert.equal(searchRecipe(sodaBread, "bread"), "best");
  assert.equal(searchRecipe(tart, "pasta"), null); // "pastry" isn't "pasta"
});

test("plurals and singulars find each other", () => {
  assert.equal(searchRecipe(sodaBread, "breads"), "best");
  assert.equal(searchRecipe(cookies, "cookie"), "best");
  assert.equal(searchRecipe(cookies, "desserts"), "best");
  assert.equal(searchRecipe(tart, "berry"), "best");
});

test("matches only in the ingredients are 'also' matches", () => {
  assert.equal(searchRecipe(stuffing, "chicken"), "also"); // chicken broth
  assert.equal(searchRecipe(chickenPasta, "chicken"), "best");
});

test("every word has to match", () => {
  assert.equal(searchRecipe(chickenPasta, "quick dinner"), "best");
  assert.equal(searchRecipe(spaghettiOs, "quick dinner"), null); // not tagged quick
  assert.equal(searchRecipe(cookies, "chocolate desserts"), "best");
  assert.equal(searchRecipe(tart, "chocolate desserts"), null);
});

test("capital letters and punctuation don't matter, and an empty search shows everything", () => {
  assert.equal(searchRecipe(chickenPasta, "  GARLIC, chicken! "), "best");
  assert.equal(searchRecipe(tart, ""), "best");
});

test("your own notes are searched too, as 'also' matches", () => {
  const tried = recipe({ title: "Banana Bread", my_notes: "Used half the sugar. Came out dry." });
  assert.equal(searchRecipe(tried, "dry"), "also");
  assert.equal(searchRecipe(tried, "moist"), null);
  assert.equal(searchRecipe(recipe({ title: "Old Recipe" }), "dry"), null); // saved before My notes existed
});
