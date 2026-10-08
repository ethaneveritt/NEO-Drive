// NEO+: a new computer (NEO just installed, nothing set up) turns on
// library sync and gets the library from Google Drive, shelves and all.
// The Google stand-in, a throwaway library, made-up books.
// Run: npx electron scripts/neo-plus-library-new.e2e.js
'use strict';

process.env.NEO_PLUS_FAKE = '1';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-plus-library-new-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
require('../main.js');
const neoPlus = require('../neo-plus/main.js');
const { LibrarySync } = require('../neo-plus/library-sync.js');

const BOOK = 'book-the-lighthouse-lk3j4-abcde';
let wc;
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch { /* the page is reloading */ }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out: ' + what);
    await tick(200);
  }
}

async function main() {
  await app.whenReady();
  let failed = 0;
  try {
    // the other computer's library, already in Drive
    const home = path.join(tmp, 'home', 'NEO Library');
    const put = (rel, v) => { const f = path.join(home, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
    put('library.json', { authorName: 'Test Writer', penNames: [], firstRunDone: true, pageTheme: 'night', shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [BOOK] }] });
    put(`${BOOK}/book.json`, { id: BOOK, title: 'The Lighthouse', subtitle: 'Book One', author: 'Test Writer', chapterOrder: ['ch-a'], chapterTitles: { 'ch-a': 'The Keeper’s House' }, created: '2026-10-01T00:00:00.000Z', modified: '2026-10-01T00:00:00.000Z', tabNames: { notes: 'Notes', outline: 'Outline' } });
    put(`${BOOK}/chapters/ch-a.html`, '<p>The lamp was lit.</p>');
    put(`${BOOK}/notes.html`, '');
    await new LibrarySync({ api: neoPlus._drive().fake, dir: path.join(tmp, 'home', 'app'), libraryDir: () => home, device: 'Desk PC' }).pass();

    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    wc = win.webContents;
    await until(() => js(`typeof library !== 'undefined' && !!library && !!window.NeoPlusLibrary`), 15000, 'NEO to start');
    await tick(500);
    assert.equal(await js(`!document.getElementById('firstrun').hidden`), true, 'NEO starts on its first-run screen');
    await js('NeoPlusLibrary.hello()');
    js(`window.neo.neoPlus({ op: 'libSet', on: true })`).catch(() => {}); // the page reloads as it answers
    await until(() => js(`typeof library !== 'undefined' && !!library && library.firstRunDone && library.shelves[0].bookIds.includes('${BOOK}')`), 15000, 'the library from Drive');
    await until(() => js(`document.getElementById('firstrun').hidden && !document.getElementById('bookshelf-view').hidden`), 15000, 'the shelves, not the first-run screen');
    assert.equal(fs.readFileSync(path.join(tmp, 'NEO Library', BOOK, 'chapters', 'ch-a.html'), 'utf8'), '<p>The lamp was lit.</p>');
    console.log('ok   a new computer gets the library from Drive, and NEO opens on its shelves');
  } catch (err) {
    failed++;
    console.log('FAIL ' + String(err.message));
  } finally {
    console.log(`\n${1 - failed} passed, ${failed} failed`);
    app.exit(failed ? 1 : 0);
  }
}
main();
