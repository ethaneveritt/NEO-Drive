// NEO-Drive: keeping a book and its Google Docs the same.
//
// For each book: a folder in Drive, a Master Manuscript Doc (the whole book,
// a reading copy), and one Doc per chapter. The window (renderer.js) hands
// over the open book as blocks every few seconds; this decides, chapter by
// chapter, what moves which way:
//
//   NEO changed, Doc didn't ......... the Doc is updated (only what changed)
//   Doc changed, NEO didn't ......... the Doc's text goes back to NEO
//   both changed .................... NEO keeps its text, and the Doc's comes
//                                     back as a new chapter (version G);
//                                     then the Doc takes NEO's (version N)
//   the Master Doc changed .......... the change is undone, and a comment
//                                     on the Doc says where to make it
//   a chapter left the book ......... its Doc moves to "Deleted chapters"
//
// "Changed" is measured against `base`: the last text both sides agreed on,
// kept per chapter in NEO's app-data folder (never in the library).
'use strict';

const fs = require('fs');
const path = require('path');
const B = require('./blocks.js');

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';
const POLL_MS = 15000;      // how often to look for edits made in Docs, when nothing changed here
const MAX_COMMENTS = 5;     // per sync, for edits undone in the Master Doc

const keysOf = (blocks) => blocks.map(B.blockKey);
const sameBlocks = (a, b) => a.length === b.length && keysOf(a).every((k, i) => k === B.blockKey(b[i]));
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

class Sync {
  // api: neo-drive/google.js's Google (or the stand-in in fake-google.js)
  // dir: where the per-book state lives
  constructor({ api, dir, log = () => {}, now = () => Date.now() }) {
    this.api = api;
    this.dir = dir;
    this.log = log;
    this.now = now;
    this.busy = Promise.resolve();
    this.status = { state: 'idle', at: 0, message: '' };
  }

  // ------------------------------------------------------------- state
  statePath(uuid) { return path.join(this.dir, 'books', uuid.replace(/[^\w-]/g, '') + '.json'); }
  load(uuid) {
    try { return JSON.parse(fs.readFileSync(this.statePath(uuid), 'utf8')); } catch { return { chapters: {} }; }
  }
  save(uuid, st) {
    const file = this.statePath(uuid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(st));
    fs.renameSync(file + '.tmp', file);
  }
  forget(uuid) { try { fs.unlinkSync(this.statePath(uuid)); } catch { /* none */ } }
  forgetChapters(uuid, chIds) {
    const st = this.load(uuid);
    for (const chId of chIds) if (st.chapters && st.chapters[chId]) { st.chapters[chId].base = null; st.chapters[chId].version = null; }
    this.save(uuid, st);
  }
  links(uuid) {
    const st = this.load(uuid);
    const chapters = {};
    for (const [chId, c] of Object.entries(st.chapters || {})) chapters[chId] = c.docId;
    return { folderId: st.folderId || null, masterId: st.masterId || null, chapters };
  }

  // One sync at a time; a call while one runs waits its turn.
  run(model) {
    const next = this.busy.then(() => this.syncBook(model));
    this.busy = next.catch(() => {});
    return next;
  }

