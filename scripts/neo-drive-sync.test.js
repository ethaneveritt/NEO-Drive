// NEO-Drive: the sync engine (neo-drive/sync.js) against the Google stand-in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../neo-drive/blocks.js');
const { Sync } = require('../neo-drive/sync.js');
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
    { chId: 'c1', kind: 'chapter', heading: 'Chapter 1 — Cold Front', name: 'Chapter 1 — Cold Front', blocks: [p('It rained on the harbor.'), brk(), p('Mara counted coins.')] },
    { chId: 'c2', kind: 'chapter', heading: 'Chapter 2 — The Keeper’s House', name: 'Chapter 2 — The Keeper’s House', blocks: [p('The house was cold.')] }
  ];
  const sync = (over = {}) => { clock += 20000; return s.run({ book, entries, dirty: true, ...over }); };
  const files = () => [...g.files.values()];
  const chapterDoc = (chId) => files().find((f) => f.appProperties.neoChapter === chId);
  const master = () => files().find((f) => f.appProperties.neoRole === 'master');
  return { g, s, book, entries, sync, files, chapterDoc, master, tick: (ms) => { clock += ms; } };
}

test('first sync makes a folder, a Master Manuscript, and a Doc per chapter', async () => {
  const t = setup();
  const r = await t.sync();
  assert.strictEqual(r.created, 3);
  const folder = t.files().find((f) => f.mimeType.includes('folder'));
  assert.strictEqual(folder.name, 'The Lighthouse');
  assert.strictEqual(t.chapterDoc('c1').name, '01 · Chapter 1 — Cold Front');
  assert.strictEqual(t.chapterDoc('c2').name, '02 · Chapter 2 — The Keeper’s House');
  assert.strictEqual(t.master().name, 'The Lighthouse — Master Manuscript');
  assert.ok(t.chapterDoc('c1').parents.includes(folder.id));
  const c1 = B.fromDoc(await t.g.getDoc(t.chapterDoc('c1').id));
  assert.deepStrictEqual(c1.map((b) => b.k), ['chapter', 'p', 'brk', 'p']);
  const m = B.fromDoc(await t.g.getDoc(t.master().id));
  assert.deepStrictEqual(m.map((b) => b.text), ['The Lighthouse', 'Book One', 'by Ethan Everitt', 'Chapter 1 — Cold Front', 'It rained on the harbor.', '***', 'Mara counted coins.', 'Chapter 2 — The Keeper’s House', 'The house was cold.']);
  // the reading-copy reminder in the header
  const hdr = Object.values((await t.g.getDoc(t.master().id)).headers)[0];
  assert.match(hdr.content[0].paragraph.elements[0].textRun.content, /Reading copy/);
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
  const comments = await t.g.listComments(id);
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
  const deleted = t.files().find((f) => f.name === 'Deleted chapters');
  assert.ok(deleted, 'Deleted chapters folder');
  assert.deepStrictEqual(doc.parents, [deleted.id]);
  assert.strictEqual(doc.trashed, false);
  assert.match(doc.name, /^Chapter 2 — The Keeper’s House \(deleted \d{4}-\d\d-\d\d\)$/);
  assert.doesNotMatch(t.g.docText(t.master().id), /house was cold/);
});

test('a new chapter gets its Doc; renumbered chapters are renamed', async () => {
  const t = setup();
  await t.sync();
  t.entries.unshift({ chId: 'c0', kind: 'prologue', heading: 'Prologue', name: 'Prologue', blocks: [p('Before.')] });
  await t.sync();
  assert.strictEqual(t.chapterDoc('c0').name, '01 · Prologue');
  assert.strictEqual(t.chapterDoc('c1').name, '02 · Chapter 1 — Cold Front');
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
