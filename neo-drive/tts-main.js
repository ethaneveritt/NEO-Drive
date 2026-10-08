// NEO-Drive: natural voices for Read Aloud (main process).
//
// The voices are Kokoro-82M (Apache-2.0), a small open neural voice model,
// run entirely on this computer by ONNX Runtime's WebAssembly build inside a
// hidden window. Nothing is sent anywhere: the hidden window's network is
// this file's request handler, which answers only with the voice files on
// disk.
//
// The voice files (~125 MB) are not in the installer. "Download Natural
// Voices" fetches them once from this repo's kokoro-voices release; every
// file is checked against manifest.json, whose own SHA-256 is pinned below.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PACK = {
  base: 'https://github.com/ethaneveritt/NEO-Drive/releases/download/kokoro-voices-1/',
  manifestSha256: 'c8248b10baddab59013ee384940384a1a2fe60a257d369567ff3baf2e3ad9987',
  model: 'onnx-community/Kokoro-82M-v1.0-ONNX'
};
const ENGINE_HOST = 'neo-tts.local';
const VENDOR = path.join(__dirname, 'vendor');
const ENGINE_DIR = path.join(__dirname, 'tts');

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
    return m.files.every((f) => {
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
      this.download.total = m.files.reduce((n, f) => n + f.size, 0);
      for (const f of m.files) {
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
  // A hidden window whose every request is answered from disk: the page and
  // the Kokoro bundle from the app, the model, voices and ONNX Runtime from
  // the downloaded pack. COOP/COEP make it cross-origin isolated, so ONNX
  // Runtime can use several threads.
  startEngine() {
    if (this.ready) return this.ready;
    const { BrowserWindow, session, ipcMain } = require('electron');
    const m = this.manifest();
    if (!m) return Promise.reject(new Error('Natural voices aren’t downloaded.'));
    const files = new Map(m.files.map((f) => [f.path, path.join(this.dir, f.path)]));
    const ses = session.fromPartition('neo-tts');
    const headers = (type) => ({
      'Content-Type': type,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*'
    });
    const typeOf = (f) => (/\.m?js$/.test(f) ? 'text/javascript' : /\.html$/.test(f) ? 'text/html' : /\.json$/.test(f) ? 'application/json' : /\.wasm$/.test(f) ? 'application/wasm' : 'application/octet-stream');
    const serve = (file) => {
      try { return new Response(fs.readFileSync(file), { headers: headers(typeOf(file)) }); } catch { return new Response('not found', { status: 404 }); }
    };
    if (!this.handled) {
      this.handled = true;
      ses.protocol.handle('https', (req) => {
        const u = new URL(req.url);
        if (u.host === ENGINE_HOST) {
          if (u.pathname === '/engine.html') return serve(path.join(ENGINE_DIR, 'engine.html'));
          if (u.pathname === '/engine.js') return serve(path.join(ENGINE_DIR, 'engine.js'));
          if (u.pathname === '/kokoro.web.js') return serve(path.join(VENDOR, 'kokoro.web.js'));
          if (u.pathname.startsWith('/ort/')) return serve(files.get('ort/' + u.pathname.slice(5)) || '');
        }
        // the model's own files, by their path in the model repository
        const at = u.pathname.indexOf('/resolve/');
        if (at >= 0) {
          const rel = u.pathname.slice(at + '/resolve/'.length).split('/').slice(1).join('/');
          if (files.has(rel)) return serve(files.get(rel));
        }
        return new Response('offline', { status: 404 });
      });
      ses.protocol.handle('http', () => new Response('offline', { status: 404 }));
      ipcMain.on('neo-tts-done', (_e, id, result) => {
        const job = this.jobs.get(id);
        if (job) { this.jobs.delete(id); job(result); }
      });
    }
    this.ready = new Promise((resolve, reject) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          partition: 'neo-tts', sandbox: true, contextIsolation: true, backgroundThrottling: false,
          preload: path.join(ENGINE_DIR, 'engine-preload.js')
        }
      });
      this.engine = win;
      win.on('closed', () => { if (this.engine === win) { this.engine = null; this.ready = null; this.failAll('the voice engine stopped'); } });
      win.webContents.on('render-process-gone', () => { try { win.destroy(); } catch { /* gone */ } });
      win.loadURL(`https://${ENGINE_HOST}/engine.html`).then(() => {
        this.call({ type: 'load', model: PACK.model }).then((r) => (r && r.ok ? resolve(true) : reject(new Error((r && r.error) || 'the voice engine didn’t start'))));
      }, reject);
    });
    this.ready.catch((err) => { this.log('voices engine', err); this.stopEngine(); });
    return this.ready;
  }
  call(msg) {
    return new Promise((resolve) => {
      if (!this.engine || this.engine.isDestroyed()) { resolve({ error: 'the voice engine isn’t running' }); return; }
      const id = ++this.seq;
      this.jobs.set(id, resolve);
      this.engine.webContents.send('neo-tts-job', { ...msg, id });
    });
  }
  failAll(error) { for (const done of this.jobs.values()) done({ error }); this.jobs.clear(); }
  stopEngine() {
    const w = this.engine;
    this.engine = null;
    this.ready = null;
    this.failAll('stopped');
    if (w && !w.isDestroyed()) w.destroy();
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
