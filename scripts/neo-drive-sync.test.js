// NEO-Drive: the sync engine (neo-drive/sync.js) against the Google stand-in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../neo-drive/blocks.js');
const { Sync, bookName } = require('../neo-drive/sync.js');
const { FakeGoogle } = require('../neo-drive/fake-google.js');

const p = (text, extra = {}) => B.normalize({ k: 'p', text, ...extra });
const brk = () => B.normalize({ k: 'brk' });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nd-sync-'));

function setup() {
  const g = new FakeGoogle();
  let clock = 1e12;
  const s = new Sync({ api: g, dir: tmpDir(), now: () => clock });
  const book = { uuid: 'book-uuid-1', title: 'The Lighthouse', subtitle: 'Book One', author: 'Ethan Everitt' };
  const entries = [
    { chId: 'c1', kind: 'chapter', heading: 'Chapter 1 — Cold Front', name: 'Chapter 1 — Cold Front', label: 'Cold Front', section: 1, blocks: [p('It rained on the harbor.'), brk(), p('Mara counted coins.')] },
    { chId: 'c2', kind: 'chapter', heading: 'Chapter 2 — The Keeper’s House', name: 'Chapter 2 — The Keeper’s House', label: 'The Keeper’s House', section: 1, blocks: [p('The house was cold.')] }
  ];
  const sync = (over = {}) => { clock += 20000; return s.run({ book, entries, dirty: true, ...over }); };
  const files = () => [...g.files.values()];
  const chapterDoc = (chId) => files().find((f) => f.appProperties.neoChapter === chId);
  const master = () => files().find((f) => f.appProperties.neoRole === 'master');
  return { g, s, book, entries, sync, files, chapterDoc, master, tick: (ms) => { clock += ms; } };
}

test('first sync makes a folder, a Master Manuscript, a Chapters folder and a Doc per chapter', async () => {
  const t = setup();
  const r = await t.sync();
  assert.strictEqual(r.created, 3);
  const folder = t.files().find((f) => f.mimeType.includes('folder') && !f.appProperties.neoRole);
  const chapters = t.files().find((f) => f.appProperties.neoRole === 'chapters');
  assert.strictEqual(folder.name, 'The Lighthouse');
  assert.strictEqual(chapters.name, 'Chapters');
  assert.deepStrictEqual(chapters.parents, [folder.id]);
  assert.strictEqual(t.chapterDoc('c1').name, '1.1: Cold Front');
  assert.strictEqual(t.chapterDoc('c2').name, '1.2: The Keeper’s House');
  assert.deepStrictEqual(t.chapterDoc('c1').parents, [chapters.id]);
  assert.strictEqual(t.master().name, 'The Lighthouse');
  assert.deepStrictEqual(t.master().parents, [folder.id]);
  const c1 = B.fromDoc(await t.g.getDoc(t.chapterDoc('c1').id));
  assert.deepStrictEqual(c1.map((b) => b.k), ['p', 'p', 'brk', 'p']);
  assert.ok(B.isHeading(c1[0]) && !B.isHeading(c1[1]));
  const m = B.fromDoc(await t.g.getDoc(t.master().id));
  assert.deepStrictEqual(m.map((b) => b.text), ['The Lighthouse', 'Book One', 'Ethan Everitt', 'Chapter 1 — Cold Front', 'It rained on the harbor.', '***', 'Mara counted coins.', 'Chapter 2 — The Keeper’s House', 'The house was cold.']);
  // the reading-copy note: a comment, not in the page
  assert.deepStrictEqual(Object.keys((await t.g.getDoc(t.master().id)).headers), []);
  const notes = await t.g.listComments(t.master().id);
  assert.deepStrictEqual(notes.map((c) => c.content), ['Reading copy — comments welcome. Edits made here are undone automatically.']);
});

