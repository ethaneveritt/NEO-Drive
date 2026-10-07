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
  assert.ok(sub.includes('Name the Master Manuscript By'));
  assert.ok(!sub.includes('Number Chapter Docs'));
  const naming = Menu.getApplicationMenu().items[at].submenu.items.find((i) => i.label === 'Name Book Folders By');
  assert.deepEqual(naming.submenu.items.map((i) => [i.label, i.checked]), [['Title', true], ['Subtitle', false], ['Title: Subtitle', false]]);
});

test('first sync: a folder, a Master Manuscript and a Doc per chapter', async () => {
  const r = await sync();
  assert.ok(r && r.ok, JSON.stringify(r));
  const all = await files();
  assert.equal(all.filter((f) => f.mimeType.includes('folder') && !f.appProperties.neoRole).length, 1);
  assert.ok(all.find((f) => f.appProperties.neoRole === 'chapters'), 'Chapters folder');
  assert.ok(await master());
  for (const id of await chIds()) assert.ok(await docFor(id), 'Doc for ' + id);
  // named by part (a book without parts: its chapters are part 1)
  assert.deepEqual((await Promise.all((await chIds()).map(docFor))).map((d) => d.name), ['1.1: Cold Front', '1.2: The Keeper’s House', '1.3: The Labyrinth']);
  const [c1] = await chIds();
  const text = await fake({ do: 'text', id: (await docFor(c1)).id });
  assert.match(text, /^Chapter 1: Cold Front\nIt rained on the harbor\.\n\*\*\*\nMara counted coins\.\n/);
});

test('the Doc is set like the manuscript: TNR 12, double-spaced, bold heading, italic title', async () => {
  const [c1] = await chIds();
  const doc = await fake({ do: 'doc', id: (await docFor(c1)).id });
  const paras = doc.body.content.filter((e) => e.paragraph);
  const [head, body, brk] = paras;
  const runs = head.paragraph.elements.filter((e) => e.textRun.content !== '\n').map((e) => [e.textRun.content.replace(/\n$/, ''), !!e.textRun.textStyle.bold, !!e.textRun.textStyle.italic, e.textRun.textStyle.fontSize.magnitude]);
  assert.deepEqual(runs, [['Chapter 1: ', true, false, 12], ['Cold Front', true, true, 12]]);
  assert.equal(head.paragraph.paragraphStyle.alignment, 'CENTER');
  assert.equal(head.paragraph.paragraphStyle.pageBreakBefore, false);
  const ps = body.paragraph.paragraphStyle;
  assert.deepEqual([ps.lineSpacing, ps.indentFirstLine.magnitude, ps.alignment], [200, 36, 'START']);
  const ts = body.paragraph.elements[0].textRun.textStyle;
  assert.deepEqual([ts.weightedFontFamily.fontFamily, ts.fontSize.magnitude, ts.bold], ['Times New Roman', 12, false]);
  assert.equal(brk.paragraph.elements.map((x) => x.textRun.content).join(''), '***\n');
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
  const comments = (await fake({ do: 'comments', id: m.id })).filter((c) => /^Edit undone/.test(c.content));
  assert.equal(comments.length, 1);
  assert.ok(await js(`!!document.querySelector('.nd-master')`), 'the window shows what was undone');
  assert.match(await js(`document.querySelector('.nd-master').textContent`), /haunted house/);
  await js(`document.querySelector('.nd-master .m-ok').click()`);
});

test('Name Book Folders By → Title: Subtitle renames the folder', async () => {
  await js(`book.subtitle = 'Book One'; saveMeta()`);
  const { Menu } = require('electron');
  const gd = Menu.getApplicationMenu().items.find((i) => i.label === 'Google Drive');
  gd.submenu.items.find((i) => i.label === 'Name Book Folders By').submenu.items.find((i) => i.label === 'Title: Subtitle').click();
  await tick(300);
  await sync();
  const folder = (await files()).find((f) => f.mimeType.includes('folder') && !f.appProperties.neoRole);
  assert.equal(folder.name, 'The Lighthouse: Book One');
  assert.equal((await master()).name, 'The Lighthouse: Book One');
});

