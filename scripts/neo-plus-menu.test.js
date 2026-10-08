// NEO+: the right-click menu additions (neo-plus/main.js)
const test = require('node:test');
const assert = require('node:assert');
const { extendTextMenu } = require('../neo-plus/main.js');

const base = [{ role: 'copy' }, { type: 'separator' }, { role: 'selectAll' }];
const fakeWin = () => {
  const sent = [];
  return { sent, isDestroyed: () => false, webContents: { send: (ch, msg) => sent.push([ch, msg]) } };
};
const labels = (items) => items.map((i) => i.label || i.role || i.type);

test('selected text gets Italic, Bold, Underline and Add Comment first, and Fix Quotes last', () => {
  const win = fakeWin();
  const items = extendTextMenu(base, { isEditable: true, selectionText: 'dawn', x: 5, y: 6 }, win);
  assert.deepStrictEqual(labels(items), ['Italic', 'Bold', 'Underline', 'separator', 'Add Comment…', 'Read Highlighted Passage Aloud', 'separator', 'copy', 'separator', 'selectAll', 'separator', 'Fix Quotes in This Chapter']);
  items[0].click();
  items[4].click();
  items[5].click();
  items[items.length - 1].click();
  assert.deepStrictEqual(win.sent, [
    ['menu', { type: 'nd-format', cmd: 'italic' }],
    ['menu', { type: 'nd-addComment' }],
    ['menu', { type: 'nd-read', cmd: 'selection' }],
    ['menu', { type: 'nd-fixApostrophes', x: 5, y: 6 }]
  ]);
});

test('no selection: no formatting items', () => {
  const items = extendTextMenu(base, { isEditable: true, selectionText: '' }, fakeWin());
  assert.ok(!labels(items).includes('Italic'));
  assert.ok(!labels(items).includes('Add Comment…'));
  assert.strictEqual(labels(items)[0], 'Read Aloud from Here');
  assert.ok(labels(items).includes('Fix Quotes in This Chapter'));
});

test('text that is not editable: menu untouched', () => {
  assert.deepStrictEqual(extendTextMenu(base, { isEditable: false, selectionText: 'x' }, fakeWin()), base);
});

test('a word the system spellchecker flags: its suggestions first, then Add to the Dictionary', () => {
  const replaced = [];
  const added = [];
  const win = { ...fakeWin(), webContents: { send() {}, replaceMisspelling: (w) => replaced.push(w), session: { addWordToSpellCheckerDictionary: (w) => added.push(w) } } };
  const items = extendTextMenu(base, { isEditable: true, selectionText: '', misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten', 'tea'] }, win);
  assert.deepStrictEqual(labels(items).slice(0, 5), ['the', 'ten', 'tea', 'Add “teh” to the Dictionary', 'separator']);
  items[0].click();
  items[3].click();
  assert.deepStrictEqual([replaced, added], [['the'], ['teh']]);
  const none = extendTextMenu(base, { isEditable: true, selectionText: '', misspelledWord: 'zxqv', dictionarySuggestions: [] }, win);
  assert.strictEqual(none[0].label, 'No suggestions');
  assert.strictEqual(none[0].enabled, false);
});
