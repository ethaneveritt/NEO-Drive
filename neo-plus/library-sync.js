// NEO+: the whole library, the same on every computer signed in to the
// same Google account.
//
// NEO already keeps a library that something else syncs underneath it
// (iCloud, Syncthing): each chapter is its own file, a save never writes
// over a chapter another device changed (that version becomes the chapter
// after it), and a look at the disk every half minute picks up what arrived.
// This is that something else, with Google Drive in the middle.
//
// Every file of the library (library.json and the book folders) has a copy
// in one Drive folder, "NEO+ Library". Each computer remembers what each
// file held when it last matched Drive (the base), so for each file:
//   changed here only      → it goes up
//   changed in Drive only  → it comes down
//   changed in both        → nothing is lost: JSON (shelves, a book's
//     chapter list, comments, Darlings) is merged; a chapter changed in both
//     places keeps this computer's text and gets the other one's as the
//     chapter after it, as NEO itself does; notes keep both texts; anything
//     else keeps the newer and saves the older aside.
// Before this computer's copy of a file is replaced or removed, it is saved
// in NEO+'s app data (library-sync/backup, kept 30 days). Files removed from
// Drive go to Drive's trash. A pass that would remove most of the library,
// or finds the library missing, stops instead.
//
// Main process only. api: neo-plus/google.js (or the stand-in for tests).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FOLDER = 'application/vnd.google-apps.folder';
const ROOT_NAME = 'NEO+ Library';
const BACKUP_DAYS = 30;
const MAX_FILE = 200 * 1024 * 1024;
const EMPTY = 'd41d8cd98f00b204e9800998ecf8427e'; // md5 of nothing

// What travels: library.json and every book folder. Not: Backups, Exports,
// the error log, _catalog.txt (NEO rebuilds it), files caught mid-write or
// spare copies (.tmp, .bak), iCloud placeholders, system litter.
function wanted(rel) {
  if (rel === 'library.json') return true;
  const parts = rel.split('/');
  if (parts.length < 2 || !/^book-/.test(parts[0])) return false;
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) return false;
  const base = parts[parts.length - 1];
  if (/\.(tmp|bak|icloud|part|dl)$/i.test(base)) return false;
  if (/^(desktop\.ini|thumbs\.db|icon\r?)$/i.test(base)) return false;
  return true;
}
// a path from Drive is only ever a plain path inside the library
function safeRel(rel) {
  return typeof rel === 'string' && rel.length < 400 && !/[\\\0]/.test(rel) && !path.isAbsolute(rel) && wanted(rel);
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const isJSONMerge = (rel) => rel === 'library.json' || /^book-[^/]+\/(book|stickies|darlings|neo-drive-chapter-notes)\.json$/.test(rel);
const chapterOf = (rel) => { const m = /^(book-[^/]+)\/chapters\/([^/]+)\.html$/.exec(rel); return m ? { book: m[1], ch: m[2] } : null; };
const isTextNotes = (rel) => /^book-[^/]+\/[^/]+\.html$/.test(rel); // notes.html, outline.html
// files of an open book that NEO itself picks up from disk while it's open
const NEO_WATCHES = /^book-[^/]+\/(book\.json|stickies\.json|darlings\.json|chapters\/[^/]+\.html)$/;

// ------------------------------------------------------------- merging
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// a list of names (chapter order, a shelf's books): this computer's order;
// what Drive added goes in after the item it followed there; what one side
// removed (and the other kept unchanged) stays removed
function mergeList(base, local, remote, keep = () => false) {
  const b = new Set(base || []);
  const r = new Set(remote);
  const out = local.filter((x) => !(b.has(x) && !r.has(x)) || keep(x));
  remote.forEach((x, i) => {
    if (out.includes(x) || b.has(x)) return;
    const prev = remote.slice(0, i).reverse().find((y) => out.includes(y));
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, x);
  });
  return out;
}
// a list of records with ids (comments, Darlings): the same, record by record
function mergeById(base, local, remote) {
  const bm = new Map((base || []).filter(isObj).map((x) => [x.id, x]));
  const rm = new Map(remote.filter(isObj).map((x) => [x.id, x]));
  const lm = new Map(local.filter(isObj).map((x) => [x.id, x]));
  const ids = mergeList(base ? [...bm.keys()] : null, [...lm.keys()], [...rm.keys()],
    (id) => !same(lm.get(id), bm.get(id))); // changed here: kept even if removed there
  return ids.map((id) => {
    if (!lm.has(id)) return rm.get(id);
    if (!rm.has(id)) return lm.get(id);
    return merge3(bm.get(id), lm.get(id), rm.get(id));
  });
}
const listOfIds = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => isObj(x) && x.id !== undefined);
const listOfNames = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' || typeof x === 'number');

