// NEO-Drive: the main-process side of Ethan's additions.
// main.js calls in here at a few marked hook points ("NEO-Drive hook"),
// so Hugh's updates to main.js merge cleanly.
'use strict';

const { t } = require('../i18n.js');

// Extra items for the right-click menu on text (see the 'context-menu'
// handler in main.js). `items` is the template Hugh's handler built.
function extendTextMenu(items, params, win) {
  if (!params.isEditable) return items;
  const send = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('menu', msg); };
  const extra = [];
  if (params.selectionText && params.selectionText.trim()) {
    extra.push(
      { label: t('Italic'), accelerator: 'CmdOrCtrl+I', registerAccelerator: false, click: () => send({ type: 'nd-format', cmd: 'italic' }) },
      { label: t('Bold'), accelerator: 'CmdOrCtrl+B', registerAccelerator: false, click: () => send({ type: 'nd-format', cmd: 'bold' }) },
      { label: t('Underline'), accelerator: 'CmdOrCtrl+U', registerAccelerator: false, click: () => send({ type: 'nd-format', cmd: 'underline' }) },
      { type: 'separator' }
    );
  }
  const tail = [
    { type: 'separator' },
    { label: t('Fix Apostrophes in This Chapter'), click: () => send({ type: 'nd-fixApostrophes', x: params.x, y: params.y }) }
  ];
  return [...extra, ...items, ...tail];
}

// Where this build's releases live. The auto-updater itself is pointed here
// at build time (.github/workflows/neo-drive.yml); this is the "see the
// release on GitHub" fallback in main.js.
const RELEASES_REPO = 'ethaneveritt/NEO-Drive';
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

module.exports = { extendTextMenu, LATEST_RELEASE_API };
