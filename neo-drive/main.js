// NEO-Drive: the main-process side of Ethan's additions.
// main.js calls in here at a few marked hook points ("NEO-Drive hook"),
// so Hugh's updates to main.js merge cleanly.
'use strict';

const path = require('path');
const { t } = require('../i18n.js');

// ------------------------------------------------------------- right-click
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
      { type: 'separator' },
      { label: t('Add Comment…'), accelerator: 'CmdOrCtrl+Alt+M', registerAccelerator: false, click: () => send({ type: 'nd-addComment' }) },
      { type: 'separator' }
    );
  }
  const tail = [
    { type: 'separator' },
    { label: t('Fix Quotes in This Chapter'), click: () => send({ type: 'nd-fixApostrophes', x: params.x, y: params.y }) }
  ];
  return [...extra, ...items, ...tail];
}

// Where this build's releases live. The auto-updater itself is pointed here
// at build time (.github/workflows/neo-drive.yml); this is the "see the
// release on GitHub" fallback in main.js.
const RELEASES_REPO = 'ethaneveritt/NEO-Drive';
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

// ------------------------------------------------------------ Google Drive
let drive = null; // { google, sync, fake }
let rebuildMenu = () => {};

function sendToWindow(msg) {
  const { BrowserWindow } = require('electron');
  const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (w && !w.isDestroyed()) w.webContents.send('menu', msg);
}

function logError(where, err) {
  try { console.error('[NEO-Drive]', where, (err && err.stack) || err); } catch { /* nowhere to say it */ }
}

function getDrive() {
  if (drive) return drive;
  const { app, safeStorage, shell } = require('electron');
  const { Google } = require('./google.js');
  const { Sync } = require('./sync.js');
  const dir = path.join(app.getPath('userData'), 'neo-drive');
  let api;
  let fake = null;
  if (process.env.NEO_DRIVE_FAKE) {
    // tests: Google in memory, already signed in
    const { FakeGoogle } = require('./fake-google.js');
    fake = new FakeGoogle();
    api = fake;
    api.connected = true;
    api.email = 'test@example.com';
    api.available = true;
  } else {
    api = new Google({ dir, safeStorage, openExternal: (u) => shell.openExternal(u), log: logError });
  }
  drive = { api, fake, sync: new Sync({ api, dir, log: logError }), lastSync: 0, error: '' };
  return drive;
}

// NEO-Drive's own settings, in NEO's app-data folder
function settingsFile() { return path.join(require('electron').app.getPath('userData'), 'neo-drive', 'settings.json'); }
function readSettings() {
  try { return JSON.parse(require('fs').readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(obj) {
  const fs = require('fs');
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...obj }));
}
const NAME_BY = ['title', 'subtitle', 'both'];
function nameBy() { const v = readSettings().nameBy; return NAME_BY.includes(v) ? v : 'title'; }
// the Master Manuscript's name has its own choice (until one is made, the folder's)
// Google Docs comments shown in NEO: 'all' (chapters and the Master), 'chapters', or 'off'
const COMMENTS_FROM = ['all', 'chapters', 'off'];
function commentsFrom() { const v = readSettings().commentsFrom; return COMMENTS_FROM.includes(v) ? v : 'all'; }
// the outline note's "What happens here…" under each chapter in the Chapters pane
function navHints() { return readSettings().navHints !== false; }
function masterNameBy() { const v = readSettings().masterNameBy; return NAME_BY.includes(v) ? v : nameBy(); }

function status() {
  const d = getDrive();
  return {
    available: !!d.api.available,
    connected: !!d.api.connected,
    email: d.api.email || '',
    lastSync: d.lastSync,
    error: d.error
  };
}

async function connect() {
  const d = getDrive();
  if (d.fake) return status();
  try {
    await d.api.connect();
    d.error = '';
    sendToWindow({ type: 'nd-status', ...status(), note: 'connected' });
  } catch (err) {
    sendToWindow({ type: 'nd-status', ...status(), note: 'connect-failed', message: String(err.message || err) });
  }
  rebuildMenu();
  return status();
}

function disconnect() {
  const d = getDrive();
  if (!d.fake) d.api.disconnect();
  sendToWindow({ type: 'nd-status', ...status(), note: 'disconnected' });
  rebuildMenu();
  return status();
}

