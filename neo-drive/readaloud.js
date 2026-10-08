// NEO-Drive: Read Aloud, with natural voices.
//
// Read Aloud menu (and right-click): a chapter from its beginning or from
// here, the highlighted passage, the page on screen, the whole manuscript,
// or carry on from where you stopped. A small player sits above the bottom
// bar while it reads: back a sentence, pause/play (mid-sentence), forward a
// sentence, stop, NEO's own volume (not the computer's), speed and voice.
//
// The natural voices are Kokoro (neo-drive/tts-main.js), played through Web
// Audio so pause holds its place and the volume is NEO's own. Without them,
// or by choice, the computer's own voice reads instead, with the same
// controls (it pauses at the start of the sentence it was on).
//
// The sentence being read is lit with NEO's own Read Aloud highlight
// (neo-speak), using NEO's sentence splitter (readSentences, readRange).
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const call = (msg) => window.neo.neoDrive(msg);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  if (!window.neo || !window.neo.neoDrive) return;

  let prefs = { voice: 'af_heart', speed: 1, volume: 0.8, asked: false, voices: { installed: false, voices: [] } };
  let session = null; // { items, idx, mode, bookId, gen, paused, waiting }
  let gen = 0;
  let ctx = null;
  let gain = null;
  let source = null;
  let cache = new Map();   // item index → Promise<AudioBuffer|null>
  let speakChain = Promise.resolve();

  call({ op: 'readPrefs' }).then((p) => { if (p) prefs = p; drawBar(); }).catch(() => {});

  // ------------------------------------------------------------- the look
  const st = document.createElement('style');
  st.textContent = `
    #nd-player { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(40px * var(--ui-zoom, 1) + 14px);
      z-index: 85; display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 22px;
      background: var(--pane); border: 1px solid color-mix(in srgb, var(--muted) 25%, transparent);
      box-shadow: 0 6px 24px rgba(0,0,0,.3); font-size: 12px; color: var(--muted); max-width: calc(100vw - 32px); -webkit-app-region: no-drag; }
    #nd-player button { background: none; border: none; color: inherit; width: 28px; height: 28px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center; padding: 0; }
    #nd-player button:hover { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
    #nd-player button.big { width: 34px; height: 34px; color: var(--accent); }
    #nd-player svg { width: 16px; height: 16px; fill: currentColor; }
    #nd-player button.big svg { width: 20px; height: 20px; }
    #nd-player .sep { width: 1px; height: 18px; background: color-mix(in srgb, var(--muted) 30%, transparent); margin: 0 4px; }
    #nd-player input[type=range] { width: 84px; accent-color: var(--accent); }
    #nd-player select { background: transparent; color: inherit; border: 1px solid color-mix(in srgb, var(--muted) 30%, transparent);
      border-radius: 6px; font: inherit; padding: 2px 4px; max-width: 150px; }
    #nd-player select option { background: var(--pane); color: #ddd; }
    #nd-player .what { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-left: 4px; }
    #nd-player .wait { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); opacity: 0; transition: opacity .2s; }
    #nd-player.waiting .wait { opacity: .8; animation: nd-pulse 1s ease-in-out infinite; }
    @keyframes nd-pulse { 50% { opacity: .2; } }
    @media (max-width: 760px) { #nd-player .what, #nd-player .voice { display: none; } }
    #nd-export { position: fixed; right: 18px; bottom: calc(40px * var(--ui-zoom, 1) + 70px); z-index: 86; width: 300px;
      background: var(--pane); border: 1px solid color-mix(in srgb, var(--muted) 25%, transparent); border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,.3); padding: 12px 14px; font-size: 12px; color: var(--muted); }
    #nd-export b { color: inherit; font-weight: 600; display: block; margin-bottom: 4px; }
    #nd-export .bar { height: 5px; border-radius: 3px; background: color-mix(in srgb, var(--muted) 25%, transparent); overflow: hidden; margin: 8px 0 6px; }
    #nd-export .bar > div { height: 100%; width: 0; background: var(--accent); transition: width .3s; }
    #nd-export .acts { text-align: right; margin-top: 6px; }
    #nd-export .acts button { background: none; border: none; color: var(--muted); font-size: 12px; margin-left: 12px; }
    #nd-export .acts button:hover, #nd-export .acts button.go { color: var(--accent); }
    .nd-voices-modal .bar { height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--muted) 25%, transparent); overflow: hidden; margin: 14px 0 6px; }
    .nd-voices-modal .bar > div { height: 100%; width: 0; background: var(--accent); transition: width .2s; }`;
  document.head.appendChild(st);

  const ICON = {
    prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zM9.5 12 18 6v12z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>',
    vol: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M11 4h2v9.2l3.3-3.3 1.4 1.4L12 17l-5.7-5.7 1.4-1.4 3.3 3.3zM5 19h14v2H5z"/></svg>'
  };
  const bar = document.createElement('div');
  bar.id = 'nd-player';
  bar.hidden = true;
  document.body.appendChild(bar);
  bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

  function drawBar() {
    if (!session) { bar.hidden = true; return; }
    const installed = prefs.voices && prefs.voices.installed;
    const voiceOpts = (installed ? prefs.voices.voices : []).map((v) => `<option value="${v.id}"${v.id === prefs.voice ? ' selected' : ''} title="${esc(t(v.kind))}">${esc(v.name)} · ${v.id[0] === 'b' ? 'UK' : 'US'} ${v.id[1] === 'f' ? '♀' : '♂'}</option>`).join('') +
      `<option value="system"${!installed || prefs.voice === 'system' ? ' selected' : ''}>${esc(t('This computer’s voice'))}</option>`;
    const speeds = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
    bar.innerHTML = `
      <button class="prev" title="${esc(t('Back a sentence'))}">${ICON.prev}</button>
      <button class="big toggle" title="${esc(t('Pause / Play (Ctrl+Shift+U)'))}">${session.paused ? ICON.play : ICON.pause}</button>
      <button class="next" title="${esc(t('Forward a sentence'))}">${ICON.next}</button>
      <button class="stop" title="${esc(t('Stop (you can carry on later: Read Aloud → Continue Where I Stopped)'))}">${ICON.stop}</button>
      <span class="sep"></span>
      <span title="${esc(t('NEO’s reading volume'))}" style="display:inline-flex">${ICON.vol}</span>
      <input class="vol" type="range" min="0" max="100" value="${Math.round(prefs.volume * 100)}" title="${esc(t('Volume'))}">
      <select class="speed" title="${esc(t('Speed'))}">${speeds.map((s) => `<option value="${s}"${Math.abs(prefs.speed - s) < 0.01 ? ' selected' : ''}>${s === 1 ? '1×' : s + '×'}</option>`).join('')}</select>
      <select class="voice" title="${esc(t('Voice'))}">${voiceOpts}</select>
      <button class="save" title="${esc(t('Export as audio (MP3) to listen on your phone'))}">${ICON.save}</button>
      <span class="wait"></span>
      <span class="what"></span>`;
    bar.hidden = false;
    bar.classList.toggle('waiting', !!session.waiting);
    bar.querySelector('.prev').onclick = () => step(-1);
    bar.querySelector('.next').onclick = () => step(1);
    bar.querySelector('.toggle').onclick = toggle;
    bar.querySelector('.stop').onclick = () => stop(true);
    bar.querySelector('.save').onclick = chooseExport;
    const vol = bar.querySelector('.vol');
    vol.oninput = () => setVolume(vol.value / 100);
    vol.onchange = () => call({ op: 'setReadPrefs', volume: prefs.volume });
    bar.querySelector('.speed').onchange = (e) => setPrefs({ speed: Number(e.target.value) });
    bar.querySelector('.voice').onchange = (e) => setPrefs({ voice: e.target.value });
    showWhat();
  }
  function showWhat() {
    if (!session) return;
    const it = session.items[session.idx];
    const w = bar.querySelector('.what');
    if (w && it) w.textContent = it.chId === 'aux' ? t('Notes') : chapterTitle(it.chId);
    const tg = bar.querySelector('.toggle');
    if (tg) tg.innerHTML = session.paused ? ICON.play : ICON.pause;
    bar.classList.toggle('waiting', !!session.waiting && !session.paused);
  }
  const chapterTitle = (chId) => (book && book.chapterOrder.includes(chId) ? (chapterHeading(chId) || chapterName(chId)) : '');

  function setVolume(v) {
    prefs.volume = Math.max(0, Math.min(1, v));
    if (gain) gain.gain.value = prefs.volume;
  }
  async function setPrefs(o) {
    const was = { ...prefs };
    prefs = { ...prefs, ...(await call({ op: 'setReadPrefs', ...o })) };
    if (!session) return;
    if (prefs.voice !== was.voice || prefs.speed !== was.speed) {
      // the sentence being read finishes as it was; the rest are read anew
      const keep = cache.get(session.idx);
      cache = new Map();
      if (keep && useNatural() && (was.voice !== 'system')) cache.set(session.idx, keep);
      if (!useNatural() || was.voice === 'system') { const i = session.idx; play(i, true); return; }
      prefetch(session.idx + 1);
    }
  }
  const useNatural = () => !!(prefs.voices && prefs.voices.installed) && prefs.voice !== 'system';

  // --------------------------------------------------- what's to be read
  // a chapter's paragraphs (as NEO counts them: not the outline's ghosts)
  function parasOf(chId) {
    const body = chId === 'aux' ? $('#aux-editor') : document.querySelector(`.chapter[data-id="${CSS.escape(chId)}"] .chapter-body`);
    return body ? [...body.querySelectorAll('p')].filter((p) => !p.classList.contains('ghost')) : [];
  }
  const clean = (s) => String(s || '').replace(/[⚑￼]/g, '').replace(/\s+/g, ' ').trim();
  // long sentences in pieces the voice can take (at ; : , — when it must)
  function pieces(text, a, b) {
    const out = [];
    let s = a;
    while (b - s > 320) {
      const chunk = text.slice(s, s + 320);
      let cut = Math.max(chunk.lastIndexOf('; '), chunk.lastIndexOf(': '), chunk.lastIndexOf('— '), chunk.lastIndexOf(', '));
      if (cut < 80) cut = chunk.lastIndexOf(' ');
      if (cut < 40) cut = 320;
      out.push([s, s + cut + 1]);
      s = s + cut + 1;
    }
    out.push([s, b]);
    return out;
  }
  function paraItems(chId, pi, p, from = 0, to = Infinity) {
    // a scene break (*** or the like): a pause
    if (p.classList.contains('scene-break') || /^[\s*#~•·⁂—-]+$/u.test(p.textContent) && /[*#~•·⁂]/u.test(p.textContent)) return [{ kind: 'pause', ms: 900, chId, pi }];
    const text = p.textContent;
    const items = [];
    for (const [sa, sb] of readSentences(p, 0)) {
      const a = Math.max(sa, from), b = Math.min(sb, to);
      if (b <= a) continue;
      for (let [x, y] of pieces(text, a, b)) {
        // the highlight hugs the words, not the spaces around them
        while (x < y && /\s/.test(text[x])) x++;
        while (y > x && /\s/.test(text[y - 1])) y--;
        const say = clean(text.slice(x, y));
        if (say && /[\p{L}\p{N}]/u.test(say)) items.push({ kind: 'say', chId, pi, a: x, b: y, text: say });
      }
    }
    if (items.length) items[items.length - 1].gap = 260; // a breath between paragraphs
    return items;
  }
  function headingItem(chId) {
    const h = chapterHeading(chId) || chapterName(chId);
    return h ? [{ kind: 'say', chId, head: true, text: clean(h).replace(/\s+[—–]\s+/g, '. ') + '.', gap: 700 }] : [];
  }
  function chapterItems(chId, fromPi = 0, fromA = 0, withHead = true) {
    const out = [];
    if (withHead && fromPi === 0 && fromA === 0 && chId !== 'aux' && !['contents', 'copyright'].includes(chapterKind(chId))) out.push(...headingItem(chId));
    parasOf(chId).forEach((p, pi) => { if (pi >= fromPi) out.push(...paraItems(chId, pi, p, pi === fromPi ? fromA : 0)); });
    return out;
  }
  function bookItems(fromCh = null, fromPi = 0, fromA = 0, withHead = true) {
    const out = [];
    const order = book.chapterOrder.filter((c) => !['contents', 'copyright'].includes(chapterKind(c)));
    let started = !fromCh;
    if (!fromCh) {
      const title = [book.title, book.subtitle].filter(Boolean).join('. ');
      if (title) out.push({ kind: 'say', chId: order[0], head: true, title: true, text: clean(title + (book.author ? '. By ' + book.author : '')) + '.', gap: 1200 });
    }
    for (const c of order) {
      if (!started) { if (c !== fromCh) continue; started = true; out.push(...chapterItems(c, fromPi, fromA, withHead)); continue; }
      const items = chapterItems(c);
      if (items.length) { if (out.length) out[out.length - 1].gap = 1200; out.push(...items); }
    }
    return out;
  }
  // where the caret (or a point) is: chapter, paragraph, offset
  function placeOf(node, offset) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    const p = el && el.closest && el.closest('.chapter-body p, #aux-editor p');
    if (!p || p.classList.contains('ghost')) return null;
    const chEl = p.closest('.chapter');
    const chId = chEl ? chEl.dataset.id : 'aux';
    const pi = parasOf(chId).indexOf(p);
    if (pi < 0) return null;
    const r = document.createRange();
    r.selectNodeContents(p);
    try { r.setEnd(node, offset); } catch { return { chId, pi, a: 0 }; }
    let a = r.toString().length;
    const s = readSentences(p, 0).find(([x, y]) => a >= x && a < y);
    if (s) a = s[0];
    return { chId, pi, a };
  }
  function caretPlace() {
    const sel = window.getSelection();
    return sel.rangeCount ? placeOf(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset) : null;
  }
  function chapterInView() {
    if (currentChapterId && book.chapterOrder.includes(currentChapterId)) return currentChapterId;
    return book.chapterOrder[0];
  }

  function build(cmd, opts = {}) {
    if (!book) return null;
    if (currentTab === 'notes' && ['here', 'chapter', 'page'].includes(cmd)) {
      const pl = caretPlace();
      return { mode: 'aux', items: chapterItems('aux', pl && pl.chId === 'aux' ? pl.pi : 0, pl && pl.chId === 'aux' ? pl.a : 0, false) };
    }
    if (cmd === 'chapter') {
      const pl = caretPlace();
      return { mode: 'chapter', items: chapterItems(pl && pl.chId !== 'aux' ? pl.chId : chapterInView()) };
    }
    if (cmd === 'here') {
      let pl = null;
      if (typeof opts.x === 'number') {
        const r = document.caretRangeFromPoint(opts.x, opts.y);
        if (r) pl = placeOf(r.startContainer, r.startOffset);
      }
      pl = pl || caretPlace();
      if (!pl) return { mode: 'chapter', items: chapterItems(chapterInView()) };
      return { mode: 'chapter', items: chapterItems(pl.chId, pl.pi, pl.a) };
    }
    if (cmd === 'selection') {
      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) { toast(t('Highlight the words to read first.')); return null; }
      const range = sel.getRangeAt(0);
      const items = [];
      for (const p of document.querySelectorAll('.chapter-body p, #aux-editor p')) {
        if (p.classList.contains('ghost') || !range.intersectsNode(p)) continue;
        const chEl = p.closest('.chapter');
        const chId = chEl ? chEl.dataset.id : 'aux';
        const pi = parasOf(chId).indexOf(p);
        const pr = document.createRange();
        pr.selectNodeContents(p);
        const len = p.textContent.length;
        let from = 0, to = len;
        if (p.contains(range.startContainer)) { const x = document.createRange(); x.selectNodeContents(p); x.setEnd(range.startContainer, range.startOffset); from = x.toString().length; }
        if (p.contains(range.endContainer)) { const x = document.createRange(); x.selectNodeContents(p); x.setEnd(range.endContainer, range.endOffset); to = x.toString().length; }
        items.push(...paraItems(chId, pi, p, from, to));
      }
      return { mode: 'selection', items };
    }
    if (cmd === 'page') {
      // the paragraphs on screen, from the first sentence that shows
      const view = $('#paper-scroll').getBoundingClientRect();
      const items = [];
      for (const p of document.querySelectorAll('#chapters .chapter-body p')) {
        if (p.classList.contains('ghost')) continue;
        const r = p.getBoundingClientRect();
        if (r.bottom < view.top + 4 || r.top > view.bottom - 4) continue;
        const chId = p.closest('.chapter').dataset.id;
        const pi = parasOf(chId).indexOf(p);
        let from = 0;
        if (r.top < view.top) {
          // starts above the screen: from the first sentence that's in view
          for (const [a, b] of readSentences(p, 0)) {
            const rr = readRange(p, a, b);
            if (rr && rr.getBoundingClientRect().bottom > view.top) { from = a; break; }
          }
        }
        items.push(...paraItems(chId, pi, p, from));
      }
      return { mode: 'page', items };
    }
    if (cmd === 'book') return { mode: 'book', items: bookItems() };
    if (cmd === 'continue') {
      const pos = savedPos();
      if (!pos) { toast(t('Nothing to continue in this book yet.')); return null; }
      if (pos.mode === 'book') return { mode: 'book', items: bookItems(pos.chId, pos.pi, pos.a, !!pos.head) };
      if (pos.chId === 'aux') return { mode: 'aux', items: chapterItems('aux', pos.pi, pos.a, false) };
      if (!book.chapterOrder.includes(pos.chId)) return null;
      return { mode: 'chapter', items: chapterItems(pos.chId, pos.pi, pos.a, !!pos.head) };
    }
    return null;
  }

  // where reading stopped, per book, for Continue Where I Stopped
  function savePos() {
    if (!session || !book) return;
    const it = session.items[session.idx];
    if (!it) return;
    try {
      const all = JSON.parse(localStorage.getItem('nd-read-pos') || '{}');
      all[book.id] = { mode: session.mode === 'book' ? 'book' : 'chapter', chId: it.chId, pi: it.head ? 0 : it.pi, a: it.head ? 0 : it.a, head: !!it.head };
      localStorage.setItem('nd-read-pos', JSON.stringify(all));
    } catch { /* not kept */ }
  }
  function savedPos() {
    try { return JSON.parse(localStorage.getItem('nd-read-pos') || '{}')[book.id] || null; } catch { return null; }
  }

  // ------------------------------------------------------------ playing
  function audio() {
    if (!ctx) {
      ctx = new AudioContext();
      gain = ctx.createGain();
      gain.connect(ctx.destination);
    }
    gain.gain.value = prefs.volume;
    return ctx;
  }
  // the audio for item i, one request at a time (the voice works on one thing at once)
  function audioFor(i) {
    if (cache.has(i)) return cache.get(i);
    const it = session && session.items[i];
    if (!it || it.kind !== 'say') return Promise.resolve(null);
    const voice = prefs.voice, speed = prefs.speed;
    const p = speakChain = speakChain.catch(() => {}).then(async () => {
      const r = await call({ op: 'speak', text: it.text, voice, speed });
      if (!r || r.error) throw new Error((r && r.error) || 'no audio');
      const data = r.audio instanceof Float32Array ? r.audio : new Float32Array(r.audio);
      const buf = audio().createBuffer(1, data.length, r.rate);
      buf.copyToChannel(data, 0);
      return buf;
    });
    cache.set(i, p);
    p.catch(() => {});
    return p;
  }
  function prefetch(from) {
    if (!session || !useNatural()) return;
    for (let i = from; i < Math.min(session.items.length, from + 3); i++) audioFor(i);
    // and let go of what's behind
    for (const k of cache.keys()) if (k < session.idx - 1) cache.delete(k);
  }

  function light(it) {
    if (!window.Highlight || !CSS.highlights) return;
    let r = null;
    if (it.head) {
      const h = document.querySelector(`.chapter[data-id="${CSS.escape(it.chId)}"] .chapter-head`);
      if (h && !it.title) { r = document.createRange(); r.selectNodeContents(h); }
      if (it.title) { const tp = $('#tp-title'); if (tp) { r = document.createRange(); r.selectNodeContents(tp); } }
    } else {
      const p = parasOf(it.chId)[it.pi];
      if (p) {
        // the words may have moved a little if they were edited meanwhile
        let a = it.a, b = it.b;
        if (clean(p.textContent.slice(a, b)) !== it.text) {
          const at = p.textContent.indexOf(it.text.slice(0, 40));
          if (at >= 0) { a = at; b = Math.min(p.textContent.length, at + (it.b - it.a)); }
        }
        r = readRange(p, a, b);
      }
    }
    if (!r) { CSS.highlights.delete('neo-speak'); return; }
    CSS.highlights.set('neo-speak', new Highlight(r));
    const sc = it.chId === 'aux' || currentTab !== 'manuscript' ? $('#paper-scroll') : $('#paper-scroll');
    const box = r.getBoundingClientRect();
    const view = sc.getBoundingClientRect();
    if (box.height && (box.top < view.top + 40 || box.bottom > view.bottom - 80)) sc.scrollTop += box.top - view.top - view.height / 3;
  }

  async function play(i, restart) {
    if (!session) return;
    const g = ++gen;
    try { if (source) { source.onended = null; source.stop(); } } catch { /* done already */ }
    source = null;
    try { window.speechSynthesis.cancel(); } catch { /* none */ }
    if (i < 0) i = 0;
    if (i >= session.items.length) { finish(); return; }
    session.idx = i;
    const it = session.items[i];
    savePos();
    showWhat();
    if (it.kind === 'pause') {
      CSS.highlights.delete('neo-speak');
      await wait(it.ms, g);
      if (g === gen && session && !session.paused) play(i + 1);
      else if (g === gen && session) session.pending = i + 1;
      return;
    }
    light(it);
    if (session.paused && !restart) { session.pending = i; return; }
    session.pending = null;
    if (!useNatural()) { sayWithSystem(it, i, g); return; }
    audio();
    prefetch(i);
    let buf;
    session.waiting = true;
    const slow = setTimeout(showWhat, 300);
    try { buf = await audioFor(i); } catch (err) {
      clearTimeout(slow);
      if (g !== gen) return;
      session.waiting = false;
      showWhat();
      toast(t('The natural voice couldn’t read that: {msg}. Using this computer’s voice instead.', { msg: String(err.message || err).slice(0, 80) }), 8000);
      prefs.voice = 'system';
      sayWithSystem(it, i, g);
      return;
    }
    clearTimeout(slow);
    if (g !== gen || !session) return;
    session.waiting = false;
    showWhat();
    prefetch(i + 1);
    if (session.paused) { session.pending = i; return; }
    if (ctx.state === 'suspended') await ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    src.onended = async () => {
      if (g !== gen || !session) return;
      await wait(it.gap || 60, g);
      if (g !== gen || !session) return;
      if (session.paused) { session.pending = i + 1; return; }
      play(i + 1);
    };
    source = src;
    src.start();
  }
  function sayWithSystem(it, i, g) {
    if (!window.speechSynthesis) { toast(t('Read aloud needs a voice on this computer')); stop(false); return; }
    const u = new SpeechSynthesisUtterance(it.text);
    u.volume = prefs.volume;
    u.rate = prefs.speed;
    const v = typeof readVoice === 'function' ? readVoice() : null;
    if (v) { u.voice = v; u.lang = v.lang; } else if (typeof writingLanguage === 'function') u.lang = writingLanguage();
    u.onend = async () => {
      if (g !== gen || !session || session.paused) return;
      await wait(it.gap || 60, g);
      if (g === gen && session && !session.paused) play(i + 1);
    };
    u.onerror = (ev) => { if (g === gen && ev.error !== 'interrupted' && ev.error !== 'canceled') stop(false); };
    window.speechSynthesis.speak(u);
  }
  const wait = (ms, g) => new Promise((r) => setTimeout(() => r(g === gen), ms));

  function pause() {
    if (!session || session.paused) return;
    session.paused = true;
    if (useNatural() && ctx && source) ctx.suspend();
    else { gen++; try { window.speechSynthesis.cancel(); } catch { /* none */ } session.pending = session.idx; }
    showWhat();
  }
  async function resume() {
    if (!session || !session.paused) return;
    session.paused = false;
    showWhat();
    if (session.pending != null) { const i = session.pending; session.pending = null; play(i, true); return; }
    if (ctx && ctx.state === 'suspended') await ctx.resume();
  }
  function toggle() { if (!session) return; if (session.paused) resume(); else pause(); }
  function step(d) {
    if (!session) return;
    let i = session.idx + d;
    while (session.items[i] && session.items[i].kind === 'pause') i += d;
    if (i < 0) i = 0;
    if (i >= session.items.length) { stop(false); return; }
    if (session.paused) { session.idx = i; session.pending = i; light(session.items[i]); savePos(); showWhat(); gen++; try { if (source) { source.onended = null; source.stop(); } } catch { /* done */ } source = null; if (ctx && ctx.state === 'suspended') ctx.resume(); return; }
    play(i);
  }
  function stop(keepPlace) {
    gen++;
    try { if (source) { source.onended = null; source.stop(); } } catch { /* done */ }
    source = null;
    try { window.speechSynthesis.cancel(); } catch { /* none */ }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    if (keepPlace) savePos();
    session = null;
    cache = new Map();
    if (window.CSS && CSS.highlights) CSS.highlights.delete('neo-speak');
    drawBar();
  }
  function finish() {
    // read to the end: next time starts fresh
    try { const all = JSON.parse(localStorage.getItem('nd-read-pos') || '{}'); delete all[book.id]; localStorage.setItem('nd-read-pos', JSON.stringify(all)); } catch { /* fine */ }
    stop(false);
  }

  async function start(cmd, opts) {
    if (!book) return;
    if (!(await offerVoices())) return;
    const plan = build(cmd, opts);
    if (!plan) return;
    if (!plan.items.length) { toast(t('There’s nothing there to read.')); return; }
    stop(false);
    session = { items: plan.items, idx: 0, mode: plan.mode, bookId: book.id, paused: false };
    drawBar();
    // a click unlocks audio; the menu's click counts
    if (useNatural()) { audio(); if (ctx.state === 'suspended') ctx.resume().catch(() => {}); }
    play(0);
  }

  // ------------------------------------------------------ natural voices
  // The first time anything is read: offer the natural voices once.
  async function offerVoices() {
    if (prefs.voices && prefs.voices.installed) return true;
    if (prefs.asked || prefs.voice === 'system') return true;
    const choice = await ask(
      t('Natural voices for Read Aloud'),
      t('NEO+ can read your book in a natural, audiobook-like voice (Kokoro). It runs entirely on this computer — nothing you write is sent anywhere — and it’s free. It’s a one-time download of about 340 MB.'),
      [['later', t('Use this computer’s voice')], ['get', t('Download (about 340 MB)')]]);
    prefs = { ...prefs, ...(await call({ op: 'setReadPrefs', asked: true })) };
    if (choice !== 'get') return true;
    return getVoices();
  }
  function ask(title, text, buttons) {
    return new Promise((resolve) => {
      const bd = document.createElement('div');
      bd.className = 'modal-backdrop';
      bd.innerHTML = `<div class="modal nd-voices-modal" style="width:440px"><h2 style="font-size:16px">${esc(title)}</h2><p>${esc(text)}</p>
        <div style="text-align:right;margin-top:16px">${buttons.map(([v, l], i) => `<button data-v="${v}" class="${i === buttons.length - 1 ? 'btn-gold' : 'btn-quiet'}" style="margin-left:8px">${esc(l)}</button>`).join('')}</div></div>`;
      document.body.appendChild(bd);
      const done = (v) => { bd.remove(); resolve(v); };
      bd.querySelectorAll('button').forEach((b) => { b.onclick = () => done(b.dataset.v); });
      bd.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
      bd.querySelector('.btn-gold').focus();
    });
  }
  let progressModal = null;
  async function getVoices() {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.innerHTML = `<div class="modal nd-voices-modal" style="width:440px"><h2 style="font-size:16px">${esc(t('Downloading natural voices'))}</h2>
      <p class="msg">${esc(t('About 340 MB, once. You can keep writing.'))}</p><div class="bar"><div></div></div><p class="soft n" style="margin:0"></p>
      <div style="text-align:right;margin-top:14px"><button class="btn-quiet cancel">${esc(t('Cancel'))}</button> <button class="btn-gold hide" style="margin-left:8px">${esc(t('Hide'))}</button></div></div>`;
    document.body.appendChild(bd);
    progressModal = bd;
    bd.querySelector('.cancel').onclick = () => call({ op: 'voicesCancel' });
    bd.querySelector('.hide').onclick = () => { bd.hidden = true; };
    const r = await call({ op: 'voicesInstall' });
    bd.remove();
    progressModal = null;
    prefs = { ...prefs, ...(await call({ op: 'readPrefs' })) };
    if (r && r.ok) {
      if (prefs.voice === 'system') prefs = { ...prefs, ...(await call({ op: 'setReadPrefs', voice: 'af_heart' })) };
      toast(t('Natural voices are ready. Read Aloud → Voice to choose one.'), 7000);
      drawBar();
      return true;
    }
    if (r && r.error !== 'cancelled') toast(t('The natural voices didn’t download: {msg}', { msg: r.error }), 10000);
    return true; // reading goes on with this computer's voice
  }
  function progress(m) {
    if (!progressModal) return;
    const pct = m.total ? Math.floor((m.done / m.total) * 100) : 0;
    progressModal.querySelector('.bar > div').style.width = pct + '%';
    progressModal.querySelector('.n').textContent = m.total ? `${Math.round(m.done / 1048576)} / ${Math.round(m.total / 1048576)} MB` : '';
  }
  async function removeVoices() {
    const v = await ask(t('Remove the natural voices?'), t('Read Aloud goes back to this computer’s voice. You can download them again any time.'), [['keep', t('Keep')], ['remove', t('Remove')]]);
    if (v !== 'remove') return;
    stop(false);
    await call({ op: 'voicesRemove' });
    prefs = { ...prefs, ...(await call({ op: 'readPrefs' })) };
    toast(t('Natural voices removed.'));
  }

  // --------------------------------------------------- export as audio
  // MP3 files of the natural voice reading a chapter or the whole book, to
  // listen to on a phone. The voice engine writes them in the background.
  async function chooseExport() {
    const v = await ask(t('Export as audio'), t('An MP3 file of the voice reading, to listen to anywhere. It uses the voice and speed you’ve chosen, and runs in the background while you keep writing.'),
      [['', t('Cancel')], ['chapters', t('Manuscript, a file per chapter')], ['book', t('Whole manuscript')], ['chapter', t('This chapter')]]);
    if (v) exportAudio(v);
  }
  const forExport = (items) => items.map((it) => (it.kind === 'pause' ? { text: '', gap: it.ms } : { text: it.text, gap: it.gap || 120 }));
  async function exportAudio(scope) {
    if (!book) return;
    if (!(prefs.voices && prefs.voices.installed)) {
      const v = await ask(t('Natural voices needed'), t('Exporting audio uses the natural voices. Download them now (about 340 MB, once)?'), [['', t('Not now')], ['get', t('Download')]]);
      if (v !== 'get' || !(await getVoices()) || !(prefs.voices && prefs.voices.installed)) return;
    }
    if (exportPanel) { toast(t('An export is already running.')); return; }
    const order = book.chapterOrder.filter((c) => !['contents', 'copyright'].includes(chapterKind(c)));
    let chapters;
    if (scope === 'chapter') {
      const pl = caretPlace();
      const chId = pl && pl.chId !== 'aux' ? pl.chId : chapterInView();
      chapters = [{ title: chapterTitle(chId), items: forExport(chapterItems(chId)) }];
    } else {
      chapters = order.map((c) => ({ title: chapterTitle(c), items: forExport(chapterItems(c)) })).filter((c) => c.items.some((x) => x.text));
      if (scope === 'book' && chapters.length) {
        const title = [book.title, book.subtitle].filter(Boolean).join('. ');
        if (title) chapters[0].items.unshift({ text: clean(title + (book.author ? '. By ' + book.author : '')) + '.', gap: 1200 });
        for (const c of chapters) c.items[c.items.length - 1].gap = 1400;
      }
    }
    if (!chapters.length || !chapters.some((c) => c.items.some((x) => x.text))) { toast(t('There’s nothing there to read.')); return; }
    const r = await call({ op: 'exportAudio', scope, chapters, book: { title: book.title || t('Untitled'), author: book.author || '' }, voice: prefs.voice === 'system' ? 'af_heart' : prefs.voice, speed: prefs.speed });
    if (r && r.cancelled && !exportPanel) return;
  }
  let exportPanel = null;
  let exportStart = 0;
  function exportEvent(m) {
    if (m.started) {
      document.querySelectorAll('#nd-export').forEach((x) => x.remove());
      exportPanel = document.createElement('div');
      exportPanel.id = 'nd-export';
      exportPanel.innerHTML = `<b>${esc(t('Exporting audio…'))}</b><span class="what"></span><div class="bar"><div></div></div><span class="n"></span>
        <div class="acts"><button class="cancel">${esc(t('Cancel'))}</button></div>`;
      document.body.appendChild(exportPanel);
      exportPanel.querySelector('.cancel').onclick = () => call({ op: 'exportCancel' });
      exportStart = Date.now();
      return;
    }
    if (!exportPanel) return;
    if (m.finished) {
      // the note stays until closed; another export can start meanwhile
      const p = exportPanel;
      exportPanel = null;
      if (m.ok) {
        const where = m.written && m.written[0];
        p.innerHTML = `<b>${esc(m.written.length > 1 ? t('{n} audio files saved', { n: m.written.length }) : t('Audio saved'))}</b><span class="what"></span>
          <div class="acts"><button class="close">${esc(t('Close'))}</button><button class="go show">${esc(t('Show in Folder'))}</button></div>`;
        p.querySelector('.what').textContent = where ? where.split(/[\\/]/).pop() : '';
        p.querySelector('.show').onclick = () => { call({ op: 'reveal', path: where }); p.remove(); };
      } else if (m.error === 'cancelled') {
        p.remove(); toast(t('Export cancelled.')); return;
      } else {
        p.innerHTML = `<b>${esc(t('The export stopped'))}</b><span class="what"></span><div class="acts"><button class="close">${esc(t('Close'))}</button></div>`;
        p.querySelector('.what').textContent = String(m.error || '');
      }
      p.querySelector('.close').onclick = () => p.remove();
      return;
    }
    const pct = m.total ? m.done / m.total : 0;
    exportPanel.querySelector('.bar > div').style.width = Math.floor(pct * 100) + '%';
    exportPanel.querySelector('.what').textContent = m.file || '';
    const spent = (Date.now() - exportStart) / 1000;
    const left = pct > 0.02 ? Math.round(spent / pct - spent) : null;
    exportPanel.querySelector('.n').textContent = `${Math.floor(pct * 100)}%` + (left != null ? ` · ${left > 5400 ? t('about {h} hours left', { h: Math.round(left / 3600) }) : left > 90 ? t('about {m} minutes left', { m: Math.round(left / 60) }) : t('less than two minutes left')}` : '');
  }

  // ------------------------------------------------------------ wiring
  window.neo.onMenu((msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'nd-read-prefs') { const was = { ...prefs }; prefs = { ...prefs, ...msg }; if (session && (was.voice !== prefs.voice || was.speed !== prefs.speed)) setPrefs({}); drawBar(); return; }
    if (msg.type === 'nd-voices') { prefs.voices = { ...prefs.voices, ...msg }; progress(msg); return; }
    if (msg.type === 'nd-export') { exportEvent(msg); return; }
    if (msg.type !== 'nd-read') return;
    const c = msg.cmd;
    if (c === 'toggle') { if (session) toggle(); else start('here'); return; }
    if (c === 'stop') { stop(true); return; }
    if (c === 'getVoices') { getVoices(); return; }
    if (c === 'removeVoices') { removeVoices(); return; }
    if (c === 'export') { exportAudio(msg.scope); return; }
    start(c, msg);
  });
  // NEO's own Read Aloud shortcut (Ctrl+Shift+U, or K on Linux): pause and
  // play while reading, otherwise read the chapter from here
  if (typeof window.toggleReadAloud === 'function') {
    window.toggleReadAloud = function () { if (session) toggle(); else start('here'); };
  }
  document.addEventListener('keydown', (e) => {
    if (!session || e.key !== 'Escape' || document.querySelector('.modal-backdrop:not([hidden])')) return;
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#searchbar')) return;
    stop(true);
  });
  // a book closed: reading stops
  setInterval(() => { if (session && (!book || book.id !== session.bookId)) stop(true); }, 1000);

  window.NeoDriveRead = { exportAudio, start, stop: () => stop(true), toggle, step, get session() { return session; }, get prefs() { return prefs; }, setVolume, get ctx() { return ctx; }, get gain() { return gain; } };
})();
