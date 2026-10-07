// NEO-Drive: Google Drive sync, end to end inside NEO, against the Google
// stand-in (NEO_DRIVE_FAKE). A throwaway library, as in words.e2e.js.
// Run: npx electron scripts/neo-drive-sync.e2e.js
'use strict';

process.env.NEO_DRIVE_FAKE = '1';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-drive-sync-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
const LIB = path.join(tmp, 'NEO Library');
fs.mkdirSync(LIB);
fs.writeFileSync(path.join(LIB, 'library.json'), JSON.stringify({
  authorName: 'Ethan Everitt', penNames: [], firstRunDone: true, pageTheme: 'night',
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
const fake = (msg) => js(`window.neo.neoDrive({ op: 'fake', ...${JSON.stringify(msg)} })`);
const sync = async () => { const r = await js('NeoDrive.tick(true)'); await tick(400); return r; };
const files = () => fake({ do: 'files' });
const docFor = async (chId) => (await files()).find((f) => f.appProperties.neoChapter === chId);
const master = async () => (await files()).find((f) => f.appProperties.neoRole === 'master');
const chIds = () => js('book.chapterOrder.slice()');
const chapterText = (chId) => js(`document.querySelector('.chapter[data-id="${chId}"] .chapter-body').textContent`);
const diskText = (chId) => {
  const dir = fs.readdirSync(LIB).find((n) => n.startsWith('book-'));
  return fs.readFileSync(path.join(LIB, dir, 'chapters', chId + '.html'), 'utf8');
};
// type at the end of a chapter's first paragraph, the way a person does
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

test('the Google Drive menu sits before Help and shows the account', async () => {
  const { Menu } = require('electron');
  const labels = Menu.getApplicationMenu().items.map((i) => i.label);
  const at = labels.indexOf('Google Drive');
  assert.ok(at >= 0, labels.join(', '));
  assert.ok(at < labels.indexOf('Help'));
  const sub = Menu.getApplicationMenu().items[at].submenu.items.map((i) => i.label);
  assert.ok(sub.includes('Connected as test@example.com'), sub.join(', '));
  assert.ok(sub.includes('Sync Now'));
});

test('first sync: a folder, a Master Manuscript and a Doc per chapter', async () => {
  const r = await sync();
  assert.ok(r && r.ok, JSON.stringify(r));
  const all = await files();
  assert.equal(all.filter((f) => f.mimeType.includes('folder')).length, 1);
  assert.ok(await master());
  for (const id of await chIds()) assert.ok(await docFor(id), 'Doc for ' + id);
  const [c1] = await chIds();
  const text = await fake({ do: 'text', id: (await docFor(c1)).id });
  assert.match(text, /^Chapter 1 — Cold Front\nIt rained on the harbor\.\n\*\*\*\nMara counted coins\.\n/);
});

test('typing in NEO reaches the chapter Doc and the Master', async () => {
  const [c1] = await chIds();
  await typeInNeo(c1, ' Again.');
  await sync();
  assert.match(await fake({ do: 'text', id: (await docFor(c1)).id }), /harbor\. Again\./);
  assert.match(await fake({ do: 'text', id: (await master()).id }), /harbor\. Again\./);
});

test('italics made in NEO arrive as italics', async () => {
  const [, c2] = await chIds();
  await js(`(() => {
    const p = document.querySelector('.chapter[data-id="${c2}"] .chapter-body p');
    p.closest('.chapter-body').focus();
    const r = document.createRange(); r.setStart(p.firstChild, 4); r.setEnd(p.firstChild, 9);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  })()`);
  wc.send('menu', { type: 'nd-format', cmd: 'italic' });
  await tick(200);
  await js('flushAllSaves()');
  await tick(300);
  await sync();
  const model = await js('NeoDrive.model()');
  const b = model.entries.find((e) => e.chId === c2).blocks[0];
  assert.deepEqual(b.marks, [[4, 9, 'i']]);
});

test('an edit made in a chapter Doc comes into NEO, on the page and on disk', async () => {
  const [, c2] = await chIds();
  await fake({ do: 'type', id: (await docFor(c2)).id, before: 'cold', text: 'very ' });
  await sync();
  await tick(600);
  assert.match(await chapterText(c2), /very cold/);
  assert.match(diskText(c2), /very cold/);
  // and the italics NEO had stayed
  assert.match(diskText(c2), /<i>house<\/i>/);
});

test('edited in both places: version N and version G', async () => {
  const [c1] = await chIds();
  await fake({ do: 'type', id: (await docFor(c1)).id, before: 'Mara', text: 'Little ' });
  await typeInNeo(c1, ' Still raining.');
  await sync();
  await tick(600);
  const titles = await js('book.chapterTitles');
  const order = await chIds();
  assert.match(titles[c1], /\(version N\)$/);
  const twin = order[order.indexOf(c1) + 1];
  assert.match(titles[twin], /\(version G — Google Docs, /);
  assert.match(await chapterText(twin), /Little Mara/);
  assert.doesNotMatch(await chapterText(c1), /Little Mara/);
  // the twin gets its own Doc on the next round
  await sync();
  assert.ok(await docFor(twin));
});

test('an edit in the Master Manuscript is undone and shown in NEO', async () => {
  const m = await master();
  await fake({ do: 'type', id: m.id, before: 'house', text: 'haunted ' });
  await sync();
  assert.doesNotMatch(await fake({ do: 'text', id: m.id }), /haunted/);
  const comments = await fake({ do: 'comments', id: m.id });
  assert.equal(comments.length, 1);
  assert.ok(await js(`!!document.querySelector('.nd-master')`), 'the window shows what was undone');
  assert.match(await js(`document.querySelector('.nd-master').textContent`), /haunted house/);
  await js(`document.querySelector('.nd-master .m-ok').click()`);
});

test('a chapter deleted in NEO goes to "Deleted chapters" in Drive', async () => {
  const order = await chIds();
  const last = order[order.length - 1];
  const doc = await docFor(last);
  await js(`deleteChapterQuiet(${JSON.stringify(last)})`);
  await tick(300);
  await sync();
  const all = await files();
  const deleted = all.find((f) => f.name === 'Deleted chapters');
  assert.ok(deleted);
  assert.deepEqual(all.find((f) => f.id === doc.id).parents, [deleted.id]);
});

async function main() {
  await app.whenReady();
  let failed = 0;
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    wc = win.webContents;
    while (!(await js(`typeof library !== 'undefined' && !!library && !!window.NeoDrive`).catch(() => false))) await tick(50);
    await tick(300);
    await js(`(async () => {
      document.getElementById('firstrun').hidden = true;
      await addImportedBooks([{ name: 'The Lighthouse', chapters: [
        { title: 'Cold Front', paras: [{ text: 'It rained on the harbor.' }, { text: '***' }, { text: 'Mara counted coins.' }] },
        { title: 'The Keeper’s House', paras: [{ text: 'The house was cold.' }] },
        { title: 'The Labyrinth', paras: [{ text: 'Dark.' }] }
      ] }], library.shelves[0]);
      const ids = library.shelves[0].bookIds;
      await openBook(ids[ids.length - 1]);
    })()`);
    await tick(800);
    // the stand-in counts as signed in
    await js(`window.neo.neoDrive({ op: 'status' }).then((s) => s)`);
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
