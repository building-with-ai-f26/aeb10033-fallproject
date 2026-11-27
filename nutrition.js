// Nutrition per serving: calories, protein, carbs, and fat.
// Used by server.js (the AI's instructions, and cleaning what the AI or an edit sends) and by the tests.

// What the AI is told, both when it reads a new recipe and when it estimates one already saved.
const NUTRITION_RULE = `- nutrition: calories, protein, carbs, and fat for ONE serving.
  - If the source shows nutrition (like "Serving: 2 cookies, Calories: 79kcal, Protein: 1g"), copy those numbers: source "shown", and serving = what the source calls one serving (like "2 cookies").
  - Otherwise estimate it from the ingredients and amounts: source "estimated". Divide by the servings shown. If servings aren't shown, pick a sensible number and say so in serving, like "1 of about 8 servings (assumed)"; otherwise write it like "1 of 12 servings".
  - Round calories to the nearest 10 and grams to whole numbers.
  - Use source "none" (and 0 for the numbers) if this isn't a recipe or the amounts are too vague to estimate honestly.`;

// The shape the AI must reply with (inside the recipe, or on its own).
const NUTRITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["source", "serving", "calories", "protein_g", "carbs_g", "fat_g"],
  properties: {
    source: { type: "string", enum: ["shown", "estimated", "none"] },
    serving: { type: "string" },
    calories: { type: "number" },
    protein_g: { type: "number" },
    carbs_g: { type: "number" },
    fat_g: { type: "number" },
  },
};

// Turn whatever arrives (the AI's reply, or the edit form's text boxes) into the saved shape:
//   { calories, protein_g, carbs_g, fat_g, serving, estimated }  or  null for "no nutrition".
// Numbers must be between 0 and a sane maximum; anything else becomes null (left blank).
function cleanNutrition(n) {
  if (!n || typeof n !== "object" || n.source === "none") return null;
  const num = (value, max) => {
    const x = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max ? Math.round(x) : null;
  };
  const cleaned = {
    calories: num(n.calories, 5000),
    protein_g: num(n.protein_g, 500),
    carbs_g: num(n.carbs_g, 1000),
    fat_g: num(n.fat_g, 500),
  };
  if (Object.values(cleaned).every((v) => v === null)) return null;
  return {
    ...cleaned,
    serving: typeof n.serving === "string" ? n.serving.trim().slice(0, 80) : "",
    // From the AI: "shown" means copied from the source. From an edit: keep the flag it had.
    estimated: n.source !== undefined ? n.source !== "shown" : n.estimated !== false,
  };
}

module.exports = { NUTRITION_RULE, NUTRITION_SCHEMA, cleanNutrition };
