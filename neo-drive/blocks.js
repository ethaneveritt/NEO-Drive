// NEO-Drive: the shape a manuscript takes in Google Docs, and the edits that
// turn one Doc into another. Pure functions, no network, no DOM.
//
// A "block" is one paragraph as NEO-Drive understands it:
//   { k, text, marks, align, ind }
//     k      what the paragraph is: 'p' (prose), 'brk' (***), or a heading
//            kind of the Doc's profile (see PROFILES)
//     text   the paragraph's characters, without its newline. A line break
//            inside a paragraph is '\u000b', as Google Docs stores it.
//     marks  [[start, end, flags]] — flags a string of b i u x (bold,
//            italic, underline, strikethrough), beyond the kind's own look
//     align  'left' | 'center' | 'right' | 'justify'
//     ind    'normal' | 'flush' | 'poetry' — first-line indent, none, or a
//            left indent (a poem; a contents line inside a part)
//
// Two looks ("profiles"):
//   chapter — the chapter Docs, set like Ethan's manuscript pages: Times New
//             Roman 12, double-spaced, bold centered headings
//   master  — the Master Manuscript, set like NEO's own Word export: Georgia
//             12 at 1.5 lines, a title page, a contents page, a page per part,
//             chapter headings in capitals each on a new page
//
// Everything that decides whether two blocks are "the same" lives in
// blockKey(), and readDoc() reads back exactly what editRequests() writes,
// so a Doc NEO-Drive wrote reads back as the blocks it was written from.
(function (root) {
  'use strict';

  const PT = (n) => ({ magnitude: n, unit: 'PT' });
  const ALIGN_TO_DOCS = { left: 'START', center: 'CENTER', right: 'END', justify: 'JUSTIFIED' };
  const ALIGN_FROM_DOCS = { START: 'left', CENTER: 'center', END: 'right', JUSTIFIED: 'justify' };
  const FLAG_FIELDS = { b: 'bold', i: 'italic', u: 'underline', x: 'strikethrough' };
  const BREAK_TEXT = '***';

  // Per kind: the Docs named style it is written with (and read back by),
  // its size, the flags every character carries (base), spacing in points,
  // alignment, and whether it starts a new page.
  const PROFILES = {
    chapter: {
      font: 'Times New Roman', size: 12, spacing: 200, indent: 36, brkAbove: 0,
      kinds: {
        title: { named: 'TITLE', size: 20, base: 'b', spacing: 100, below: 24 },
        subtitle: { named: 'SUBTITLE', size: 14, base: 'b', spacing: 100 },
        part: { named: 'HEADING_1', size: 12, base: 'b' },
        chapter: { named: 'HEADING_2', size: 12, base: 'b' },
        heading: { named: 'HEADING_3', size: 12, base: 'b' },
        parttitle: { named: 'HEADING_4', size: 12, base: 'b' }
      }
    },
    master: {
      font: 'Georgia', size: 12, spacing: 150, indent: 24, brkAbove: 12,
      kinds: {
        title: { named: 'TITLE', size: 28, base: 'b', above: 150 },
        subtitle: { named: 'SUBTITLE', size: 16, base: 'i' },
        author: { named: 'HEADING_5', size: 12, above: 40 },
        heading: { named: 'HEADING_3', size: 14, above: 60, below: 18, page: true },
        chapter: { named: 'HEADING_2', size: 14, above: 60, below: 18, page: true },
        part: { named: 'HEADING_1', size: 14, above: 180, page: true },
        parttitle: { named: 'HEADING_4', size: 24, above: 24, below: 24 },
        // contents lines: a part's line has a little space above it
        toc: { named: 'HEADING_6', size: 12, align: 'left', indents: true },
        tocpart: { named: 'HEADING_6', size: 12, align: 'left', above: 12, indents: true }
      }
    }
  };
  const prof = (name) => PROFILES[name] || PROFILES.chapter;
  const isBody = (k) => k === 'p';

  // ------------------------------------------------------------ normalize
  // One canonical form, so blocks built from NEO and blocks read from a Doc
  // compare equal when they say the same thing.
  function normalize(b, profile = 'chapter') {
    const P = prof(profile);
    const k = b.k || 'p';
    const out = { k, text: String(b.text || ''), marks: [], align: 'left', ind: 'flush' };
    if (k === 'brk') {
      out.text = BREAK_TEXT;
      out.align = 'center';
      return out;
    }
    if (k !== 'p') {
      const spec = P.kinds[k] || {};
      out.align = spec.align || 'center';
      if (spec.indents) out.ind = b.ind === 'poetry' ? 'poetry' : 'flush';
      // what every character of the kind carries isn't a mark of its own
      const base = spec.base || '';
      out.marks = normMarks((b.marks || []).map(([s0, e0, f]) => [s0, e0, [...String(f || '')].filter((c) => !base.includes(c)).join('')]), out.text.length);
      return out;
    }
    out.align = ALIGN_TO_DOCS[b.align] ? b.align : 'left';
    out.ind = b.ind === 'poetry' ? 'poetry' : b.ind === 'flush' ? 'flush' : 'normal';
    // a centered or right-set line has no first-line indent to speak of
    if (out.align === 'center' || out.align === 'right') out.ind = out.ind === 'poetry' ? 'poetry' : 'flush';
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

  const blockKey = (b) => JSON.stringify([b.k, b.text, b.marks, b.align, b.ind]);
  const sameBlock = (a, b) => blockKey(a) === blockKey(b);

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
  function readDoc(doc, profile = 'chapter') {
    const P = prof(profile);
    const content = (doc && doc.body && doc.body.content) || [];
    const paras = [];
    for (const el of content) {
      if (!el.paragraph) continue;
      const ps = el.paragraph.paragraphStyle || {};
      let text = '';
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
      const k = kindOf(P, ps, text);
      const align = ALIGN_FROM_DOCS[ps.alignment] || 'left';
      const first = mag(ps.indentFirstLine);
      const left = mag(ps.indentStart);
      const ind = left >= 6 ? 'poetry' : first >= 6 ? 'normal' : 'flush';
      const marks = [];
      for (let i = 0; i < flags.length;) {
        let j = i + 1;
        while (j < flags.length && flags[j] === flags[i]) j++;
        if (flags[i]) marks.push([i, j, flags[i]]);
        i = j;
      }
      const block = text.trim() === '' && k !== 'brk' ? null : normalize({ k, text, marks, align, ind }, profile);
      paras.push({ start: el.startIndex, end: el.endIndex, text, map, block });
    }
    const end = paras.length ? paras[paras.length - 1].end : 2;
    return { paras, blocks: paras.filter((p) => p.block).map((p) => p.block), end };
  }
  const mag = (d) => (d && d.magnitude) || 0;

  // the kind a paragraph was written as, from its named style (and, for the
  // two kinds that share one, the space above it)
  function kindOf(P, ps, text) {
    const named = ps.namedStyleType || 'NORMAL_TEXT';
    if (named === 'NORMAL_TEXT') {
      return text === BREAK_TEXT && ps.alignment === 'CENTER' ? 'brk' : 'p';
    }
    const hits = Object.entries(P.kinds).filter(([, s]) => s.named === named);
    if (!hits.length) return 'p';
    if (hits.length > 1) {
      const above = mag(ps.spaceAbove);
      const best = hits.find(([, s]) => (s.above || 0) > 0 === above > 0);
      if (best) return best[0];
    }
    return hits[0][0];
  }

  const fromDoc = (doc, profile) => readDoc(doc, profile).blocks;

  // ------------------------------------------------------------ styling
  function paraStyleRequest(P, b, start, end) {
    const spec = P.kinds[b.k] || {};
    const body = isBody(b.k);
    const style = {
      namedStyleType: b.k === 'p' || b.k === 'brk' ? 'NORMAL_TEXT' : spec.named,
      alignment: ALIGN_TO_DOCS[b.align] || 'START',
      lineSpacing: spec.spacing || P.spacing,
      spaceAbove: PT(b.k === 'brk' ? P.brkAbove : spec.above || 0),
      spaceBelow: PT(spec.below || 0),
      indentFirstLine: PT(body && b.ind === 'normal' ? P.indent : 0),
      indentStart: PT((body || spec.indents) && b.ind === 'poetry' ? P.indent : 0),
      // a part or chapter starts its own page — except at the very top
      pageBreakBefore: !!spec.page && start > 1
    };
    return {
      updateParagraphStyle: {
        range: { startIndex: start, endIndex: end },
        paragraphStyle: style,
        fields: 'namedStyleType,alignment,lineSpacing,spaceAbove,spaceBelow,indentFirstLine,indentStart,pageBreakBefore'
      }
    };
  }

  // the whole paragraph in the profile's face, then its own marks on top
  function textStyleRequests(P, b, start, len) {
    if (len <= 0) return [];
    const spec = (b.k !== 'p' && b.k !== 'brk' && P.kinds[b.k]) || {};
    const base = spec.base || '';
    const out = [{
      updateTextStyle: {
        range: { startIndex: start, endIndex: start + len },
        textStyle: {
          weightedFontFamily: { fontFamily: P.font, weight: 400 },
          fontSize: PT(spec.size || P.size),
          bold: base.includes('b'),
          italic: base.includes('i'),
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
  function editRequests(doc, want, profile = 'chapter') {
    const P = prof(profile);
    want = want.map((b) => normalize(b, profile));
    const rd = readDoc(doc, profile);
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
        if (ob.k === nb.k && ob.align === nb.align && ob.ind === nb.ind && !o.text.includes('￼')) {
          requests.push(...charEdit(P, o, ob, nb));
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
          requests.push(paraStyleRequest(P, b, pos, pos + b.text.length + 1));
          requests.push(...textStyleRequests(P, b, pos, b.text.length));
          pos += b.text.length + 1;
        }
      }
    }
    return requests;
  }

  function charEdit(P, o, ob, nb) {
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
    // the paragraph's styling, whole, so marks moved or changed come out right
    out.push(...textStyleRequests(P, nb, o.start, b.length));
    return out;
  }

  // A new, empty Doc ({body: one empty paragraph}) filled with `want`.
  function fillRequests(want, profile) {
    return editRequests({ body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: 2, paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n' } }] } }] } }, want, profile);
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

  const api = {
    normalize, blockKey, sameBlock, fromNeoPara, readDoc, fromDoc, diffBlocks,
    editRequests, fillRequests, toNeoHtml, plain, BREAK_TEXT, PROFILES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NeoDriveBlocks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