const toggle = (m) => js(`document.querySelector('#nd-dock .nd-bar button[data-m="${m}"]').click()`);
const cards = () => js(`[...document.querySelectorAll('#nd-margin .nd-card')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim())`);

test('Google Docs comments sit in the margin beside their passage, highlighted; clicking Comments again puts them away', async () => {
  const [c1] = await chIds();
  const doc = await docFor(c1);
  await fake({ do: 'readerComment', id: doc.id, comment: { content: 'Love this line.', quote: 'rained on the harbor', author: 'Faye', replies: [{ content: 'Same!', author: 'Sam' }] } });
  await sync();
  assert.equal(await js(`document.querySelector('#nd-dock').hidden`), false);
  assert.match(await js(`document.querySelector('#nd-dock [data-m="comments"]').textContent`), /Comments\s*1/);
  await toggle('comments');
  await tick(300);
  const [card] = await cards();
  assert.match(card, /Faye/);
  assert.match(card, /Love this line\./);
  assert.match(card, /Same!/);
  assert.match(card, /Resolve/);
  assert.doesNotMatch(card, /Edit/, 'not mine: no Edit');
  assert.equal(await js(`CSS.highlights.get('nd-comment').size + CSS.highlights.get('nd-comment-active').size`), 1);
  assert.equal(await js(`[...CSS.highlights.get('nd-comment')][0].toString()`), 'rained on the harbor');
  // level with its words, to the right of the page
  const pos = await js(`(() => {
    const r = [...CSS.highlights.get('nd-comment')][0].getClientRects()[0];
    const c = document.querySelector('#nd-margin .nd-card').getBoundingClientRect();
    const page = document.getElementById('paper').getBoundingClientRect();
    return { dy: Math.abs(c.top - r.top), right: c.left >= page.right };
  })()`);
  assert.ok(pos.dy < 3, JSON.stringify(pos));
  assert.ok(pos.right, 'beside the page');
  if (process.env.SHOT) fs.writeFileSync(process.env.SHOT, (await wc.capturePage()).toPNG());
  await toggle('comments');
  await tick(500);
  assert.equal(await js(`document.getElementById('nd-margin').hidden`), true);
  assert.equal(await js(`CSS.highlights.has('nd-comment')`), false);
  await toggle('comments');
  await tick(300);
  await js(`document.querySelector('#nd-margin .nd-card .resolve').click()`);
  await tick(500);
  assert.deepEqual(await cards(), []);
  const all = await fake({ do: 'comments', id: doc.id });
  assert.equal(all.find((c) => c.content === 'Love this line.').resolved, true);
});

test('select words, Add Comment: it goes to the chapter Doc, and is yours to edit', async () => {
  const [c1] = await chIds();
  const doc = await docFor(c1);
  await js(`(() => {
    const p = [...document.querySelectorAll('.chapter[data-id="${c1}"] .chapter-body p')].find((x) => x.textContent.startsWith('Mara'));
    p.closest('.chapter-body').focus();
    const r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 'Mara counted coins'.length);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  })()`);
  wc.send('menu', { type: 'nd-addComment' });
  await tick(300);
  assert.equal(await js(`document.activeElement === document.querySelector('#nd-margin .nd-draft textarea')`), true);
  await js(`document.execCommand('insertText', false, 'How many coins?')`);
  await js(`document.querySelector('#nd-margin .nd-draft .go').click()`);
  await tick(500);
  let mine = (await fake({ do: 'comments', id: doc.id })).find((c) => c.content === 'How many coins?');
  assert.ok(mine, 'in the Doc');
  assert.equal(mine.quotedFileContent.value, 'Mara counted coins');
  const card = (await cards()).find((c) => /How many coins/.test(c));
  assert.match(card, /You/);
  assert.match(card, /Edit/);
  if (process.env.SHOT) fs.writeFileSync(process.env.SHOT.replace(/\.png$/, '-add.png'), (await wc.capturePage()).toPNG());
  await js(`[...document.querySelectorAll('#nd-margin .nd-card')].find((c) => /How many coins/.test(c.textContent)).querySelector('.edit').click()`);
  await tick(100);
  await js(`(() => { const ta = document.querySelector('#nd-margin .nd-card textarea'); ta.value = 'How many coins, exactly?'; ta.closest('.nd-card').querySelector('.go').click(); })()`);
  await tick(500);
  mine = (await fake({ do: 'comments', id: doc.id })).find((c) => c.id === mine.id);
  assert.equal(mine.content, 'How many coins, exactly?');
  assert.ok((await cards()).some((c) => /How many coins, exactly\?/.test(c)));
});