test('parts are folders inside Chapters, holding their chapters', async () => {
  const t = setup();
  const parts = [{ partId: 'p1', name: 'Part I: The Crossing' }, { partId: 'p2', name: 'Part II: The Road' }];
  t.entries.unshift({ chId: 'c0', kind: 'prologue', heading: 'Prologue', name: 'Prologue', label: 'Prologue', section: 0, blocks: [p('Before.')] });
  t.entries[1].part = 'p1';
  t.entries[2].part = 'p1';
  await t.sync({ parts });
  const chapters = t.files().find((f) => f.appProperties.neoRole === 'chapters');
  const p1 = t.files().find((f) => f.appProperties.neoPart === 'p1');
  const p2 = t.files().find((f) => f.appProperties.neoPart === 'p2');
  assert.strictEqual(p1.name, 'Part I: The Crossing');
  assert.deepStrictEqual(p1.parents, [chapters.id]);
  assert.deepStrictEqual(t.chapterDoc('c0').parents, [chapters.id]);
  assert.strictEqual(t.chapterDoc('c0').name, '0.1: Prologue');
  assert.deepStrictEqual(t.chapterDoc('c1').parents, [p1.id]);
  assert.strictEqual(t.chapterDoc('c1').name, '1.1: Cold Front');
  assert.strictEqual(t.chapterDoc('c2').name, '1.2: The Keeper’s House');
  // chapter 2 moves to part II: its Doc follows, renumbered
  t.entries[2].part = 'p2';
  t.entries[2].section = 2;
  await t.sync({ parts });
  assert.deepStrictEqual(t.chapterDoc('c2').parents, [p2.id]);
  assert.strictEqual(t.chapterDoc('c2').name, '2.1: The Keeper’s House');
  // the part is renamed, then dropped: its folder goes to Deleted chapters
  parts[1].name = 'Part II: The Long Road';
  await t.sync({ parts });
  assert.strictEqual(t.files().find((f) => f.id === p2.id).name, 'Part II: The Long Road');
  t.entries[2].part = 'p1';
  t.entries[2].section = 1;
  await t.sync({ parts: [parts[0]] });
  const deleted = t.files().find((f) => f.appProperties.neoRole === 'deleted');
  assert.strictEqual(deleted.name, 'The Lighthouse Deleted Chapters');
  assert.deepStrictEqual(deleted.parents, t.files().find((f) => f.mimeType.includes('folder') && !f.appProperties.neoRole).parents, 'beside the book folder');
  assert.deepStrictEqual(t.files().find((f) => f.id === p2.id).parents, [deleted.id]);
  assert.deepStrictEqual(t.chapterDoc('c2').parents, [p1.id]);
});

test('Docs from the old layout (all in the book folder) move into Chapters', async () => {
  const t = setup();
  await t.sync();
  const folder = t.files().find((f) => f.mimeType.includes('folder') && !f.appProperties.neoRole);
  const chapters = t.files().find((f) => f.appProperties.neoRole === 'chapters');
  const doc = t.g.files.get(t.chapterDoc('c1').id);
  doc.parents = [folder.id]; // as 1.4.7 left it
  await t.sync();
  assert.deepStrictEqual(t.chapterDoc('c1').parents, [chapters.id]);
});

test('a Doc moved by hand somewhere else in Drive stays where it was put', async () => {
  const t = setup();
  await t.sync();
  const mine = await t.g.createFile({ name: 'My stuff', mimeType: 'application/vnd.google-apps.folder' });
  t.g.files.get(t.chapterDoc('c1').id).parents = [mine.id];
  const count = t.g.files.size;
  t.entries[0].blocks[0] = p('It poured on the harbor.');
  await t.sync();
  assert.strictEqual(t.g.files.size, count, 'no duplicate made');
  assert.deepStrictEqual(t.chapterDoc('c1').parents, [mine.id]);
  assert.match(t.g.docText(t.chapterDoc('c1').id), /It poured/);
});

test('nothing changed: nothing written', async () => {
  const t = setup();
  await t.sync();
  const w = t.g.calls.write;
  const r = await t.sync();
  assert.strictEqual(t.g.calls.write, w);
  assert.deepStrictEqual([r.pulls.length, r.conflicts.length, r.pushed], [0, 0, 0]);
});

test('typing in NEO updates that chapter and the master, and no other Doc', async () => {
  const t = setup();
  await t.sync();
  const c2Before = t.g.docText(t.chapterDoc('c2').id);
  t.entries[0].blocks[2] = p('Mara counted coins twice.');
  const r = await t.sync();
  assert.strictEqual(r.pushed, 2);
  assert.match(t.g.docText(t.chapterDoc('c1').id), /Mara counted coins twice\./);
  assert.match(t.g.docText(t.master().id), /Mara counted coins twice\./);
  assert.strictEqual(t.g.docText(t.chapterDoc('c2').id), c2Before);
});