// base may be undefined (never matched before). Where both sides changed
// the same plain value, this computer's wins unless prefer says otherwise.
function merge3(base, local, remote, prefer = 'local', ctx = {}) {
  if (same(local, remote)) return local;
  if (base !== undefined && same(local, base)) return remote;
  if (base !== undefined && same(remote, base)) return local;
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  if (isObj(local) && isObj(remote)) {
    const out = {};
    const b = isObj(base) ? base : undefined;
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const bk = b ? b[k] : undefined;
      const lk = local[k];
      const rk = remote[k];
      let v;
      if (ctx.special && ctx.special[k]) v = ctx.special[k](bk, lk, rk);
      else if (b && lk === undefined && same(rk, bk)) v = undefined; // removed here
      else if (b && rk === undefined && same(lk, bk)) v = undefined; // removed there
      else v = merge3(bk, lk, rk, prefer, { special: ctx.nested && ctx.nested[k] });
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (Array.isArray(local) && Array.isArray(remote)) {
    if ((listOfIds(local) || listOfIds(remote)) && local.concat(remote).every(isObj)) return mergeById(Array.isArray(base) ? base : null, local, remote);
    if (listOfNames(local) && listOfNames(remote)) return mergeList(Array.isArray(base) ? base : null, local, remote);
  }
  return prefer === 'remote' ? remote : local;
}

// The three kinds of JSON NEO keeps, merged with what each one means
function mergeJSON(rel, base, local, remote, { chapterChangedHere = () => false } = {}) {
  if (rel === 'library.json') {
    // a library that hasn't been set up yet (a new computer) takes Drive's
    const fresh = !local || !local.firstRunDone || !Array.isArray(local.shelves) || !local.shelves.some((s) => s.bookIds && s.bookIds.length);
    const shelves = (b, l, r) => mergeById(Array.isArray(b) ? b : null, Array.isArray(l) ? l : [], Array.isArray(r) ? r : []);
    return merge3(base, local, remote, fresh ? 'remote' : 'local', { special: { shelves } });
  }
  if (/\/book\.json$/.test(rel)) {
    const special = {
      chapterOrder: (b, l, r) => mergeList(Array.isArray(b) ? b : null, l || [], r || [], chapterChangedHere),
      // where you were: wherever you were last
      lastPosition: (b, l, r) => ((r && r.at || 0) > (l && l.at || 0) ? r : l),
      modified: (b, l, r) => (String(r || '') > String(l || '') ? r : l)
    };
    return merge3(base, local, remote, 'local', { special });
  }
  if (/\/neo-drive-chapter-notes\.json$/.test(rel)) {
    // chapter → its notes: both texts where both changed
    const out = merge3(base, local, remote);
    if (isObj(local) && isObj(remote)) {
      for (const k of Object.keys(out)) {
        const b = isObj(base) ? base[k] : undefined;
        if (typeof local[k] === 'string' && typeof remote[k] === 'string' && local[k] !== remote[k] && local[k] !== b && remote[k] !== b) {
          out[k] = local[k].includes(remote[k]) ? local[k] : remote[k].includes(local[k]) ? remote[k] : local[k] + '\n\n' + remote[k];
        }
      }
    }
    return out;
  }
  return merge3(base, Array.isArray(local) || isObj(local) ? local : [], Array.isArray(remote) || isObj(remote) ? remote : []);
}

// ---------------------------------------------------------------- disk
function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.nd-sync.tmp';
  fs.writeFileSync(tmp, buf);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (err) {
      // Windows can hold a file for a moment (an antivirus scan, the indexer)
      if (i >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw err; }
      const until = Date.now() + 200;
      while (Date.now() < until) { /* a short wait, in a sync step */ }
    }
  }
}

