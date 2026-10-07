// NEO-Drive: the room to the right of the page.
//
// A small bar sticks out from the window's right edge: Comments, Chapter
// Notes, Notepad, and an arrow that tucks it away (only the arrow stays).
// Clicking one opens it as a pane down the right side, one at a time; the
// page moves over (and narrows, in a small window) to make room. Clicking
// the open one closes the pane again.
//
// This takes the place of NEO's own Notes & Comments pane on the manuscript
// (hidden by CSS here, not removed from NEO's code: the Outline still uses
// that pane for its loose cards). NEO's placeholders (Ctrl+Shift+X) become
// a kind of comment: the flag shows in the page only while Comments is open,
// and its note is a card beside it.
//
//   Comments       Google Docs comments beside the passage they're on
//                  (highlighted), and placeholders beside their flags.
//                  Resolve; Edit on your own. Select words, right-click →
//                  Add Comment… to make one.
//   Chapter Notes  a note per chapter, following the chapter you're in
//   Notepad        the book's Notes page
//
// The Notes tab gets the same three as its own heading: Notepad (NEO's
// Notes page, as it always was), Comments (every comment, with Jump to) and
// Chapter Notes (every chapter's note).
//
// Chapter Notes are kept beside the book (neo-drive-chapter-notes.json);
// the Notepad is NEO's own notes file. Both go to the book's Notes folder in
// Google Drive and come back from it (see syncNotes in sync.js).
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const call = (msg) => window.neo.neoDrive(msg);
  const CN_FILE = 'neo-drive-chapter-notes';

  let mode = '';               // '' | 'comments' | 'chapter' | 'notepad'
  let comments = [];           // open comments, from Google Docs and made here
  let seenIds = null;          // the comment ids already shown for this book
  let active = '';             // the comment picked out
  let draft = null;            // a comment being written: {range, chId, quote}
  let editing = '';            // the id of the comment being edited
  let held = null;             // a newer list, waiting for the editing to end
  let forBook = null;          // the book the notes below belong to
  let chapterNotes = null;     // {chId: text}, once read
  let notepadDisk = null;      // the Notes page as last read from disk
  let sent = null;             // the notes as last handed to the sync
  let connected = false;

  // ------------------------------------------------------------- the look
  const st = document.createElement('style');
  st.textContent = `
    :root { --nd-dock-w: clamp(220px, 25vw, 340px); --nd-pw: calc((var(--page-w) + var(--page-gutter)) * var(--page-zoom, 1)); }
    /* NEO's Notes & Comments pane gives way to the dock, except on the Outline (its loose cards) */
    #editor-view:not(.outline-tab) #side-pane, #editor-view:not(.outline-tab) #side-hotzone { display: none !important; }
    #editor-view.side-pinned:not(.outline-tab) #paper-scroll { left: 50%; }
    #editor-view.side-pinned.nav-pinned:not(.outline-tab) #paper-scroll { left: calc(50% + 124px * var(--ui-zoom, 1)); }
    /* the open dock: the page moves left as far as it must, and narrows when the window is small */
    #editor-view.nd-docked:not(.outline-tab) #paper-scroll {
      width: min(var(--nd-pw), calc(100vw - var(--nd-dock-w) - 16px));
      left: min(50vw, calc(100vw - var(--nd-dock-w) - min(var(--nd-pw), calc(100vw - var(--nd-dock-w) - 16px)) / 2 - 8px)); }
    #editor-view.nd-docked.nav-pinned:not(.outline-tab) #paper-scroll {
      width: min(var(--nd-pw), calc(100vw - 248px * var(--ui-zoom, 1) - var(--nd-dock-w) - 16px));
      left: calc(248px * var(--ui-zoom, 1) + (100vw - 248px * var(--ui-zoom, 1) - var(--nd-dock-w)) / 2); }
    /* placeholders show only while Comments is open */
    body:not(.nd-flags) #chapters .ph-mark { display: none; }

    #nd-dock { position: fixed; right: 0; top: 30px; z-index: 66; -webkit-app-region: no-drag; font-size: 12px; }
    #nd-dock .nd-bar { display: flex; align-items: center; gap: 2px; background: var(--pane);
      border: 1px solid color-mix(in srgb, var(--muted) 22%, transparent); border-right: none; border-radius: 8px 0 0 8px;
      padding: 3px 8px 3px 2px; box-shadow: -6px 0 18px rgba(0,0,0,.18); }
    #nd-dock .nd-bar button { background: none; border: none; color: var(--muted); padding: 5px 7px; border-radius: 5px; white-space: nowrap;
      transition: color .15s ease, background .15s ease; }
    #nd-dock .nd-bar button:hover { color: var(--accent); }
    #nd-dock .nd-bar button.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
    #nd-dock .nd-bar .nd-arrow, #nd-dock .nd-tab { font-size: 15px; line-height: 1; padding: 5px 6px; }
    #nd-dock .n { font-size: 10px; margin-left: 4px; opacity: .8; }
    #nd-dock .nd-tab { display: none; background: var(--pane); color: var(--muted); border: 1px solid color-mix(in srgb, var(--muted) 22%, transparent);
      border-right: none; border-radius: 8px 0 0 8px; padding: 10px 5px; box-shadow: -6px 0 18px rgba(0,0,0,.18); }
    #nd-dock .nd-tab:hover { color: var(--accent); }
    #nd-dock.tucked .nd-bar { display: none; }
    #nd-dock.tucked .nd-tab { display: block; }
    #nd-dock .nd-body { display: none; }
    /* open: the bar stays as it is; below it, Chapter Notes and Notepad sit
       in a soft box over the right of the page, and comment cards float free */
    #nd-dock.open { bottom: calc(40px * var(--ui-zoom, 1) + 18px); width: var(--nd-dock-w); display: flex; flex-direction: column; align-items: flex-end; }
    #nd-dock.open .nd-body { display: block; position: relative; flex: 1; min-height: 0; align-self: stretch; margin: 10px 16px 0 0; }
    #nd-dock.open.boxed .nd-body { background: var(--pane); border: 1px solid color-mix(in srgb, var(--muted) 25%, transparent);
      border-radius: 8px; box-shadow: 0 4px 22px rgba(0,0,0,.22); }

    #nd-panel { position: absolute; inset: 14px 16px 14px 16px; display: flex; flex-direction: column; }
    #nd-panel .nd-p-head { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--muted); margin-bottom: 10px; }
    #nd-panel .nd-p-head b { display: block; font-size: 13px; letter-spacing: 0; text-transform: none; font-weight: 600;
      color: inherit; margin-top: 3px; font-family: var(--body-font); }
    #nd-panel textarea, #nd-panel .nd-pad { flex: 1; width: 100%; background: none; border: none; outline: none; resize: none;
      color: inherit; font-family: var(--body-font); font-size: 14px; line-height: 1.6; overflow-y: auto; }
    #nd-panel .nd-pad p { margin: 0 0 .4em; }
    #nd-panel textarea::placeholder { color: var(--muted); opacity: .6; font-style: italic; }
    #nd-panel .nd-pad:empty::before { content: attr(data-ph); color: var(--muted); opacity: .6; font-style: italic; }

    #nd-margin { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
    .nd-card.nd-flag { border-left-color: var(--red); }
    .nd-card.nd-flag.active { border-left-color: var(--red); }
    .nd-card { position: absolute; left: 0; right: 0; pointer-events: auto; background: var(--bg);
      border: 1px solid color-mix(in srgb, var(--muted) 25%, transparent); border-left: 3px solid var(--nd-google);
      border-radius: 6px; padding: 8px 10px; font-size: 12.5px; line-height: 1.45; cursor: default;
      transition: top .12s ease, box-shadow .12s ease; }
    .nd-card.active { box-shadow: 0 2px 14px rgba(0,0,0,.35); z-index: 2; }
    .nd-card.mine, .nd-card.nd-draft, .nd-list .nd-item.mine { border-left-color: var(--nd-mine); }
    .nd-card.active:not(.mine):not(.nd-flag):not(.nd-draft) { border-left-width: 4px; }
    .nd-card.lost { border-left-color: var(--muted); }
    .nd-c-who { font-weight: 600; font-size: 11.5px; }
    .nd-c-lost { font-size: 10.5px; color: var(--muted); font-style: italic; margin-top: 2px; }
    .nd-c-body { margin: 3px 0 2px; white-space: pre-wrap; word-wrap: break-word; }
    .nd-c-reply { margin: 5px 0 0 8px; padding-left: 8px; border-left: 2px solid color-mix(in srgb, var(--muted) 30%, transparent); white-space: pre-wrap; }
    .nd-c-actions { text-align: right; margin-top: 4px; }
    .nd-c-actions button, .nd-list .nd-c-actions button { background: none; border: none; color: var(--muted); font-size: 11px; margin-left: 10px; }
    .nd-c-actions button:hover { color: var(--accent); }
    .nd-c-actions button.go { color: var(--accent); }
    .nd-card textarea { width: 100%; min-height: 54px; background: var(--bg); color: inherit; border: 1px solid color-mix(in srgb, var(--muted) 35%, transparent);
      border-radius: 4px; padding: 5px 6px; font: inherit; resize: vertical; outline: none; margin-top: 4px; }
    .nd-card textarea:focus { border-color: var(--accent); }
    /* Google Docs comments yellow, your own blue, placeholders red */
    :root { --nd-google: #e2b93b; --nd-mine: #5b8fd6; }
    ::highlight(nd-comment) { background: rgba(240, 196, 60, 0.28); }
    ::highlight(nd-comment-active) { background: rgba(240, 186, 40, 0.55); }
    ::highlight(nd-mine) { background: rgba(91, 143, 214, 0.28); }
    ::highlight(nd-mine-active) { background: rgba(91, 143, 214, 0.55); }

    #nd-notes-head { display: flex; justify-content: center; gap: 28px; margin-bottom: 40px; }
    #nd-notes-head button { background: none; border: none; font-family: var(--body-font); font-weight: 400; letter-spacing: 3px;
      text-transform: uppercase; font-size: 14px; color: #777; opacity: .35; transition: opacity .15s ease; }
    #nd-notes-head button:hover { opacity: .75; }
    #nd-notes-head button.on { opacity: 1; cursor: default; }
    .nd-list { font-family: var(--body-font); font-size: calc(15px * var(--page-zoom, 1)); line-height: 1.55; }
    .nd-list .nd-empty { text-align: center; color: #999; font-style: italic; padding: 30px 0; }
    .nd-list h3 { font-size: .8em; text-transform: uppercase; letter-spacing: 2px; color: #888; font-weight: 400; margin: 28px 0 10px; }
    .nd-list h3:first-child { margin-top: 0; }
    .nd-list .nd-item { border-left: 3px solid var(--nd-google); padding: 4px 0 4px 12px; margin-bottom: 16px; }
    .nd-list .nd-q { color: #888; font-style: italic; margin-bottom: 3px; }
    .nd-list .nd-c-actions { text-align: left; }
    .nd-list .nd-c-actions button { margin: 0 14px 0 0; font-size: 12px; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
    .nd-list textarea { width: 100%; min-height: 3.4em; background: none; border: none; border-bottom: 1px solid rgba(128,128,128,.25);
      color: inherit; font: inherit; resize: none; outline: none; overflow: hidden; padding: 2px 0 6px; }
    .nd-list textarea:focus { border-bottom-color: var(--accent); }
    .nd-list textarea::placeholder { color: #aaa; font-style: italic; }`;
  document.head.appendChild(st);

  // ----------------------------------------------------------- the pieces
  const dock = document.createElement('div');
  dock.id = 'nd-dock';
  dock.hidden = true;
  dock.innerHTML = `<button class="nd-tab" title="${esc(t('Comments, Chapter Notes, Notepad'))}">‹</button>
    <div class="nd-bar"><button class="nd-arrow" title="${esc(t('Tuck away'))}">›</button><button data-m="comments">${t('Comments')}<span class="n"></span></button><button data-m="chapter">${t('Chapter Notes')}</button><button data-m="notepad">${t('Notepad')}</button></div>
    <div class="nd-body"><div id="nd-panel" hidden></div><div id="nd-margin" hidden></div></div>`;
  const toggles = dock.querySelector('.nd-bar');
  const panel = dock.querySelector('#nd-panel');
  const margin = dock.querySelector('#nd-margin');
  let tucked = false;
  try { const kept = JSON.parse(localStorage.getItem('nd-dock') || '{}'); tucked = !!kept.tucked; mode = kept.mode || ''; } catch { /* first time */ }
  const keep = () => { try { localStorage.setItem('nd-dock', JSON.stringify({ tucked, mode })); } catch { /* not kept */ } };
  dock.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // the caret stays in the page
  toggles.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('nd-arrow')) { tucked = true; setMode(''); return; }
    setMode(mode === b.dataset.m ? '' : b.dataset.m);
  });
  dock.querySelector('.nd-tab').addEventListener('click', () => { tucked = false; setMode(''); });
  document.body.append(dock);

  const onManuscript = () => !!(book && currentTab === 'manuscript' && !$('#editor-view').hidden && !$('#paper').hidden);

  function setMode(m) {
    if (mode === 'chapter') saveChapterNotes();
    if (mode === 'notepad') savePad();
    if (m !== 'comments') { draft = null; editing = ''; }
    mode = m;
    if (m) tucked = false;
    keep();
    toggles.querySelectorAll('button').forEach((b) => b.classList.toggle('on', !!mode && b.dataset.m === mode));
    drawPanel();
    refreshComments();
  }

  let lastRoom = '';
  function placeAll() {
    const show = onManuscript() && !!window.NeoDrive;
    dock.hidden = !show;
    dock.classList.toggle('tucked', tucked && !mode);
    dock.classList.toggle('open', !!mode);
    dock.classList.toggle('boxed', mode === 'chapter' || mode === 'notepad');
    $('#editor-view').classList.toggle('nd-docked', show && !!mode);
    panel.hidden = !show || (mode !== 'chapter' && mode !== 'notepad');
    margin.hidden = !show || mode !== 'comments';
    document.body.classList.toggle('nd-flags', !margin.hidden);
    if (!margin.hidden) {
      const r = margin.getBoundingClientRect();
      const key = Math.round(r.left) + ',' + Math.round(r.width) + ',' + Math.round($('#paper').getBoundingClientRect().width);
      if (key !== lastRoom) { lastRoom = key; layout(); }
    }
    if (margin.hidden) unpaint();
  }

  // --------------------------------------------------------- Chapter Notes
  // {chId: text} beside the book, read when the book opens, saved a moment
  // after each change.
  function loadNotes() {
    if (!book || forBook === book.id) return;
    const id = forBook = book.id;
    chapterNotes = null;
    notepadDisk = null;
    sent = null;
    comments = [];
    found = new Map();
    seenIds = null;
    active = '';
    draft = null;
    editing = '';
    window.neo.readJSON(id, CN_FILE, {}).then((v) => {
      if (forBook === id) { chapterNotes = (v && typeof v === 'object') ? v : {}; if (mode === 'chapter') drawPanel(); }
    }, () => { if (forBook === id) chapterNotes = {}; });
    readPad();
  }
  let cnTimer = 0;
  function saveChapterNotes() {
    clearTimeout(cnTimer);
    if (!chapterNotes || !forBook) return;
    const id = forBook;
    const data = { ...chapterNotes };
    window.neo.writeJSON(id, CN_FILE, data).catch((err) => window.neo.logError('NEO-Drive chapter notes: ' + err));
  }
  function setChapterNote(chId, text) {
    if (!chapterNotes) return;
    if (text) chapterNotes[chId] = text;
    else delete chapterNotes[chId];
    clearTimeout(cnTimer);
    cnTimer = setTimeout(saveChapterNotes, 600);
  }
  function storyChapters() {
    return book.chapterOrder.filter((c) => chapterKind(c) !== 'contents');
  }
  function chapterTitle(chId) {
    return chapterHeading(chId) || chapterName(chId);
  }

  // -------------------------------------------------------------- Notepad
  // NEO's own Notes page (notes.html beside the book). Whatever is newest
  // wins: the page open on the Notes tab, a save still on its way, the file.
  function readPad() {
    if (!book) return;
    const id = book.id;
    window.neo.readAux(id, 'notes').then((h) => { if (forBook === id) notepadDisk = h || ''; }, () => {});
  }
  function padHtml() {
    if (!book) return null;
    const ed = $('#aux-editor');
    if (currentTab === 'notes' && ed.dataset.kind === 'notes' && ed.dataset.book === book.id) return ed.innerHTML;
    const box = panel.querySelector('.nd-pad');
    if (box && mode === 'notepad') return box.innerHTML;
    const p = auxPending[book.id + '/notes'];
    if (p) return p.html;
    return notepadDisk;
  }
  function writePad(html) {
    if (!book) return;
    auxPending[book.id + '/notes'] = { bookId: book.id, kind: 'notes', html, inFlight: false };
    notepadDisk = html;
    flushAux();
  }
  let padTimer = 0;
  function savePad() {
    clearTimeout(padTimer);
    const box = panel.querySelector('.nd-pad');
    if (box && box.dataset.dirty) { delete box.dataset.dirty; writePad(box.innerHTML); }
  }

  // The notes as Docs paragraphs. A line that isn't a paragraph of its own
  // (loose text, a list, a div) is made one first, so nothing is dropped.
  function padBlocks(html) {
    const holder = document.createElement('div');
    holder.innerHTML = html || '';
    const out = document.createElement('div');
    let loose = null;
    const end = () => { if (loose) { out.appendChild(loose); loose = null; } };
    const para = (inner) => { const p = document.createElement('p'); p.innerHTML = inner; out.appendChild(p); };
    for (const n of [...holder.childNodes]) {
      if (n.nodeType === 1 && n.tagName === 'P') { end(); out.appendChild(n); }
      else if (n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName)) { end(); for (const li of n.children) para(li.innerHTML); }
      else if (n.nodeType === 1 && /^(DIV|H[1-6]|LI|BLOCKQUOTE|SECTION)$/.test(n.tagName)) {
        end();
        if (n.querySelector('p')) n.querySelectorAll('p').forEach((p) => out.appendChild(p.cloneNode(true)));
        else para(n.innerHTML);
      } else if (n.nodeType === 1 && n.tagName === 'BR') { if (loose) end(); else para(''); }
      else { if (!loose) loose = document.createElement('p'); loose.appendChild(n); }
    }
    end();
    // a blank line is a paragraph too: the gaps between notes are kept
    const blocks = [];
    for (const p of out.children) {
      if (!p.textContent.replace(/\u00a0/g, ' ').trim()) { blocks.push({ k: 'p', text: '' }); continue; }
      for (const x of parasFromHtml(p.outerHTML)) blocks.push(window.NeoDriveBlocks.fromNeoPara(x));
    }
    while (blocks.length && !blocks[0].text) blocks.shift();
    while (blocks.length && !blocks[blocks.length - 1].text) blocks.pop();
    return blocks;
  }

  // Pasting into the Notepad (here or on the Notes tab) keeps the blank
  // lines between notes. NEO's own paste cleaning closes them up, which
  // suits a manuscript, so each gap is held by a marker through it.
  const GAP = '\uE001';
  function gapHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const BLOCK = /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE|SECTION|ARTICLE|UL|OL|TABLE)$/;
    for (const el of [...doc.body.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6')]) {
      if (!el.textContent.replace(/\u00a0/g, ' ').trim() && !el.querySelector('p, div, li')) el.textContent = GAP;
    }
    // a <br> between blocks (how Google Docs copies a blank line), or a second one in a row
    for (const br of [...doc.body.querySelectorAll('br')]) {
      let prev = br.previousSibling;
      while (prev && prev.nodeType === 3 && !prev.data.trim()) prev = prev.previousSibling;
      if (prev && prev.nodeType === 1 && (BLOCK.test(prev.tagName) || prev.tagName === 'BR')) {
        const p = doc.createElement('p');
        p.textContent = GAP;
        br.replaceWith(p);
      }
    }
    return doc.body.innerHTML;
  }
  function pasteNotes(e) {
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    if (!html && !text) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    let out;
    if (html) {
      out = cleanPasteHtml(gapHtml(html));
      if (out.includes(GAP)) out = out.split(`<p>${GAP}</p>`).join('<p><br></p>').split(GAP).join('');
    } else {
      const lines = text.replace(/\r/g, '').split('\n');
      out = lines.length === 1 ? esc(lines[0]) : lines.map((l) => (l.trim() ? `<p>${esc(l)}</p>` : '<p><br></p>')).join('');
    }
    if (out) document.execCommand('insertHTML', false, out);
  }
  // the Notes tab's Notepad: ahead of NEO's own paste
  document.addEventListener('paste', (e) => {
    const ed = e.target && e.target.closest && e.target.closest('#aux-editor');
    if (ed && ed.dataset.kind === 'notes') pasteNotes(e);
  }, true);
  const padToHtml = (blocks) => blocks.map((b) => window.NeoDriveBlocks.toNeoHtml({ ...b, ind: 'normal', ls: 200 })).join('');

  // ------------------------------------------------------------ the panel
  function drawPanel() {
    placeAll();
    if (mode === 'chapter') {
      const chId = (currentChapterId && book.chapterOrder.includes(currentChapterId)) ? currentChapterId : storyChapters()[0];
      panel.dataset.ch = chId || '';
      panel.innerHTML = `<div class="nd-p-head">${t('Chapter Notes')}<b></b></div><textarea spellcheck="true"></textarea>`;
      panel.querySelector('b').textContent = chId ? chapterTitle(chId) : '';
      const ta = panel.querySelector('textarea');
      ta.placeholder = chapterNotes ? t('Notes for this chapter…') : t('Reading…');
      ta.disabled = !chapterNotes || !chId;
      ta.value = (chapterNotes && chId && chapterNotes[chId]) || '';
      ta.addEventListener('input', () => setChapterNote(chId, ta.value));
    } else if (mode === 'notepad') {
      panel.innerHTML = `<div class="nd-p-head">${t('Notepad')}<b></b></div><div class="nd-pad" contenteditable="true" spellcheck="true"></div>`;
      panel.querySelector('b').textContent = book ? (book.title || t('Untitled')) : '';
      const box = panel.querySelector('.nd-pad');
      box.dataset.ph = t('Notes for the whole book…');
      const p = book && auxPending[book.id + '/notes'];
      box.innerHTML = (p ? p.html : notepadDisk) || '';
      box.addEventListener('input', () => {
        box.dataset.dirty = '1';
        notepadDisk = null; // the box is now the newest
        clearTimeout(padTimer);
        padTimer = setTimeout(savePad, 800);
      });
      box.addEventListener('paste', pasteNotes);
      box.addEventListener('blur', savePad);
    } else {
      panel.innerHTML = '';
    }
  }
  // Chapter Notes follow the chapter you're in (unless you're typing in them)
  function followChapter() {
    if (mode !== 'chapter' || panel.hidden) return;
    const ta = panel.querySelector('textarea');
    if (ta && document.activeElement === ta) return;
    const chId = currentChapterId && book.chapterOrder.includes(currentChapterId) ? currentChapterId : storyChapters()[0];
    if ((chId || '') !== panel.dataset.ch || (ta && ta.disabled && chapterNotes)) drawPanel();
  }

  // ------------------------------------------- finding a comment's passage
  // A chapter's text, paragraph after paragraph ("\n" between, as Docs
  // quotes it), with the text nodes it came from, to turn a place in the
  // text back into a place in the page.
  const indexes = new WeakMap();
  const dirty = new WeakSet();
  function indexOf(body) {
    let ix = indexes.get(body);
    if (ix && !dirty.has(body)) return ix;
    let text = '';
    const segs = []; // {start, node} for each text node; node null for a line break
    let first = true;
    for (const p of body.querySelectorAll('p')) {
      if (p.classList.contains('ghost') || p.closest('.darling-anchor')) continue;
      if (!first) { segs.push({ start: text.length, node: null }); text += '\n'; }
      first = false;
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = w.nextNode())) {
        if (n.nodeType === 1) {
          if (n.tagName === 'BR') { segs.push({ start: text.length, node: null }); text += '\n'; }
          continue;
        }
        if (n.parentElement && n.parentElement.closest('.ph-mark, .darling-anchor')) continue;
        segs.push({ start: text.length, node: n });
        text += n.data.replace(/ /g, ' ');
      }
    }
    ix = { text, segs };
    indexes.set(body, ix);
    dirty.delete(body);
    return ix;
  }
  // where a range starting (or ending) at `pos` in the text sits in the page
  function pointAt(ix, pos, atEnd) {
    const segs = ix.segs;
    if (!atEnd) {
      for (const g of segs) if (g.node && g.start + g.node.data.length > pos) return { node: g.node, offset: Math.max(0, pos - g.start) };
      return null;
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      const g = segs[i];
      if (g.node && g.start < pos) return { node: g.node, offset: Math.min(pos - g.start, g.node.data.length) };
    }
    return null;
  }
  function rangeFor(body, from, to) {
    const ix = indexOf(body);
    const a = pointAt(ix, from, false);
    const b = pointAt(ix, to, true);
    if (!a || !b) return null;
    const r = document.createRange();
    try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); } catch { return null; }
    return r;
  }
  const clean = (s) => String(s || '').replace(/\r\n?/g, '\n').replace(/[\u000b\u2028]/g, '\n').replace(/ /g, ' ').replace(/\uFFFC/g, '').trim();
  function findQuote(c) {
    const q = clean(c.quote);
    if (!q) return null;
    const bodies = [...document.querySelectorAll('#chapters .chapter-body')];
    const own = c.chId ? bodies.filter((b) => b.closest('.chapter').dataset.id === c.chId) : [];
    const order = own.length ? own : bodies;
    const tries = [q];
    if (q.length > 60) tries.push(q.slice(0, 40), q.slice(-40));
    for (const needle of tries) {
      for (const body of order) {
        const at = indexOf(body).text.indexOf(needle);
        if (at < 0) continue;
        const r = rangeFor(body, at, at + needle.length);
        if (r) return { range: r, chId: body.closest('.chapter').dataset.id };
      }
    }
    return null;
  }
  // a comment on the heading, or on words that are gone: by its chapter's
  // heading (or the title page)
  function fallbackAnchor(c) {
    if (c.chId) {
      const head = document.querySelector(`.chapter[data-id="${CSS.escape(c.chId)}"] .chapter-head`) || document.querySelector(`.chapter[data-id="${CSS.escape(c.chId)}"]`);
      if (head) return head;
    }
    return $('#title-page');
  }

  // ------------------------------------------------------ margin comments
  let found = new Map(); // id -> {range, chId} | null
  function match() {
    found = new Map();
    for (const c of comments) found.set(c.id, findQuote(c));
    margin.querySelectorAll('.nd-card[data-id]').forEach((el) => el.classList.toggle('lost', !found.get(el.dataset.id)));
    paint();
  }
  function paint() {
    if (!CSS.highlights) return;
    if (margin.hidden) { unpaint(); return; }
    const sets = { 'nd-comment': [], 'nd-comment-active': [], 'nd-mine': [], 'nd-mine-active': [] };
    for (const c of comments) {
      const f = found.get(c.id);
      if (f) sets[(c.mine ? 'nd-mine' : 'nd-comment') + (c.id === active ? '-active' : '')].push(f.range);
    }
    if (draft) sets['nd-mine-active'].push(draft.range);
    for (const [k, v] of Object.entries(sets)) CSS.highlights.set(k, new Highlight(...v));
  }
  function unpaint() {
    if (CSS.highlights) for (const k of ['nd-comment', 'nd-comment-active', 'nd-mine', 'nd-mine-active']) CSS.highlights.delete(k);
  }
  const fmtWhen = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(NeoI18n.getLocale(), { month: 'short', day: 'numeric' });
  };
  function cardHtml(c, lost) {
    const who = c.mine ? t('You') : (c.author || t('Someone'));
    return `
      <div class="nd-c-who">${esc(who)} <span style="font-weight:400;color:var(--muted)">${esc(fmtWhen(c.created))}</span></div>
      ${lost ? `<div class="nd-c-lost">${c.quote ? esc(t('On words that have changed: “{q}”', { q: c.quote.length > 80 ? c.quote.slice(0, 80) + '…' : c.quote })) : esc(t('On the whole Doc'))}</div>` : ''}
      <div class="nd-c-body"></div>
      ${(c.replies || []).map((r) => `<div class="nd-c-reply"><span class="nd-c-who">${esc(r.author)}</span> ${esc(r.content)}</div>`).join('')}
      <div class="nd-c-actions">${c.mine ? `<button class="edit">${t('Edit')}</button>` : ''}<button class="resolve">${t('Resolve')}</button></div>`;
  }
  // NEO's placeholders (Ctrl+Shift+X): a flag in the page and a note,
  // shown here as a kind of comment, kept by NEO as it always kept them
  const flags = () => (Array.isArray(stickies) ? stickies : []).filter((x) => !x.resolved);
  const flagMark = (sid) => document.querySelector(`#chapters .ph-mark[data-sid="${CSS.escape(sid)}"]`);
  function count() {
    const n = comments.length + flags().length;
    toggles.querySelector('.n').textContent = n ? String(n) : '';
  }
  // where a card belongs on the page: its words, its flag, or its chapter
  function anchorTop(id) {
    if (id.startsWith('flag:')) {
      const m = flagMark(id.slice(5));
      if (m) { const r = m.getBoundingClientRect(); if (r.height) return r.top; }
      const s = flags().find((x) => x.id === id.slice(5));
      const a = fallbackAnchor({ chId: s && s.chapterId });
      return a ? a.getBoundingClientRect().top : 0;
    }
    const c = comments.find((x) => x.id === id);
    const f = c && found.get(c.id);
    const y = f ? rectTop(f.range) : null;
    if (y != null) return y;
    const a = c && fallbackAnchor(c);
    return a ? a.getBoundingClientRect().top : 0;
  }
  function flagCard(s) {
    const el = document.createElement('div');
    el.className = 'nd-card nd-flag' + ('flag:' + s.id === active ? ' active' : '');
    el.dataset.id = 'flag:' + s.id;
    el.innerHTML = `<div class="nd-c-who">⚑ ${t('Placeholder')}</div><textarea spellcheck="true" placeholder="${esc(t('What needs doing here?'))}"></textarea>
      <div class="nd-c-actions"><button class="resolve">${t('Resolve')}</button></div>`;
    const ta = el.querySelector('textarea');
    ta.value = s.text || '';
    ta.style.minHeight = '34px';
    ta.addEventListener('input', () => { s.text = ta.value; scheduleStickiesSave(); });
    ta.addEventListener('focus', () => { if (active !== el.dataset.id) activate(el.dataset.id); });
    // Enter: back to the page, just past the flag (Shift+Enter: another line)
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      returnToMark(s.id);
    });
    el.addEventListener('mousedown', (e) => { if (!e.target.closest('button, textarea')) activate(el.dataset.id); });
    el.querySelector('.resolve').onclick = () => { if (active === el.dataset.id) active = ''; resolveSticky(s.id); };
    return el;
  }

  function buildCards() {
    margin.innerHTML = '';
    count();
    if (draft) {
      const el = document.createElement('div');
      el.className = 'nd-card active nd-draft';
      el.innerHTML = `<div class="nd-c-who">${t('You')}</div><textarea placeholder="${esc(t('Comment…'))}"></textarea>
        <div class="nd-c-actions"><button class="cancel">${t('Cancel')}</button><button class="go">${t('Comment')}</button></div>`;
      const ta = el.querySelector('textarea');
      el.querySelector('.cancel').onclick = () => { draft = null; buildCards(); };
      el.querySelector('.go').onclick = () => postDraft(ta.value, el);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postDraft(ta.value, el); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); draft = null; buildCards(); }
      });
      margin.appendChild(el);
    }
    for (const c of comments) {
      const lost = !found.get(c.id);
      const el = document.createElement('div');
      el.className = 'nd-card' + (c.mine ? ' mine' : '') + (c.id === active ? ' active' : '') + (lost ? ' lost' : '');
      el.dataset.id = c.id;
      el.innerHTML = cardHtml(c, lost);
      el.querySelector('.nd-c-body').textContent = c.content;
      el.addEventListener('mousedown', (e) => { if (!e.target.closest('button, textarea')) { activate(c.id); } });
      el.querySelector('.resolve').onclick = () => resolve(c, el);
      const ed = el.querySelector('.edit');
      if (ed) ed.onclick = () => startEdit(c, el);
      margin.appendChild(el);
    }
    for (const f of flags()) margin.appendChild(flagCard(f));
    paint();
    layout();
    const ta = margin.querySelector('.nd-draft textarea');
    if (ta) ta.focus({ preventScroll: true });
  }
  // Each card level with its passage; cards that would overlap are nudged
  // down, except the picked one, which stays level with its words and moves
  // the others out of its way.
  function layout() {
    if (margin.hidden) return;
    const top0 = margin.getBoundingClientRect().top;
    const cards = [...margin.children].map((el) => {
      let y;
      if (el.classList.contains('nd-draft')) y = rectTop(draft && draft.range);
      else y = anchorTop(el.dataset.id);
      return { el, y: (y == null ? 0 : y) - top0, h: el.offsetHeight };
    });
    cards.sort((a, b) => a.y - b.y);
    const gap = 8;
    const pin = cards.findIndex((k) => k.el.classList.contains('active'));
    if (pin < 0) {
      let at = -Infinity;
      for (const k of cards) { k.top = Math.max(k.y, at); at = k.top + k.h + gap; }
    } else {
      cards[pin].top = cards[pin].y;
      let at = cards[pin].top + cards[pin].h + gap;
      for (let i = pin + 1; i < cards.length; i++) { cards[i].top = Math.max(cards[i].y, at); at = cards[i].top + cards[i].h + gap; }
      at = cards[pin].top - gap;
      for (let i = pin - 1; i >= 0; i--) { cards[i].top = Math.min(cards[i].y, at - cards[i].h); at = cards[i].top - gap; }
    }
    for (const k of cards) k.el.style.top = Math.round(k.top) + 'px';
  }
  function rectTop(r) {
    if (!r) return null;
    const rects = r.getClientRects();
    for (const x of rects) if (x.width || x.height) return x.top;
    const b = r.getBoundingClientRect();
    return (b.width || b.height) ? b.top : null;
  }
  function activate(id, scroll) {
    active = id;
    margin.querySelectorAll('.nd-card').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
    paint();
    if (scroll) {
      const f = found.get(id);
      const c = comments.find((x) => x.id === id);
      const el = id.startsWith('flag:') ? (flagMark(id.slice(5)) || fallbackAnchor({ chId: (flags().find((x) => 'flag:' + x.id === id) || {}).chapterId }))
        : f ? f.range.startContainer.parentElement : (c && fallbackAnchor(c));
      if (el) el.scrollIntoView({ block: 'center' });
    }
    layout();
  }
  // a click on highlighted words picks out their comment
  document.addEventListener('mouseup', (e) => {
    if (mode !== 'comments' || margin.hidden || !e.target.closest || !e.target.closest('#chapters')) return;
    let node = null, off = 0;
    if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(e.clientX, e.clientY); if (p) { node = p.offsetNode; off = p.offset; } }
    else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(e.clientX, e.clientY); if (r) { node = r.startContainer; off = r.startOffset; } }
    if (!node) return;
    for (const c of comments) {
      const f = found.get(c.id);
      try { if (f && f.range.isPointInRange(node, off)) { if (active !== c.id) activate(c.id); return; } } catch { /* other doc */ }
    }
  });

  function refreshComments() {
    placeAll();
    if (mode !== 'comments' || margin.hidden) { paint(); return; }
    match();
    buildCards();
  }

  function setComments(list) {
    list = list || [];
    if (editing || draft || margin.contains(document.activeElement)) { held = list; return; }
    held = null;
    const key = (l) => JSON.stringify(l.map((c) => [c.id, c.content, c.quote, (c.replies || []).length]));
    const changed = key(list) !== key(comments);
    const fresh = seenIds ? list.filter((c) => !seenIds.has(c.id)) : [];
    seenIds = new Set([...(seenIds || []), ...list.map((c) => c.id)]);
    comments = list;
    count();
    if (fresh.length && mode !== 'comments') {
      const who = [...new Set(fresh.map((c) => c.author).filter(Boolean))].join(', ');
      toast(fresh.length === 1
        ? t('A new comment from Google Docs{who} — Comments, at the right edge', { who: who ? ' (' + who + ')' : '' })
        : t('{n} new comments from Google Docs — Comments, at the right edge', { n: fresh.length }), 7000);
    }
    if (changed) { refreshComments(); if (notesView === 'comments') drawNotesView(); }
  }
  function release() {
    if (held && !editing && !draft && !margin.contains(document.activeElement)) setComments(held);
  }
  margin.addEventListener('focusout', () => setTimeout(release, 0));

  async function resolve(c, el) {
    el.style.opacity = '0.5';
    const r = await call({ op: 'resolve', docId: c.docId, commentId: c.id });
    if (r && r.ok) {
      comments = comments.filter((x) => x.id !== c.id);
      if (held) held = held.filter((x) => x.id !== c.id);
      count();
      if (active === c.id) active = '';
      refreshComments();
      if (notesView === 'comments') drawNotesView();
    } else {
      el.style.opacity = '';
      toast(t('Couldn’t resolve that comment in Google Docs: {msg}', { msg: (r && (r.message || r.error)) || '' }), 8000);
    }
  }

  function startEdit(c, el) {
    editing = c.id;
    const body = el.querySelector('.nd-c-body');
    const acts = el.querySelector('.nd-c-actions');
    body.innerHTML = '<textarea></textarea>';
    const ta = body.querySelector('textarea');
    ta.value = c.content;
    acts.innerHTML = `<button class="cancel">${t('Cancel')}</button><button class="go">${t('Save')}</button>`;
    const done = () => { editing = ''; release(); refreshComments(); if (notesView === 'comments') drawNotesView(); };
    const save = async () => {
      const content = ta.value.trim();
      if (!content || content === c.content) { done(); return; }
      ta.disabled = true;
      const r = await call({ op: 'editComment', docId: c.docId, commentId: c.id, content });
      if (r && r.ok) { c.content = content; if (held) { const h = held.find((x) => x.id === c.id); if (h) h.content = content; } }
      else toast(t('Couldn’t change that comment in Google Docs: {msg}', { msg: (r && (r.message || r.error)) || '' }), 8000);
      done();
    };
    acts.querySelector('.cancel').onclick = done;
    acts.querySelector('.go').onclick = save;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
    });
    ta.focus();
    layout();
  }

  // ---------------------------------------------------- a comment from NEO
  // The selected words: the chapter they're in, and their text as Docs
  // quotes it (paragraphs joined by a line break).
  function selectedPassage() {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    const at = (n) => (n.nodeType === 1 ? n : n.parentElement);
    const body = at(r.startContainer) && at(r.startContainer).closest('#chapters .chapter-body');
    if (!body) return null;
    const endBody = at(r.endContainer) && at(r.endContainer).closest('.chapter-body');
    const range = r.cloneRange();
    if (endBody !== body) range.setEnd(body, body.childNodes.length);
    const parts = [];
    for (const p of body.querySelectorAll('p')) {
      if (p.classList.contains('ghost') || !range.intersectsNode(p)) continue;
      const pr = document.createRange();
      pr.selectNodeContents(p);
      if (p.contains(range.startContainer) || p === range.startContainer) pr.setStart(range.startContainer, range.startOffset);
      if (p.contains(range.endContainer) || p === range.endContainer) pr.setEnd(range.endContainer, range.endOffset);
      parts.push(pr.toString().replace(/ /g, ' '));
    }
    const quote = parts.join('\n').trim();
    if (!quote) return null;
    return { range, chId: body.closest('.chapter').dataset.id, quote };
  }
  function startComment() {
    if (!book || currentTab !== 'manuscript') return;
    const p = selectedPassage();
    if (!p) { toast(t('Select the words you want to comment on, then Add Comment.')); return; }
    if (!connected) { toast(t('Connect Google Drive first (Google Drive menu): comments live in the chapter’s Google Doc.'), 7000); return; }
    editing = '';
    draft = p;
    window.getSelection().removeAllRanges();
    if (mode !== 'comments') setMode('comments');
    else refreshComments();
  }
  async function postDraft(text, el) {
    const content = String(text || '').trim();
    if (!content || !draft) return;
    el.querySelectorAll('button, textarea').forEach((x) => { x.disabled = true; });
    const d = draft;
    const r = await call({ op: 'addComment', uuid: book.uuid, chId: d.chId, quote: d.quote, content, where: chapterTitle(d.chId) });
    if (r && r.ok && r.comment) {
      draft = null;
      comments = [...comments.filter((c) => c.id !== r.comment.id), r.comment];
      if (seenIds) seenIds.add(r.comment.id);
      if (held) held = [...held.filter((c) => c.id !== r.comment.id), r.comment];
      count();
      active = r.comment.id;
      release();
      refreshComments();
    } else {
      el.querySelectorAll('button, textarea').forEach((x) => { x.disabled = false; });
      toast(t('Couldn’t add the comment in Google Docs: {msg}', { msg: (r && (r.message || r.error)) || '' }), 8000);
    }
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'm' || e.key === 'M' || e.code === 'KeyM')) {
      if (currentTab === 'manuscript' && book) { e.preventDefault(); startComment(); }
    }
  }, true);

  // --------------------------------------------------- the Notes tab head
  let notesView = 'notepad';
  const notesHead = document.createElement('div');
  notesHead.id = 'nd-notes-head';
  notesHead.hidden = true;
  notesHead.innerHTML = `<button data-v="notepad">${t('Notepad')}</button><button data-v="comments">${t('Comments')}</button><button data-v="chapter">${t('Chapter Notes')}</button>`;
  notesHead.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.v !== notesView) showNotesView(b.dataset.v);
  });
  const notesBody = document.createElement('div');
  notesBody.className = 'nd-list';
  notesBody.hidden = true;
  $('#aux-title').before(notesHead);
  $('#aux-editor').after(notesBody);

  function showNotesView(v) {
    notesView = v;
    notesHead.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    const ed = $('#aux-editor');
    if (v === 'notepad') {
      notesBody.hidden = true;
      notesBody.innerHTML = '';
      ed.hidden = false;
      if (ed.dataset.kind === 'notes') ed.focus({ preventScroll: true });
    } else {
      flushAux();
      ed.hidden = true;
      notesBody.hidden = false;
      drawNotesView();
    }
  }
  function drawNotesView() {
    if (notesBody.hidden || currentTab !== 'notes') return;
    if (notesView === 'comments') drawCommentList();
    else if (notesView === 'chapter') drawChapterList();
  }
  function drawCommentList() {
    if (editing) return;
    notesBody.innerHTML = '';
    if (!comments.length && !flags().length) {
      notesBody.innerHTML = `<div class="nd-empty">${connected ? t('No open comments. Comments on the chapter Docs (and the Master Manuscript) show here and beside the page.') : t('Connect Google Drive (Google Drive menu) and comments from the book’s Google Docs show here and beside the page.')}<br><br>${esc(t('Ctrl+Shift+X while writing plants a placeholder: a flag and a note to come back to.'))}</div>`;
      return;
    }
    // in the book's order, a heading per chapter
    if (!found.size || comments.some((c) => !found.has(c.id))) for (const c of comments) if (!found.has(c.id)) found.set(c.id, findQuote(c));
    const where = (c) => (found.get(c.id) && found.get(c.id).chId) || c.chId || '';
    const order = book.chapterOrder;
    const groups = new Map();
    for (const c of comments) {
      const k = where(c);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    for (const f of flags()) {
      const m = flagMark(f.id);
      const k = (m && m.closest('.chapter') && m.closest('.chapter').dataset.id) || f.chapterId || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ flag: f });
    }
    const keys = [...groups.keys()].sort((a, b) => (a ? order.indexOf(a) : 1e9) - (b ? order.indexOf(b) : 1e9));
    for (const k of keys) {
      const h = document.createElement('h3');
      h.textContent = k ? chapterTitle(k) : t('Master Manuscript');
      notesBody.appendChild(h);
      for (const c of groups.get(k)) {
        if (c.flag) { notesBody.appendChild(flagItem(c.flag)); continue; }
        const el = document.createElement('div');
        el.className = 'nd-item' + (c.mine ? ' mine' : '');
        el.dataset.id = c.id;
        el.innerHTML = `${c.quote ? `<div class="nd-q"></div>` : ''}${cardHtml(c, false)}`;
        if (c.quote) el.querySelector('.nd-q').textContent = '“' + (c.quote.length > 200 ? c.quote.slice(0, 200) + '…' : c.quote) + '”';
        el.querySelector('.nd-c-body').textContent = c.content;
        const acts = el.querySelector('.nd-c-actions');
        const jump = document.createElement('button');
        jump.className = 'go';
        jump.textContent = t('Jump to comment');
        jump.onclick = () => jumpTo(c.id);
        acts.prepend(jump);
        acts.querySelector('.resolve').onclick = () => resolve(c, el);
        const ed = acts.querySelector('.edit');
        if (ed) ed.onclick = () => startEdit(c, el);
        notesBody.appendChild(el);
      }
    }
  }
  function flagItem(f) {
    const el = document.createElement('div');
    el.className = 'nd-item';
    el.style.borderLeftColor = 'var(--red)';
    el.innerHTML = `<div class="nd-c-who">⚑ ${t('Placeholder')}</div><div class="nd-c-body"></div>
      <div class="nd-c-actions"><button class="go">${t('Jump to placeholder')}</button><button class="resolve">${t('Resolve')}</button></div>`;
    const body = el.querySelector('.nd-c-body');
    body.textContent = f.text || t('What needs doing here?');
    if (!f.text) body.style.opacity = '.5';
    el.querySelector('.go').onclick = () => jumpTo('flag:' + f.id);
    el.querySelector('.resolve').onclick = () => { resolveSticky(f.id); drawNotesView(); };
    return el;
  }
  function drawChapterList() {
    notesBody.innerHTML = '';
    if (!chapterNotes) { notesBody.innerHTML = `<div class="nd-empty">${t('Reading…')}</div>`; return; }
    for (const chId of storyChapters()) {
      const h = document.createElement('h3');
      h.textContent = chapterTitle(chId);
      const ta = document.createElement('textarea');
      ta.spellcheck = true;
      ta.placeholder = t('Notes for this chapter…');
      ta.value = chapterNotes[chId] || '';
      const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
      ta.addEventListener('input', () => { setChapterNote(chId, ta.value); grow(); });
      notesBody.append(h, ta);
      requestAnimationFrame(grow);
    }
  }
  function jumpTo(id) {
    switchTab('manuscript');
    if (mode !== 'comments') setMode('comments');
    else refreshComments();
    requestAnimationFrame(() => activate(id, true));
  }

  // NEO's placeholders arrive here instead of its Notes & Comments pane:
  // planting one (or clicking a flag) opens Comments at its note; whenever
  // NEO redraws its list, the cards follow.
  if (typeof window.focusSticky === 'function') {
    window.focusSticky = function (sid) {
      if (currentTab !== 'manuscript') switchTab('manuscript');
      if (mode !== 'comments') setMode('comments');
      else refreshComments();
      activate('flag:' + sid);
      const ta = margin.querySelector(`.nd-card[data-id="${CSS.escape('flag:' + sid)}"] textarea`);
      if (ta) ta.focus({ preventScroll: true });
    };
  }
  if (typeof window.renderStickies === 'function') {
    const own = window.renderStickies;
    window.renderStickies = function () {
      own.apply(this, arguments);
      try {
        count();
        if (mode === 'comments' && !margin.hidden) {
          // a note being typed in keeps its card; the rest just move
          const ids = [...margin.querySelectorAll('.nd-flag')].map((el) => el.dataset.id).join();
          if (margin.contains(document.activeElement) && ids === flags().map((f) => 'flag:' + f.id).join()) layout();
          else refreshComments();
        }
        if (currentTab === 'notes' && notesView === 'comments' && !notesBody.contains(document.activeElement)) drawNotesView();
      } catch (err) { window.neo.logError('NEO-Drive placeholders: ' + err); }
    };
  }

  // The Notes tab: the head above, Notepad open as NEO always opened it
  if (typeof window.switchTab === 'function') {
    const own = window.switchTab;
    window.switchTab = function (name) {
      if (mode === 'notepad') savePad();
      // leaving the Notes page: what it holds is the newest Notepad
      const ed = $('#aux-editor');
      if (book && currentTab === 'notes' && ed.dataset.kind === 'notes' && ed.dataset.book === book.id && forBook === book.id) notepadDisk = ed.innerHTML;
      const r = own.apply(this, arguments);
      try {
        const onNotes = currentTab === 'notes';
        notesHead.hidden = !onNotes;
        $('#aux-title').hidden = onNotes;
        if (onNotes) showNotesView('notepad');
        else { notesBody.hidden = true; notesBody.innerHTML = ''; }
        placeAll();
        if (currentTab === 'manuscript' && mode) setMode(mode);
      } catch (err) { window.neo.logError('NEO-Drive notes tab: ' + err); }
      return r;
    };
  }

  // ---------------------------------------- the notes, to and from Drive
  // What the sync sends to the book's Notes folder; null until both kinds
  // of notes have been read for this book, so an empty start never
  // overwrites the Docs.
  function notesForModel() {
    loadNotes();
    const html = padHtml();
    if (!chapterNotes || html == null) return null;
    const notepad = padBlocks(html);
    const chapters = {};
    for (const chId of book.chapterOrder) if (chapterNotes[chId]) chapters[chId] = chapterNotes[chId];
    const list = Array.isArray(darlings) ? darlings : [];
    const dl = list.map((d) => ({
      label: d.chapterLabel ? t('from {label}', { label: d.chapterLabel }) : '',
      date: d.date ? new Date(d.date).toLocaleDateString(NeoI18n.getLocale(), { year: 'numeric', month: 'short', day: 'numeric' }) : '',
      text: d.text || ''
    }));
    const notes = { notepad, chapters, darlings: dl };
    sent = { book: book.id, notepad: JSON.stringify(notepad.map(window.NeoDriveBlocks.blockKey)), chapters: JSON.stringify(chapters) };
    return notes;
  }

  // What came back: the Docs' text taken in. Where the notes changed here
  // too (since they were sent), nothing is lost: lines new in the Doc are
  // added under what's here.
  function applyNotes(pulls, conflicts) {
    if (!book || !sent || sent.book !== book.id) return;
    const DB = window.NeoDriveBlocks;
    const say = [];
    // Notepad
    const padNow = padHtml();
    const padMoved = padNow != null && JSON.stringify(padBlocks(padNow).map(DB.blockKey)) !== sent.notepad;
    const padIn = (pulls && pulls.notepad) || (conflicts && conflicts.notepad);
    if (padIn) {
      const merge = padMoved || !(pulls && pulls.notepad);
      let html;
      if (!merge) html = padToHtml(padIn);
      else {
        const have = new Set(padBlocks(padNow || '').map((b) => b.text.trim()));
        const extra = padIn.filter((b) => b.text.trim() && !have.has(b.text.trim()));
        html = extra.length ? (padNow || '') + `<p>${esc(t('— From Google Docs —'))}</p>` + padToHtml(extra) : null;
      }
      if (html != null) { putPad(html); say.push(t('Notepad')); }
    }
    // Chapter Notes
    const cnIn = (pulls && pulls.chapternotes) || (conflicts && conflicts.chapternotes);
    if (cnIn && chapterNotes) {
      const now = {};
      for (const chId of book.chapterOrder) if (chapterNotes[chId]) now[chId] = chapterNotes[chId];
      const merge = JSON.stringify(now) !== sent.chapters || !(pulls && pulls.chapternotes);
      let changed = false;
      for (const [chId, text] of Object.entries(cnIn)) {
        if (!book.chapterOrder.includes(chId)) continue;
        const mine = chapterNotes[chId] || '';
        let next = text;
        if (merge) {
          const have = new Set(mine.split('\n').map((x) => x.trim()));
          const extra = String(text || '').split('\n').filter((x) => x.trim() && !have.has(x.trim()));
          next = extra.length ? (mine ? mine + '\n' : '') + extra.join('\n') : mine;
        }
        if (next !== mine) { if (next) chapterNotes[chId] = next; else delete chapterNotes[chId]; changed = true; }
      }
      if (changed) {
        saveChapterNotes();
        say.push(t('Chapter Notes'));
        const ta = panel.querySelector('textarea');
        if (mode === 'chapter' && !(ta && document.activeElement === ta)) drawPanel();
        if (currentTab === 'notes' && notesView === 'chapter' && !notesBody.contains(document.activeElement)) drawChapterList();
      }
    }
    if (say.length) toast(t('Updated from Google Docs: {names}', { names: say.join(', ') }), 5000);
  }
  function putPad(html) {
    writePad(html);
    const ed = $('#aux-editor');
    if (ed.dataset.kind === 'notes' && ed.dataset.book === book.id) ed.innerHTML = html;
    const box = panel.querySelector('.nd-pad');
    if (box && mode === 'notepad') { box.innerHTML = html; delete box.dataset.dirty; }
  }

  // ------------------------------------------------------- keeping in step
  // The page moves under the cards as it scrolls; what was typed moves the
  // passages; a new book brings its own notes.
  let raf = 0;
  const soon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; layout(); }); };
  $('#paper-scroll').addEventListener('scroll', () => { if (mode === 'comments') soon(); }, { passive: true });
  window.addEventListener('resize', () => { placeAll(); soon(); });
  let rematchTimer = 0;
  new MutationObserver((list) => {
    let any = false;
    for (const m of list) {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const body = el && el.closest && el.closest('.chapter-body');
      if (body) { dirty.add(body); any = true; } else if (m.type === 'childList') any = true;
    }
    if (!any || mode !== 'comments') return;
    soon();
    clearTimeout(rematchTimer);
    rematchTimer = setTimeout(() => { if (mode === 'comments' && !margin.hidden) { match(); layout(); } }, 500);
  }).observe($('#chapters'), { subtree: true, childList: true, characterData: true });

  let lastShown = false;
  let ticks = 0;
  setInterval(() => {
    ticks++;
    if (book) count();
    if (book && forBook !== book.id) { loadNotes(); if (mode) setMode(mode); }
    if (!book && forBook) forBook = null;
    const shown = onManuscript();
    placeAll();
    if (shown && !lastShown && mode === 'comments') refreshComments();
    lastShown = shown;
    followChapter();
    // the Notes file, as it stands, for when the Notes page isn't open
    if (book && forBook === book.id && currentTab !== 'notes' && mode !== 'notepad' && !auxPending[book.id + '/notes'] && ticks % 30 === 0) readPad();
  }, 400);

  window.NeoDrivePanels = {
    setComments,
    setConnected(v) { connected = !!v; },
    startComment,
    notesForModel,
    applyNotes,
    get mode() { return mode; },
    setMode,
    get comments() { return comments; },
    found: () => found,
    showNotesView
  };
})();
