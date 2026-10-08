// NEO-Drive: Read Aloud with the natural voices, end to end, on a throwaway
// library. The voices come from the kokoro-voices release (a real download)
// unless NEO_DRIVE_VOICES_FROM points at a folder that already holds them.
// Run: npx electron scripts/neo-drive-read.e2e.js
'use strict';

const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-drive-read-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
const LIB = path.join(tmp, 'NEO Library');
fs.mkdirSync(LIB);
fs.writeFileSync(path.join(LIB, 'library.json'), JSON.stringify({
  authorName: 'Test Writer', penNames: [], firstRunDone: true, pageTheme: 'night',
  shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
}));
if (process.env.NEO_DRIVE_VOICES_FROM) fs.cpSync(process.env.NEO_DRIVE_VOICES_FROM, path.join(tmp, 'app', 'neo-drive', 'kokoro'), { recursive: true });
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
require('../main.js');

const say = (kind, msg) => console.log(process.env.GITHUB_ACTIONS ? `::${kind}::${msg}` : `${kind}: ${msg}`);
let wc, win;
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (cmd, extra = {}) => wc.send('menu', { type: 'nd-read', cmd, ...extra });
const sess = () => js(`(() => { const s = NeoDriveRead.session; return s && { idx: s.idx, n: s.items.length, paused: s.paused, waiting: !!s.waiting, mode: s.mode, text: s.items[s.idx] && s.items[s.idx].text, texts: s.items.map((i) => i.text || '[pause]') }; })()`);
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out: ' + what);
    await tick(250);
  }
}

