// NEO-Drive: the right-click menu additions (neo-drive/main.js)
const test = require('node:test');
const assert = require('node:assert');
const { extendTextMenu } = require('../neo-drive/main.js');

const base = [{ role: 'copy' }, { type: 'separator' }, { role: 'selectAll' }];
const fakeWin = () => {
  const sent = [];
  return { sent, isDestroyed: () => false, webContents: { send: (ch, msg) => sent.push([ch, msg]) } };
};
const labels = (items) => items.map((i) => i.label || i.role || i.type);

test('selected text gets Italic, Bold, Underline and Add Comment first, and Fix Quotes last', () => {
  const win = fakeWin();
  const items = extendTextMenu(base, { isEditable: true, selectionText: 'dawn', x: 5, y: 6 }, win);
  assert.deepStrictEqual(labels(items), ['Italic', 'Bold', 'Underline', 'separator', 'Add Comment…', 'separator', 'copy', 'separator', 'selectAll', 'separator', 'Fix Quotes in This Chapter']);
  items[0].click();
  items[4].click();
  items[items.length - 1].click();
  assert.deepStrictEqual(win.sent, [
    ['menu', { type: 'nd-format', cmd: 'italic' }],
    ['menu', { type: 'nd-addComment' }],
    ['menu', { type: 'nd-fixApostrophes', x: 5, y: 6 }]
  ]);
});

test('no selection: no formatting items', () => {
  const items = extendTextMenu(base, { isEditable: true, selectionText: '' }, fakeWin());
  assert.ok(!labels(items).includes('Italic'));
  assert.ok(!labels(items).includes('Add Comment…'));
  assert.ok(labels(items).includes('Fix Quotes in This Chapter'));
});

test('text that is not editable: menu untouched', () => {
  assert.deepStrictEqual(extendTextMenu(base, { isEditable: false, selectionText: 'x' }, fakeWin()), base);
});
