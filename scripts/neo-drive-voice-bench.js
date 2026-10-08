// NEO-Drive: how fast the voice model runs here, by precision and threads
// (a one-off measurement, run from the voices benchmark workflow)
'use strict';
const ort = require('onnxruntime-node');
const fs = require('fs');
const os = require('os');
(async () => {
  const dir = process.argv[2];
  const n = 150;
  const ids = new BigInt64Array(n).fill(50n); ids[0] = 0n; ids[n - 1] = 0n;
  const buf = fs.readFileSync(dir + '/voices/af_heart.bin');
  const voice = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const style = voice.slice(n * 256, n * 256 + 256);
  console.log(`::notice::cpus ${os.cpus().length} ${os.cpus()[0].model}`);
  for (const file of process.argv.slice(3)) {
    for (const threads of [1, 2, 3, 4]) {
      const s = await ort.InferenceSession.create(dir + '/onnx/' + file, { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all' });
      const feeds = { input_ids: new ort.Tensor('int64', ids, [1, n]), style: new ort.Tensor('float32', style, [1, 256]), speed: new ort.Tensor('float32', new Float32Array([1]), [1]) };
      await s.run(feeds);
      const t = Date.now();
      const out = await s.run(feeds);
      const secs = out.waveform.data.length / 24000;
      console.log(`::notice::${file} threads ${threads}: ${secs.toFixed(1)}s audio in ${((Date.now() - t) / 1000).toFixed(2)}s (${(((Date.now() - t) / 1000) / secs).toFixed(2)}× real time)`);
    }
  }
})();
