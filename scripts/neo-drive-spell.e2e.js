// NEO-Drive: Edit → Spellcheck With → the system spellchecker, end to end.
// Needs a system checker: run on Windows or macOS (the release workflow runs
// it on Windows). On Linux, NEO_DRIVE_SYSTEM_SPELL=1 tests the wiring with
// Chromium's own dictionary, downloaded on first use.
// Run: npx electron scripts/neo-drive-spell.e2e.js
'use strict';

const { app, BrowserWindow, Menu, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-drive-spell-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
const LIB = path.join(tmp, 'NEO Library');
fs.mkdirSync(LIB);
fs.writeFileSync(path.join(LIB, 'library.json'), JSON.stringify({
  authorName: 'Test Writer', penNames: [], firstRunDone: true, pageTheme: 'night',
  shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
}));
fs.mkdirSync(path.join(tmp, 'app', 'neo-drive'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'app', 'neo-drive', 'settings.json'), JSON.stringify({ spellEngine: 'system' }));
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
require('../main.js');

const say = (kind, msg) => console.log(process.env.GITHUB_ACTIONS ? `::${kind}::${msg}` : `${kind}: ${msg}`);
let wc;
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

// right-click a word; the context-menu event's spellcheck findings
async function rightClickWord(word) {
  const at = await js(`(() => {
    const body = document.querySelector('.chapter-body');
    const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const i = n.data.indexOf(${JSON.stringify(word)});
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2);
      const b = r.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    }
    return null;
  })()`);
  assert.ok(at, 'word on the page');
  const got = new Promise((resolve) => {
    const on = (_e, params) => { wc.removeListener('context-menu', on); resolve(params); };
    wc.on('context-menu', on);
    setTimeout(() => resolve(null), 5000);
  });
  wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'right', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'right', clickCount: 1 });
  return got;
}

async function main() {
  await app.whenReady();
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); say('notice', 'ok   ' + name); } catch (err) { failed++; say('error', 'FAIL ' + name + ' — ' + String(err.message).replace(/\n/g, ' ')); }
  };
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    wc = win.webContents;
    while (!(await js(`typeof library !== 'undefined' && !!library && !!window.NeoDriveSpell`).catch(() => false))) await tick(50);
    await tick(500);
    await js(`(async () => {
      document.getElementById('firstrun').hidden = true;
      await addImportedBooks([{ name: 'Spelling', chapters: [{ title: 'One', paras: [{ text: 'I saw teh cat yesterday morning.' }] }] }], library.shelves[0]);
      const ids = library.shelves[0].bookIds;
      await openBook(ids[ids.length - 1]);
    })()`);
    await tick(1200);
    win.focus();

    await check('Edit → Spellcheck With offers the system spellchecker, chosen', async () => {
      const edit = Menu.getApplicationMenu().items.find((i) => i.label === 'Edit');
      const sw = edit.submenu.items.find((i) => i.label === 'Spellcheck With');
      assert.ok(sw, 'menu item');
      assert.deepEqual(sw.submenu.items.map((i) => [i.label, i.checked]).map(([l, c]) => [/Spellchecker/.test(l) ? 'system' : l, c]), [['NEO’s Dictionary', false], ['system', true]]);
    });
    await check('the system checker is on, and NEO\'s own pass stands aside', async () => {
      assert.equal(session.defaultSession.isSpellCheckerEnabled(), true);
      assert.equal(await js('NeoDriveSpell.system'), true);
      await js('toggleSpellcheck()');
      await tick(800);
      assert.equal(await js(`document.querySelector('.chapter-body').spellcheck`), true);
      assert.equal(await js(`CSS.highlights.has('neo-spell')`), false);
    });
    await check('a misspelled word is flagged, with the right suggestion', async () => {
      await js(`(() => {
        const body = document.querySelector('.chapter-body');
        body.focus();
        const r = document.createRange(); r.selectNodeContents(body.querySelector('p')); r.collapse(false);
        getSelection().removeAllRanges(); getSelection().addRange(r);
        document.execCommand('insertText', false, ' ');
      })()`);
      let params = null;
      for (let i = 0; i < 8 && !(params && params.misspelledWord); i++) { await tick(1000); params = await rightClickWord('teh'); }
      say('notice', 'context menu: ' + JSON.stringify(params && { word: params.misspelledWord, suggestions: params.dictionarySuggestions }));
      assert.equal(params && params.misspelledWord, 'teh');
      assert.ok(params.dictionarySuggestions.includes('the'), JSON.stringify(params.dictionarySuggestions));
      const ok = await rightClickWord('yesterday');
      assert.equal(ok && ok.misspelledWord, '', 'a correct word is not flagged');
    });
    await check('choosing a suggestion fixes the word in the page and on disk', async () => {
      // as a person does: right-click the word, then pick the suggestion
      const params = await rightClickWord('teh');
      assert.equal(params && params.misspelledWord, 'teh');
      wc.replaceMisspelling('the');
      await tick(300);
      assert.match(await js(`document.querySelector('.chapter-body').textContent`), /I saw the cat/);
      await js('flushAllSaves()');
      await tick(1500);
      const dir = fs.readdirSync(LIB).find((n) => n.startsWith('book-'));
      const html = fs.readdirSync(path.join(LIB, dir, 'chapters')).map((f) => fs.readFileSync(path.join(LIB, dir, 'chapters', f), 'utf8')).join('');
      assert.match(html, /I saw the cat/);
    });
    await check('back to NEO\'s dictionary: the system checker goes off', async () => {
      const edit = Menu.getApplicationMenu().items.find((i) => i.label === 'Edit');
      edit.submenu.items.find((i) => i.label === 'Spellcheck With').submenu.items[0].click();
      await tick(800);
      assert.equal(session.defaultSession.isSpellCheckerEnabled(), false);
      assert.equal(await js('NeoDriveSpell.system'), false);
      assert.equal(await js(`document.querySelector('.chapter-body').spellcheck`), false);
    });
    console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
  } catch (err) {
    failed++;
    say('error', String(err && err.stack || err).replace(/\n/g, ' '));
  } finally {
    app.exit(failed ? 1 : 0);
  }
}
main();
