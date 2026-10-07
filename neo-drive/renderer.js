// NEO-Drive: the window side of Ethan's additions. Loaded after app.js
// (index.html), so it can use app.js's globals: book, chapterHTML,
// syncChapter, snapshotStructure, structuralUndo, undoStack, t, toast, $.
//
// Kept in its own file so Hugh's updates to app.js merge cleanly.
(function () {
  'use strict';
  if (!window.neo || !window.neo.onMenu) return;

  // ---------------------------------------------------------------- format
  // Right-click → Italic / Bold / Underline. Same as ⌘I/⌘B/⌘U in app.js
  // (styleKeepScroll): apply, and keep the page from jumping.
  function applyFormat(cmd) {
    const sc = document.querySelector('#paper-scroll');
    const keep = sc ? sc.scrollTop : 0;
    document.execCommand(cmd);
    if (sc) {
      sc.scrollTop = keep;
      requestAnimationFrame(() => { sc.scrollTop = keep; });
    }
  }

  // ------------------------------------------------------------ apostrophes
  const A = window.NeoDriveApostrophes;

  // the chapter under the pointer, else the one being written in
  function chapterAt(x, y) {
    let el = (x || y) ? document.elementFromPoint(x, y) : null;
    let ch = el && el.closest ? el.closest('.chapter') : null;
    if (!ch) {
      const sel = window.getSelection();
      el = sel && sel.anchorNode;
      if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
      ch = el && el.closest ? el.closest('.chapter') : null;
    }
    const body = ch && ch.querySelector('.chapter-body');
    return body ? { chId: ch.dataset.id, body } : null;
  }

  // Swap characters in a paragraph's text nodes, by position in the
  // paragraph's full text. Swaps are one character for one, so nodes keep
  // their lengths and the bold/italic around them is untouched.
  function applyToParagraph(p, changes) {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let node, start = 0;
    const byIndex = new Map(changes.map((c) => [c.index, c.to]));
    while ((node = walker.nextNode())) {
      const len = node.data.length;
      let text = node.data, touched = false;
      for (let i = 0; i < len; i++) {
        const to = byIndex.get(start + i);
        if (to !== undefined && text[i] !== to) {
          text = text.slice(0, i) + to + text.slice(i + 1);
          touched = true;
        }
      }
      if (touched) node.data = text;
      start += len;
    }
  }

  function chapterLabel(chId) {
    const title = book.chapterTitles && book.chapterTitles[chId];
    if (title) return title;
    return t('Chapter {n}', { n: Math.max(1, book.chapterOrder.indexOf(chId) + 1) });
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function fixApostrophes(x, y) {
    if (!A || !book) return;
    const at = chapterAt(x, y);
    if (!at) { toast(t('Click inside a chapter first.')); return; }
    const { chId, body } = at;

    // plan the whole chapter before touching it
    const paras = [...body.querySelectorAll('p')].filter((p) => !p.classList.contains('scene-break'));
    const plans = paras.map((p) => ({ p, changes: A.planParagraph(p.textContent) }));
    const swaps = plans.reduce((n, pl) => n + pl.changes.filter((c) => c.to !== c.from).length, 0);
    const flagged = [];
    for (const pl of plans) for (const c of pl.changes) if (c.flag) flagged.push({ p: pl.p, c });
    if (!swaps) {
      toast(t('Every apostrophe in {chapter} already faces the right way.', { chapter: chapterLabel(chId) }));
      return;
    }

    // one step back: the whole fix undoes together (structural undo stack)
    snapshotStructure('Fix Apostrophes');
    const snap = undoStack[undoStack.length - 1];
    for (const pl of plans) if (pl.changes.some((c) => c.to !== c.from)) applyToParagraph(pl.p, pl.changes);
    syncChapter(body, chId);

    showReport(chId, swaps, flagged, snap);
  }

  // What changed, what's worth a second look, and a way back.
  function showReport(chId, swaps, flagged, snap) {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    const rows = flagged.slice(0, 30).map((f, i) => {
      const text = f.p.textContent;
      const a = Math.max(0, f.c.index - 30);
      const b = Math.min(text.length, f.c.index + 31);
      const before = escapeHTML((a > 0 ? '…' : '') + text.slice(a, f.c.index));
      const after = escapeHTML(text.slice(f.c.index + 1, b) + (b < text.length ? '…' : ''));
      const what = f.c.to === '‘' ? t('opens a quote') : t('apostrophe');
      return `<button class="fr-choice nd-flag" data-i="${i}" style="width:100%;margin-bottom:6px;text-align:left">
        <span style="display:block;font-weight:normal">${before}<span style="display:inline;font-weight:700;font-size:1.3em">${f.c.to}</span>${after}</span>
        <span style="display:block;opacity:.6;font-size:12px;font-weight:normal">${what}</span>
      </button>`;
    }).join('');
    const more = flagged.length > 30 ? `<p style="opacity:.6">${t('…and {n} more.', { n: flagged.length - 30 })}</p>` : '';
    bd.innerHTML = `
      <div class="modal nd-report" style="width:480px;max-height:80vh;overflow:auto">
        <h2 style="font-size:16px">${t('Fixed {n} apostrophes in {chapter}', { n: swaps, chapter: escapeHTML(chapterLabel(chId)) })}</h2>
        ${flagged.length ? `<p>${t('These were judgment calls. Click one to jump to it:')}</p>${rows}${more}` : ''}
        <div style="text-align:right;margin-top:14px">
          <button class="nd-undo btn-quiet" style="margin-right:10px">${t('Undo')}</button>
          <button class="m-ok btn-gold">${t('Done')}</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector('.m-ok').onclick = close;
    bd.querySelector('.nd-undo').onclick = () => {
      close();
      if (undoStack[undoStack.length - 1] === snap) structuralUndo();
      else toast(t('Too much has changed since to undo the fix in one step.'));
    };
    bd.querySelectorAll('.nd-flag').forEach((btn) => {
      btn.onclick = () => {
        const f = flagged[+btn.dataset.i];
        close();
        if (!f.p.isConnected) return;
        selectIndex(f.p, f.c.index);
      };
    });
    bd.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    bd.querySelector('.m-ok').focus();
  }

  // put the selection on one character of a paragraph, and bring it into view
  function selectIndex(p, index) {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let node, start = 0;
    while ((node = walker.nextNode())) {
      if (index < start + node.data.length) {
        const r = document.createRange();
        r.setStart(node, index - start);
        r.setEnd(node, index - start + 1);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        p.scrollIntoView({ block: 'center' });
        return;
      }
      start += node.data.length;
    }
  }

  // ----------------------------------------------------------- Google Drive
  // The open book goes to Google Drive every few seconds (neo-drive/sync.js
  // does the work in the main process). What comes back from Docs is written
  // through NEO's own door (window.neo.writeChapter, then refreshFromDisk),
  // the same way an edit from another device arrives, so NEO's own care for
  // a chapter being typed in still applies.
  const DB = window.NeoDriveBlocks;
  const SYNC_EVERY = 5000;
  let drive = { connected: false };
  let syncing = false;
  let lastSig = '';
  let lastBook = null;
  let lastError = '';
  const paraCache = new Map(); // chapter html -> its blocks

  // A chapter's paragraphs, each with the element it came from. NEO's own
  // export reading (parasFromHtml) decides what a paragraph is; an outline's
  // unwritten sections (ghosts) and their breaks are not part of the book.
  function neoParas(html) {
    const holder = document.createElement('div');
    holder.innerHTML = html || '';
    const skip = new Set();
    holder.querySelectorAll('p.ghost').forEach((g) => {
      skip.add(g);
      const id = g.dataset.secId;
      if (id) holder.querySelectorAll('p.scene-break').forEach((b) => { if (b.dataset.secBrk === id) skip.add(b); });
    });
    const list = [];
    for (const p of holder.querySelectorAll('p')) {
      if (skip.has(p)) continue;
      const paras = parasFromHtml(p.outerHTML);
      if (paras.length) list.push({ el: p, block: DB.fromNeoPara(paras[0]) });
    }
    return { holder, list };
  }
  function blocksOf(html) {
    let b = paraCache.get(html);
    if (!b) {
      b = neoParas(html).list.map((x) => x.block);
      if (paraCache.size > 400) paraCache.clear();
      paraCache.set(html, b);
    }
    return b;
  }
  function liveHtml(chId) {
    const el = document.querySelector(`.chapter[data-id="${CSS.escape(chId)}"] .chapter-body`);
    return el ? captureBody(el) : (chapterHTML[chId] || '');
  }

  // The headings a chapter's Doc opens with, set the way Ethan's pages set
  // them: a plain centered bold line, "Chapter 2: Title" with the title in
  // italic; "Prologue"; a part as "PART I:" over its title (the part's first
  // line in NEO) in italic. The pages NEO's exports leave unheaded
  // (copyright, dedication, epigraph) have none here either.
  const partSkip = new Map(); // part chId -> NEO paragraphs used up by its heading
  function headsFor(chId, kind, html, blocks) {
    partSkip.delete(chId);
    if (chId === soloStory() || FRONT_PAGES.includes(kind)) return [];
    if (kind === 'part') {
      const ps = parasFromHtml(html);
      const titled = !!(ps[0] && !ps[0].sceneBreak && !isAttribution(ps[0]) && blocks[0] && blocks[0].k === 'p');
      const label = chapterName(chId).toUpperCase();
      if (!titled) return [DB.heading(label)];
      partSkip.set(chId, 1);
      return [DB.heading(label + ':'), DB.heading(blocks[0].text, 0)];
    }
    if (kind === 'acknowledgments' || kind === 'about') return [DB.heading(kindName(kind))];
    const title = ((book.chapterTitles || {})[chId] || '').trim();
    if (kind === 'unnumbered' || (title && library.exportCustomChapterTitles)) {
      return [DB.heading(title || chapterName(chId), title ? 0 : undefined)];
    }
    const name = chapterName(chId);
    if (!title) return [DB.heading(name)];
    return [DB.heading(`${name}: ${title}`, name.length + 2)];
  }

  // The open book as the sync wants it: a Doc per chapter (with the part it
  // sits in), the parts (folders), and the Master Manuscript laid out the way
  // NEO's own Word export lays a book out (title page, contents, a page per
  // part) in the chapters' own look.
  function bookModel() {
    if (!book.uuid) { book.uuid = crypto.randomUUID(); saveMeta(); }
    const entries = [];
    const parts = [];
    const toc = [];
    const body = []; // master blocks after the contents page, with their owners
    const m = (b, owner = '') => ({ b, owner });
    let part = null;
    // the number of the part a chapter sits in, for Docs named "1.1: Title":
    // 0 before the first part; after the last part's chapters (an epilogue),
    // the number after it
    let section = 0, partsSeen = 0;
    for (const chId of book.chapterOrder) {
      const kind = chapterKind(chId);
      if (kind === 'contents') continue;
      if (BACK_KINDS.includes(kind) && part) { part = null; section = partsSeen + 1; }
      const label = ((book.chapterTitles || {})[chId] || '').trim() || chapterName(chId);
      const html = liveHtml(chId);
      const all = blocksOf(html);
      const heads = headsFor(chId, kind, html, all);
      const blocks = all.slice(partSkip.get(chId) || 0);
      const name = heads.length ? heads.map((h) => h.text).join(' ') : (chapterHeading(chId) || chapterName(chId));
      if (kind === 'part') {
        part = chId;
        section = ++partsSeen;
        // the folder and the contents line read "Part I: The Crossing"; the
        // part's page in the Master, "PART I:" over its title
        const partName = partSkip.get(chId) ? `${chapterName(chId)}: ${all[0].text}` : chapterName(chId);
        parts.push({ partId: chId, name: partName });
        toc.push(m({ k: 'p', text: partName, ind: 'flush', sa: 12 }, partName));
        // the part's page: a little way down a new page
        heads.forEach((h, i) => body.push(m(i ? h : { ...h, pb: true, sa: 72 }, partName)));
        for (const b of blocks) body.push(m(b, partName));
        if (blocks.length) entries.push({ chId, kind, heads, name: partName, label: partName, section, blocks, part: chId });
        continue;
      }
      entries.push({ chId, kind, heads, name, label, section, blocks, part });
      if (heads.length && !FRONT_PAGES.includes(kind)) toc.push(m({ k: 'p', text: name, ind: part ? 'poetry' : 'flush' }, name));
      // each chapter starts a new page
      heads.forEach((h, i) => body.push(m(i ? h : { ...h, pb: true }, name)));
      for (const b of blocks) body.push(m(b, name));
    }
    // the title page, as NEO's export sets it: title, subtitle, author
    const master = [m({ ...DB.heading(book.title || t('Untitled')), sz: 20, sa: 150, ls: 100 })];
    if (book.subtitle) master.push(m({ k: 'p', text: book.subtitle, marks: [[0, book.subtitle.length, 'i']], align: 'center', sz: 14, ls: 100 }));
    if (book.author) master.push(m({ k: 'p', text: book.author, align: 'center', sa: 40, ls: 100 }));
    if (toc.length > 1) master.push(m({ ...DB.heading(t('Contents')), pb: true }), ...toc);
    master.push(...body);
    return {
      book: { uuid: book.uuid, title: book.title || '', subtitle: book.subtitle || '', author: book.author || '' },
      entries, parts, master
    };
  }

  async function driveTick(force) {
    if (syncing || !drive.connected || !book || isScript()) return null;
    const bookId = book.id;
    if (lastBook !== bookId) { lastBook = bookId; lastSig = ''; }
    const model = bookModel();
    const sig = JSON.stringify([model.book, model.parts, model.entries.map((e) => [e.chId, e.kind, e.part, e.name, e.label, e.section, (e.heads || []).map(DB.blockKey), e.blocks.map(DB.blockKey)]), model.master.length]);
    syncing = true;
    try {
      const r = await window.neo.neoDrive({ op: 'sync', model: { ...model, dirty: force || sig !== lastSig, force: !!force } });
      if (!r) return null;
      drive = { ...drive, ...r };
      if (r.error) {
        // said once, not every five seconds
        if (r.error !== 'offline' && r.message !== lastError) toast(t('Google Drive: {msg}', { msg: r.message || r.error }), 8000);
        lastError = r.message || r.error;
        return r;
      }
      if (lastError) { lastError = ''; }
      if (!book || book.id !== bookId) {
        // the book closed mid-sync: anything Docs sent is looked at afresh next time
        const back = [...r.result.pulls, ...r.result.conflicts].map((x) => x.chId);
        if (back.length) await window.neo.neoDrive({ op: 'forget', uuid: model.book.uuid, chIds: back });
        return r;
      }
      lastSig = sig;
      await applyFromDrive(model.book.uuid, r.result);
      return r;
    } finally {
      syncing = false;
    }
  }

  async function applyFromDrive(uuid, res) {
    const names = [];
    const missed = [];
    for (const pull of res.pulls) {
      if (await applyPull(pull.chId, pull.blocks)) names.push(chapterHeading(pull.chId) || chapterName(pull.chId));
      else missed.push(pull.chId);
    }
    if (names.length) {
      await refreshFromDisk();
      toast(t('Updated from Google Docs: {names}', { names: names.join(', ') }), 6000);
    }
    for (const c of res.conflicts) await applyConflict(c.chId, c.blocks, c.name);
    if (missed.length) await window.neo.neoDrive({ op: 'forget', uuid, chIds: missed });
    if (res.masterEdits && res.masterEdits.length) showMasterEdits(res.masterEdits);
  }

  // The Doc's text, merged into the chapter as it stands on disk: only the
  // paragraphs that changed are replaced, so an outline section's mark (and
  // everything else NEO keeps in the file) stays on the paragraphs Docs
  // didn't touch.
  async function applyPull(chId, blocks) {
    if (!book.chapterOrder.includes(chId)) return false;
    const html = savedHTML[chId] !== undefined ? savedHTML[chId] : chapterHTML[chId];
    if (html === undefined) return false;
    const parsed = neoParas(html);
    const holder = parsed.holder;
    // a part's first line is its title, which the Doc shows as a heading
    const list = parsed.list.slice(partSkip.get(chId) || 0);
    const want = blocks.map(DB.normalize);
    const hunks = DB.diffBlocks(list.map((x) => x.block), want);
    for (let h = hunks.length - 1; h >= 0; h--) {
      const { i0, i1, j0, j1 } = hunks[h];
      const olds = list.slice(i0, i1).map((x) => x.el);
      const tmp = document.createElement('div');
      tmp.innerHTML = want.slice(j0, j1).map(DB.toNeoHtml).join('');
      const news = [...tmp.children];
      if (olds[0] && news[0] && olds[0].dataset.secId) news[0].dataset.secId = olds[0].dataset.secId;
      if (i0 < list.length) for (const n of news) list[i0].el.before(n);
      else if (list.length) { let at = list[list.length - 1].el; for (const n of news) { at.after(n); at = n; } }
      else for (const n of news) holder.appendChild(n);
      for (const o of olds) o.remove();
    }
    const out = holder.innerHTML || '<p><br></p>';
    if (out === html) return true;
    const r = await window.neo.writeChapter(book.id, chId, out, diskKnown[book.id + '/' + chId]);
    return !(r && typeof r.conflict === 'string');
  }

  // Edited in NEO and in Docs at once: both stay. NEO's is version N; the
  // Doc's comes in right after it as version G (NEO's own way of keeping
  // another device's copy, titled for where it came from).
  async function applyConflict(chId, blocks, name) {
    if (!book.chapterOrder.includes(chId)) return;
    const html = blocks.map(DB.toNeoHtml).join('') || '<p><br></p>';
    const titles = book.chapterTitles = book.chapterTitles || {};
    const was = (titles[chId] || '').trim();
    const when = new Date().toLocaleTimeString(NeoI18n.getLocale(), { hour: 'numeric', minute: '2-digit' });
    const g = (was || name) + ' ' + t('(version G — Google Docs, {time})', { time: when });
    if (!/\(version N\)$/.test(was)) titles[chId] = (was ? was + ' ' : '') + t('(version N)');
    const keep = window.twinChapterTitle;
    window.twinChapterTitle = () => g;
    try {
      await keepOtherDeviceVersion(book.id, chId, html);
    } finally {
      window.twinChapterTitle = keep;
    }
    toast(t('“{name}” changed here and in Google Docs. Both are kept: version N is yours from NEO, version G (right after it) is from Docs.', { name }), 12000);
  }

  // Someone typed in the Master Manuscript; it was put back. Show what they
  // typed, so it can be made here.
  function showMasterEdits(edits) {
    if (document.querySelector('.nd-master')) return;
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    const rows = edits.slice(0, 10).map((e) => `
      <div style="margin:0 0 12px">
        ${e.name ? `<div style="opacity:.6;font-size:12px;margin-bottom:2px">${escapeHTML(e.name)}</div>` : ''}
        <div style="opacity:.7;text-decoration:line-through">${escapeHTML(e.before || t('(nothing)'))}</div>
        <div>${escapeHTML(e.after || t('(deleted)'))}</div>
      </div>`).join('');
    bd.innerHTML = `
      <div class="modal nd-master" style="width:520px;max-height:80vh;overflow:auto">
        <h2 style="font-size:16px">${t('Edits in the Master Manuscript were undone')}</h2>
        <p>${t('The Master Manuscript is a reading copy. Make these changes here in NEO (or in the chapter’s own Doc):')}</p>
        ${rows}
        <div style="text-align:right;margin-top:14px"><button class="m-ok btn-gold">${t('OK')}</button></div>
      </div>`;
    document.body.appendChild(bd);
    bd.querySelector('.m-ok').onclick = () => bd.remove();
    bd.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); bd.remove(); } });
  }

  async function openInDrive(what) {
    if (!book) { toast(t('Open a book first.')); return; }
    const r = await window.neo.neoDrive({ op: 'open', what, uuid: book.uuid, chId: currentChapterId || book.chapterOrder[0] });
    if (r && r.error) toast(t('This book hasn’t been synced to Google Drive yet.'));
  }

  function driveStatus(msg) {
    drive = { ...drive, ...msg };
    if (msg.note === 'connected') toast(t('Connected to Google Drive{as}. Open a book and it syncs on its own.', { as: msg.email ? ' — ' + msg.email : '' }), 8000);
    if (msg.note === 'connect-failed') toast(t('Google Drive: {msg}', { msg: msg.message || '' }), 8000);
    if (msg.note === 'disconnected') toast(t('Google Drive disconnected. Your Docs stay in your Drive.'), 6000);
  }

  if (window.neo.neoDrive && DB) {
    window.neo.neoDrive({ op: 'status' }).then((s) => { if (s) drive = { ...drive, ...s }; }).catch(() => {});
    setInterval(() => { driveTick(false).catch(() => {}); }, SYNC_EVERY);
    window.NeoDrive = { tick: driveTick, model: () => bookModel() }; // for tests
  }

  // ------------------------------------------------------------ menu bridge
  window.neo.onMenu((msg) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('nd-')) return;
    if (msg.type === 'nd-format' && ['italic', 'bold', 'underline'].includes(msg.cmd)) applyFormat(msg.cmd);
    if (msg.type === 'nd-fixApostrophes') fixApostrophes(msg.x, msg.y);
    if (msg.type === 'nd-status') driveStatus(msg);
    if (msg.type === 'nd-open') openInDrive(msg.what);
    if (msg.type === 'nd-syncNow') {
      if (!book) { if (!msg.quiet) toast(t('Open a book to sync it.')); return; }
      driveTick(true).then((r) => { if (r && r.ok && !msg.quiet) toast(t('Synced with Google Drive.')); });
    }
  });
})();
