// NEO+: the library kept the same on two computers (neo-plus/library-sync.js),
// two "computers" sharing the Google stand-in. Made-up books only.
// Run: node --test scripts/neo-plus-library-sync.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FakeGoogle } = require('../neo-plus/fake-google.js');
const { LibrarySync, wanted, mergeJSON } = require('../neo-plus/library-sync.js');

const BOOK = 'book-the-lighthouse-lk3j4-abcde';

function computer(google, name, t0 = Date.now()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `neo-plus-libsync-${name}-`));
  const lib = path.join(root, 'NEO Library');
  const app = path.join(root, 'app');
  fs.mkdirSync(lib, { recursive: true });
  let clock = t0;
  const sync = new LibrarySync({ api: google, dir: app, libraryDir: () => lib, device: name, now: () => clock });
  const file = (rel) => path.join(lib, ...rel.split('/'));
  return {
    lib, app, sync,
    tick(ms = 1000) { clock += ms; },
    write(rel, text) { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), typeof text === 'string' ? text : JSON.stringify(text, null, 2)); },
    read(rel) { return fs.readFileSync(file(rel), 'utf8'); },
    json(rel) { return JSON.parse(this.read(rel)); },
    has(rel) { return fs.existsSync(file(rel)); },
    remove(rel) { fs.rmSync(file(rel), { recursive: true, force: true }); },
    pass(opts) { return sync.pass(opts); },
    backups() {
      const out = [];
      const walk = (d, r) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name), r ? r + '/' + e.name : e.name) : out.push(r + '/' + e.name); } catch { /* none */ } };
      walk(path.join(app, 'library-sync', 'backup'), '');
      return out;
    }
  };
}

function seedBook(pc) {
  pc.write('library.json', { authorName: 'Test Writer', penNames: [], firstRunDone: true, pageTheme: 'night', shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [BOOK] }] });
  pc.write(`${BOOK}/book.json`, { id: BOOK, title: 'The Lighthouse', subtitle: 'Book One', author: 'Test Writer', chapterOrder: ['ch-a', 'ch-b'], chapterTitles: { 'ch-a': "The Keeper's House", 'ch-b': 'Low Tide' }, modified: '2026-10-01T00:00:00.000Z' });
  pc.write(`${BOOK}/chapters/ch-a.html`, '<p>The lamp was lit.</p>');
  pc.write(`${BOOK}/chapters/ch-b.html`, '<p>Mara walked the flats at low tide.</p>');
  pc.write(`${BOOK}/notes.html`, '<p>Remember the bell.</p>');
  pc.write(`${BOOK}/stickies.json`, [{ id: 's1', chapterId: 'ch-a', text: 'Check the date', resolved: false }]);
  pc.write(`${BOOK}/darlings.json`, []);
}
// a new computer: NEO's own fresh library, nothing in it yet
function freshLibrary(pc) {
  pc.write('library.json', { authorName: '', penNames: [], firstRunDone: false, pageTheme: 'night', shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }] });
}

async function twoComputers() {
  const g = new FakeGoogle();
  const a = computer(g, 'Desk PC');
  const b = computer(g, 'Laptop');
  seedBook(a);
  freshLibrary(b);
  await a.pass();
  await b.pass();
  return { g, a, b };
}

test('what travels: library.json and book folders, not backups, exports or half-written files', () => {
  assert.equal(wanted('library.json'), true);
  assert.equal(wanted(`${BOOK}/chapters/ch-a.html`), true);
  assert.equal(wanted(`${BOOK}/cover-1700000000.png`), true);
  for (const r of ['_catalog.txt', 'neo-errors.log', 'Backups/neo-backup.zip', 'Exports/x.docx', `${BOOK}/book.json.bak`, `${BOOK}/chapters/ch-a.html.tmp`, `${BOOK}/.DS_Store`, `${BOOK}/desktop.ini`, `${BOOK}/../library.json`]) {
    assert.equal(wanted(r), false, r);
  }
});

test('the first computer sends its library up; a new computer gets all of it', async () => {
  const { g, a, b } = await twoComputers();
  assert.equal(b.read(`${BOOK}/chapters/ch-a.html`), '<p>The lamp was lit.</p>');
  assert.equal(b.json(`${BOOK}/book.json`).title, 'The Lighthouse');
  assert.deepEqual(b.json('library.json').shelves[0].bookIds, [BOOK]);
  assert.equal(b.json('library.json').firstRunDone, true);
  // one Drive folder, a file per library file
  const roots = await g.listFiles(`appProperties has { key='neoLib' and value='root' } and trashed = false`);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].name, 'NEO+ Library');
  assert.equal((await g.listFiles(`'${roots[0].id}' in parents and trashed = false`)).length, 7);
  // and a second look changes nothing
  const again = await a.pass();
  assert.equal(again.pushed.length + again.pulled.length, 0);
});

