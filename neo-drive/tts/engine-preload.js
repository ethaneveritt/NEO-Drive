// NEO-Drive: the voice engine's only door to NEO (see tts-main.js)
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ttsHost', {
  onJob: (fn) => ipcRenderer.on('neo-tts-job', (_e, job) => fn(job)),
  done: (id, result) => ipcRenderer.send('neo-tts-done', id, result)
});