  // ------------------------------------------------------------- the book
  // model: { book: {uuid, title, subtitle, author}, entries: [{chId, kind,
  //          heading, name, blocks}], force }
  // returns { pulls: [{chId, blocks}], conflicts: [{chId, blocks, name}],
  //           masterEdits: [{name, before, after}], created: n }
  async syncBook(model) {
    const { book } = model;
    const st = this.load(book.uuid);
    st.chapters = st.chapters || {};
    const out = { pulls: [], conflicts: [], masterEdits: [], created: 0, pushed: 0 };
    const t0 = this.now();
    const poll = model.force || !st.polledAt || t0 - st.polledAt >= POLL_MS;
    const localDirty = model.dirty !== false;
    if (!poll && !localDirty && st.folderId) return out;

    await this.ensureFolder(st, book);
    // what Drive holds in the folder, with versions: one call shows every
    // Doc edited since the last look
    const listed = new Map();
    for (const f of await this.api.listFiles(`'${esc(st.folderId)}' in parents and trashed = false`)) listed.set(f.id, f);
    st.polledAt = t0;

    const docWant = (e) => (e.heading ? [B.normalize({ k: headingKind(e.kind), text: e.heading })] : []).concat(e.blocks.map(B.normalize));

    // ---- chapters
    for (let n = 0; n < model.entries.length; n++) {
      const e = model.entries[n];
      const want = docWant(e);
      const name = `${pad(n + 1)} · ${e.name}`;
      let c = st.chapters[e.chId];
      if (c && !listed.has(c.docId)) {
        // gone from the folder (moved or trashed in Drive): look for it by its tag
        const found = [...listed.values()].find((f) => f.appProperties && f.appProperties.neoChapter === e.chId);
        if (found) c.docId = found.id; else c = null;
      }
      if (!c) {
        const found = [...listed.values()].find((f) => f.appProperties && f.appProperties.neoChapter === e.chId && f.mimeType === DOC);
        if (found) {
          // a Doc made before (this computer forgot it): adopt, and treat its
          // text as the agreed one only if it matches
          c = st.chapters[e.chId] = { docId: found.id, base: null, version: null, name: found.name };
        } else {
          const f = await this.api.createFile({ name, mimeType: DOC, parents: [st.folderId], appProperties: { neoBook: book.uuid, neoChapter: e.chId } });
          await this.write(f.id, want);
          const v = await this.api.getFile(f.id);
          st.chapters[e.chId] = { docId: f.id, base: keysOf(want), version: v.version, name };
          out.created++;
          continue;
        }
      }
      if (c.name !== name) {
        await this.api.updateFile(c.docId, { name });
        c.name = name;
        const v = listed.get(c.docId);
        if (v) v.version = null; // the rename bumped it; read the Doc to be sure
      }
      const base = c.base;
      const localChanged = !base || !sameKeys(want, base);
      const lv = listed.get(c.docId);
      const remoteMaybe = !base || !lv || lv.version !== c.version;
      if (!localChanged && !remoteMaybe) continue;

      try {
        await this.syncChapter(e, c, want, lv, out);
      } catch (err) {
        if (!err.stale) throw err; // edited in Docs mid-sync: next time round
      }
    }

    // ---- chapters that left the book: their Docs go to "Deleted chapters"
    const inBook = new Set(model.entries.map((e) => e.chId));
    for (const [chId, c] of Object.entries(st.chapters)) {
      if (inBook.has(chId)) continue;
      if (!st.deletedFolderId) {
        const f = await this.api.createFile({ name: 'Deleted chapters', mimeType: FOLDER, parents: [st.folderId], appProperties: { neoBook: book.uuid, neoRole: 'deleted' } });
        st.deletedFolderId = f.id;
      }
      try {
        const when = new Date(this.now()).toISOString().slice(0, 10);
        await this.api.updateFile(c.docId, {
          name: `${(c.name || 'Chapter').replace(/^\d+ · /, '')} (deleted ${when})`,
          addParents: [st.deletedFolderId], removeParents: [st.folderId]
        });
      } catch (err) {
        if (err.status !== 404) throw err; // already gone from Drive: nothing to keep
      }
      delete st.chapters[chId];
    }

    // ---- the Master Manuscript
    try {
      await this.syncMaster(st, model, listed, out);
    } catch (err) {
      if (!err.stale) throw err;
    }
    this.save(book.uuid, st);
    return out;
  }

  async syncChapter(e, c, want, lv, out) {
    const base = c.base;
    const localChanged = !base || !sameKeys(want, base);
    const doc = await this.api.getDoc(c.docId);
    const remote = B.fromDoc(doc);
    const remoteChanged = !base || !sameKeys(remote, base);
    if (base && !remoteChanged && !localChanged) { c.version = lv ? lv.version : c.version; return; }

    const body = (blocks) => (blocks[0] && blocks[0].k !== 'p' && blocks[0].k !== 'brk' ? blocks.slice(1) : blocks);
    if (!base && sameBlocks(remote, want)) {
      c.base = keysOf(want);
    } else if (remoteChanged && !localChanged) {
      // edited in Docs: the words go back to NEO. The agreed text becomes
      // the Doc's; the next sync tidies the Doc if NEO reads it differently.
      out.pulls.push({ chId: e.chId, blocks: body(remote) });
      c.base = keysOf(remote);
    } else if (remoteChanged && localChanged) {
      // edited in both places: keep both. NEO gets the Doc's version as a
      // chapter of its own; this Doc goes on with NEO's.
      await this.write(c.docId, want, doc);
      // (only once the Doc took NEO's text: a refused write means the next
      // sync sees this again, and a second copy would be made)
      if (!sameBlocks(body(remote), e.blocks.map(B.normalize))) out.conflicts.push({ chId: e.chId, blocks: body(remote), name: e.name });
      c.base = keysOf(want);
      out.pushed++;
    } else {
      await this.write(c.docId, want, doc);
      c.base = keysOf(want);
      out.pushed++;
    }
    c.version = (await this.api.getFile(c.docId)).version;
  }

