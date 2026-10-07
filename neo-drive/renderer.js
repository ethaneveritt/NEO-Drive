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

  // ------------------------------------------------------------ menu bridge
  window.neo.onMenu((msg) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('nd-')) return;
    if (msg.type === 'nd-format' && ['italic', 'bold', 'underline'].includes(msg.cmd)) applyFormat(msg.cmd);
    if (msg.type === 'nd-fixApostrophes') fixApostrophes(msg.x, msg.y);
  });
})();