async function main() {
  await app.whenReady();
  let failed = 0;
  const check = async (name, fn) => {
    const t0 = Date.now();
    try { await fn(); say('notice', `ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); } catch (err) { failed++; say('error', 'FAIL ' + name + ' — ' + String(err.message).replace(/\n/g, ' ')); }
  };
  try {
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    wc = win.webContents;
    while (!(await js(`typeof library !== 'undefined' && !!library && !!window.NeoDriveRead`).catch(() => false))) await tick(50);
    await tick(500);
    await js(`(async () => {
      document.getElementById('firstrun').hidden = true;
      await addImportedBooks([{ name: 'The Lighthouse', chapters: [
        { title: 'Cold Front', paras: [{ text: 'It rained on the harbor. The boats rocked in the dark.' }, { text: '***' }, { text: 'Mara counted coins. There were not enough.' }] },
        { title: 'Low Tide', paras: [{ text: 'The tide went out. Nobody noticed.' }] }
      ] }], library.shelves[0]);
      const ids = library.shelves[0].bookIds;
      await openBook(ids[ids.length - 1]);
    })()`);
    await tick(1200);
    win.focus();

    await check('the Read Aloud menu', async () => {
      const m = Menu.getApplicationMenu().items.find((i) => i.label === 'Read Aloud');
      assert.ok(m, 'menu');
      const labels = m.submenu.items.map((i) => i.label).filter(Boolean);
      for (const l of ['Read Chapter from the Beginning', 'Read Chapter from Here', 'Read Highlighted Passage', 'Read This Page', 'Read the Whole Manuscript', 'Continue Where I Stopped', 'Pause / Play', 'Stop', 'Voice', 'Speed']) assert.ok(labels.includes(l), l + ' in ' + labels.join(', '));
    });

    if (!process.env.NEO_DRIVE_VOICES_FROM) {
      await check('Download Natural Voices fetches and checks the voices', async () => {
        const t0 = Date.now();
        const r = await js(`window.neo.neoDrive({ op: 'voicesInstall' })`);
        assert.deepEqual(r, { ok: true });
        say('notice', `voices downloaded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      });
    }
    await js(`window.neo.neoDrive({ op: 'setReadPrefs', voice: 'af_heart', asked: true }).then(() => window.neo.neoDrive({ op: 'readPrefs' }))`);
    await js(`(async () => { const p = await window.neo.neoDrive({ op: 'readPrefs' }); window.neo.onMenu && 0; })()`);
    wc.send('menu', { type: 'nd-read-prefs', ...(await js(`window.neo.neoDrive({ op: 'readPrefs' })`)) });
    await tick(300);

    await check('a sentence of natural voice comes back as audio', async () => {
      const t0 = Date.now();
      const r = await js(`window.neo.neoDrive({ op: 'speak', text: 'The lamp was lit.', voice: 'af_heart', speed: 1 }).then((r) => ({ error: r.error, secs: r.audio && r.audio.length / r.rate, peak: r.audio ? r.audio.reduce((m, x) => Math.max(m, Math.abs(x)), 0) : 0 }))`);
      assert.ok(!r.error, r.error);
      say('notice', `speech: ${r.secs.toFixed(2)}s of audio in ${((Date.now() - t0) / 1000).toFixed(1)}s (first call loads the model)`);
      assert.ok(r.secs > 0.5 && r.secs < 5, 'length ' + r.secs);
      assert.ok(r.peak > 0.05, 'not silent');
      const t1 = Date.now();
      const r2 = await js(`window.neo.neoDrive({ op: 'speak', text: 'The ferry was an hour late, though once it had cleared the breakwater it would only take ten minutes to land.', voice: 'bm_george', speed: 1 }).then((r) => ({ error: r.error, secs: r.audio && r.audio.length / r.rate }))`);
      assert.ok(!r2.error, r2.error);
      say('notice', `speed: ${r2.secs.toFixed(2)}s of audio in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
      // every voice, short and long, comes out as sound (not silence)
      const long = 'The lamp was lit. Mara had made sure of that. She had trimmed the wick, wiped the glass, and filled the reservoir twice.';
      // (all 28 with NEO_DRIVE_ALL_VOICES=1; by default a few of each kind)
      const voices = process.env.NEO_DRIVE_ALL_VOICES ? (await js(`window.neo.neoDrive({ op: 'readPrefs' })`)).voices.voices.map((v) => v.id) : ['af_heart', 'am_michael', 'bf_emma', 'bm_george'];
      for (const v of voices) {
        for (const text of [long, 'The lamp was lit.']) {
          const q = await js(`window.neo.neoDrive({ op: 'speak', text: ${JSON.stringify(text)}, voice: '${v}', speed: 1 }).then((r) => r.error ? { error: r.error } : (() => { let peak = 0, bad = 0; for (const x of r.audio) { if (!Number.isFinite(x)) bad++; else if (Math.abs(x) > peak) peak = Math.abs(x); } return { peak, bad }; })())`);
          assert.ok(!q.error && !q.bad && q.peak > 0.05, `${v} (${text.length} chars): ${JSON.stringify(q)}`);
        }
      }
    });

    await check('Read Chapter from the Beginning: heading, then each sentence, lit as it is read', async () => {
      await js(`document.querySelector('.chapter-body').focus()`);
      read('chapter');
      const s = await until(sess, 5000, 'session');
      assert.deepEqual(s.texts, ['Chapter 1. Cold Front.', 'It rained on the harbor.', 'The boats rocked in the dark.', '[pause]', 'Mara counted coins.', 'There were not enough.']);
      assert.equal(await js(`document.getElementById('nd-player').hidden`), false);
      await until(async () => (await sess()).idx >= 1, 60000, 'reading moves on');
      assert.equal(await js(`[...CSS.highlights.get('neo-speak')][0].toString()`), 'It rained on the harbor.');
    });

    await check('Pause holds the place mid-sentence; Play carries on from it', async () => {
      await js('NeoDriveRead.toggle()');
      await tick(300);
      const a = await sess();
      assert.equal(a.paused, true);
      await tick(2500);
      const b = await sess();
      assert.equal(b.idx, a.idx, 'still on the same sentence');
      await js('NeoDriveRead.toggle()');
      await until(async () => { const c = await sess(); return c && !c.paused && c.idx > a.idx; }, 60000, 'carries on');
    });

    await check('NEO\'s own volume: the slider sets the reading volume, not the computer\'s', async () => {
      await js(`(() => { const v = document.querySelector('#nd-player .vol'); v.value = 30; v.dispatchEvent(new Event('input')); v.dispatchEvent(new Event('change')); })()`);
      await tick(300);
      assert.equal(Math.round(await js('NeoDriveRead.gain.gain.value') * 100), 30);
      assert.equal((await js(`window.neo.neoDrive({ op: 'readPrefs' })`)).volume, 0.3);
    });

    await check('Stop keeps the place; Continue Where I Stopped starts there', async () => {
      const before = await sess();
      read('stop');
      await tick(300);
      assert.equal(await js('NeoDriveRead.session'), null);
      assert.equal(await js(`CSS.highlights.has('neo-speak')`), false);
      read('continue');
      const s = await until(sess, 5000, 'session');
      assert.equal(s.texts[0], before.text, 'starts at the sentence it stopped on');
      read('stop');
      await tick(200);
    });

    await check('Read Highlighted Passage reads just what is selected', async () => {
      await js(`(() => {
        const ps = document.querySelectorAll('.chapter-body')[0].querySelectorAll('p');
        const a = ps[0].firstChild, b = ps[2].firstChild;
        const r = document.createRange(); r.setStart(a, a.data.indexOf('The boats')); r.setEnd(b, 'Mara counted coins.'.length);
        getSelection().removeAllRanges(); getSelection().addRange(r);
      })()`);
      read('selection');
      const s = await until(sess, 5000, 'session');
      assert.deepEqual(s.texts, ['The boats rocked in the dark.', '[pause]', 'Mara counted coins.']);
      read('stop');
      await tick(200);
    });

    await check('Read the Whole Manuscript: title, every chapter', async () => {
      read('book');
      const s = await until(sess, 5000, 'session');
      assert.match(s.texts[0], /^The Lighthouse\. By Test Writer\.$/);
      assert.ok(s.texts.includes('Chapter 2. Low Tide.'), s.texts.join(' | '));
      assert.ok(s.texts.includes('Nobody noticed.'));
      read('stop');
      await tick(200);
    });

    await check('Read This Page reads what is on screen', async () => {
      await js(`document.querySelector('.chapter-body p').scrollIntoView({ block: 'start' })`);
      await tick(200);
      read('page');
      const s = await until(sess, 5000, 'session');
      assert.ok(s.n > 0 && s.texts.includes('It rained on the harbor.'), s.texts.join(' | '));
      read('stop');
      await tick(200);
    });

    await check('forward and back a sentence', async () => {
      read('chapter');
      await until(sess, 5000, 'session');
      await js('NeoDriveRead.step(1)');
      await tick(200);
      assert.equal((await sess()).idx, 1);
      await js('NeoDriveRead.step(1)');
      await tick(200);
      assert.equal((await sess()).idx, 2);
      await js('NeoDriveRead.step(-1)');
      await tick(200);
      assert.equal((await sess()).idx, 1);
      if (process.env.SHOT) fs.writeFileSync(process.env.SHOT, (await wc.capturePage()).toPNG());
      read('stop');
    });

    await check('Export as Audio: a chapter as one MP3, the manuscript as an MP3 per chapter', async () => {
      const { dialog } = require('electron');
      const out = path.join(tmp, 'audio');
      fs.mkdirSync(out, { recursive: true });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(out, 'Cold Front.mp3') });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [out] });
      await js(`document.querySelector('.chapter-body').focus()`);
      const r = await js(`window.neo.neoDrive({ op: 'exportAudio', scope: 'chapter', chapters: [{ title: 'Chapter 1 — Cold Front', items: [{ text: 'It rained on the harbor.', gap: 300 }, { text: '', gap: 900 }, { text: 'Mara counted coins.', gap: 120 }] }], book: { title: 'The Lighthouse', author: 'Test Writer' }, voice: 'bm_george', speed: 1 })`);
      assert.ok(r.ok, JSON.stringify(r));
      const mp3 = fs.readFileSync(path.join(out, 'Cold Front.mp3'));
      assert.equal(mp3.slice(0, 3).toString(), 'ID3');
      assert.ok(mp3.includes(Buffer.from('The Lighthouse', 'utf16le')), 'album tag');
      const size = (mp3[6] << 21) | (mp3[7] << 14) | (mp3[8] << 7) | mp3[9];
      assert.equal(mp3[10 + size], 0xff, 'MPEG frames after the tag');
      assert.ok(mp3.length > 15000, 'a few seconds of audio: ' + mp3.length);
      // the whole manuscript, a file per chapter, through the window's own code
      await js(`NeoDriveRead.exportAudio('chapters')`);
      const folder = path.join(out, 'The Lighthouse (audio)');
      try {
        await until(async () => fs.existsSync(folder) && fs.readdirSync(folder).filter((f) => f.endsWith('.mp3')).length === 2, 240000, 'two chapter files');
      } catch (err) {
        say('notice', 'folder: ' + JSON.stringify(fs.existsSync(out) && fs.readdirSync(out, { recursive: true })) + ' panel: ' + (await js(`(document.getElementById('nd-export') || {}).textContent || 'none'`)));
        throw err;
      }
      assert.deepEqual(fs.readdirSync(folder).sort(), ['01 Chapter 1 — Cold Front.mp3', '02 Chapter 2 — Low Tide.mp3']);
      await until(() => js(`(() => { const p = document.getElementById('nd-export'); return !!p && /saved/.test(p.textContent); })()`), 10000, 'saved note');
      if (process.env.SHOT) fs.writeFileSync(process.env.SHOT.replace(/\.png$/, '-export.png'), (await wc.capturePage()).toPNG());
    });

    if (process.env.SAMPLES) {
      // a few voices reading the same lines, saved as WAV files to listen to
      const line = 'The lamp was lit. Mara had made sure of that. She had trimmed the wick, wiped the glass, and filled the reservoir twice.';
      fs.mkdirSync(process.env.SAMPLES, { recursive: true });
      for (const v of ['af_heart', 'af_bella', 'am_michael', 'am_fenrir', 'bf_emma', 'bm_george', 'bm_fable']) {
        const r = await js(`window.neo.neoDrive({ op: 'speak', text: ${JSON.stringify(line)}, voice: '${v}', speed: 1 }).then((r) => ({ rate: r.rate, audio: Array.from(r.audio) }))`);
        fs.writeFileSync(path.join(process.env.SAMPLES, v + '.wav'), wav(r.audio, r.rate));
        say('notice', 'sample ' + v);
      }
    }
    console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
  } catch (err) {
    failed++;
    say('error', String(err && err.stack || err).replace(/\n/g, ' '));
  } finally {
    app.exit(failed ? 1 : 0);
  }
}

function wav(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2));
  return b;
}
main();