  async ensureFolder(st, book) {
    if (st.folderId) {
      try {
        const f = await this.api.getFile(st.folderId);
        if (f.trashed) st.folderId = null;
        else if (f.name !== bookName(book)) await this.api.updateFile(st.folderId, { name: bookName(book) });
      } catch (err) {
        if (err.status !== 404) throw err;
        st.folderId = null;
      }
    }
    if (!st.folderId) {
      const found = await this.api.listFiles(`appProperties has { key='neoBook' and value='${esc(book.uuid)}' } and mimeType = '${FOLDER}' and trashed = false`);
      const mine = found.find((f) => !f.appProperties || !f.appProperties.neoRole);
      if (mine) st.folderId = mine.id;
      else st.folderId = (await this.api.createFile({ name: bookName(book), mimeType: FOLDER, appProperties: { neoBook: book.uuid } })).id;
      // a new folder: forget the Docs this computer thought it knew
      if (!mine) { st.chapters = {}; st.masterId = null; st.deletedFolderId = null; }
    }
  }

  // ------------------------------------------------------------ master
  async syncMaster(st, model, listed, out) {
    const { book } = model;
    const want = [];
    const owner = []; // which chapter each block belongs to, for comments
    const add = (b, name) => { want.push(B.normalize(b)); owner.push(name); };
    add({ k: 'title', text: book.title || 'Untitled' }, '');
    if (book.subtitle) add({ k: 'subtitle', text: book.subtitle }, '');
    if (book.author) add({ k: 'p', text: 'by ' + book.author, align: 'center' }, '');
    for (const e of model.entries) {
      if (e.heading) add({ k: headingKind(e.kind), text: e.heading }, e.name);
      for (const b of e.blocks) add(b, e.name);
    }
    const name = `${bookName(book)} — Master Manuscript`;

    if (st.masterId && !listed.has(st.masterId)) {
      const found = [...listed.values()].find((f) => f.appProperties && f.appProperties.neoRole === 'master');
      st.masterId = found ? found.id : null;
      if (found) st.masterBase = null;
    }
    if (!st.masterId) {
      const found = [...listed.values()].find((f) => f.appProperties && f.appProperties.neoRole === 'master');
      if (found) {
        st.masterId = found.id;
        st.masterBase = null;
      } else {
        const f = await this.api.createFile({ name, mimeType: DOC, parents: [st.folderId], appProperties: { neoBook: book.uuid, neoRole: 'master' } });
        st.masterId = f.id;
        await this.addReminder(f.id);
        await this.write(f.id, want);
        st.masterBase = keysOf(want);
        st.masterOwner = owner;
        st.masterName = name;
        st.masterVersion = (await this.api.getFile(f.id)).version;
        out.created++;
        return;
      }
    }
    if (st.masterName !== name) { await this.api.updateFile(st.masterId, { name }); st.masterName = name; }
    const lv = listed.get(st.masterId);
    const localChanged = !st.masterBase || !sameKeys(want, st.masterBase);
    const remoteMaybe = !lv || lv.version !== st.masterVersion;
    if (!localChanged && !remoteMaybe) return;

    const doc = await this.api.getDoc(st.masterId);
    const remote = B.fromDoc(doc);
    const undone = [];
    if (st.masterBase && !sameKeys(remote, st.masterBase)) {
      // someone typed in the reading copy: it is put back below, and a
      // comment says where the change belongs
      const baseBlocks = st.masterBase.map(keyBlock);
      for (const h of B.diffBlocks(baseBlocks, remote)) {
        const owners = st.masterOwner || [];
        undone.push({
          name: owners[Math.min(h.i0, owners.length - 1)] || '',
          before: baseBlocks.slice(h.i0, h.i1).map(B.plain).join('\n'),
          after: remote.slice(h.j0, h.j1).map(B.plain).join('\n')
        });
      }
    }
    if (!sameKeys(remote, keysOf(want))) {
      await this.write(st.masterId, want, doc);
      out.pushed++;
    }
    // said only once the edit really was undone
    for (const u of undone) {
      out.masterEdits.push(u);
      if (out.masterEdits.length > MAX_COMMENTS) continue;
      const lines = [
        `Edit undone — this is a reading copy. Make this change in NEO${u.name ? ` or in the “${u.name}” Doc` : ''}.`,
        '',
        u.before ? `Original: “${clip(u.before)}”` : 'Original: (nothing here)',
        u.after ? `Your change: “${clip(u.after)}”` : 'Your change: (deleted)'
      ];
      try { await this.api.createComment(st.masterId, lines.join('\n')); } catch (err) { this.log('master comment', err); }
    }
    st.masterBase = keysOf(want);
    st.masterOwner = owner;
    st.masterVersion = (await this.api.getFile(st.masterId)).version;
  }