test('a chapter written on one computer arrives on the other, both ways', async () => {
  const { a, b } = await twoComputers();
  b.write(`${BOOK}/chapters/ch-b.html`, '<p>Mara walked the flats at low tide.</p><p>The bell rang twice.</p>');
  const up = await b.pass();
  assert.deepEqual(up.pushed, [`${BOOK}/chapters/ch-b.html`]);
  const down = await a.pass();
  assert.deepEqual(down.pulled, [`${BOOK}/chapters/ch-b.html`]);
  assert.match(a.read(`${BOOK}/chapters/ch-b.html`), /rang twice/);
  assert.deepEqual([...down.books], [BOOK]);
  // the copy it replaced is kept aside
  assert.ok(a.backups().some((f) => f.endsWith(`${BOOK}/chapters/ch-b.html`)));
  a.write(`${BOOK}/chapters/ch-a.html`, '<p>The lamp was lit, and then it went out.</p>');
  await a.pass();
  await b.pass();
  assert.match(b.read(`${BOOK}/chapters/ch-a.html`), /went out/);
});

test('a new book on one computer appears on the other, on its shelf', async () => {
  const { a, b } = await twoComputers();
  const NEW = 'book-low-tide-stories-lk9z1-qwert';
  b.write(`${NEW}/book.json`, { id: NEW, title: 'Low Tide Stories', author: 'Test Writer', chapterOrder: ['ch-x'], chapterTitles: {} });
  b.write(`${NEW}/chapters/ch-x.html`, '<p>Gulls.</p>');
  const lib = b.json('library.json'); lib.shelves[0].bookIds.push(NEW); b.write('library.json', lib);
  await b.pass();
  const r = await a.pass();
  assert.equal(r.library, true);
  assert.equal(a.read(`${NEW}/chapters/ch-x.html`), '<p>Gulls.</p>');
  assert.deepEqual(a.json('library.json').shelves[0].bookIds, [BOOK, NEW]);
});

test('a book deleted on one computer leaves the other (kept aside there, in Drive’s trash)', async () => {
  const { g, a, b } = await twoComputers();
  const NEW = 'book-scratch-lk9z1-zzzzz';
  a.write(`${NEW}/book.json`, { id: NEW, title: 'Scratch', chapterOrder: ['ch-1'] });
  a.write(`${NEW}/chapters/ch-1.html`, '<p>Draft.</p>');
  const lib = a.json('library.json'); lib.shelves[0].bookIds.push(NEW); a.write('library.json', lib);
  await a.pass(); await b.pass();
  assert.ok(b.has(`${NEW}/chapters/ch-1.html`));
  a.remove(NEW);
  const lib2 = a.json('library.json'); lib2.shelves[0].bookIds = [BOOK]; a.write('library.json', lib2);
  const r = await a.pass();
  assert.equal(r.removedThere.length, 2);
  const trashed = [...g.files.values()].filter((f) => f.trashed && f.name.startsWith(NEW));
  assert.equal(trashed.length, 2);
  await b.pass();
  assert.equal(b.has(`${NEW}/chapters/ch-1.html`), false);
  assert.ok(b.backups().some((f) => f.endsWith(`${NEW}/chapters/ch-1.html`)));
  assert.deepEqual(b.json('library.json').shelves[0].bookIds, [BOOK]);
});

