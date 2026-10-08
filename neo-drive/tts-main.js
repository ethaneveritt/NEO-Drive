// NEO-Drive: natural voices for Read Aloud (main process).
//
// The voices are Kokoro-82M (Apache-2.0), a small open neural voice model,
// run entirely on this computer by ONNX Runtime in a helper process
// (tts/engine.js). Nothing is sent anywhere.
//
// The voice files (about 190 MB) are not in the installer. "Download Natural
// Voices" fetches them once from this repo's kokoro-voices release (only
// this computer's platform's runtime); every file is checked against
// manifest.json, whose own SHA-256 is pinned below.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PACK = {
  base: 'https://github.com/ethaneveritt/NEO-Drive/releases/download/kokoro-voices-3/',
  manifestSha256: 'f2098a7dcc3a0b1d682e915b9ef46a11a401bd5fffa5f36088d932e38a590992'
};
const PLATFORM = process.platform + '-' + process.arch;
// the pack's files this computer needs: everything but other platforms' runtimes
const mine = (f) => !f.platform || f.platform === PLATFORM;

// The voices, by the names people know them by (Kokoro's own names, plus
// accent and voice). American and British English.
const VOICES = [
  ['af_heart', 'Heart', 'American · woman'], ['af_bella', 'Bella', 'American · woman'],
  ['af_nicole', 'Nicole', 'American · woman, soft'], ['af_aoede', 'Aoede', 'American · woman'],
  ['af_kore', 'Kore', 'American · woman'], ['af_sarah', 'Sarah', 'American · woman'],
  ['af_nova', 'Nova', 'American · woman'], ['af_sky', 'Sky', 'American · woman'],
  ['af_alloy', 'Alloy', 'American · woman'], ['af_jessica', 'Jessica', 'American · woman'],
  ['af_river', 'River', 'American · woman'],
  ['am_michael', 'Michael', 'American · man'], ['am_fenrir', 'Fenrir', 'American · man'],
  ['am_puck', 'Puck', 'American · man'], ['am_echo', 'Echo', 'American · man'],
  ['am_eric', 'Eric', 'American · man'], ['am_liam', 'Liam', 'American · man'],
  ['am_onyx', 'Onyx', 'American · man'], ['am_adam', 'Adam', 'American · man'],
  ['am_santa', 'Santa', 'American · man'],
  ['bf_emma', 'Emma', 'British · woman'], ['bf_isabella', 'Isabella', 'British · woman'],
  ['bf_alice', 'Alice', 'British · woman'], ['bf_lily', 'Lily', 'British · woman'],
  ['bm_george', 'George', 'British · man'], ['bm_fable', 'Fable', 'British · man'],
  ['bm_lewis', 'Lewis', 'British · man'], ['bm_daniel', 'Daniel', 'British · man']
];

class Voices {
  constructor({ dir, log = () => {}, notify = () => {} }) {
    this.dir = path.join(dir, 'kokoro');
    this.log = log;
    this.notify = notify; // (msg) → the window: download progress
    this.engine = null;   // the hidden window
    this.ready = null;    // promise: the engine has loaded the model
    this.jobs = new Map();
    this.seq = 0;
    this.download = null; // { done, total, abort }
  }

  manifestPath() { return path.join(this.dir, 'manifest.json'); }
  manifest() {
    try {
      const buf = fs.readFileSync(this.manifestPath());
      if (sha256(buf) !== PACK.manifestSha256) return null;
      return JSON.parse(buf.toString('utf8'));
    } catch { return null; }
  }
  installed() {
    const m = this.manifest();
    if (!m) return false;
    return m.files.filter(mine).every((f) => {
      try { return fs.statSync(path.join(this.dir, f.path)).size === f.size; } catch { return false; }
    });
  }
  status() {
    return {
      installed: this.installed(),
      downloading: !!this.download,
      done: this.download ? this.download.done : 0,
      total: this.download ? this.download.total : 0,
      voices: VOICES.map(([id, name, kind]) => ({ id, name, kind }))
    };
  }