test('an edit made in a chapter Doc comes back to NEO', async () => {
  const t = setup();
  await t.sync();
  const id = t.chapterDoc('c2').id;
  await t.g.typeInDoc(id, t.g.findText(id, 'cold'), 'very ');
  const r = await t.sync();
  assert.strictEqual(r.pulls.length, 1);
  assert.strictEqual(r.pulls[0].chId, 'c2');
  assert.deepStrictEqual(r.pulls[0].blocks.map((b) => b.text), ['The house was very cold.']);
  // NEO takes it in; the next sync agrees and the master follows
  t.entries[1].blocks = r.pulls[0].blocks;
  const r2 = await t.sync();
  assert.deepStrictEqual([r2.pulls.length, r2.conflicts.length], [0, 0]);
  assert.match(t.g.docText(t.master().id), /very cold/);
});

test('edited in both places: NEO keeps its text, the Doc\'s comes back as a conflict', async () => {
  const t = setup();
  await t.sync();
  const id = t.chapterDoc('c2').id;
  await t.g.typeInDoc(id, t.g.findText(id, 'cold'), 'bitterly ');
  t.entries[1].blocks = [p('The house was warm.')];
  const r = await t.sync();
  assert.strictEqual(r.conflicts.length, 1);
  assert.deepStrictEqual(r.conflicts[0].blocks.map((b) => b.text), ['The house was bitterly cold.']);
  assert.match(t.g.docText(id), /The house was warm\./);
  // and the conflict is not raised a second time
  const r2 = await t.sync();
  assert.strictEqual(r2.conflicts.length, 0);
});

test('an edit in the Master Manuscript is undone, with a comment saying where it belongs', async () => {
  const t = setup();
  await t.sync();
  const id = t.master().id;
  await t.g.typeInDoc(id, t.g.findText(id, 'harbor'), 'old ');
  const r = await t.sync();
  assert.strictEqual(r.masterEdits.length, 1);
  assert.strictEqual(r.masterEdits[0].name, 'Chapter 1 — Cold Front');
  assert.strictEqual(r.masterEdits[0].after, 'It rained on the old harbor.');
  assert.doesNotMatch(t.g.docText(id), /old harbor/);
  const comments = (await t.g.listComments(id)).filter((c) => /^Edit undone/.test(c.content));
  assert.strictEqual(comments.length, 1);
  assert.match(comments[0].content, /Make this change in NEO or in the “Chapter 1 — Cold Front” Doc/);
  assert.match(comments[0].content, /Your change: “It rained on the old harbor\.”/);
  // NEO's text never changed
  assert.strictEqual(r.pulls.length, 0);
  const r2 = await t.sync();
  assert.strictEqual(r2.masterEdits.length, 0);
});

test('a chapter deleted in NEO moves to "Deleted chapters", never deleted', async () => {
  const t = setup();
  await t.sync();
  const id = t.chapterDoc('c2').id;
  t.entries.splice(1, 1);
  await t.sync();
  const doc = t.g.files.get(id);
  const deleted = t.files().find((f) => f.name === 'The Lighthouse Deleted Chapters');
  assert.ok(deleted, 'Deleted Chapters folder');
  assert.deepStrictEqual(doc.parents, [deleted.id]);
  assert.strictEqual(doc.trashed, false);
  assert.match(doc.name, /^1\.2: The Keeper’s House \(deleted \d{4}-\d\d-\d\d\)$/);
  assert.doesNotMatch(t.g.docText(t.master().id), /house was cold/);
});

test('a new chapter gets its Doc; renumbered chapters are renamed', async () => {
  const t = setup();
  await t.sync();
  t.entries.splice(1, 0, { chId: 'c15', kind: 'chapter', heading: 'Chapter 2 — Inserted', name: 'Chapter 2 — Inserted', label: 'Inserted', section: 1, blocks: [p('New.')] });
  await t.sync();
  assert.strictEqual(t.chapterDoc('c15').name, '1.2: Inserted');
  assert.strictEqual(t.chapterDoc('c2').name, '1.3: The Keeper’s House');
});

test('a computer that forgot everything adopts the Docs instead of making new ones', async () => {
  const t = setup();
  await t.sync();
  const count = t.g.files.size;
  const fresh = new Sync({ api: t.g, dir: tmpDir() });
  const r = await fresh.run({ book: t.book, entries: t.entries, dirty: true });
  assert.strictEqual(t.g.files.size, count);
  assert.deepStrictEqual([r.created, r.conflicts.length, r.pulls.length], [0, 0, 0]);
});