  // The page header every page of the Master Doc carries.
  async addReminder(docId) {
    try {
      const r = await this.api.batchUpdate(docId, [{ createHeader: { type: 'DEFAULT' } }]);
      const headerId = r.replies && r.replies[0] && r.replies[0].createHeader && r.replies[0].createHeader.headerId;
      if (!headerId) return;
      const text = 'Reading copy — comments welcome. Edits made here are undone automatically.';
      await this.api.batchUpdate(docId, [
        { insertText: { location: { segmentId: headerId, index: 0 }, text } },
        {
          updateTextStyle: {
            range: { segmentId: headerId, startIndex: 0, endIndex: text.length },
            textStyle: { italic: true, fontSize: { magnitude: 9, unit: 'PT' }, weightedFontFamily: { fontFamily: 'Times New Roman', weight: 400 } },
            fields: 'italic,fontSize,weightedFontFamily'
          }
        },
        { updateParagraphStyle: { range: { segmentId: headerId, startIndex: 0, endIndex: text.length }, paragraphStyle: { alignment: 'CENTER' }, fields: 'alignment' } }
      ]);
    } catch (err) {
      this.log('master header', err); // a missing header is no reason to stop
    }
  }

  // Make the Doc read as `want`. Guarded by the Doc's revision: if it
  // changed since it was read (someone typing in Docs this very moment),
  // Google refuses, nothing is written, and the next sync sees the edit.
  async write(docId, want, doc) {
    const d = doc || await this.api.getDoc(docId);
    const reqs = B.editRequests(d, want);
    if (!reqs.length) return;
    await this.api.batchUpdate(docId, reqs, d.revisionId);
  }
}

// What the book's folder (and Master Manuscript) are called, by the setting
// in the Google Drive menu: 'title' (The Lighthouse), 'subtitle' (Book One) or
// 'both' (The Lighthouse: Book One). A book without a subtitle uses its title.
function bookName(book, by = book.nameBy) {
  const title = String(book.title || '').trim() || 'Untitled';
  const sub = String(book.subtitle || '').trim();
  if (!sub) return title;
  if (by === 'subtitle') return sub;
  if (by === 'both') return `${title}: ${sub}`;
  return title;
}

function headingKind(kind) {
  if (kind === 'part') return 'part';
  if (['chapter', 'unnumbered', 'prologue', 'epilogue', 'interlude'].includes(kind)) return 'chapter';
  return 'heading';
}
function sameKeys(blocks, keys) {
  return blocks.length === keys.length && blocks.every((b, i) => B.blockKey(b) === keys[i]);
}
function keyBlock(k) {
  const [kk, text, marks, align, ind] = JSON.parse(k);
  return { k: kk, text, marks, align, ind };
}
function clip(s) { return s.length > 400 ? s.slice(0, 400) + '…' : s; }

module.exports = { Sync, POLL_MS, bookName };
