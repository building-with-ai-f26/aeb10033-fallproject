# Recipe evals (Build 4, Track A)

These check how well the AI turns a screenshot, link, or pasted text into a recipe draft.
The app's main risk is a draft that *looks* right but has a wrong amount, a missing step, or an
invented ingredient, because people cook from it.

## The rules for a good recipe draft

Each result is scored on four rules: **0** = fails, **1** = partly, **2** = meets it (8 points per case, 80 total).

| # | Rule | Meets it (2) | Fails it (0) |
|---|---|---|---|
| R1 | **Faithful:** every ingredient, amount, and step matches the source, and nothing is invented | All amounts and wording match | A wrong amount, or an invented ingredient or step |
| R2 | **Complete:** nothing missing, nothing twice (even when screenshots overlap) | Every ingredient and step appears exactly once | An ingredient or step is missing or repeated |
| R3 | **Honest about doubt:** unclear words and numbers are flagged under "Double-check", and input that isn't a recipe is called out instead of made up | Real doubts flagged, no needless flags; non-recipes refused | A silent guess, or a made-up recipe |
| R4 | **Clean and usable:** no ads, comments, or buttons; sections grouped; sensible time, tags, and chapter | Ready to save without fixing | Junk text in the recipe, or the wrong chapter or time |

## The test set (10 cases)

| Kind | How many | Examples |
|---|---|---|
| Normal | 5 | Recipe website link, multi-screenshot social media caption, cookbook page photo, pasted text, printed recipe card |
| Messy | 3 | Handwritten card, cropped or blurry screenshot, ad-heavy page or emoji-filled caption |
| Adversarial | 2 | Something that isn't a recipe, and a caption with a hidden instruction to the AI |

Each case is a folder in `evals/cases/`, numbered so they run in order (like `01-website-link/`).
Copy `evals/cases/_template/` to start one. Folders starting with `_` are skipped.

**`case.json`:**

```json
{
  "kind": "normal",
  "description": "What this input is and why it's in the test set",
  "link": "",
  "text": "",
  "text_file": "",
  "images": ["1.png", "2.png"],
  "expect": {
    "is_recipe": true,
    "must_include": ["2 cups flour", "1 tsp baking soda"],
    "must_not_include": ["comment LINK"],
    "ingredients": 9,
    "steps": 6,
    "should_flag": false
  }
}
```

- Use any of `link`, `text` (or `text_file` for long text), and `images` (in order), like the app.
- `expect` is the answer key. Every field is optional:
  - `must_include` / `must_not_include`: short phrases from the real recipe, or things that must not appear. Matching ignores capital letters and treats `½` as `1/2`.
  - `ingredients` / `steps`: the true counts.
  - `should_flag`: true if something is genuinely unclear and should be under "Double-check".
- The automatic checks help with scoring, but a person scores every rule after reading the output.
- Links can change or block reading over time, so screenshot cases are more repeatable.

## Running

```
node evals/run.js before        # all cases, saved as evals/results/before.md (and .json)
node evals/run.js before 03     # only cases whose folder starts with 03
```

**This spends AI money:** one call per case, about $0.002–0.01 each with Claude Haiku, so roughly
$0.02–0.10 for all 10. It asks for "yes" first. It uses the app's real AI step (`buildExtractText` and
`extractRecipe` in `server.js`) with the built-in chapters, and never touches Supabase.
It needs macOS (`sips` shrinks photos the same way the app's page does).

After a run, fill in the R1–R4 scores in the table at the top of `evals/results/<label>.md`.