test('the Notes tab: Notepad on top, Comments listed with Jump to comment', async () => {
  await js(`switchTab('notes')`);
  await tick(400);
  assert.deepEqual(await js(`[...document.querySelectorAll('#nd-notes-head button')].map((b) => [b.textContent, b.classList.contains('on')])`),
    [['Notepad', true], ['Comments', false], ['Chapter Notes', false]]);
  assert.equal(await js(`document.getElementById('aux-editor').hidden`), false);
  assert.equal(await js(`document.getElementById('nd-dock').hidden`), true, 'the dock belongs to the manuscript');
  await js(`document.querySelector('#nd-notes-head [data-v="comments"]').click()`);
  await tick(200);
  assert.equal(await js(`document.getElementById('aux-editor').hidden`), true);
  const list = await js(`document.querySelector('.nd-list').textContent.replace(/\\s+/g, ' ')`);
  assert.match(list, /Chapter 1/);
  assert.match(list, /Mara counted coins/);
  assert.match(list, /Jump to comment/);
  await js(`document.querySelector('.nd-list .nd-item .go').click()`);
  await tick(400);
  assert.equal(await js('currentTab'), 'manuscript');
  assert.equal(await js('NeoDrivePanels.mode'), 'comments');
  assert.match(await js(`document.querySelector('#nd-margin .nd-card.active').textContent`), /How many coins/);
  // leaving and coming back to Notes opens the Notepad again, and Outline shows its own title
  await js(`switchTab('outline')`);
  await tick(200);
  assert.equal(await js(`document.getElementById('nd-notes-head').hidden`), true);
  assert.equal(await js(`document.getElementById('aux-title').hidden`), false);
  await js(`switchTab('manuscript')`);
  await tick(200);
});

test('Chapter Notes and Notepad open beside the page, one at a time, and go to a Notes folder in Drive', async () => {
  const [c1] = await chIds();
  await toggle('chapter');
  await tick(200);
  assert.equal(await js(`document.getElementById('nd-margin').hidden`), true, 'one at a time');
  assert.equal(await js(`document.getElementById('nd-panel').hidden`), false);
  await js(`document.querySelector('.chapter[data-id="${c1}"] .chapter-body').focus()`);
  await tick(500);
  assert.match(await js(`document.querySelector('#nd-panel b').textContent`), /Cold Front/);
  await js(`(() => { const ta = document.querySelector('#nd-panel textarea'); ta.focus(); document.execCommand('insertText', false, 'Make the rain colder.'); })()`);
  await tick(800);
  assert.deepEqual(await js(`window.neo.readJSON(book.id, 'neo-drive-chapter-notes', {})`), { [c1]: 'Make the rain colder.' });
  await toggle('notepad');
  await tick(300);
  assert.equal(await js(`document.querySelector('#nd-panel textarea')`), null);
  await js(`(() => { const box = document.querySelector('#nd-panel .nd-pad'); box.focus(); document.execCommand('insertText', false, 'Idea one.'); })()`);
  await tick(1000);
  assert.match(await js(`window.neo.readAux(book.id, 'notes')`), /Idea one\./);
  if (process.env.SHOT) fs.writeFileSync(process.env.SHOT.replace(/\.png$/, '-notepad.png'), (await wc.capturePage()).toPNG());
  await toggle('notepad');
  await tick(200);
  assert.equal(await js(`document.getElementById('nd-panel').hidden`), true);
  await sync();
  const all = await files();
  const notes = all.find((f) => f.appProperties.neoRole === 'notes');
  const folder = all.find((f) => f.mimeType.includes('folder') && !f.appProperties.neoRole);
  assert.equal(notes.name, 'Notes');
  assert.deepEqual(notes.parents, [folder.id], 'in the book folder, not Chapters');
  const byKey = async (k) => fake({ do: 'noteDoc', key: k });
  assert.match(await fake({ do: 'text', id: (await byKey('notepad')).id }), /Idea one\./);
  assert.match(await fake({ do: 'text', id: (await byKey('chapternotes')).id }), /1\.1: Cold Front[^\n]*\nMake the rain colder\.\n/);
  assert.ok(await byKey('darlings'));
});

