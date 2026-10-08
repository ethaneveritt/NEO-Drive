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
  const session = await ort.InferenceSession.create(path.join(dir, 'onnx', 'model_fp16.onnx'), {
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
  return Float32Array.from(out.waveform.data);
}

process.parentPort.on('message', async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      const s = await load(m.dir);
      process.parentPort.postMessage({ id: m.id, ok: true, threads: s.threads });
    } else if (m.type === 'speak') {
      const audio = await speak(m.dir, m.text, m.voice, m.speed);
      process.parentPort.postMessage({ id: m.id, audio, rate: RATE });
    }
  } catch (err) {
    process.parentPort.postMessage({ id: m.id, error: String((err && err.message) || err) });
  }
});
