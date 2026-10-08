// NEO+: the library kept the same on two computers, end to end inside NEO.
// NEO runs on a throwaway library against the Google stand-in; the "other
// computer" is a second library synced to the same stand-in from here.
// Made-up books only. Run: npx electron scripts/neo-plus-library.e2e.js
'use strict';

process.env.NEO_PLUS_FAKE = '1';
const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-plus-library-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
const LIB = path.join(tmp, 'NEO Library');
fs.mkdirSync(LIB);
fs.writeFileSync(path.join(LIB, 'library.json'), JSON.stringify({
  authorName: 'Test Writer', penNames: [], firstRunDone: true, pageTheme: 'night',
  shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
}));
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
require('../main.js');
const neoPlus = require('../neo-plus/main.js');
const { LibrarySync } = require('../neo-plus/library-sync.js');

let wc;
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out: ' + what);
    await tick(150);
  }
}

// the other computer
const OTHER = path.join(tmp, 'other', 'NEO Library');
fs.mkdirSync(OTHER, { recursive: true });
fs.writeFileSync(path.join(OTHER, 'library.json'), JSON.stringify({ authorName: '', penNames: [], firstRunDone: false, pageTheme: 'day', shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }] }));
let other;
const otherFile = (rel) => path.join(OTHER, ...rel.split('/'));
const otherRead = (rel) => fs.readFileSync(otherFile(rel), 'utf8');
const otherWrite = (rel, v) => { fs.mkdirSync(path.dirname(otherFile(rel)), { recursive: true }); fs.writeFileSync(otherFile(rel), typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
// NEO here: one look now (as on focus), then NEO takes in what came
const neoLook = async () => { const r = await js(`window.neo.neoPlus({ op: 'libNow', open: typeof book !== 'undefined' && book ? book.id : null })`); await tick(900); return r; };

let BOOK;
const chIds = () => js('book.chapterOrder.slice()');
const pageText = (chId) => js(`document.querySelector('.chapter[data-id="${chId}"] .chapter-body').textContent`);
async function typeInNeo(chId, text) {
  await js(`(() => {
    const p = document.querySelector('.chapter[data-id="${chId}"] .chapter-body p');
    p.closest('.chapter-body').focus();
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    document.execCommand('insertText', false, ${JSON.stringify(text)});
  })()`);
  await js('flushAllSaves()');
  await tick(400);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the Google Drive menu offers to keep the library the same on every computer', async () => {
  const gd = Menu.getApplicationMenu().items.find((i) => i.label === 'Google Drive');
  const item = gd.submenu.items.find((i) => i.label === 'Keep My Library the Same on Every Computer');
  assert.ok(item, gd.submenu.items.map((i) => i.label).join(', '));
  assert.equal(item.checked, false);
});

test('turned on, the whole library goes up to a “NEO+ Library” folder', async () => {
  const r = await js(`window.neo.neoPlus({ op: 'libSet', on: true })`);
  assert.ok(r && r.ok, JSON.stringify(r));
  const g = neoPlus._drive().fake;
  const root = [...g.files.values()].find((f) => f.appProperties.neoLib === 'root');
  assert.equal(root.name, 'NEO+ Library');
  const names = [...g.files.values()].filter((f) => f.parents.includes(root.id) && !f.trashed).map((f) => f.name);
  assert.ok(names.includes('library.json'));
  assert.ok(names.includes(`${BOOK}/book.json`));
  assert.equal(names.filter((n) => n.startsWith(`${BOOK}/chapters/`)).length, 2);
  const gd = Menu.getApplicationMenu().items.find((i) => i.label === 'Google Drive');
  assert.equal(gd.submenu.items.find((i) => i.label === 'Keep My Library the Same on Every Computer').checked, true);
  assert.ok(gd.submenu.items.some((i) => /^Library synced /.test(i.label)));
});

test('a new computer gets every book', async () => {
  other = new LibrarySync({ api: neoPlus._drive().fake, dir: path.join(tmp, 'other', 'app'), libraryDir: () => OTHER, device: 'Laptop' });
  await other.pass();
  const lib = JSON.parse(otherRead('library.json'));
  assert.equal(lib.firstRunDone, true);
  assert.deepEqual(lib.shelves[0].bookIds, [BOOK]);
  const [c1] = await chIds();
  assert.match(otherRead(`${BOOK}/chapters/${c1}.html`), /The lamp was lit/);
});

test('words written on the other computer appear on the open page', async () => {
  const [, c2] = await chIds();
  otherWrite(`${BOOK}/chapters/${c2}.html`, '<p>Mara walked the flats at low tide. The bell rang twice.</p>');
  await other.pass();
  await neoLook();
  await until(async () => /rang twice/.test(await pageText(c2)), 8000, 'the page to take in the other computer’s words');
});

test('words written here reach the other computer', async () => {
  const [c1] = await chIds();
  await typeInNeo(c1, ' The wick was new.');
  await neoLook();
  await other.pass();
  assert.match(otherRead(`${BOOK}/chapters/${c1}.html`), /The wick was new\./);
});

test('the same chapter changed on both: both kept, the other computer’s as the chapter after', async () => {
  const [c1] = await chIds();
  otherWrite(`${BOOK}/chapters/${c1}.html`, '<p>The lamp was lit by the keeper herself.</p>');
  await other.pass();
  await typeInNeo(c1, ' Mara trimmed it.');
  await neoLook();
  await until(async () => (await chIds()).length === 3, 8000, 'the other version to arrive as a chapter');
  const ids = await chIds();
  assert.equal(ids[0], c1);
  assert.match(await pageText(c1), /Mara trimmed it\./);
  assert.match(await pageText(ids[1]), /keeper herself/);
  assert.match(await js(`book.chapterTitles[${JSON.stringify(ids[1])}]`), /from Laptop/);
  // and the other computer ends up with both
  await js('flushAllSaves()'); await tick(400);
  await neoLook();
  await other.pass();
  const meta = JSON.parse(otherRead(`${BOOK}/book.json`));
  assert.equal(meta.chapterOrder.length, 3);
});

test('the open book’s notes wait until it’s closed', async () => {
  otherWrite(`${BOOK}/notes.html`, '<p>The ferry runs Tuesdays.</p>');
  await other.pass();
  const r = await neoLook();
  assert.ok(r && r.waiting >= 1, JSON.stringify(r));
  assert.doesNotMatch(fs.readFileSync(path.join(LIB, BOOK, 'notes.html'), 'utf8'), /Tuesdays/);
  await js('backToShelf()');
  await tick(600);
  await neoLook();
  assert.match(fs.readFileSync(path.join(LIB, BOOK, 'notes.html'), 'utf8'), /Tuesdays/);
});

test('a book started on the other computer appears on the shelf here', async () => {
  const NEW = 'book-tide-tables-lkaaa-bbbbb';
  otherWrite(`${NEW}/book.json`, { id: NEW, title: 'Tide Tables', subtitle: '', author: 'Test Writer', chapterOrder: ['ch-t'], chapterTitles: { 'ch-t': 'High Water' }, created: new Date().toISOString(), modified: new Date().toISOString(), tabNames: { notes: 'Notes', outline: 'Outline' } });
  otherWrite(`${NEW}/chapters/ch-t.html`, '<p>High water at six.</p>');
  otherWrite(`${NEW}/notes.html`, '');
  const lib = JSON.parse(otherRead('library.json')); lib.shelves[0].bookIds.push(NEW); otherWrite('library.json', lib);
  await other.pass();
  await neoLook();
  await until(() => js(`library.shelves[0].bookIds.includes('${NEW}')`), 8000, 'the shelf to list the new book');
  await until(() => js(`!!document.querySelector('#bookshelf-view [data-id="${NEW}"], #bookshelf-view [data-book-id="${NEW}"]') || [...document.querySelectorAll('#bookshelf-view *')].some((e) => e.children.length === 0 && /Tide Tables/.test(e.textContent))`), 8000, 'a tile for the new book');
});

async function main() {
  await app.whenReady();
  let failed = 0;
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    wc = win.webContents;
    while (!(await js(`typeof library !== 'undefined' && !!library && !!window.NeoPlusLibrary`).catch(() => false))) await tick(50);
    await tick(300);
    BOOK = await js(`(async () => {
      document.getElementById('firstrun').hidden = true;
      await addImportedBooks([{ name: 'The Lighthouse', chapters: [
        { title: 'The Keeper’s House', paras: [{ text: 'The lamp was lit.' }] },
        { title: 'Low Tide', paras: [{ text: 'Mara walked the flats at low tide.' }] }
      ] }], library.shelves[0]);
      const ids = library.shelves[0].bookIds;
      await openBook(ids[ids.length - 1]);
      return ids[ids.length - 1];
    })()`);
    await tick(800);
    await js('NeoPlusLibrary.hello()');
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