test('the same chapter changed on both: this computer’s text stays, the other’s is the chapter after it', async () => {
  const { a, b } = await twoComputers();
  a.write(`${BOOK}/chapters/ch-a.html`, '<p>The lamp was lit by Mara.</p>');
  b.write(`${BOOK}/chapters/ch-a.html`, '<p>The lamp was lit by the keeper.</p>');
  await a.pass();
  const r = await b.pass();
  assert.deepEqual(r.conflicts, [`${BOOK}/chapters/ch-a.html`]);
  assert.equal(b.read(`${BOOK}/chapters/ch-a.html`), '<p>The lamp was lit by the keeper.</p>');
  const meta = b.json(`${BOOK}/book.json`);
  assert.equal(meta.chapterOrder.length, 3);
  const twin = meta.chapterOrder[1];
  assert.equal(b.read(`${BOOK}/chapters/${twin}.html`), '<p>The lamp was lit by Mara.</p>');
  assert.match(meta.chapterTitles[twin], /^The Keeper's House \(from Desk PC, /);
  // and the first computer ends up with both, the same way round
  await a.pass();
  assert.equal(a.read(`${BOOK}/chapters/ch-a.html`), '<p>The lamp was lit by the keeper.</p>');
  assert.equal(a.read(`${BOOK}/chapters/${twin}.html`), '<p>The lamp was lit by Mara.</p>');
  assert.deepEqual(a.json(`${BOOK}/book.json`).chapterOrder, meta.chapterOrder);
  const settle = await b.pass();
  assert.equal(settle.pushed.length + settle.pulled.length + settle.conflicts.length, 0);
});

test('book.json changed on both: a new chapter there, a renamed one here, both kept', async () => {
  const { a, b } = await twoComputers();
  const ma = a.json(`${BOOK}/book.json`); ma.chapterOrder.push('ch-c'); ma.chapterTitles['ch-c'] = 'The Crossing'; a.write(`${BOOK}/book.json`, ma);
  a.write(`${BOOK}/chapters/ch-c.html`, '<p>The boat left at dawn.</p>');
  const mb = b.json(`${BOOK}/book.json`); mb.chapterTitles['ch-b'] = 'Lower Tide'; mb.subtitle = 'Book One: Revised'; b.write(`${BOOK}/book.json`, mb);
  await a.pass();
  await b.pass();
  await a.pass();
  for (const pc of [a, b]) {
    const m = pc.json(`${BOOK}/book.json`);
    assert.deepEqual(m.chapterOrder, ['ch-a', 'ch-b', 'ch-c']);
    assert.equal(m.chapterTitles['ch-b'], 'Lower Tide');
    assert.equal(m.chapterTitles['ch-c'], 'The Crossing');
    assert.equal(m.subtitle, 'Book One: Revised');
    assert.equal(pc.read(`${BOOK}/chapters/ch-c.html`), '<p>The boat left at dawn.</p>');
  }
});

test('comments added on both computers are all kept; one resolved there stays resolved', async () => {
  const { a, b } = await twoComputers();
  const sa = a.json(`${BOOK}/stickies.json`); sa.push({ id: 's2', chapterId: 'ch-b', text: 'Tide times?', resolved: false }); a.write(`${BOOK}/stickies.json`, sa);
  const sb = b.json(`${BOOK}/stickies.json`); sb[0].resolved = true; sb.push({ id: 's3', chapterId: 'ch-a', text: 'Name the keeper', resolved: false }); b.write(`${BOOK}/stickies.json`, sb);
  await a.pass(); await b.pass(); await a.pass();
  for (const pc of [a, b]) {
    const s = pc.json(`${BOOK}/stickies.json`);
    assert.deepEqual(s.map((x) => x.id).sort(), ['s1', 's2', 's3']);
    assert.equal(s.find((x) => x.id === 's1').resolved, true);
  }
});

test('notes changed on both keep both texts', async () => {
  const { a, b } = await twoComputers();
  a.write(`${BOOK}/notes.html`, '<p>Remember the bell.</p><p>Mara is left-handed.</p>');
  b.write(`${BOOK}/notes.html`, '<p>Remember the bell.</p><p>The ferry runs Tuesdays.</p>');
  await a.pass(); await b.pass(); await a.pass();
  for (const pc of [a, b]) {
    const n = pc.read(`${BOOK}/notes.html`);
    assert.match(n, /left-handed/);
    assert.match(n, /Tuesdays/);
  }
});

test('while a book is open, its notes wait; its chapters (which NEO picks up itself) come in', async () => {
  const { a, b } = await twoComputers();
  b.write(`${BOOK}/notes.html`, '<p>New note.</p>');
  b.write(`${BOOK}/chapters/ch-a.html`, '<p>The lamp was lit at dusk.</p>');
  await b.pass();
  const r = await a.pass({ open: BOOK });
  assert.equal(r.waiting, 1);
  assert.match(a.read(`${BOOK}/chapters/ch-a.html`), /dusk/);
  assert.equal(a.read(`${BOOK}/notes.html`), '<p>Remember the bell.</p>');
  await a.pass();
  assert.equal(a.read(`${BOOK}/notes.html`), '<p>New note.</p>');
});

test('a library folder that’s gone, or mostly emptied, stops the sync before anything is removed', async () => {
  const { g, a } = await twoComputers();
  for (let i = 0; i < 20; i++) a.write(`${BOOK}/chapters/ch-${i}x.html`, `<p>${i}</p>`);
  await a.pass();
  const before = [...g.files.values()].filter((f) => !f.trashed).length;
  a.remove(BOOK);
  await assert.rejects(a.pass(), /Sync stopped: it would have removed \d+ of your library’s \d+ files in Google Drive/);
  assert.equal([...g.files.values()].filter((f) => !f.trashed).length, before);
  a.remove('library.json');
  await assert.rejects(a.pass(), /library folder isn’t there/);
});

test('if the Drive folder is deleted, the library goes up again and nothing here is removed', async () => {
  const { g, a } = await twoComputers();
  const root = [...g.files.values()].find((f) => f.appProperties.neoLib === 'root');
  await g.updateFile(root.id, { trashed: true });
  const r = await a.pass();
  assert.equal(r.removedHere.length, 0);
  assert.equal(r.pushed.length, 7);
  assert.equal(a.read(`${BOOK}/chapters/ch-a.html`), '<p>The lamp was lit.</p>');
});

test('two computers that each had a library before: shelves and books from both', async () => {
  const g = new FakeGoogle();
  const a = computer(g, 'Desk PC');
  const b = computer(g, 'Laptop');
  seedBook(a);
  const OTHER = 'book-tide-tables-lkaaa-bbbbb';
  b.write('library.json', { authorName: 'Test Writer', penNames: [], firstRunDone: true, pageTheme: 'day', shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [OTHER] }, { id: 'shelf-2', name: 'Ideas', bookIds: [] }] });
  b.write(`${OTHER}/book.json`, { id: OTHER, title: 'Tide Tables', chapterOrder: ['ch-t'] });
  b.write(`${OTHER}/chapters/ch-t.html`, '<p>High water.</p>');
  await a.pass(); await b.pass(); await a.pass();
  for (const pc of [a, b]) {
    const lib = pc.json('library.json');
    assert.deepEqual(lib.shelves.map((s) => s.id), ['shelf-1', 'shelf-2']);
    assert.deepEqual([...lib.shelves[0].bookIds].sort(), [BOOK, OTHER].sort());
    assert.ok(pc.has(`${OTHER}/chapters/ch-t.html`) && pc.has(`${BOOK}/chapters/ch-a.html`));
  }
});

