const test = require("node:test");
const assert = require("node:assert");
const { cleanNutrition } = require("../nutrition.js");

test("keeps an AI estimate and marks it estimated", () => {
  assert.deepStrictEqual(
    cleanNutrition({ source: "estimated", serving: "1 of 4 servings", calories: 412.4, protein_g: 31.6, carbs_g: 12, fat_g: 27 }),
    { calories: 412, protein_g: 32, carbs_g: 12, fat_g: 27, serving: "1 of 4 servings", estimated: true },
  );
});

test("nutrition copied from the source is not marked estimated", () => {
  assert.strictEqual(cleanNutrition({ source: "shown", serving: "2 cookies", calories: 79, protein_g: 1, carbs_g: 10, fat_g: 4 }).estimated, false);
});

test("'none' and missing nutrition are saved as null", () => {
  assert.strictEqual(cleanNutrition({ source: "none", serving: "", calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }), null);
  assert.strictEqual(cleanNutrition(undefined), null);
  assert.strictEqual(cleanNutrition("lots"), null);
});

test("edit form text boxes: numbers as text work, blanks and nonsense are left blank", () => {
  assert.deepStrictEqual(
    cleanNutrition({ calories: "250", protein_g: "", carbs_g: "abc", fat_g: "-3", serving: " 1 slice ", estimated: false }),
    { calories: 250, protein_g: null, carbs_g: null, fat_g: null, serving: "1 slice", estimated: false },
  );
});

test("an edit with every number blank removes nutrition", () => {
  assert.strictEqual(cleanNutrition({ calories: "", protein_g: "", carbs_g: "", fat_g: "", serving: "1 slice", estimated: true }), null);
});

test("impossible numbers are refused", () => {
  assert.strictEqual(cleanNutrition({ source: "estimated", calories: 99999, protein_g: Infinity, carbs_g: NaN, fat_g: 1e9 }), null);
});