const docUrl = (id) => `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`;
const folderUrl = (id) => `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;

// The window's one door in: window.neo.neoDrive(msg) (preload.js hook)
async function handle(_e, msg) {
  const d = getDrive();
  switch (msg && msg.op) {
    case 'status': return status();
    case 'prefs': return { navHints: navHints() };
    case 'connect': return connect();
    case 'disconnect': return disconnect();
    case 'sync': {
      if (!d.api.connected) return { error: 'not-connected', ...status() };
      try {
        const model = { ...msg.model, book: { ...msg.model.book, nameBy: nameBy(), masterNameBy: masterNameBy(), commentsFrom: commentsFrom() } };
        const result = await d.sync.run(model);
        d.lastSync = Date.now();
        if (result.commentsFetched) {
          const n = result.comments.length;
          if (n !== d.commentCount || result.commentsError !== d.commentsError) { d.commentCount = n; d.commentsError = result.commentsError || ''; rebuildMenu(); }
        }
        if (d.error) { d.error = ''; rebuildMenu(); }
        return { ok: true, result, ...status() };
      } catch (err) {
        const message = String((err && err.message) || err);
        if (err && err.signedOut) { d.error = message; rebuildMenu(); return { error: 'signed-out', message, ...status() }; }
        if (err && err.offline) return { error: 'offline', message, ...status() };
        logError('sync', err);
        d.error = message;
        return { error: 'failed', message, ...status() };
      }
    }
    case 'open': {
      // what: 'folder' | 'master' | 'chapter'
      const links = d.sync.links(String(msg.uuid || ''));
      const id = msg.what === 'folder' ? links.folderId : msg.what === 'master' ? links.masterId : links.chapters[msg.chId];
      if (!id) return { error: 'not-synced' };
      const url = msg.what === 'folder' ? folderUrl(id) : docUrl(id);
      if (!d.fake) require('electron').shell.openExternal(url);
      return { ok: true, url };
    }
    case 'resolve': {
      // a Google Docs comment resolved from NEO's pane
      if (!d.api.connected) return { error: 'not-connected' };
      try {
        await d.api.resolveComment(String(msg.docId), String(msg.commentId));
        return { ok: true };
      } catch (err) {
        return { error: err.offline ? 'offline' : 'failed', message: String((err && err.message) || err) };
      }
    }
    case 'addComment': {
      // a comment made in NEO on a passage: it goes to the chapter's Doc
      if (!d.api.connected) return { error: 'not-connected' };
      const links = d.sync.links(String(msg.uuid || ''));
      const docId = links.chapters[msg.chId];
      if (!docId) return { error: 'not-synced', message: 'This chapter hasn’t been synced to Google Drive yet.' };
      try {
        const c = await d.api.createComment(docId, String(msg.content || ''), String(msg.quote || ''));
        return { ok: true, comment: { id: c.id, docId, chId: msg.chId, where: msg.where || '', mine: true, author: (c.author && c.author.displayName) || '', content: c.content, quote: String(msg.quote || ''), created: c.createdTime || '', replies: [] } };
      } catch (err) {
        return { error: err.offline ? 'offline' : 'failed', message: String((err && err.message) || err) };
      }
    }
    case 'editComment': {
      if (!d.api.connected) return { error: 'not-connected' };
      try {
        await d.api.updateComment(String(msg.docId), String(msg.commentId), String(msg.content || ''));
        return { ok: true };
      } catch (err) {
        return { error: err.offline ? 'offline' : 'failed', message: String((err && err.message) || err) };
      }
    }
    case 'forget': {
      // the window couldn't take in what Docs sent: the next sync treats
      // those chapters as changed on both sides, so both versions are kept
      d.sync.forgetChapters(String(msg.uuid || ''), msg.chIds || []);
      return { ok: true };
    }
    case 'fake': return d.fake ? fakeOp(d.fake, msg) : null; // tests only
    default: return { error: 'unknown op' };
  }
}

// tests reach the Google stand-in through here
async function fakeOp(g, msg) {
  if (msg.do === 'files') return [...g.files.values()];
  if (msg.do === 'text') return g.docText(msg.id);
  if (msg.do === 'doc') return g.getDoc(msg.id);
  if (msg.do === 'type') { await g.typeInDoc(msg.id, g.findText(msg.id, msg.before), msg.text); return true; }
  if (msg.do === 'comments') return g.listComments(msg.id);
  if (msg.do === 'readerComment') return g.addReaderComment(msg.id, msg.comment);
  if (msg.do === 'noteDoc') return [...g.files.values()].find((f) => f.appProperties.neoNote === msg.key);
  return null;
}

// (not under plain Node, where the unit tests load this file)
if (process.versions.electron) require('electron').ipcMain.handle('neo-drive', handle);

// Title | Subtitle | Title: Subtitle, kept under `key` in the settings
function namingMenu(label, key, current) {
  return {
    label,
    submenu: [['title', t('Title')], ['subtitle', t('Subtitle')], ['both', t('Title: Subtitle')]].map(([v, l]) => ({
      label: l, type: 'radio', checked: current === v,
      click: () => { writeSettings({ [key]: v }); rebuildMenu(); sendToWindow({ type: 'nd-syncNow', quiet: true }); }
    }))
  };
}

// The Google Drive menu, before Help. `rebuild` is main.js's buildMenu, so
// the menu can show what's connected after a change.
function extendAppMenu(template, rebuild) {
  if (typeof rebuild === 'function') rebuildMenu = rebuild;
  let st;
  try { st = status(); } catch (err) { logError('menu', err); return template; }
  const items = [];
  if (!st.available) {
    items.push({ label: t('This build has no Google sign-in configured'), enabled: false });
  } else if (st.connected) {
    items.push({ label: st.email ? t('Connected as {email}', { email: st.email }) : t('Connected'), enabled: false });
    if (st.error) items.push({ label: st.error, enabled: false });
    const dd = getDrive();
    if (dd.lastSync) {
      const when = new Date(dd.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      items.push({ label: t('Last synced {time}', { time: when }), enabled: false });
    }
    if (commentsFrom() !== 'off' && dd.commentCount !== undefined) {
      items.push({ label: dd.commentsError ? t('Comments: couldn’t be read ({msg})', { msg: dd.commentsError.slice(0, 80) }) : t('{n} open comments — Comments, at the right edge', { n: dd.commentCount }), enabled: false });
    }
    items.push(
      { type: 'separator' },
      { label: t('Sync Now'), click: () => sendToWindow({ type: 'nd-syncNow' }) },
      { type: 'separator' },
      { label: t('Open This Book in Google Drive'), click: () => sendToWindow({ type: 'nd-open', what: 'folder' }) },
      { label: t('Open the Master Manuscript'), click: () => sendToWindow({ type: 'nd-open', what: 'master' }) },
      { label: t('Open This Chapter’s Google Doc'), click: () => sendToWindow({ type: 'nd-open', what: 'chapter' }) },
      { type: 'separator' },
      {
        label: t('Show Google Docs Comments in NEO'),
        submenu: [
          ['all', t('From Chapters and the Master Manuscript')],
          ['chapters', t('From Chapters Only')],
          ['off', t('Off')]
        ].map(([v, l]) => ({
          label: l, type: 'radio', checked: commentsFrom() === v,
          click: () => { writeSettings({ commentsFrom: v }); rebuildMenu(); sendToWindow({ type: 'nd-syncNow', quiet: true }); }
        }))
      },
      { type: 'separator' },
      namingMenu(t('Name Book Folders By'), 'nameBy', nameBy()),
      namingMenu(t('Name the Master Manuscript By'), 'masterNameBy', masterNameBy()),
      { type: 'separator' },
      { label: t('Disconnect Google Drive'), click: () => disconnect() }
    );
  } else {
    items.push({ label: t('Connect Google Drive…'), click: () => connect() });
  }
  const menu = { label: t('Google Drive'), submenu: items };
  const out = [...template];
  // View: the Chapters pane's "What happens here…" lines, on or off
  const view = out.find((m) => m && Array.isArray(m.submenu) && (m.role === 'viewMenu' || m.label === t('View')));
  if (view) {
    view.submenu = [...view.submenu, { type: 'separator' }, {
      label: t('Show “What happens here…” in the Chapters Pane'), type: 'checkbox', checked: navHints(),
      click: (item) => { writeSettings({ navHints: !!item.checked }); sendToWindow({ type: 'nd-prefs', navHints: !!item.checked }); }
    }];
  }
  const help = out.findIndex((m) => m && m.role === 'help' || (m && m.label === t('Help')));
  out.splice(help < 0 ? out.length : help, 0, menu);
  return out;
}

module.exports = { extendTextMenu, extendAppMenu, LATEST_RELEASE_API };