test('offline: the sync fails cleanly and catches up afterwards', async () => {
  const t = setup();
  await t.sync();
  t.g.offline = true;
  t.entries[0].blocks[0] = p('It poured on the harbor.');
  await assert.rejects(t.sync(), (e) => e.offline);
  t.g.offline = false;
  await t.sync();
  assert.match(t.g.docText(t.chapterDoc('c1').id), /It poured/);
});

test('both edited while offline: both versions kept', async () => {
  const t = setup();
  await t.sync();
  const id = t.chapterDoc('c1').id;
  t.g.offline = true;
  t.entries[0].blocks[2] = p('Mara counted nothing.');
  await assert.rejects(t.sync(), (e) => e.offline);
  t.g.offline = false;
  await t.g.typeInDoc(id, t.g.findText(id, 'coins'), 'silver ');
  const r = await t.sync();
  assert.strictEqual(r.conflicts.length, 1);
  assert.match(r.conflicts[0].blocks.map((b) => b.text).join(' '), /silver coins/);
  assert.match(t.g.docText(id), /Mara counted nothing\./);
});

test('a Doc edited in the instant between reading and writing is not written over', async () => {
  const t = setup();
  await t.sync();
  const id = t.chapterDoc('c2').id;
  t.entries[1].blocks = [p('The house was warm.')];
  // someone types just after NEO reads the Doc
  const realGet = t.g.getDoc.bind(t.g);
  let once = true;
  t.g.getDoc = async (docId) => {
    const d = await realGet(docId);
    if (docId === id && once) { once = false; await t.g.typeInDoc(id, t.g.findText(id, 'house'), 'old '); }
    return d;
  };
  await t.sync(); // refused; nothing lost
  assert.match(t.g.docText(id), /old house/);
  t.g.getDoc = realGet;
  const r = await t.sync();
  assert.strictEqual(r.conflicts.length, 1);
  assert.match(r.conflicts[0].blocks[0].text, /old house was cold/);
});

test('folder names: title, subtitle, or both', () => {
  const b = { title: 'The Lighthouse', subtitle: 'Book One' };
  assert.strictEqual(bookName(b, 'title'), 'The Lighthouse');
  assert.strictEqual(bookName(b, 'subtitle'), 'Book One');
  assert.strictEqual(bookName(b, 'both'), 'The Lighthouse: Book One');
  assert.strictEqual(bookName({ title: 'Solo' }, 'subtitle'), 'Solo'); // no subtitle: the title
});

test('the Master Manuscript has its own naming choice', async () => {
  const t = setup();
  t.book.nameBy = 'both';
  t.book.masterNameBy = 'title';
  await t.sync();
  assert.strictEqual(t.files().find((f) => f.mimeType.includes('folder') && !f.appProperties.neoRole).name, 'The Lighthouse: Book One');
  assert.strictEqual(t.master().name, 'The Lighthouse');
  t.book.masterNameBy = 'subtitle';
  await t.sync();
  assert.strictEqual(t.master().name, 'Book One');
});

test('changing how folders are named renames the folder and the Master', async () => {
  const t = setup();
  await t.sync();
  t.book.nameBy = 'both';
  await t.sync();
  const folder = t.files().find((f) => f.mimeType.includes('folder'));
  assert.strictEqual(folder.name, 'The Lighthouse: Book One');
  assert.strictEqual(t.master().name, 'The Lighthouse: Book One');
  t.book.nameBy = 'subtitle';
  await t.sync();
  assert.strictEqual(t.files().find((f) => f.id === folder.id).name, 'Book One');
});

test('the reading-copy note is posted once, and never again after it is resolved', async () => {
  const t = setup();
  await t.sync();
  const id = t.master().id;
  t.g.comments.get(id).forEach((c) => { c.resolved = true; });
  t.entries[0].blocks[0] = p('It poured on the harbor.');
  await t.sync();
  await t.sync();
  assert.strictEqual((await t.g.listComments(id)).length, 1);
});

