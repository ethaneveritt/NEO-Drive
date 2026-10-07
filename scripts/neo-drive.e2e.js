// NEO-Drive: end-to-end tests for the right-click additions, on a throwaway
// library (same harness as words.e2e.js). Run: npx electron scripts/neo-drive.e2e.js
'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-drive-test-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
const LIB = path.join(tmp, 'NEO Library');
fs.mkdirSync(LIB);
fs.writeFileSync(path.join(LIB, 'library.json'), JSON.stringify({
  authorName: '', penNames: [], firstRunDone: true, pageTheme: 'night',
  shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
}));
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
require('../main.js');

let wc;
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const menu = (msg) => wc.send('menu', msg);

const WRONG = "\"‘Til dawn,” Mara said, “we keep the ‘90s rule: don't wake ‘em.\"";
const RIGHT = '“’Til dawn,” Mara said, “we keep the ’90s rule: don’t wake ’em.”';

const caretInChapter = () => js(`(() => {
  const p = document.querySelector('.chapter-body p');
  document.querySelector('.chapter-body').focus();
  const r = document.createRange(); r.setStart(p.firstChild, 3); r.collapse(true);
  getSelection().removeAllRanges(); getSelection().addRange(r);
})()`);
const firstPara = () => js(`document.querySelector('.chapter-body p').textContent`);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('Fix Quotes rewrites the chapter and reports', async () => {
  await caretInChapter();
  menu({ type: 'nd-fixApostrophes' });
  await tick(300);
  assert.equal(await firstPara(), RIGHT);
  assert.match(await js(`document.querySelector('.nd-report h2').textContent`), /^Fixed \d+ quotes and apostrophes in /);
  if (process.env.SHOT) fs.writeFileSync(process.env.SHOT, (await wc.capturePage()).toPNG());
});

test('Undo puts every mark back in one step', async () => {
  await js(`document.querySelector('.nd-undo').click()`);
  await tick(400);
  assert.equal(await firstPara(), WRONG);
});

test('the fixed chapter is saved to disk', async () => {
  await caretInChapter();
  menu({ type: 'nd-fixApostrophes' });
  await tick(300);
  await js(`document.querySelector('.nd-report .m-ok').click()`);
  await js('flushAllSaves()');
  await tick(1500);
  const bookDir = fs.readdirSync(LIB).find((n) => n.startsWith('book-'));
  const chDir = path.join(LIB, bookDir, 'chapters');
  const html = fs.readdirSync(chDir).map((f) => fs.readFileSync(path.join(chDir, f), 'utf8')).join('\n');
  assert.ok(html.includes('don’t wake ’em'), html.slice(0, 300));
});

test('a second run finds nothing to fix', async () => {
  await caretInChapter();
  menu({ type: 'nd-fixApostrophes' });
  await tick(300);
  assert.equal(await js(`!!document.querySelector('.nd-report')`), false);
});

test('right-click Italic sets the selection in italic', async () => {
  await js(`(() => {
    const p = document.querySelector('.chapter-body p');
    document.querySelector('.chapter-body').focus();
    const r = document.createRange(); r.setStart(p.firstChild, 6); r.setEnd(p.firstChild, 10);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  })()`);
  menu({ type: 'nd-format', cmd: 'italic' });
  await tick(200);
  assert.match(await js(`document.querySelector('.chapter-body p').innerHTML`), /<(i|em)>dawn<\/(i|em)>/);
});

test('right-click Bold sets the selection in bold', async () => {
  menu({ type: 'nd-format', cmd: 'bold' });
  await tick(200);
  assert.match(await js(`document.querySelector('.chapter-body p').innerHTML`), /<(b|strong)>/);
});

async function main() {
  await app.whenReady();
  let failed = 0;
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    wc = win.webContents;
    while (!(await js(`typeof library !== 'undefined' && !!library`).catch(() => false))) await tick(50);
    await tick(300);
    await js(`(async () => {
      document.getElementById('firstrun').hidden = true;
      await addImportedBooks([{ name: 'Quotes', chapters: [
        { title: 'One', paras: [{ text: ${JSON.stringify(WRONG)} }, { text: 'A second line.' }] }
      ] }], library.shelves[0]);
      const ids = library.shelves[0].bookIds;
      await openBook(ids[ids.length - 1]);
    })()`);
    await tick(500);
    win.focus();
    for (const t of tests) {
      try {
        await t.fn();
        console.log('ok   ' + t.name);
      } catch (err) {
        failed++;
        console.log('FAIL ' + t.name + '\n     ' + String(err.message).replace(/\n/g, '\n     '));
      }
    }
    console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  } catch (err) {
    failed++;
    console.error(err);
  } finally {
    app.exit(failed ? 1 : 0);
  }
}
main();
