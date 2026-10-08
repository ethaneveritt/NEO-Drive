// NEO-Drive: the natural-voice engine, in its own helper process (Electron
// utilityProcess, started by tts-main.js), so reading never slows the page.
//
// Kokoro-82M runs on ONNX Runtime for Node, from the downloaded voice pack;
// the text becomes phonemes with eSpeak NG (phonemizer) and Kokoro's own
// preparation (kokoro-text.js). Nothing here touches the network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('./kokoro-text.js');

const RATE = 24000;
const STYLE = 256;
let st = null;

async function load(dir) {
  if (st && st.dir === dir) return st;
  const nm = path.join(dir, 'node_modules');
  const ort = require(path.join(nm, 'onnxruntime-node'));
  K.init(require(path.join(nm, 'phonemizer', 'dist', 'phonemizer.cjs')).phonemize);
  const tok = K.tokenizer(JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')));
  // all but one of the computer's cores
  const threads = Math.max(1, Math.min(8, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1));
  const session = await ort.InferenceSession.create(path.join(dir, 'onnx', 'model.onnx'), {
    intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', executionMode: 'sequential'
  });
  st = { dir, ort, tok, session, voices: new Map(), threads };
  return st;
}

function voiceData(s, id) {
  if (!/^[ab][fm]_[a-z]+$/.test(id)) throw new Error('unknown voice ' + id);
  let v = s.voices.get(id);
  if (!v) {
    const buf = fs.readFileSync(path.join(s.dir, 'voices', id + '.bin'));
    v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
    s.voices.set(id, v);
  }
  return v;
}

async function speak(dir, text, voice, speed) {
  const s = await load(dir);
  const ids = s.tok(await K.phonemize(text, voice[0]));
  const v = voiceData(s, voice);
  const at = STYLE * Math.min(Math.max(ids.length - 2, 0), 509);
  const out = await s.session.run({
    input_ids: new s.ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, ids.length]),
    style: new s.ort.Tensor('float32', v.slice(at, at + STYLE), [1, STYLE]),
    speed: new s.ort.Tensor('float32', new Float32Array([speed]), [1])
  });
  const audio = Float32Array.from(out.waveform.data);
  // a voice that came out as nothing (numbers that overflowed) is an error, not silence
  for (let i = 0; i < audio.length; i += 97) if (!Number.isFinite(audio[i])) throw new Error('the voice came out empty');
  return audio;
}

// The model runs one piece at a time; reading aloud and an export take turns.
let queue = Promise.resolve();
function turn(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

// ------------------------------------------------------------ export
// A chapter (or the book) as MP3 files a phone can play: the voice sentence
// by sentence, the pauses between them, encoded with LAME (lamejs, LGPL-3.0)
// as it goes, with ID3 tags (title, book, author, track).
let lame = null;
function encoder() {
  if (!lame) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'lamejs.iife.js'), 'utf8');
    lame = new Function(src + ';return lamejs;')(); // eslint-disable-line no-new-func
  }
  return new lame.Mp3Encoder(1, RATE, 64);
}
function id3(tags) {
  const frames = [];
  for (const [fid, value] of Object.entries(tags)) {
    if (!value) continue;
    const text = Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(String(value), 'utf16le')]);
    const h = Buffer.alloc(10);
    h.write(fid, 0, 'latin1');
    h.writeUInt32BE(text.length, 4);
    frames.push(h, text);
  }
  const body = Buffer.concat(frames);
  const head = Buffer.alloc(10);
  head.write('ID3', 0, 'latin1');
  head[3] = 3;
  const n = body.length;
  head[6] = (n >> 21) & 0x7f; head[7] = (n >> 14) & 0x7f; head[8] = (n >> 7) & 0x7f; head[9] = n & 0x7f;
  return Buffer.concat([head, body]);
}
const toPcm = (f) => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767))); return o; };
const cancelled = new Set();
async function exportAudio(m) {
  const total = m.files.reduce((n, f) => n + f.items.length, 0);
  let done = 0;
  const written = [];
  for (const f of m.files) {
    const part = f.path + '.part';
    const out = fs.openSync(part, 'w');
    try {
      fs.writeSync(out, id3({ TIT2: f.title, TALB: f.album, TPE1: f.artist, TRCK: f.track }));
      const enc = encoder();
      const put = (b) => { if (b && b.length) fs.writeSync(out, Buffer.from(b.buffer, b.byteOffset, b.byteLength)); };
      for (const it of f.items) {
        if (cancelled.has(m.id)) throw new Error('cancelled');
        if (it.text) {
          const audio = await turn(() => speak(m.dir, it.text, m.voice, m.speed));
          const pcm = toPcm(audio);
          for (let i = 0; i < pcm.length; i += 11520) put(enc.encodeBuffer(pcm.subarray(i, i + 11520)));
        }
        const gap = Math.round((it.gap || 120) / 1000 * RATE);
        if (gap > 0) put(enc.encodeBuffer(new Int16Array(gap)));
        done++;
        process.parentPort.postMessage({ event: 'progress', id: m.id, done, total, file: f.title });
      }
      put(enc.flush());
      fs.closeSync(out);
      fs.renameSync(part, f.path);
      written.push(f.path);
    } catch (err) {
      try { fs.closeSync(out); } catch { /* closed */ }
      try { fs.unlinkSync(part); } catch { /* gone */ }
      throw err;
    }
  }
  return written;
}

process.parentPort.on('message', async (e) => {
  const m = e.data || {};
  if (m.type === 'cancel') { cancelled.add(m.target); return; }
  try {
    if (m.type === 'load') {
      const s = await load(m.dir);
      process.parentPort.postMessage({ id: m.id, ok: true, threads: s.threads });
    } else if (m.type === 'speak') {
      const audio = await turn(() => speak(m.dir, m.text, m.voice, m.speed));
      process.parentPort.postMessage({ id: m.id, audio, rate: RATE });
    } else if (m.type === 'export') {
      const written = await exportAudio(m);
      process.parentPort.postMessage({ id: m.id, ok: true, written });
    }
  } catch (err) {
    process.parentPort.postMessage({ id: m.id, error: String((err && err.message) || err) });
  } finally {
    if (m.type === 'export') cancelled.delete(m.id);
  }
});
