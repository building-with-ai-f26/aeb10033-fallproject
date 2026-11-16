// Search for Scrapbook Kitchen. Kept in its own file so it can be tested (tests/search.test.js).
//
// Every word you type has to match a whole word in the recipe ("bread" finds "breads" but not
// "breadcrumbs"). If all your words are in the title, tags, chapter, or source, it's a "best" match.
// If some only appear in the ingredients or notes (like "chicken" in "chicken broth"), it's an
// "also" match, which the page shows in a separate section underneath.

// The words in some text, lowercased: "No-Knead Bread!" -> ["no", "knead", "bread"]
function words(text) {
  return String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

// The forms a search word can take, so plurals still match: cookie -> cookies, berry -> berries,
// dish -> dishes, and the other way around (desserts -> dessert).
function wordForms(word) {
  const forms = new Set([word, word + "s", word + "es"]);
  if (word.length > 3 && word.endsWith("s")) forms.add(word.slice(0, -1));
  if (word.length > 4 && word.endsWith("es")) forms.add(word.slice(0, -2));
  if (word.length > 3 && word.endsWith("y")) forms.add(word.slice(0, -1) + "ies");
  if (word.length > 4 && word.endsWith("ies")) forms.add(word.slice(0, -3) + "y");
  return forms;
}

// Returns "best", "also", or null (no match). An empty search matches everything as "best".
function searchRecipe(recipe, query) {
  const main = new Set(words([recipe.title, recipe.chapter, recipe.source_name, ...(recipe.tags || [])].join(" ")));
  const other = new Set(words([
    recipe.notes,
    ...(recipe.ingredient_groups || []).flatMap((g) => [g.name, ...g.items]),
  ].join(" ")));

  let result = "best";
  for (const word of words(query)) {
    const forms = [...wordForms(word)];
    if (forms.some((f) => main.has(f))) continue;
    if (forms.some((f) => other.has(f))) result = "also";
    else return null;
  }
  return result;
}

module.exports = { searchRecipe, words, wordForms };