class LibrarySync {
  // dir: NEO+'s app data; libraryDir(): NEO's library folder (or null)
  constructor({ api, dir, libraryDir, log = () => {}, now = () => Date.now(), device = os.hostname() }) {
    this.api = api;
    this.dir = path.join(dir, 'library-sync');
    this.libraryDir = libraryDir;
    this.log = log;
    this.now = now;
    this.device = String(device || 'another computer').slice(0, 60);
    this.running = null;
  }

  stateFile() { return path.join(this.dir, 'state.json'); }
  load() {
    try { return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')); } catch { return { files: {} }; }
  }
  save(st) { writeAtomic(this.stateFile(), JSON.stringify(st)); }
  baseFile(rel) { return path.join(this.dir, 'base', ...rel.split('/')); }
  readBase(rel) {
    try { return JSON.parse(fs.readFileSync(this.baseFile(rel), 'utf8')); } catch { return undefined; }
  }
  keepBase(rel, buf) { if (isJSONMerge(rel)) { try { writeAtomic(this.baseFile(rel), buf); } catch (err) { this.log('library sync base', err); } } }
  dropBase(rel) { try { fs.unlinkSync(this.baseFile(rel)); } catch { /* none */ } }
  // this computer's copy of a file, kept before it's replaced or removed
  backup(rel, buf) {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    try { writeAtomic(path.join(this.dir, 'backup', stamp, ...rel.split('/')), buf); } catch (err) { this.log('library sync backup', err); }
  }
  pruneBackups() {
    const dir = path.join(this.dir, 'backup');
    const cut = new Date(this.now() - BACKUP_DAYS * 86400000).toISOString().replace(/[:.]/g, '-');
    try {
      for (const d of fs.readdirSync(dir)) if (d < cut) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
    } catch { /* none yet */ }
  }

  // Is there a library in Drive already (from another computer)?
  async remoteExists() {
    const roots = await this.api.listFiles(`appProperties has { key='neoLib' and value='root' } and trashed = false`);
    if (!roots.length) return false;
    const files = await this.api.listFiles(`'${roots[0].id}' in parents and trashed = false`);
    return files.length > 0;
  }

  // One look both ways. open: the id of the book open in NEO (its notes,
  // outline and covers wait until it closes; NEO picks the rest up itself).
  pass(opts = {}) {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        let out = await this.once(opts);
        // a conflict settled here leaves files to send up: one more look
        for (let i = 0; i < 2 && out.again; i++) out = merge(out, await this.once(opts));
        return out;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async once({ open = null } = {}) {
    const lib = this.libraryDir && this.libraryDir();
    if (!lib || !fs.existsSync(path.join(lib, 'library.json'))) throw new Error('The library folder isn’t there right now, so nothing was synced.');
    const st = this.load();
    st.files = st.files || {};
    const out = { pulled: [], pushed: [], removedHere: [], removedThere: [], conflicts: [], books: new Set(), library: false, waiting: 0, again: false };

    // ---- the folder in Drive (made once; found by its tag on every computer)
    const roots = (await this.api.listFiles(`appProperties has { key='neoLib' and value='root' } and trashed = false`))
      .sort((a, b) => String(a.modifiedTime).localeCompare(String(b.modifiedTime)));
    let root = roots.find((r) => r.id === st.rootId) || roots[0];
    if (!root) root = await this.api.createFile({ name: ROOT_NAME, mimeType: FOLDER, appProperties: { neoLib: 'root' } });
    if (st.rootId !== root.id) {
      // a different folder (first time here, or the old one was deleted in
      // Drive): nothing is known to match, so nothing is taken for removed
      st.rootId = root.id;
      st.files = {};
    }

    // ---- what Drive has
    const remote = new Map();
    const extra = [];
    // files whose state can't be told for sure this time are left alone:
    // never taken for removed
    const unsure = new Set();
    for (const f of await this.api.listFiles(`'${root.id}' in parents and trashed = false`)) {
      if (!f.appProperties || f.appProperties.neoLib !== 'file' || !safeRel(f.name)) continue;
      if (!f.md5Checksum) {
        if (Number(f.size) === 0) f.md5Checksum = EMPTY;
        else { unsure.add(f.name); continue; }
      }
      const had = remote.get(f.name);
      if (had) {
        // two computers sent up the same new file at once: the newer stands
        const newer = String(f.modifiedTime) > String(had.modifiedTime) ? f : had;
        extra.push(newer === f ? had : f);
        remote.set(f.name, newer);
      } else remote.set(f.name, f);
    }

    // ---- what this computer has
    const local = new Map();
    const walk = (abs, rel) => {
      let ents;
      try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) { if (!rel ? /^book-/.test(e.name) && !e.name.startsWith('.') : !e.name.startsWith('.')) walk(path.join(abs, e.name), r); continue; }
        // iCloud (Desktop & Documents, with Optimize Mac Storage) keeps a
        // file it hasn't downloaded as ".name.icloud": there, just not here
        const cloud = /^\.(.+)\.icloud$/.exec(e.name);
        if (cloud) { unsure.add(rel ? rel + '/' + cloud[1] : cloud[1]); continue; }
        if (!e.isFile() || !wanted(r)) continue;
        let s;
        try { s = fs.statSync(path.join(abs, e.name)); } catch { unsure.add(r); continue; }
        if (s.size > MAX_FILE) { unsure.add(r); continue; }
        const stamp = s.mtimeMs + ':' + s.size;
        const known = st.files[r];
        let sum = known && known.stamp === stamp ? known.local : null;
        if (!sum) { try { sum = md5(fs.readFileSync(path.join(abs, e.name))); } catch { unsure.add(r); continue; } }
        local.set(r, { md5: sum, stamp, mtime: s.mtimeMs });
      }
    };
    walk(lib, '');
    if (!local.has('library.json')) throw new Error('The library couldn’t be read, so nothing was synced.');

    const absOf = (rel) => path.join(lib, ...rel.split('/'));
    const isOpen = (rel) => open && rel.startsWith(open + '/');
    const known = (rel) => st.files[rel] || null;
    const setKnown = (rel, sum, abs) => {
      let stamp = null;
      try { const s = fs.statSync(abs); stamp = s.mtimeMs + ':' + s.size; } catch { /* gone */ }
      st.files[rel] = { md5: sum, local: sum, stamp };
    };

    // ---- decide
    const plan = { up: [], down: [], delHere: [], delThere: [], both: [] };
    for (const rel of new Set([...local.keys(), ...remote.keys(), ...Object.keys(st.files)])) {
      if (unsure.has(rel)) continue;
      const L = local.has(rel) ? local.get(rel).md5 : null;
      const R = remote.has(rel) ? remote.get(rel).md5Checksum : null;
      const B = known(rel) ? known(rel).md5 : null;
      if (L === R) {
        if (L) st.files[rel] = { md5: L, local: L, stamp: local.get(rel).stamp };
        else delete st.files[rel];
        continue;
      }
      if (L === B) { if (R) plan.down.push(rel); else plan.delHere.push(rel); continue; }
      if (R === B) { if (L) plan.up.push(rel); else plan.delThere.push(rel); continue; }
      // changed in both places
      if (!L) plan.down.push(rel);      // removed here, changed there: it comes back
      else if (!R) plan.up.push(rel);   // removed there, changed here: it goes back
      else plan.both.push(rel);
    }

    // too much going at once is a sign of trouble (a library folder half
    // there, a Drive folder emptied by hand), not of writing
    const knownCount = Object.keys(st.files).length;
    for (const [list, where] of [[plan.delHere, 'on this computer'], [plan.delThere, 'in Google Drive']]) {
      if (list.length > 10 && list.length > knownCount * 0.8) {
        throw new Error(`Sync stopped: it would have removed ${list.length} of your library’s ${knownCount} files ${where}. Nothing was changed.`);
      }
    }

    const fetchRemote = async (rel) => this.api.download(remote.get(rel).id);
    const readLocal = (rel) => fs.readFileSync(absOf(rel));
    const wait = (rel) => { const w = isOpen(rel) && !NEO_WATCHES.test(rel); if (w) out.waiting++; return w; };
    const noteBook = (rel) => { if (rel === 'library.json') out.library = true; else out.books.add(rel.split('/')[0]); };
    const send = async (rel, buf) => {
      const sum = md5(buf);
      const r = remote.get(rel);
      const props = { neoLib: 'file', neoDevice: this.device };
      const f = r
        ? await this.api.upload({ id: r.id, data: buf, appProperties: props })
        : await this.api.upload({ name: rel, parents: [root.id], appProperties: props, data: buf, mimeType: mimeOf(rel) });
      if (f.md5Checksum && f.md5Checksum !== sum) throw new Error(`${rel} arrived in Google Drive damaged`);
      remote.set(rel, { ...f, md5Checksum: sum });
      return sum;
    };
    const take = (rel, buf) => {
      const abs = absOf(rel);
      try { const cur = fs.readFileSync(abs); if (!cur.equals(buf)) this.backup(rel, cur); } catch { /* new here */ }
      writeAtomic(abs, buf);
      return md5(buf);
    };

    for (const rel of plan.up) {
      const buf = readLocal(rel);
      const sum = await send(rel, buf);
      setKnown(rel, sum, absOf(rel));
      this.keepBase(rel, buf);
      out.pushed.push(rel);
    }
    for (const rel of plan.down) {
      if (wait(rel)) continue;
      const buf = await fetchRemote(rel);
      const sum = take(rel, buf);
      setKnown(rel, sum, absOf(rel));
      this.keepBase(rel, buf);
      out.pulled.push(rel);
      noteBook(rel);
    }
    for (const rel of plan.delHere) {
      if (wait(rel)) continue;
      const abs = absOf(rel);
      try { this.backup(rel, fs.readFileSync(abs)); fs.unlinkSync(abs); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      delete st.files[rel];
      this.dropBase(rel);
      out.removedHere.push(rel);
      noteBook(rel);
    }
    for (const rel of plan.delThere) {
      await this.api.updateFile(remote.get(rel).id, { trashed: true });
      remote.delete(rel);
      delete st.files[rel];
      this.dropBase(rel);
      out.removedThere.push(rel);
    }
    for (const f of extra) { try { await this.api.updateFile(f.id, { trashed: true }); } catch (err) { this.log('library sync tidy', err); } }

    // ---- changed in both places: JSON first (a chapter's twin goes into
    // its book.json), then everything else
    const order = plan.both.sort((a, b) => (isJSONMerge(b) ? 1 : 0) - (isJSONMerge(a) ? 1 : 0));
    const twins = []; // { book, ch, html, device }
    for (const rel of order) {
      if (wait(rel)) continue;
      const theirs = await fetchRemote(rel);
      const mine = readLocal(rel);
      const device = (remote.get(rel).appProperties && remote.get(rel).appProperties.neoDevice) || 'your other computer';
      let result;
      if (isJSONMerge(rel)) {
        let l, r;
        try { l = JSON.parse(mine.toString('utf8')); } catch { l = undefined; }
        try { r = JSON.parse(theirs.toString('utf8')); } catch { r = undefined; }
        if (l === undefined || r === undefined) result = l === undefined ? theirs : mine;
        else {
          const bookId = rel.split('/')[0];
          const changedHere = (ch) => {
            const cr = `${bookId}/chapters/${ch}.html`;
            const k = known(cr);
            return local.has(cr) && (!k || k.md5 !== local.get(cr).md5);
          };
          result = Buffer.from(JSON.stringify(mergeJSON(rel, this.readBase(rel), l, r, { chapterChangedHere: changedHere }), null, 2));
        }
      } else if (chapterOf(rel)) {
        // this computer's text stays; theirs becomes the chapter after it
        twins.push({ ...chapterOf(rel), html: theirs, device });
        result = mine;
      } else if (isTextNotes(rel)) {
        const a = mine.toString('utf8');
        const b = theirs.toString('utf8');
        result = a.includes(b) ? mine : b.includes(a) ? theirs
          : Buffer.from(a + `<p>— ${escapeHtml('From ' + device)} —</p>` + b);
      } else {
        // a cover and such: the newer one
        const theirsNewer = Date.parse(remote.get(rel).modifiedTime || 0) > local.get(rel).mtime;
        result = theirsNewer ? theirs : mine;
        if (theirsNewer) this.backup(rel, mine);
      }
      if (!result.equals(mine)) { take(rel, result); noteBook(rel); }
      // what Drive has now is the agreed version; what's here goes up next look
      const rsum = remote.get(rel).md5Checksum;
      st.files[rel] = { md5: rsum, local: null, stamp: null };
      this.keepBase(rel, theirs);
      out.conflicts.push(rel);
      out.again = true;
    }
    for (const tw of twins) {
      this.addTwin(lib, tw);
      out.books.add(tw.book);
      out.again = true;
    }

    st.lastPass = this.now();
    this.save(st);
    this.pruneBackups();
    return out;
  }

  // A chapter changed on both computers: the other one's text goes in as
  // the chapter after it, named for where it came from (NEO's own way).
  addTwin(lib, { book, ch, html, device }) {
    const metaFile = path.join(lib, book, 'book.json');
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { return; }
    const twinId = 'ch-' + this.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    writeAtomic(path.join(lib, book, 'chapters', twinId + '.html'), html);
    meta.chapterOrder = Array.isArray(meta.chapterOrder) ? meta.chapterOrder : [];
    const at = meta.chapterOrder.indexOf(ch);
    meta.chapterOrder.splice(at < 0 ? meta.chapterOrder.length : at + 1, 0, twinId);
    meta.chapterTitles = meta.chapterTitles || {};
    const when = new Date(this.now()).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    meta.chapterTitles[twinId] = `${meta.chapterTitles[ch] || ''} (from ${device}, ${when})`.trim();
    writeAtomic(metaFile, JSON.stringify(meta, null, 2));
  }
}

function merge(a, b) {
  return {
    pulled: a.pulled.concat(b.pulled), pushed: a.pushed.concat(b.pushed),
    removedHere: a.removedHere.concat(b.removedHere), removedThere: a.removedThere.concat(b.removedThere),
    conflicts: a.conflicts.concat(b.conflicts), books: new Set([...a.books, ...b.books]),
    library: a.library || b.library, waiting: b.waiting, again: b.again
  };
}
function mimeOf(rel) {
  const ext = (rel.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  return { html: 'text/html', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain' }[ext.toLowerCase()] || 'application/octet-stream';
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

module.exports = { LibrarySync, wanted, mergeJSON, merge3, mergeList, ROOT_NAME };