test('a Master from before (note in its page header) loses the header and gets the comment', async () => {
  const t = setup();
  await t.sync();
  const id = t.master().id;
  // as 1.4.4–1.4.8 made it
  const r = await t.g.batchUpdate(id, [{ createHeader: { type: 'DEFAULT' } }]);
  const hid = r.replies[0].createHeader.headerId;
  await t.g.batchUpdate(id, [{ insertText: { location: { segmentId: hid, index: 0 }, text: 'Reading copy — comments welcome. Edits made here are undone automatically.' } }]);
  t.g.comments.set(id, []);
  const file = path.join(t.s.dir, 'books', 'book-uuid-1.json');
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete st.headerChecked; delete st.noteDone;
  fs.writeFileSync(file, JSON.stringify(st));
  await t.sync();
  assert.deepStrictEqual(Object.keys((await t.g.getDoc(id)).headers), []);
  assert.strictEqual((await t.g.listComments(id)).length, 1);
  await t.sync();
  assert.strictEqual((await t.g.listComments(id)).length, 1);
});

test('a Master set in an older look is set again, whole', async () => {
  const t = setup();
  await t.sync();
  const id = t.master().id;
  const file = path.join(t.s.dir, 'books', 'book-uuid-1.json');
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.masterStyle = 1;
  fs.writeFileSync(file, JSON.stringify(st));
  // an old-look paragraph: Georgia
  const d = t.g.docs.get(id);
  d.chars.forEach((c) => { c.ts.weightedFontFamily = { fontFamily: 'Georgia' }; });
  await t.sync();
  assert.ok(t.g.docs.get(id).chars.filter((c) => c.c !== '\n').every((c) => c.ts.weightedFontFamily.fontFamily === 'Times New Roman'));
  const w = t.g.calls.write;
  await t.sync();
  assert.strictEqual(t.g.calls.write, w, 'only once');
});

test('Docs numbered by part: 0.1: Epigraph, 0.2: Prologue, 1.1: The Keeper’s House', async () => {
  const t = setup();
  const parts = [{ partId: 'p1', name: 'Part I: The Crossing' }];
  t.entries.splice(0, t.entries.length,
    { chId: 'e', kind: 'epigraph', heads: [], name: 'Epigraph', label: 'Epigraph', section: 0, blocks: [p('A saying.')] },
    { chId: 'pro', kind: 'prologue', heading: 'Prologue', name: 'Prologue', label: 'Prologue', section: 0, blocks: [p('Before.')] },
    { chId: 'c1', kind: 'chapter', heading: 'Chapter 1: The Keeper’s House', name: 'Chapter 1: The Keeper’s House', label: 'The Keeper’s House', section: 1, part: 'p1', blocks: [p('Mara.')] },
    { chId: 'c2', kind: 'chapter', heading: 'Chapter 2: Cold Front', name: 'Chapter 2: Cold Front', label: 'Cold Front', section: 1, part: 'p1', blocks: [p('Rain.')] },
    { chId: 'ep', kind: 'epilogue', heading: 'Epilogue', name: 'Epilogue', label: 'Epilogue', section: 2, blocks: [p('After.')] });
  await t.sync({ parts });
  assert.deepStrictEqual(['e', 'pro', 'c1', 'c2', 'ep'].map((id) => t.chapterDoc(id).name), ['0.1: Epigraph', '0.2: Prologue', '1.1: The Keeper’s House', '1.2: Cold Front', '2.1: Epilogue']);
});

test('an old "Deleted chapters" folder inside Chapters is renamed and moved beside the book, once', async () => {
  const t = setup();
  await t.sync();
  t.entries.splice(1, 1);
  await t.sync(); // makes the deleted folder
  const deleted = t.files().find((f) => f.appProperties.neoRole === 'deleted');
  const chapters = t.files().find((f) => f.appProperties.neoRole === 'chapters');
  // as 1.4.8–1.4.101 left it
  const d = t.g.files.get(deleted.id);
  d.parents = [chapters.id]; d.name = 'Deleted chapters';
  const file = path.join(t.s.dir, 'books', 'book-uuid-1.json');
  const st = JSON.parse(fs.readFileSync(file, 'utf8')); delete st.deletedPlaced; fs.writeFileSync(file, JSON.stringify(st));
  await t.sync();
  assert.strictEqual(t.g.files.get(deleted.id).name, 'The Lighthouse Deleted Chapters');
  assert.ok(!t.g.files.get(deleted.id).parents.includes(chapters.id));
  // moved by hand into Chapters again: left there
  t.g.files.get(deleted.id).parents = [chapters.id];
  await t.sync();
  assert.deepStrictEqual(t.g.files.get(deleted.id).parents, [chapters.id]);
});
