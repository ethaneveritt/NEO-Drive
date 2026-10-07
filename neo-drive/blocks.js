// NEO-Drive: the shape a manuscript takes in Google Docs, and the edits that
// turn one Doc into another. Pure functions, no network, no DOM.
//
// Every paragraph NEO-Drive writes is a plain one (Google's "Normal text"),
// set by hand the way Ethan sets his manuscript pages: Times New Roman 12,
// double-spaced, a half-inch first-line indent; a chapter heading is just a
// centered bold line. No heading styles, no extra space.
//
// A "block" is one such paragraph:
//   { k, text, marks, align, ind, pb, sa, sb, sz, ls }
//     k      'p', or 'brk' (the *** of a scene break)
//     text   the paragraph's characters, without its newline. A line break
//            inside a paragraph is '\u000b', as Google Docs stores it.
//     marks  [[start, end, flags]] — flags a string of b i u x (bold,
//            italic, underline, strikethrough)
//     align  'left' | 'center' | 'right' | 'justify'
//     ind    'normal' | 'flush' | 'poetry' — first-line indent, none, or a
//            left indent (a poem; a contents line inside a part)
//     pb     starts a new page
//     sa sb  space above / below, in points
//     sz     type size, in points
//     ls     line spacing, in percent (200 = double)
//
// Everything that decides whether two blocks are "the same" lives in
// blockKey(), and readDoc() reads back exactly what editRequests() writes,
// so a Doc NEO-Drive wrote reads back as the blocks it was written from.
(function (root) {
  'use strict';

  const FONT = 'Times New Roman';
  const SIZE = 12;
  const SPACING = 200;
  const INDENT = 36; // half an inch
  const PT = (n) => ({ magnitude: n, unit: 'PT' });
  const ALIGN_TO_DOCS = { left: 'START', center: 'CENTER', right: 'END', justify: 'JUSTIFIED' };
  const ALIGN_FROM_DOCS = { START: 'left', CENTER: 'center', END: 'right', JUSTIFIED: 'justify' };
  const FLAG_FIELDS = { b: 'bold', i: 'italic', u: 'underline', x: 'strikethrough' };
  const BREAK_TEXT = '***';

  // ------------------------------------------------------------ normalize
  // One canonical form, so blocks built from NEO and blocks read from a Doc
  // compare equal when they say the same thing.
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : d);
  function normalize(b) {
    const out = {
      k: b.k === 'brk' ? 'brk' : 'p',
      text: String(b.text || ''),
      marks: [],
      align: ALIGN_TO_DOCS[b.align] ? b.align : 'left',
      ind: b.ind === 'poetry' ? 'poetry' : b.ind === 'flush' ? 'flush' : 'normal',
      pb: !!b.pb,
      sa: num(b.sa, 0),
      sb: num(b.sb, 0),
      sz: num(b.sz, SIZE),
      ls: num(b.ls, SPACING)
    };
    if (out.k === 'brk') {
      Object.assign(out, { text: BREAK_TEXT, align: 'center', ind: 'flush' });
      return out;
    }
    // a centered or right-set line has no first-line indent to speak of
    if ((out.align === 'center' || out.align === 'right') && out.ind === 'normal') out.ind = 'flush';
    out.marks = normMarks(b.marks || [], out.text.length);
    return out;
  }

  // merge, clip and order marks: one entry per maximal run of the same flags
  function normMarks(marks, len) {
    const per = new Array(len).fill('');
    for (const [s, e, f] of marks) {
      for (let i = Math.max(0, s); i < Math.min(len, e); i++) {
        for (const c of String(f || '')) if (FLAG_FIELDS[c] && !per[i].includes(c)) per[i] += c;
      }
    }
    const out = [];
    for (let i = 0; i < len;) {
      const f = [...per[i]].sort().join('');
      let j = i + 1;
      while (j < len && [...per[j]].sort().join('') === f) j++;
      if (f) out.push([i, j, f]);
      i = j;
    }
    return out;
  }

  const blockKey = (b) => JSON.stringify([b.k, b.text, b.marks, b.align, b.ind, b.pb, b.sa, b.sb, b.sz, b.ls]);
  const sameBlock = (a, b) => blockKey(a) === blockKey(b);

  // A heading line: centered, bold all the way through. (How the chapter
  // Docs' headings are set, and how they are told from the chapter's text.)
  function isHeading(b) {
    if (b.k !== 'p' || b.align !== 'center' || !b.text) return false;
    let covered = 0;
    for (const [s, e, f] of b.marks) if (f.includes('b')) covered += e - s;
    return covered >= b.text.length;
  }

  // ---------------------------------------------------------- from NEO
  // A paragraph as NEO's own export reads it (parasFromHtml in app.js):
  // { sceneBreak, poetry, flush, align, runs: [{text, b, i, u, s, br}] }
  function fromNeoPara(p) {
    if (p.sceneBreak) return normalize({ k: 'brk' });
    let text = '';
    const marks = [];
    for (const r of p.runs || []) {
      const t = r.br ? '\u000b' : String(r.text || '');
      const f = (r.b ? 'b' : '') + (r.i ? 'i' : '') + (r.u ? 'u' : '') + (r.s ? 'x' : '');
      if (f && t) marks.push([text.length, text.length + t.length, f]);
      text += t;
    }
    return normalize({
      k: 'p', text, marks,
      align: p.align || 'left',
      ind: p.poetry ? 'poetry' : p.flush ? 'flush' : 'normal'
    });
  }

  // ----------------------------------------------------------- from Docs
  // A Doc (documents.get, suggestionsViewMode SUGGESTIONS_INLINE) as its
  // paragraphs, each with where it sits, plus the blocks it holds. Empty
  // paragraphs are kept in `paras` (they take up room) but are not blocks.
  // Suggested insertions take up room too, but are not the writer's text
  // yet, so they stay out of the block; `map` turns a block offset back
  // into a Doc index.
  function readDoc(doc) {
    const content = (doc && doc.body && doc.body.content) || [];
    const paras = [];
    for (const el of content) {
      if (!el.paragraph) continue;
      const ps = el.paragraph.paragraphStyle || {};
      let text = '';
      let sz = null;
      const map = [];
      const flags = [];
      for (const pe of el.paragraph.elements || []) {
        const start = pe.startIndex;
        if (pe.textRun) {
          const c = pe.textRun.content || '';
          const ts = pe.textRun.textStyle || {};
          const suggested = (pe.textRun.suggestedInsertionIds || []).length > 0;
          for (let i = 0; i < c.length; i++) {
            if (suggested || c[i] === '\n') continue;
            if (sz === null) sz = mag(ts.fontSize) || 11;
            map.push(start + i);
            text += c[i];
            flags.push((ts.bold ? 'b' : '') + (ts.italic ? 'i' : '') + (ts.underline ? 'u' : '') + (ts.strikethrough ? 'x' : ''));
          }
        } else {
          // a page break, an image, a footnote mark: one index, no words
          map.push(start);
          text += '￼';
          flags.push('');
        }
      }
      map.push(el.endIndex - 1); // the paragraph's own newline
      const align = ALIGN_FROM_DOCS[ps.alignment] || 'left';
      const first = mag(ps.indentFirstLine);
      const left = mag(ps.indentStart);
      const ind = left >= 6 ? 'poetry' : first >= 6 ? 'normal' : 'flush';
      const k = text === BREAK_TEXT && align === 'center' ? 'brk' : 'p';
      const marks = [];
      for (let i = 0; i < flags.length;) {
        let j = i + 1;
        while (j < flags.length && flags[j] === flags[i]) j++;
        if (flags[i]) marks.push([i, j, flags[i]]);
        i = j;
      }
      const block = text.trim() === '' && k !== 'brk' ? null : normalize({
        k, text, marks, align, ind,
        pb: !!ps.pageBreakBefore, sa: mag(ps.spaceAbove), sb: mag(ps.spaceBelow),
        sz: sz || SIZE, ls: ps.lineSpacing || 100
      });
      paras.push({ start: el.startIndex, end: el.endIndex, text, map, block });
    }
    const end = paras.length ? paras[paras.length - 1].end : 2;
    return { paras, blocks: paras.filter((p) => p.block).map((p) => p.block), end };
  }
  const mag = (d) => (d && d.magnitude) || 0;
  const fromDoc = (doc) => readDoc(doc).blocks;

  // ------------------------------------------------------------ styling
  function paraStyleRequest(b, start, end) {
    return {
      updateParagraphStyle: {
        range: { startIndex: start, endIndex: end },
        paragraphStyle: {
          namedStyleType: 'NORMAL_TEXT',
          alignment: ALIGN_TO_DOCS[b.align] || 'START',
          lineSpacing: b.ls,
          spaceAbove: PT(b.sa),
          spaceBelow: PT(b.sb),
          indentFirstLine: PT(b.k === 'p' && b.ind === 'normal' ? INDENT : 0),
          indentStart: PT(b.ind === 'poetry' ? INDENT : 0),
          pageBreakBefore: b.pb
        },
        fields: 'namedStyleType,alignment,lineSpacing,spaceAbove,spaceBelow,indentFirstLine,indentStart,pageBreakBefore'
      }
    };
  }

  // the whole paragraph plain, then its own marks on top
  function textStyleRequests(b, start, len) {
    if (len <= 0) return [];
    const out = [{
      updateTextStyle: {
        range: { startIndex: start, endIndex: start + len },
        textStyle: {
          weightedFontFamily: { fontFamily: FONT, weight: 400 },
          fontSize: PT(b.sz),
          bold: false,
          italic: false,
          underline: false,
          strikethrough: false,
          foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } }
        },
        fields: 'weightedFontFamily,fontSize,bold,italic,underline,strikethrough,foregroundColor'
      }
    }];
    for (const [s, e, f] of b.marks) {
      const textStyle = {};
      for (const c of f) textStyle[FLAG_FIELDS[c]] = true;
      out.push({ updateTextStyle: { range: { startIndex: start + s, endIndex: start + e }, textStyle, fields: Object.keys(textStyle).join(',') } });
    }
    return out;
  }

  // ----------------------------------------------------------------- diff
  // Longest common subsequence of blocks, as hunks: old[i0, i1) becomes
  // new[j0, j1). Unchanged blocks between hunks are never touched, which is
  // what keeps comments on them anchored.
  function diffBlocks(oldB, newB) {
    const a = oldB.map(blockKey), b = newB.map(blockKey);
    // trim the common ends first: typing changes one paragraph of hundreds
    let lo = 0;
    while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
    let ha = a.length, hb = b.length;
    while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) { ha--; hb--; }
    const n = ha - lo, m = hb - lo;
    const hunks = [];
    if (n === 0 && m === 0) return hunks;
    if (n * m > 4e6) return [{ i0: lo, i1: ha, j0: lo, j1: hb }]; // too big to align: one hunk
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i][j] = a[lo + i] === b[lo + j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }
    let i = 0, j = 0, open = null;
    const close = () => { if (open) { hunks.push(open); open = null; } };
    while (i < n || j < m) {
      if (i < n && j < m && a[lo + i] === b[lo + j]) { close(); i++; j++; continue; }
      if (!open) open = { i0: lo + i, i1: lo + i, j0: lo + j, j1: lo + j };
      if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { j++; open.j1 = lo + j; }
      else { i++; open.i1 = lo + i; }
    }
    close();
    return hunks;
  }

  // ------------------------------------------------------- edit requests
  // The batchUpdate requests that turn the Doc `doc` (documents.get) into
  // `want` (blocks). Hunks are applied last-first, so each one's indices are
  // still the Doc's own. The Doc keeps an empty paragraph at its very end:
  // Google never lets the last newline go, and with nothing written in that
  // last paragraph, no edit ever has to.
  function editRequests(doc, want) {
    want = want.map(normalize);
    const rd = readDoc(doc);
    const requests = [];
    const lastPara = rd.paras[rd.paras.length - 1];
    if (!lastPara || lastPara.text !== '') {
      // make the sentinel: a newline just before the final one
      requests.push({ insertText: { location: { index: rd.end - 1 }, text: '\n' } });
    }
    const sentinelStart = lastPara && lastPara.text === '' ? lastPara.start : rd.end; // after the insert above, if any
    const owners = rd.paras.filter((p) => p.block); // the paragraph each old block lives in
    const hunks = diffBlocks(rd.blocks, want);
    for (let h = hunks.length - 1; h >= 0; h--) {
      const { i0, i1, j0, j1 } = hunks[h];
      // one paragraph changed within itself: edit just the characters
      if (i1 - i0 === 1 && j1 - j0 === 1) {
        const o = owners[i0], ob = o.block, nb = want[j0];
        if (ob.k === nb.k && !o.text.includes('￼')) {
          requests.push(...charEdit(o, ob, nb));
          continue;
        }
      }
      const at = i0 < owners.length ? owners[i0].start : sentinelStart;
      const delEnd = i1 > i0 ? owners[i1 - 1].end : at;
      if (delEnd > at) requests.push({ deleteContentRange: { range: { startIndex: at, endIndex: delEnd } } });
      if (j1 > j0) {
        const blocks = want.slice(j0, j1);
        const text = blocks.map((b) => b.text + '\n').join('');
        requests.push({ insertText: { location: { index: at }, text } });
        let pos = at;
        for (const b of blocks) {
          requests.push(paraStyleRequest(b, pos, pos + b.text.length + 1));
          requests.push(...textStyleRequests(b, pos, b.text.length));
          pos += b.text.length + 1;
        }
      }
    }
    return requests;
  }

  // Within one paragraph: the characters that changed, then the paragraph's
  // whole look again, so nothing of an older look is left behind.
  function charEdit(o, ob, nb) {
    const a = ob.text, b = nb.text;
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const out = [];
    const docAt = (off) => o.map[off];
    const delFrom = docAt(pre), delTo = docAt(a.length - suf);
    if (delTo > delFrom) out.push({ deleteContentRange: { range: { startIndex: delFrom, endIndex: delTo } } });
    const ins = b.slice(pre, b.length - suf);
    if (ins) out.push({ insertText: { location: { index: delFrom }, text: ins } });
    out.push(paraStyleRequest(nb, o.start, o.start + b.length + 1));
    out.push(...textStyleRequests(nb, o.start, b.length));
    return out;
  }

  // A new, empty Doc ({body: one empty paragraph}) filled with `want`.
  function fillRequests(want) {
    return editRequests({ body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: 2, paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n' } }] } }] } }, want);
  }

  // ------------------------------------------------------------- to HTML
  // A block as a NEO paragraph (the inverse of fromNeoPara), for text that
  // came from Google Docs.
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toNeoHtml(b) {
    b = normalize(b);
    if (b.k === 'brk') return '<p class="scene-break">***</p>';
    const per = new Array(b.text.length).fill('');
    for (const [s, e, f] of b.marks) for (let i = s; i < e; i++) per[i] = f;
    let html = '';
    for (let i = 0; i < b.text.length;) {
      if (b.text[i] === '\u000b') { html += '<br>'; i++; continue; }
      let j = i + 1;
      while (j < b.text.length && per[j] === per[i] && b.text[j] !== '\u000b') j++;
      let t = escHtml(b.text.slice(i, j).split('￼').join(''));
      const f = per[i];
      if (f.includes('x')) t = '<s>' + t + '</s>';
      if (f.includes('u')) t = '<u>' + t + '</u>';
      if (f.includes('i')) t = '<i>' + t + '</i>';
      if (f.includes('b')) t = '<b>' + t + '</b>';
      html += t;
      i = j;
    }
    const cls = b.ind === 'poetry' ? ' class="poetry"' : b.ind === 'flush' && b.align === 'left' ? ' class="flush"' : '';
    const style = b.align !== 'left' ? ` style="text-align:${b.align}"` : '';
    return `<p${cls}${style}>${html || '<br>'}</p>`;
  }

  // a block's words, for showing a change to a person
  const plain = (b) => String(b.text || '').split('\u000b').join(' / ').split('￼').join('');

  // a heading line, from its text and the part of it in italic
  function heading(text, italicFrom = text.length, extra = {}) {
    const marks = [[0, text.length, 'b']];
    if (italicFrom < text.length) marks.push([italicFrom, text.length, 'i']);
    return normalize({ k: 'p', text, marks, align: 'center', ind: 'flush', ...extra });
  }

  const api = {
    normalize, blockKey, sameBlock, isHeading, heading, fromNeoPara, readDoc, fromDoc, diffBlocks,
    editRequests, fillRequests, toNeoHtml, plain, BREAK_TEXT
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NeoDriveBlocks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
