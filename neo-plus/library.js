// NEO+: the window's side of keeping the library the same on every computer
// (neo-plus/library-sync.js does the work, in the main process), and, on a
// Mac, the note that a new version of NEO+ is out.
//
// This side tells the main process where the library is and which book is
// open, asks for a look when NEO comes back into view or is left, and when
// files arrive has NEO take them in: its own look at the disk
// (refreshFromDisk) for the open book and the shelves, made for a library
// that something else syncs underneath it.
(function () {
  'use strict';
  if (!window.neo || !window.neo.neoPlus || !window.neo.onMenu) return;
  const ask = (msg) => window.neo.neoPlus(msg).catch(() => null);
  const openId = () => (typeof book !== 'undefined' && book ? book.id : null);
  const firstRun = () => { const f = document.getElementById('firstrun'); return !!(f && !f.hidden); };

  let hello = null;
  async function sayHello() {
    const dir = await window.neo.libraryPath().catch(() => null);
    hello = await ask({ op: 'libHello', lib: dir, open: openId() });
    return hello;
  }

  // NEO takes in what arrived
  async function takeIn(msg) {
    if (msg.error) { if (msg.loud) toast(t('Library sync: {msg}', { msg: msg.error }), 10000); return; }
    if (msg.starting) { toast(t('Syncing your library with Google Drive…')); return; }
    const anything = msg.library || (msg.books && msg.books.length);
    if (!anything) { if (msg.loud) toast(t('Your library is in step with Google Drive.')); return; }
    if (!openId()) {
      // a computer that hadn't set NEO up yet: start over on the library that came in
      if (firstRun() && msg.library) { location.reload(); return; }
      if (typeof bookMetaCache !== 'undefined') bookMetaCache.clear();
      if (typeof refreshFromDisk === 'function') await refreshFromDisk();
      const shelf = document.getElementById('bookshelf-view');
      if (shelf && !shelf.hidden && typeof renderShelves === 'function') {
        const keep = shelf.scrollTop;
        await renderShelves();
        shelf.scrollTop = keep;
      }
    } else {
      // a book is open: the shelves in memory catch up (quietly), and the
      // open book looks at the disk if anything of it came in
      if (msg.library && typeof library !== 'undefined' && typeof libraryWritesPending !== 'undefined' && !libraryWritesPending) {
        try {
          const lib = await window.neo.readLibrary();
          if (lib && lib.firstRunDone && !libraryWritesPending) library = typeof applyDeviceLook === 'function' ? applyDeviceLook(lib) : lib;
        } catch { /* next time */ }
      }
      if (msg.books && msg.books.includes(openId()) && typeof refreshFromDisk === 'function') await refreshFromDisk();
    }
    if (msg.conflicts) toast(t('Something changed on two computers at once. Both versions are kept (a chapter’s other version is the chapter after it).'), 10000);
    else if (msg.loud) toast(t('Your library is in step with Google Drive.'));
  }

  window.neo.onMenu((msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'nd-lib') takeIn(msg).catch((err) => window.neo.logError('NEO+ library: ' + err));
    if (msg.type === 'nd-lib-now') ask({ op: 'libNow', open: openId(), loud: true });
    if (msg.type === 'nd-new-version') showNewVersion(msg);
  });

  // where the library is, and the open book as it changes
  let lastOpen;
  const watchOpen = () => {
    const id = openId();
    if (id === lastOpen) return;
    lastOpen = id;
    if (hello) ask({ op: 'libNow', open: id });
  };
  sayHello().then(() => { lastOpen = openId(); });
  setInterval(watchOpen, 2000);
  // coming back to NEO (the other computer may have been busy) and leaving it
  // (what was just written goes up)
  window.addEventListener('focus', () => { if (hello) ask({ op: 'libNow', open: openId() }); });
  window.addEventListener('blur', () => { if (hello) setTimeout(() => ask({ op: 'libNow', open: openId() }), 1500); });

  // ------------------------------------------------- a new version (Mac)
  function showNewVersion(v) {
    if (!v || !v.version || document.getElementById('nd-new-version')) return;
    const bar = document.createElement('div');
    bar.id = 'nd-new-version';
    bar.setAttribute('role', 'status');
    bar.innerHTML = `<span></span><button class="nd-nv-get"></button><button class="nd-nv-x" aria-label="${t('Close')}">×</button>`;
    bar.querySelector('span').textContent = t('NEO+ {v} is out.', { v: v.version });
    bar.querySelector('.nd-nv-get').textContent = t('Download');
    bar.querySelector('.nd-nv-get').onclick = () => { ask({ op: 'openNewVersion' }); bar.remove(); };
    bar.querySelector('.nd-nv-x').onclick = () => bar.remove();
    document.body.appendChild(bar);
  }
  const css = document.createElement('style');
  css.textContent = `
    #nd-new-version { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 9000;
      display: flex; align-items: center; gap: 12px; padding: 9px 12px 9px 16px; border-radius: 10px;
      background: rgba(30, 30, 30, 0.96); color: #eee; font: 13px system-ui, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
    #nd-new-version button { font: inherit; border: 0; border-radius: 6px; cursor: pointer; }
    #nd-new-version .nd-nv-get { background: #c9a227; color: #111; padding: 5px 12px; }
    #nd-new-version .nd-nv-x { background: transparent; color: #aaa; font-size: 17px; line-height: 1; padding: 2px 6px; }
  `;
  document.head.appendChild(css);
  ask({ op: 'newVersion' }).then((v) => { if (v) showNewVersion(v); });
  window.NeoPlusLibrary = { hello: sayHello, takeIn }; // for tests
})();
