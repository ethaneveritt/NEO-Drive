// NEO+: the book's name over your own cover image.
//
// NEO shows a writer's own cover art as it is — right for a finished cover
// that already carries its lettering. For a picture chosen just to inspire,
// the ↻ on its tile now offers "Add the title, subtitle and author": NEO's own
// cover type (the same templates its abstract covers use) set over the image,
// with "A different title style" to try another, and "Just the image" to take
// it away again. The image itself is never changed.
//
// Kept in the book's own meta: ndType (on/off) and ndTypeSeed (the style).
(function () {
  'use strict';
  if (typeof window.dressTile !== 'function' || typeof window.refreshCover !== 'function' || typeof NeoCovers === 'undefined') return;

  const own = { dressTile: window.dressTile, refreshCover: window.refreshCover, exportCover: window.exportCover };
  const art = new Map(); // book id + image file → { url, canvas } fitted to a tile
  const wantsType = (meta) => !!(meta && meta.ndType && meta.coverImage && coverMode(meta) === 'image' && !isScript(meta));
  const styled = (meta) => ({ ...meta, coverSeed: meta.ndTypeSeed || meta.coverSeed || meta.id });

  async function imageArt(meta) {
    const key = meta.id + '/' + meta.coverImage;
    if (art.has(key)) return art.get(key);
    const c = await window.neo.readCover(meta.id, meta.coverImage);
    if (!c) return null;
    const entry = await NeoCovers.fitImage('nd-type:' + key, `data:${c.mime};base64,${c.base64}`);
    if (entry) art.set(key, entry);
    return entry;
  }

  // the subtitle, small, under the title (NEO's tiles carry title and author)
  function addSubtitle(el, meta) {
    const box = el.querySelector('.b-title');
    if (!box || !meta.subtitle) return;
    const sizes = [...box.querySelectorAll('.b-line:not(.b-small)')].map((s) => parseFloat(s.style.fontSize) || 0);
    const big = Math.max(10, ...sizes);
    const span = document.createElement('span');
    span.className = 'b-line b-small b-ital nd-subtitle';
    span.style.fontSize = Math.max(7, Math.min(11, big * 0.36)).toFixed(1) + 'px';
    span.style.marginTop = '3px';
    span.textContent = meta.subtitle;
    box.appendChild(span);
  }

  window.dressTile = function (el, meta) {
    if (!wantsType(meta)) return own.dressTile.apply(this, arguments);
    el.classList.remove('has-cover');
    const token = (el._dressToken = (el._dressToken || 0) + 1);
    // the image as it is until it's been read, then the type over it
    el.style.background = `#1d1d1d url("${coverUrl(meta)}") center / cover no-repeat`;
    imageArt(meta).then((a) => {
      if (el._dressToken !== token) return;
      if (!a) { own.dressTile(el, meta); return; }
      NeoCovers.dress(el, NeoCovers.plan(styled(meta), a));
      addSubtitle(el, meta);
    });
    return undefined;
  };

  // ↻ on a tile showing your own image: the type choices first
  window.refreshCover = async function (meta, el) {
    if (!meta || !meta.coverImage || coverMode(meta) !== 'image' || isScript(meta)) return own.refreshCover.apply(this, arguments);
    const options = meta.ndType
      ? [
          { label: t('A different title style'), desc: t('Sets the title, subtitle and author in another style over your image.'), value: 'restyle' },
          { label: t('Just the image'), desc: t('Takes the title, subtitle and author off again.'), value: 'off' }
        ]
      : [{ label: t('Add the title, subtitle and author'), desc: t('Sets the book’s name over your image, in one of NEO’s cover styles. Your image stays as it is.'), value: 'on' }];
    options.push({ label: t('Other cover choices…'), desc: t('NEO’s abstract cover, its painting, new colours.'), value: 'more' });
    const choice = await optionModal(t('Cover for “{title}”', { title: escHtml(meta.title || t('Untitled')) }), null, options);
    if (!choice) return undefined;
    if (choice === 'more') return own.refreshCover.call(this, meta, el);
    const live = (book && book.id === meta.id) ? book : meta;
    if (choice === 'on') { live.ndType = true; if (!live.ndTypeSeed) live.ndTypeSeed = live.id + ':type'; }
    if (choice === 'off') live.ndType = false;
    if (choice === 'restyle') {
      // a style that differs from the one showing
      const before = NeoCovers.plan(styled(live), { url: '', canvas: blank() }).template;
      for (let i = 0; i < 12; i++) {
        live.ndTypeSeed = live.id + ':type:' + Date.now().toString(36) + i;
        if (NeoCovers.plan(styled(live), { url: '', canvas: blank() }).template !== before) break;
      }
    }
    if (live !== meta) Object.assign(meta, { ndType: live.ndType, ndTypeSeed: live.ndTypeSeed });
    if (live === book) scheduleMetaSave(); else await writeBookMeta(meta.id, live);
    window.dressTile(el, live);
    return undefined;
  };
  let blankCanvas = null;
  function blank() {
    if (!blankCanvas) { blankCanvas = document.createElement('canvas'); blankCanvas.width = 208; blankCanvas.height = 300; }
    return blankCanvas;
  }

  // Exports (EPUB, PDF): your image with the title and author set over it
  // the same way, when the type is on.
  if (typeof own.exportCover === 'function') {
    window.exportCover = async function (d) {
      if (!d || !d.coverImage) return own.exportCover.apply(this, arguments);
      let meta = book && book.id === d.id ? book : null;
      if (!meta) { try { meta = await window.neo.readBookMeta(d.id); } catch { meta = null; } }
      if (!(meta && meta.ndType && meta.coverImage === d.coverImage)) return own.exportCover.apply(this, arguments);
      try {
        const c = await window.neo.readCover(d.id, d.coverImage);
        if (!c) return own.exportCover.apply(this, arguments);
        const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = `data:${c.mime};base64,${c.base64}`; });
        await NeoCovers.ready;
        const url = NeoCovers.renderFull(styled({ ...d, title: meta.title || d.title, author: meta.author || d.author, ndTypeSeed: meta.ndTypeSeed }), { image: img }).toDataURL('image/jpeg', 0.92);
        return { base64: url.split(',')[1], mime: 'image/jpeg', ext: 'jpg' };
      } catch (err) {
        window.neo.logError('NEO+ cover type: ' + err);
        return own.exportCover.apply(this, arguments);
      }
    };
  }

  window.NeoPlusCovers = { wantsType };
})();
