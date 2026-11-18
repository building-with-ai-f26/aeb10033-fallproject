// Short recipe times for the board cards, like "3 hours 45 minutes" -> "3 hr 45 min".
// Kept in its own file so it can be tested (tests/recipe-time.test.js).
//
// - An AI estimate ("about 40 min (estimated)") gets a "~" in front: "~40 min".
// - Other notes in brackets, like "(plus marinating)", become a "+": "45 min+".
// - No time gives "" so the card shows nothing.
function shortTime(time) {
  let s = String(time || "").trim().toLowerCase();
  if (!s) return "";

  const estimated = /estimat|about|approx|~/.test(s);
  const hadNote = /\(.*?\)/.test(s.replace(/\(\s*estimated\s*\)/g, ""));

  s = s
    .replace(/\(.*?\)/g, " ")                        // drop notes in brackets
    .replace(/\b(about|approximately|approx\.?|total|estimated)\b|~/g, " ")
    .replace(/(\d)\s*(hours?|hrs?|h)\b/g, "$1 hr")   // 2 hours, 2hrs, 2h -> 2 hr
    .replace(/(\d)\s*(minutes?|mins?|m)\b/g, "$1 min")
    .replace(/\s*,\s*|\s+and\s+/g, " ")              // "1 hr, 10 min" / "1 hr and 10 min"
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";

  return (estimated ? "~" : "") + s + (hadNote ? "+" : "");
}

module.exports = { shortTime };
