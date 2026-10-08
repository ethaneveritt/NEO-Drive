// NEO-Drive: the voice engine. Runs Kokoro-82M with ONNX Runtime's
// WebAssembly build, in a hidden window whose every request is answered
// from files on this computer (tts-main.js).
import { KokoroTTS, env, transformersEnv } from './kokoro.web.js';

env.wasmPaths = 'https://neo-tts.local/ort/';
transformersEnv.useBrowserCache = false;
transformersEnv.allowLocalModels = false;
// all but one of the computer's cores (ONNX Runtime's own default is half)
transformersEnv.backends.onnx.wasm.numThreads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));

let tts = null;
let loading = null;

async function load(model) {
  if (tts) return tts;
  if (!loading) loading = KokoroTTS.from_pretrained(model, { dtype: 'q8', device: 'wasm' }).then((t) => { tts = t; return t; });
  return loading;
}

window.ttsHost.onJob(async (job) => {
  try {
    if (job.type === 'load') {
      await load(job.model);
      window.ttsHost.done(job.id, { ok: true, threads: crossOriginIsolated ? navigator.hardwareConcurrency : 1 });
      return;
    }
    if (job.type === 'speak') {
      const t = await load(job.model || 'onnx-community/Kokoro-82M-v1.0-ONNX');
      const out = await t.generate(job.text, { voice: job.voice, speed: job.speed });
      window.ttsHost.done(job.id, { audio: out.audio, rate: out.sampling_rate });
    }
  } catch (err) {
    window.ttsHost.done(job.id, { error: String((err && err.message) || err) });
  }
});
