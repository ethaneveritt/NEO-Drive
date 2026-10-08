// NEO+: tests for neo-plus/apostrophes.js
const test = require('node:test');
const assert = require('node:assert');
const { fixText, planParagraph } = require('../neo-plus/apostrophes.js');

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
  ["a ' b", "a ' b"],
  // double quotes
  ['"You told me you’d give me anything," she said.', '“You told me you’d give me anything,” she said.'],
  ['“Then let’s make a deal."', '“Then let’s make a deal.”'],
  ['”Backwards,“ he said.', '“Backwards,” he said.'],
  ['"…costs double—" The fourth. "—with money."', '“…costs double—” The fourth. “—with money.”'],
  ['Essence was a sort of ‘crutch.’"', 'Essence was a sort of ‘crutch.’”'],
  ['"He said \'go home,\' and left."', '“He said ‘go home,’ and left.”'],
  ['("quoted")', '(“quoted”)'],
  ['"An open quote that runs on', '“An open quote that runs on'],
  ['a " b', 'a " b']
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

test('a dash then a word opens a double quote, flagged', () => {
  const plan = planParagraph('He stopped—"Wait."');
  assert.deepStrictEqual(plan.map((c) => [c.to, c.flag]), [['“', true], ['”', false]]);
});

test('length never changes', () => {
  for (const [input] of cases) assert.strictEqual(fixText(input).length, input.length);
});