  // ------------------------------------------------------------ download
  async install() {
    if (this.download) return { ok: false, error: 'busy' };
    if (this.installed()) return { ok: true };
    const { net } = require('electron');
    const ac = new AbortController();
    this.download = { done: 0, total: 0, abort: () => ac.abort() };
    const tmp = this.dir + '.part';
    try {
      fs.mkdirSync(tmp, { recursive: true });
      const mres = await net.fetch(PACK.base + 'manifest.json', { signal: ac.signal });
      if (!mres.ok) throw new Error('manifest: HTTP ' + mres.status);
      const mbuf = Buffer.from(await mres.arrayBuffer());
      if (sha256(mbuf) !== PACK.manifestSha256) throw new Error('the voice list didn’t match what NEO-Drive expects');
      const m = JSON.parse(mbuf.toString('utf8'));
      if (!m.files.some((f) => f.platform === PLATFORM)) throw new Error('natural voices aren’t available for this kind of computer yet');
      const files = m.files.filter(mine);
      this.download.total = files.reduce((n, f) => n + f.size, 0);
      for (const f of files) {
        if (!/^[\w./-]+$/.test(f.path) || f.path.includes('..')) throw new Error('bad path in manifest');
        const dest = path.join(tmp, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // already here from an earlier, interrupted download
        try {
          if (fs.statSync(dest).size === f.size && sha256(fs.readFileSync(dest)) === f.sha256) { this.download.done += f.size; this.tell(); continue; }
        } catch { /* not yet */ }
        const res = await net.fetch(PACK.base + f.asset, { signal: ac.signal });
        if (!res.ok) throw new Error(f.path + ': HTTP ' + res.status);
        const hash = crypto.createHash('sha256');
        const out = fs.createWriteStream(dest + '.dl');
        let got = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          got += value.length;
          this.download.done += value.length;
          if (!out.write(value)) await new Promise((r) => out.once('drain', r));
          this.tell();
        }
        await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
        if (got !== f.size || hash.digest('hex') !== f.sha256) { fs.rmSync(dest + '.dl', { force: true }); throw new Error(f.path + ' arrived damaged'); }
        fs.renameSync(dest + '.dl', dest);
      }
      fs.writeFileSync(path.join(tmp, 'manifest.json'), mbuf);
      fs.rmSync(this.dir, { recursive: true, force: true });
      fs.renameSync(tmp, this.dir);
      return { ok: true };
    } catch (err) {
      this.log('voices download', err);
      return { ok: false, error: ac.signal.aborted ? 'cancelled' : String((err && err.message) || err) };
    } finally {
      this.download = null;
      this.tell(true);
    }
  }
  cancel() { if (this.download) this.download.abort(); }
  tell(force) {
    const now = Date.now();
    if (!force && this.lastTell && now - this.lastTell < 200) return;
    this.lastTell = now;
    this.notify({ type: 'nd-voices', ...this.status() });
  }
  remove() {
    this.stopEngine();
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.rmSync(this.dir + '.part', { recursive: true, force: true });
    this.tell(true);
    return { ok: true };
  }

  // -------------------------------------------------------------- engine
  // A helper process (Electron's utilityProcess) that loads the model once
  // and answers one request at a time.
  startEngine() {
    if (this.ready) return this.ready;
    if (!this.installed()) return Promise.reject(new Error('Natural voices aren’t downloaded.'));
    const { utilityProcess } = require('electron');
    this.ready = new Promise((resolve, reject) => {
      let child;
      try {
        child = utilityProcess.fork(path.join(__dirname, 'tts', 'engine.js'), [], { serviceName: 'NEO voices' });
      } catch (err) { reject(err); return; }
      this.engine = child;
      child.on('message', (m) => {
        const done = this.jobs.get(m && m.id);
        if (done) { this.jobs.delete(m.id); done(m); }
      });
      child.on('exit', () => { if (this.engine === child) { this.engine = null; this.ready = null; } this.failAll('the voice engine stopped'); });
      this.call({ type: 'load' }).then((r) => (r && r.ok ? resolve(true) : reject(new Error((r && r.error) || 'the voice engine didn’t start'))));
    });
    this.ready.catch((err) => { this.log('voices engine', err); this.stopEngine(); });
    return this.ready;
  }
  call(msg) {
    return new Promise((resolve) => {
      if (!this.engine) { resolve({ error: 'the voice engine isn’t running' }); return; }
      const id = ++this.seq;
      this.jobs.set(id, resolve);
      this.engine.postMessage({ ...msg, id, dir: this.dir });
    });
  }
  failAll(error) { for (const done of this.jobs.values()) done({ error }); this.jobs.clear(); }
  stopEngine() {
    const c = this.engine;
    this.engine = null;
    this.ready = null;
    this.failAll('stopped');
    try { if (c) c.kill(); } catch { /* gone */ }
  }

  // one stretch of text → { audio: Float32Array, rate } or { error }
  async speak({ text, voice, speed }) {
    if (!this.installed()) return { error: 'not-installed' };
    try { await this.startEngine(); } catch (err) { return { error: String((err && err.message) || err) }; }
    const v = VOICES.some(([id]) => id === voice) ? voice : 'af_heart';
    const s = Math.min(2, Math.max(0.5, Number(speed) || 1));
    return this.call({ type: 'speak', text: String(text || '').slice(0, 2000), voice: v, speed: s });
  }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

module.exports = { Voices, VOICES, PACK };
