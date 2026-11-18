// Run: node --test
// Checks the short times shown on board cards (no AI, no saved data needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const { shortTime } = require("../recipe-time.js");

test("long words get shortened", () => {
  assert.equal(shortTime("3 hours 45 minutes"), "3 hr 45 min");
  assert.equal(shortTime("10 minutes"), "10 min");
  assert.equal(shortTime("2 hrs"), "2 hr");
  assert.equal(shortTime("20 mins"), "20 min");
  assert.equal(shortTime("1 hour and 10 minutes"), "1 hr 10 min");
});

test("times that are already short stay the same", () => {
  assert.equal(shortTime("5 hr 20 min"), "5 hr 20 min");
  assert.equal(shortTime("45 min"), "45 min");
});

test("AI estimates get a ~ and other notes become a +", () => {
  assert.equal(shortTime("about 40 min (estimated)"), "~40 min");
  assert.equal(shortTime("45 minutes (plus marinating)"), "45 min+");
});

test("no time shows nothing", () => {
  assert.equal(shortTime(""), "");
  assert.equal(shortTime(undefined), "");
  assert.equal(shortTime("  "), "");
});