test('notes written in the Docs come back into NEO', async () => {
  const [c1] = await chIds();
  const pad = await fake({ do: 'noteDoc', key: 'notepad' });
  await fake({ do: 'type', id: pad.id, before: 'Idea one.', text: 'Idea zero.\n' });
  const cn = await fake({ do: 'noteDoc', key: 'chapternotes' });
  await fake({ do: 'type', id: cn.id, before: 'Make the rain colder.', text: 'Mara needs a limp.\n' });
  await sync();
  await tick(300);
  const html = await js(`window.neo.readAux(book.id, 'notes')`);
  assert.match(html, /Idea zero\.[\s\S]*Idea one\./);
  assert.equal(await js(`window.neo.readJSON(book.id, 'neo-drive-chapter-notes', {})`).then((v) => v[c1]), 'Mara needs a limp.\nMake the rain colder.');
  await js(`switchTab('notes')`);
  await tick(400);
  assert.match(await js(`document.getElementById('aux-editor').textContent`), /Idea zero\./);
  await js(`document.querySelector('#nd-notes-head [data-v="chapter"]').click()`);
  await tick(200);
  assert.equal(await js(`document.querySelector('.nd-list textarea').value`), 'Mara needs a limp.\nMake the rain colder.');
  await js(`switchTab('manuscript')`);
  await tick(200);
});

test('the dock: NEO\'s Notes & Comments pane gives way to it; it tucks into the edge; the page makes room, and narrows in a small window', async () => {
  assert.equal(await js(`getComputedStyle(document.getElementById('side-pane')).display`), 'none');
  assert.equal(await js(`getComputedStyle(document.getElementById('side-hotzone')).display`), 'none');
  // tuck away: only the arrow stays
  await js(`document.querySelector('#nd-dock .nd-arrow').click()`);
  await tick(200);
  assert.equal(await js(`getComputedStyle(document.querySelector('#nd-dock .nd-bar')).display`), 'none');
  assert.notEqual(await js(`getComputedStyle(document.querySelector('#nd-dock .nd-tab')).display`), 'none');
  await js(`document.querySelector('#nd-dock .nd-tab').click()`);
  await tick(200);
  assert.notEqual(await js(`getComputedStyle(document.querySelector('#nd-dock .nd-bar')).display`), 'none');
  const win = BrowserWindow.getAllWindows()[0];
  const was = win.getSize();
  for (const w of [1400, 900, 700]) {
    win.setSize(w, 800);
    await tick(300);
    await toggle('notepad');
    await tick(500);
    const g = await js(`(() => {
      const page = document.getElementById('paper').getBoundingClientRect();
      const dock = document.getElementById('nd-dock').getBoundingClientRect();
      return { pageRight: page.right, pageLeft: page.left, dockLeft: dock.left, dockW: dock.width, vw: innerWidth };
    })()`);
    assert.ok(g.pageRight <= g.dockLeft + 1, 'page beside the dock at ' + w + ': ' + JSON.stringify(g));
    assert.ok(g.pageLeft >= 0, 'page on screen at ' + w + ': ' + JSON.stringify(g));
    assert.ok(g.dockW <= g.vw * 0.36, 'dock narrows at ' + w + ': ' + JSON.stringify(g));
    if (process.env.SHOT && w === 900) fs.writeFileSync(process.env.SHOT.replace(/\.png$/, '-900.png'), (await wc.capturePage()).toPNG());
    await toggle('notepad');
    await tick(200);
  }
  win.setSize(was[0], was[1]);
  await tick(300);
});

