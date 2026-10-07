// NEO-Drive: tests for neo-drive/apostrophes.js
const test = require('node:test');
const assert = require('node:assert');
const { fixText, planParagraph } = require('../neo-drive/apostrophes.js');

const cases = [
  // contractions and possessives
  ["don't", 'don’t'],
  ['don‘t', 'don’t'],
  ["Mara's staff", 'Mara’s staff'],
  ["o'clock", 'o’clock'],
  // trailing apostrophes and closing quotes
  ["the boys' shed", 'the boys’ shed'],
  ["goin' home", 'goin’ home'],
  ['goin‘ home', 'goin’ home'],
  // numbers
  ["back in the '90s", 'back in the ’90s'],
  ['back in the ‘90s', 'back in the ’90s'],
  // known elisions, straight or wrongly opened
  ["get 'em", 'get ’em'],
  ['get ‘em', 'get ’em'],
  ['‘Til morning', '’Til morning'],
  ["'cause I said so", '’cause I said so'],
  ["rock 'n' roll", 'rock ’n’ roll'],
  ['“Get ‘em!”', '“Get ’em!”'],
  // real single quotations stay open
  ['“He said ‘go home,’ and left.”', '“He said ‘go home,’ and left.”'],
  ["“He said 'go home,' and left.”", '“He said ‘go home,’ and left.”'],
  // already right: untouched
  ['It’s ’em, the ’90s, and ‘quoted’ words.', 'It’s ’em, the ’90s, and ‘quoted’ words.'],
  // after a dash, a cut-off quotation closes
  ["“She said 'wait—' and stopped.”", '“She said ‘wait—’ and stopped.”'],
  // a lone mark between spaces is left alone
  ["a ' b", "a ' b"]
];

for (const [input, want] of cases) {
  test(`fixText: ${input}`, () => assert.strictEqual(fixText(input), want));
}

test('unknown word-start with no closer becomes an apostrophe, flagged', () => {
  const s = '‘Appen not, he said.'.replace('Appen', 'Ullo');
  const plan = planParagraph(s);
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].to, '’');
  assert.strictEqual(plan[0].flag, true);
});

test('unknown word-start with a closer opens a quotation, flagged', () => {
  const plan = planParagraph("'Run,' she said.");
  assert.strictEqual(plan[0].to, '‘');
  assert.strictEqual(plan[0].flag, true);
  assert.strictEqual(plan[1].to, '’');
});

test('length never changes', () => {
  for (const [input] of cases) assert.strictEqual(fixText(input).length, input.length);
});