test('merging book.json keeps a chapter removed there if it was changed here', () => {
  const base = { chapterOrder: ['a', 'b', 'c'] };
  const local = { chapterOrder: ['a', 'b', 'c'], title: 'X' };
  const remote = { chapterOrder: ['a', 'c'] };
  assert.deepEqual(mergeJSON('book-x/book.json', base, local, remote).chapterOrder, ['a', 'c']);
  assert.deepEqual(mergeJSON('book-x/book.json', base, local, remote, { chapterChangedHere: (c) => c === 'b' }).chapterOrder, ['a', 'b', 'c']);
});

test('offline: the pass fails and changes nothing; the next one catches up', async () => {
  const { g, a, b } = await twoComputers();
  a.write(`${BOOK}/chapters/ch-a.html`, '<p>Offline words.</p>');
  g.offline = true;
  await assert.rejects(a.pass(), /offline/);
  g.offline = false;
  await a.pass();
  await b.pass();
  assert.equal(b.read(`${BOOK}/chapters/ch-a.html`), '<p>Offline words.</p>');
});

test('a chapter iCloud hasn’t downloaded yet (".name.icloud") is never taken for deleted', async () => {
  const { g, a, b } = await twoComputers();
  b.remove(`${BOOK}/chapters/ch-a.html`);
  b.write(`${BOOK}/chapters/.ch-a.html.icloud`, 'placeholder');
  const r = await b.pass();
  assert.equal(r.removedThere.length, 0);
  assert.ok([...g.files.values()].some((f) => f.name === `${BOOK}/chapters/ch-a.html` && !f.trashed));
  await a.pass();
  assert.equal(a.read(`${BOOK}/chapters/ch-a.html`), '<p>The lamp was lit.</p>');
});

test('a Drive file listed without its checksum is left alone, not taken for removed', async () => {
  const { g, a } = await twoComputers();
  const f = [...g.files.values()].find((x) => x.name === `${BOOK}/chapters/ch-b.html`);
  const keep = f.md5Checksum;
  delete f.md5Checksum;
  const r = await a.pass();
  assert.equal(r.pushed.length + r.pulled.length + r.removedHere.length + r.removedThere.length, 0);
  assert.ok(a.has(`${BOOK}/chapters/ch-b.html`));
  f.md5Checksum = keep;
});