test('placeholders (Ctrl+Shift+X) are comments: the flag shows only while Comments is open, its note beside it', async () => {
  const [, c2] = await chIds();
  await js(`(() => {
    const p = document.querySelector('.chapter[data-id="${c2}"] .chapter-body p');
    p.closest('.chapter-body').focus();
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    insertPlaceholder();
  })()`);
  await tick(400);
  assert.equal(await js('NeoDrivePanels.mode'), 'comments');
  assert.equal(await js(`document.activeElement === document.querySelector('#nd-margin .nd-flag textarea')`), true);
  await js(`document.execCommand('insertText', false, 'Check the furnace.')`);
  await tick(800);
  assert.equal(await js(`stickies.find((s) => !s.resolved).text`), 'Check the furnace.');
  const pos = await js(`(() => {
    const m = document.querySelector('#chapters .ph-mark').getBoundingClientRect();
    const c = document.querySelector('#nd-margin .nd-flag').getBoundingClientRect();
    return { dy: Math.abs(c.top - m.top), shown: m.height > 0 };
  })()`);
  assert.ok(pos.shown && pos.dy < 3, JSON.stringify(pos));
  if (process.env.SHOT) fs.writeFileSync(process.env.SHOT.replace(/\.png$/, '-flag.png'), (await wc.capturePage()).toPNG());
  // Enter: back to the page, past the flag
  await js(`document.querySelector('#nd-margin .nd-flag textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await tick(200);
  assert.equal(await js(`!!document.activeElement.closest('.chapter-body')`), true);
  await toggle('comments');
  await tick(200);
  assert.equal(await js(`getComputedStyle(document.querySelector('#chapters .ph-mark')).display`), 'none', 'flag hidden while Comments is closed');
  await js(`switchTab('notes')`);
  await tick(300);
  await js(`document.querySelector('#nd-notes-head [data-v="comments"]').click()`);
  await tick(200);
  assert.match(await js(`document.querySelector('.nd-list').textContent`), /Placeholder[\s\S]*Check the furnace\./);
  await js(`[...document.querySelectorAll('.nd-list .nd-item')].find((x) => /Check the furnace/.test(x.textContent)).querySelector('.go').click()`);
  await tick(400);
  assert.equal(await js('currentTab'), 'manuscript');
  assert.equal(await js(`getComputedStyle(document.querySelector('#chapters .ph-mark')).display`), 'inline');
  await js(`document.querySelector('#nd-margin .nd-flag .resolve').click()`);
  await tick(400);
  assert.equal(await js(`document.querySelectorAll('#chapters .ph-mark').length`), 0);
  assert.equal(await js(`document.querySelectorAll('#nd-margin .nd-flag').length`), 0);
  await toggle('comments');
  await tick(200);
});

test('a chapter deleted in NEO goes to "Deleted chapters" in Drive', async () => {
  const order = await chIds();
  const last = order[order.length - 1];
  const doc = await docFor(last);
  await js(`deleteChapterQuiet(${JSON.stringify(last)})`);
  await tick(300);
  await sync();
  const all = await files();
  const deleted = all.find((f) => f.appProperties.neoRole === 'deleted');
  assert.match(deleted.name, / Deleted Chapters$/);
  assert.ok(deleted);
  assert.deepEqual(all.find((f) => f.id === doc.id).parents, [deleted.id]);
});

test('a part is a folder holding its chapters; the Master gets a part page', async () => {
  const before = await chIds();
  await js(`(async () => {
    const id = 'ch-part-test';
    book.chapterOrder.unshift(id);
    book.chapterKinds = book.chapterKinds || {}; book.chapterKinds[id] = 'part';
    chapterHTML[id] = '<p>The Crossing</p>';
    await persistChapter(id, chapterHTML[id]);
    await saveMeta();
    renderChapters();
  })()`);
  await tick(400);
  await sync();
  const all = await files();
  const chapters = all.find((f) => f.appProperties.neoRole === 'chapters');
  const part = all.find((f) => f.appProperties.neoRole === 'part');
  assert.equal(part.name, 'Part I: The Crossing');
  assert.deepEqual(part.parents, [chapters.id]);
  assert.ok(!(await docFor('ch-part-test')), 'a part with only its title has no Doc of its own');
  for (const id of before) {
    const d = await docFor(id);
    if (d) assert.deepEqual(d.parents, [part.id], d.name);
    if (d) assert.match(d.name, /^1\.\d+: /);
  }
  // the Master: NEO's export's pages, in the chapters' look
  const m = await fake({ do: 'doc', id: (await master()).id });
  const paras = m.body.content.filter((e) => e.paragraph).map((e) => ({
    text: e.paragraph.elements.map((x) => x.textRun.content).join('').replace(/\n$/, ''),
    ps: e.paragraph.paragraphStyle,
    runs: e.paragraph.elements.map((x) => x.textRun).filter((r) => r.content !== '\n')
  }));
  const find = (t) => paras.find((x) => x.text === t);
  assert.ok(find('Contents'), paras.map((x) => x.text).slice(0, 12).join(' | '));
  assert.ok(find('Part I: The Crossing'), 'contents line for the part');
  const partLine = find('Part I: The Crossing');
  assert.deepEqual(partLine.runs.map((r) => [r.content.replace(/\n$/, ''), !!r.textStyle.italic, !!r.textStyle.bold]), [['Part I: ', false, false], ['The Crossing', true, false]]);
  const tocCh = paras.find((x) => /^Chapter 1: Cold Front/.test(x.text) && !x.ps.pageBreakBefore);
  assert.deepEqual(tocCh.runs.map((r) => [r.content.replace(/\n$/, ''), !!r.textStyle.italic, !!r.textStyle.bold]).slice(0, 2), [['Chapter 1: ', false, false], [tocCh.runs[1].content.replace(/\n$/, ''), true, false]]);
  const partHead = find('PART I:');
  assert.equal(partHead.ps.pageBreakBefore, true);
  assert.deepEqual([partHead.runs[0].textStyle.fontSize.magnitude, !!partHead.runs[0].textStyle.bold, !!partHead.runs[0].textStyle.italic], [20, true, false]);
  const partTitle = find('The Crossing');
  assert.deepEqual([partTitle.runs[0].textStyle.fontSize.magnitude, !!partTitle.runs[0].textStyle.bold, !!partTitle.runs[0].textStyle.italic], [14, false, true]);
  assert.equal(partTitle.ps.alignment, 'CENTER');
  const ch1 = paras.find((x) => /^Chapter 1: /.test(x.text) && x.ps.pageBreakBefore);
  assert.ok(paras.every((x) => x.ps.namedStyleType === 'NORMAL_TEXT'), 'plain paragraphs only');
  assert.ok(ch1 && ch1.ps.pageBreakBefore, 'chapter heading on a new page');
  const r1 = ch1.runs.map((r) => [r.content.replace(/\n$/, ''), !!r.textStyle.bold, !!r.textStyle.italic, r.textStyle.fontSize.magnitude]);
  assert.deepEqual(r1[0], ['Chapter 1: ', true, false, 12]);
  assert.match(r1[1][0], /^Cold Front/);
  assert.deepEqual(r1[1].slice(1), [true, true, 12]);
  assert.deepEqual([ch1.ps.spaceAbove.magnitude, ch1.ps.spaceBelow.magnitude], [0, 0]);
  const prose = paras.find((x) => x.text.startsWith('It rained'));
  assert.deepEqual([prose.runs[0].textStyle.weightedFontFamily.fontFamily, prose.ps.lineSpacing, prose.ps.indentFirstLine.magnitude], ['Times New Roman', 200, 36]);
  assert.ok(!paras.some((x) => x.runs.some((r) => r.textStyle.weightedFontFamily && r.textStyle.weightedFontFamily.fontFamily !== 'Times New Roman')), 'Times New Roman throughout');
  assert.match(diskText('ch-part-test'), /The Crossing/);
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
