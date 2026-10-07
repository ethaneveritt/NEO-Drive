// NEO-Drive: keeping a book and its Google Docs the same.
//
// For each book, in Drive:
//   <book>/                          named by title, subtitle, or both
//     <book>                         the Master Manuscript: the whole book,
//                                    a reading copy, laid out like NEO's export
//     Chapters/
//       0.1: Prologue                a Doc per chapter, numbered by part
//                                    (no parts: 0 before, 1 the chapters, 2 after)
//       Part I: The Crossing/       a folder per part, holding its chapters
//         1.1: The Keeper's House
//   <book> Deleted Chapters/         beside the book's folder (move it anywhere)
// The window (renderer.js) hands
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
const COMMENTS_MS = 60000;  // how often to look for new comments
const MAX_COMMENTS = 5;     // per sync, for edits undone in the Master Doc
// bumped when the Master's look changes: an older Master is set again, whole
const MASTER_STYLE = 3;
// bumped when what a chapter Doc's paragraphs say about themselves changes:
// what both sides agreed on is looked at afresh (nothing is lost: a Doc that
// differs only in look is just set again)
const CHAPTER_FORMAT = 3;
const REMINDER = 'Reading copy — comments welcome. Edits made here are undone automatically.';

const keysOf = (blocks) => blocks.map(B.blockKey);
const sameBlocks = (a, b) => a.length === b.length && keysOf(a).every((k, i) => k === B.blockKey(b[i]));
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
    return { folderId: st.folderId || null, masterId: st.masterId || null, chaptersFolderId: st.chaptersFolderId || null, chapters };
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
    if (st.chapterFormat !== CHAPTER_FORMAT) {
      for (const c of Object.values(st.chapters)) { c.base = null; c.version = null; }
      st.chapterFormat = CHAPTER_FORMAT;
    }
    const out = { pulls: [], conflicts: [], masterEdits: [], created: 0, pushed: 0 };
    const t0 = this.now();
    const poll = model.force || !st.polledAt || t0 - st.polledAt >= POLL_MS;
    const localDirty = model.dirty !== false;
    const commentsDue = !st.commentsAt || t0 - st.commentsAt >= COMMENTS_MS || st.commentsFrom !== (book.commentsFrom || 'all');
    if (!poll && !localDirty && !commentsDue && st.folderId) return out;

    await this.ensureFolder(st, book);
    // every file of this book, wherever it sits in Drive, with versions: one
    // call shows every Doc edited since the last look
    const listed = new Map();
    for (const f of await this.api.listFiles(`appProperties has { key='neoBook' and value='${esc(book.uuid)}' } and trashed = false`)) listed.set(f.id, f);
    st.polledAt = t0;
    const tagged = (key, value, mime) => [...listed.values()].find((f) => f.appProperties && f.appProperties[key] === value && (!mime || f.mimeType === mime));

    // ---- folders: Chapters, and one per part
    st.chaptersFolderId = await this.ensureSubfolder(st.chaptersFolderId, listed, tagged('neoRole', 'chapters', FOLDER), 'Chapters', st.folderId, { neoBook: book.uuid, neoRole: 'chapters' });
    if (!st.deletedFolderId) {
      const d = [...listed.values()].find((f) => f.appProperties && f.appProperties.neoRole === 'deleted');
      if (d) st.deletedFolderId = d.id;
    }
    await this.tidyDeleted(st, listed, book);
    st.parts = st.parts || {};
    for (const part of model.parts || []) {
      const known = st.parts[part.partId];
      const id = await this.ensureSubfolder(known && known.id, listed, [...listed.values()].find((f) => f.appProperties && f.appProperties.neoRole === 'part' && f.appProperties.neoPart === part.partId), part.name, st.chaptersFolderId, { neoBook: book.uuid, neoRole: 'part', neoPart: part.partId });
      if (!known || known.name !== part.name) {
        if (known && known.id === id) await this.api.updateFile(id, { name: part.name });
      }
      st.parts[part.partId] = { id, name: part.name };
    }
    // the folders a Doc of ours may be moved out of (one moved anywhere
    // else in Drive by hand stays where it was put)
    const ours = new Set([st.folderId, st.chaptersFolderId, st.deletedFolderId, ...Object.values(st.parts).map((x) => x.id)].filter(Boolean));
    const containerOf = (e) => (e.part && st.parts[e.part] ? st.parts[e.part].id : st.chaptersFolderId);
    const counts = new Map();
    const docNames = new Map(); // chId -> its Doc's name, for the Chapter Notes Doc

    const docWant = (e) => headsOf(e).concat(e.blocks.map((b) => B.normalize(b)));

    // ---- chapters
    for (const e of model.entries) {
      const want = docWant(e);
      const where = containerOf(e);
      const name = docName(e, counts);
      docNames.set(e.chId, name);
      let c = st.chapters[e.chId];
      if (c && !listed.has(c.docId)) {
        // trashed, or this computer had the wrong id: look for it by its tag
        const found = tagged('neoChapter', e.chId, DOC);
        if (found) c.docId = found.id; else c = null;
      }
      if (!c) {
        const found = tagged('neoChapter', e.chId, DOC);
        if (found) {
          // a Doc made before (this computer forgot it): adopt, and treat its
          // text as the agreed one only if it matches
          c = st.chapters[e.chId] = { docId: found.id, base: null, version: null, name: found.name };
        } else {
          const f = await this.api.createFile({ name, mimeType: DOC, parents: [where], appProperties: { neoBook: book.uuid, neoChapter: e.chId } });
          await this.write(f.id, want);
          const v = await this.api.getFile(f.id);
          st.chapters[e.chId] = { docId: f.id, base: keysOf(want), version: v.version, name };
          out.created++;
          continue;
        }
      }
      const lv = listed.get(c.docId);
      const parents = (lv && lv.parents) || [];
      const move = !parents.includes(where) && parents.some((p) => ours.has(p));
      if (c.name !== name || move) {
        await this.api.updateFile(c.docId, {
          name,
          ...(move ? { addParents: [where], removeParents: parents.filter((p) => ours.has(p)) } : {})
        });
        c.name = name;
        if (lv) lv.version = null; // the change bumped it; read the Doc to be sure
      }
      const base = c.base;
      const localChanged = !base || !sameKeys(want, base);
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
      await this.ensureDeleted(st, listed, book);
      try {
        const when = new Date(this.now()).toISOString().slice(0, 10);
        const f = listed.get(c.docId) || await this.api.getFile(c.docId);
        await this.api.updateFile(c.docId, {
          name: `${(c.name || 'Chapter').replace(/^\d+ · /, '')} (deleted ${when})`,
          addParents: [st.deletedFolderId], removeParents: (f.parents || []).filter((p) => p !== st.deletedFolderId)
        });
      } catch (err) {
        if (err.status !== 404) throw err; // already gone from Drive: nothing to keep
      }
      delete st.chapters[chId];
    }

    // ---- parts that left the book: their folders (empty now) go to "Deleted chapters"
    for (const [partId, part] of Object.entries(st.parts)) {
      if ((model.parts || []).some((x) => x.partId === partId)) continue;
      await this.ensureDeleted(st, listed, book);
      try {
        const f = listed.get(part.id) || await this.api.getFile(part.id);
        const when = new Date(this.now()).toISOString().slice(0, 10);
        await this.api.updateFile(part.id, { name: `${part.name} (deleted ${when})`, addParents: [st.deletedFolderId], removeParents: (f.parents || []).filter((p) => p !== st.deletedFolderId) });
      } catch (err) {
        if (err.status !== 404) throw err;
      }
      delete st.parts[partId];
    }

    // ---- the Master Manuscript
    try {
      await this.syncMaster(st, model, listed, out);
    } catch (err) {
      if (!err.stale) throw err;
    }

    // ---- Notes: the Notepad and Chapter Notes (both ways), Darlings (a copy)
    if (model.notes) {
      try {
        await this.syncNotes(st, model, listed, out, docNames);
      } catch (err) {
        if (!err.stale) throw err;
      }
    }

    // ---- comments, for NEO's Notes & Comments pane
    await this.readComments(st, model, out, t0);
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

    const body = (blocks) => {
      let i = 0;
      while (i < blocks.length && B.isHeading(blocks[i])) i++;
      return blocks.slice(i); // the headings are NEO's, not the chapter's text
    };
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

  // The open comments on the chapter Docs (and the Master, unless the
  // writer turned that off), about once a minute. NEO-Drive's own notes
  // are left out. out.comments replaces what the window showed.
  async readComments(st, model, out, now) {
    const from = model.book.commentsFrom || 'all';
    if (from === 'off') { out.comments = []; out.commentsFetched = true; return; }
    if (!model.force && st.commentsAt && now - st.commentsAt < COMMENTS_MS && st.commentsFrom === from) return;
    const docs = [];
    for (const e of model.entries) if (st.chapters[e.chId]) docs.push({ docId: st.chapters[e.chId].docId, chId: e.chId, where: e.name });
    if (from === 'all' && st.masterId) docs.push({ docId: st.masterId, chId: null, where: 'Master Manuscript' });
    const all = [];
    for (const d of docs) {
      let list;
      try { list = await this.api.listComments(d.docId); } catch (err) {
        if (err.offline) throw err;
        this.log('comments', err);
        out.commentsError = String((err && err.message) || err); // said in the window, once
        continue;
      }
      for (const c of list) {
        if (c.deleted || c.resolved || ours(c)) continue;
        all.push({
          id: c.id, docId: d.docId, chId: d.chId, where: d.where, mine: !!(c.author && c.author.me),
          author: (c.author && c.author.displayName) || '', content: c.content || '',
          quote: (c.quotedFileContent && c.quotedFileContent.value) || '',
          created: c.createdTime || '',
          replies: (c.replies || []).filter((r) => !r.deleted && r.content).map((r) => ({ author: (r.author && r.author.displayName) || '', content: r.content }))
        });
      }
    }
    out.comments = all;
    out.commentsFetched = true;
    st.commentsAt = now;
    st.commentsFrom = from;
  }

  // The book's Notes folder: three Docs.
  //   Notepad        NEO's Notes page, both ways
  //   Chapter Notes  a heading per chapter (named as its Doc is), its notes
  //                  under it; both ways
  //   Darlings       the words cut from the book, a copy (edits there are
  //                  set back)
  async syncNotes(st, model, listed, out, docNames) {
    const { book } = model;
    st.notesFolderId = await this.ensureSubfolder(st.notesFolderId, listed, [...listed.values()].find((f) => f.appProperties && f.appProperties.neoRole === 'notes'), 'Notes', st.folderId, { neoBook: book.uuid, neoRole: 'notes' });
    st.notes = st.notes || {};
    const note = (text, extra = {}) => B.normalize({ k: 'p', text, ind: 'flush', ls: 115, ...extra });
    // each line a paragraph; blank lines kept (the gaps between notes)
    const lines = (text) => trimGaps(String(text || '').split('\n').map((x) => x.trim())).map((x) => note(x));

    // Chapter Notes: every chapter's heading, so notes can be added under
    // any of them in Docs too
    const labels = new Map();
    const chapterWant = [];
    for (const e of model.entries) {
      const label = docNames.get(e.chId) || e.name;
      labels.set(label, e.chId);
      chapterWant.push(B.heading(label, label.length, { ls: 115, sa: chapterWant.length ? 12 : 0 }));
      chapterWant.push(...lines((model.notes.chapters || {})[e.chId]));
    }
    const darlingsWant = [];
    for (const d of model.notes.darlings || []) {
      const label = [d.label, d.date].filter(Boolean).join(' — ') || 'Darling';
      darlingsWant.push(B.heading(label, label.length, { ls: 115, sa: darlingsWant.length ? 12 : 0 }));
      darlingsWant.push(...lines(d.text));
    }
    const docs = [
      { key: 'notepad', name: 'Notepad', want: trimGaps(model.notes.notepad || [], (b) => !b.text).map((b) => B.normalize({ ...b, ind: 'flush', ls: 115, sa: 0, sb: 0 })), twoWay: true },
      { key: 'chapternotes', name: 'Chapter Notes', want: chapterWant, twoWay: true },
      { key: 'darlings', name: 'Darlings', want: darlingsWant, twoWay: false }
    ];
    out.notesPulls = {};
    out.notesConflicts = {};
    for (const d of docs) {
      let c = st.notes[d.key];
      if (c && !listed.has(c.docId)) c = null;
      if (!c) {
        const found = [...listed.values()].find((f) => f.appProperties && f.appProperties.neoNote === d.key && f.mimeType === DOC);
        if (found) c = st.notes[d.key] = { docId: found.id, base: null, version: null };
        else {
          const f = await this.api.createFile({ name: d.name, mimeType: DOC, parents: [st.notesFolderId], appProperties: { neoBook: book.uuid, neoNote: d.key } });
          await this.write(f.id, d.want, null, 'notes');
          st.notes[d.key] = { docId: f.id, base: keysOf(d.want), version: (await this.api.getFile(f.id)).version };
          out.created++;
          continue;
        }
      }
      const lv = listed.get(c.docId);
      const localChanged = !c.base || !sameKeys(d.want, c.base);
      if (!localChanged && lv && c.base && lv.version === c.version) continue;
      const doc = await this.api.getDoc(c.docId);
      const remote = trimGaps(B.fromDoc(doc, { keepEmpty: true }), (b) => !b.text.trim());
      const remoteChanged = !c.base || !sameKeys(remote, c.base);
      if (!d.twoWay) {
        // a copy: whatever was typed there gives way to the book's own
        if (!sameKeys(remote, keysOf(d.want))) { await this.write(c.docId, d.want, doc, 'notes'); out.pushed++; }
        c.base = keysOf(d.want);
      } else if (!c.base && sameBlocks(remote, d.want)) {
        c.base = keysOf(d.want);
      } else if (remoteChanged && !localChanged) {
        out.notesPulls[d.key] = d.key === 'chapternotes' ? readChapterNotes(remote, labels) : remote;
        c.base = keysOf(remote);
      } else if (remoteChanged && localChanged) {
        await this.write(c.docId, d.want, doc, 'notes');
        if (!sameBlocks(remote, d.want)) out.notesConflicts[d.key] = d.key === 'chapternotes' ? readChapterNotes(remote, labels) : remote;
        c.base = keysOf(d.want);
        out.pushed++;
      } else {
        await this.write(c.docId, d.want, doc, 'notes');
        c.base = keysOf(d.want);
        out.pushed++;
      }
      c.version = (await this.api.getFile(c.docId)).version;
    }
  }

  // A folder of ours: the one we know if it's still there, else one tagged
  // as it, else a new one in `parent`.
  async ensureSubfolder(knownId, listed, found, name, parent, appProperties) {
    if (knownId && listed.has(knownId)) return knownId;
    if (found) return found.id;
    return (await this.api.createFile({ name, mimeType: FOLDER, parents: [parent], appProperties })).id;
  }
  // "<book> Deleted Chapters": made beside the book's folder; found by its
  // tag wherever it is moved to after that
  async ensureDeleted(st, listed, book) {
    if (st.deletedFolderId && listed.has(st.deletedFolderId)) return;
    const found = [...listed.values()].find((f) => f.appProperties && f.appProperties.neoRole === 'deleted');
    const f = found || await this.api.createFile({ name: deletedName(book), mimeType: FOLDER, parents: st.folderParents || [], appProperties: { neoBook: book.uuid, neoRole: 'deleted' } });
    st.deletedFolderId = f.id;
    st.deletedPlaced = true;
    listed.set(f.id, f);
  }
  // an existing Deleted Chapters folder: named for the book; and, once, out
  // of the Chapters folder (where 1.4.8–1.4.101 put it) to beside the book's
  async tidyDeleted(st, listed, book) {
    const f = st.deletedFolderId && listed.get(st.deletedFolderId);
    if (!f) return;
    const name = deletedName(book);
    const move = !st.deletedPlaced && (f.parents || []).includes(st.chaptersFolderId);
    if (f.name !== name || move) {
      await this.api.updateFile(f.id, {
        name,
        ...(move ? { addParents: st.folderParents || [], removeParents: [st.chaptersFolderId] } : {})
      });
      f.name = name;
    }
    st.deletedPlaced = true;
  }

  async ensureFolder(st, book) {
    if (st.folderId) {
      try {
        const f = await this.api.getFile(st.folderId);
        st.folderParents = f.parents || [];
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
      const f = mine || await this.api.createFile({ name: bookName(book), mimeType: FOLDER, appProperties: { neoBook: book.uuid } });
      st.folderId = f.id;
      st.folderParents = f.parents || [];
      // a new folder: forget the Docs this computer thought it knew
      if (!mine) { st.chapters = {}; st.masterId = null; st.deletedFolderId = null; st.chaptersFolderId = null; st.parts = {}; }
    }
  }

  // ------------------------------------------------------------ master
  async syncMaster(st, model, listed, out) {
    const { book } = model;
    const want = [];
    const owner = []; // which chapter each block belongs to, for comments
    const add = (b, name) => { want.push(B.normalize(b)); owner.push(name); };
    if (Array.isArray(model.master)) {
      for (const m of model.master) add(m.b, m.owner || '');
    } else {
      // (a model without the window's layout: title, then the chapters)
      add(B.heading(book.title || 'Untitled'), '');
      if (book.subtitle) add(B.heading(book.subtitle), '');
      if (book.author) add({ k: 'p', text: book.author, align: 'center' }, '');
      for (const e of model.entries) {
        headsOf(e).forEach((h, i) => add(i ? h : { ...h, pb: true }, e.name));
        for (const b of e.blocks) add(b, e.name);
      }
    }
    const name = bookName(book, book.masterNameBy || book.nameBy);

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
        st.headerChecked = true;
        st.masterStyle = MASTER_STYLE;
        await this.write(f.id, want, null);
        await this.addReminder(st);
        st.masterBase = keysOf(want);
        st.masterOwner = owner;
        st.masterName = name;
        st.masterVersion = (await this.api.getFile(f.id)).version;
        out.created++;
        return;
      }
    }
    if (st.masterName !== name) { await this.api.updateFile(st.masterId, { name }); st.masterName = name; }
    if (!st.headerChecked) {
      await this.moveOldReminder(st, await this.api.getDoc(st.masterId));
      st.masterVersion = null; // read the Doc again below
    } else if (!st.noteDone && st.masterBase) {
      await this.addReminder(st); // a note that failed to post before
    }
    if (st.masterStyle !== MASTER_STYLE) {
      // a Master set in an older look: empty it, and set it again
      await this.write(st.masterId, [], null);
      await this.write(st.masterId, want, null);
      st.masterStyle = MASTER_STYLE;
      st.masterBase = keysOf(want);
      st.masterOwner = owner;
      st.masterVersion = (await this.api.getFile(st.masterId)).version;
      out.pushed++;
      return;
    }
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
      try { await this.api.createComment(st.masterId, lines.join('\n')); } catch (err) { this.log('master comment', err); out.commentsError = String((err && err.message) || err); }
    }
    st.masterBase = keysOf(want);
    st.masterOwner = owner;
    st.masterVersion = (await this.api.getFile(st.masterId)).version;
  }

  // The note a new Master Doc opens with: a comment, not part of the page,
  // so the writer can resolve it and it is gone for good. Posted once per
  // Master, ever (st.noteDone).
  async addReminder(st) {
    if (st.noteDone) return;
    try {
      await this.api.createComment(st.masterId, REMINDER);
      st.noteDone = true;
    } catch (err) {
      this.log('master note', err); // tried again next sync
    }
  }

  // Masters made by NEO-Drive 1.4.4–1.4.8 carried the note in their page
  // header instead: take that header out (once), and post the comment.
  async moveOldReminder(st, doc) {
    if (st.headerChecked) return;
    const old = Object.values(doc.headers || {}).filter((h) =>
      JSON.stringify(h.content || []).includes('Reading copy'));
    if (old.length) {
      await this.api.batchUpdate(st.masterId, old.map((h) => ({ deleteHeader: { headerId: h.headerId } })));
    }
    st.headerChecked = true;
    if (old.length) await this.addReminder(st);
  }

  // Make the Doc read as `want`. Guarded by the Doc's revision: if it
  // changed since it was read (someone typing in Docs this very moment),
  // Google refuses, nothing is written, and the next sync sees the edit.
  async write(docId, want, doc, profile = 'chapter') {
    const d = doc || await this.api.getDoc(docId);
    const reqs = B.editRequests(d, want, profile);
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

// The Chapter Notes Doc read back: {chId: text}, by the headings in it.
// Lines under a heading NEO doesn't know belong to the chapter above.
function readChapterNotes(blocks, labels) {
  const lines = {};
  let at = null;
  for (const b of blocks) {
    if (B.isHeading(b) && labels.has(b.text)) { at = labels.get(b.text); lines[at] = lines[at] || []; continue; }
    if (!at) continue;
    lines[at].push(B.plain(b));
  }
  const out = {};
  for (const [k, v] of Object.entries(lines)) out[k] = trimGaps(v.map((x) => x.trim())).join('\n');
  return out;
}

// a list without the blank lines at its start and end
function trimGaps(list, blank = (x) => !x) {
  let a = 0, b = list.length;
  while (a < b && blank(list[a])) a++;
  while (b > a && blank(list[b - 1])) b--;
  return list.slice(a, b);
}

// NEO-Drive's own comments (the reading-copy note, edits undone)
function ours(c) {
  const t = String(c.content || '');
  return t === REMINDER || t.startsWith('Edit undone —');
}

// The folder deleted chapters go to.
function deletedName(book) { return `${bookName(book)} Deleted Chapters`; }

// A chapter Doc's name, numbered by part: 0.1: Epigraph, 0.2: Prologue,
// 1.1: The Keeper's House (part 1, chapter 1). e.section is the number the
// window gave it (see bookModel in renderer.js); e.label the chapter's title,
// or its name when it has none. A part's own page is n.0.
function docName(e, counts) {
  if (e.kind === 'part') return `${e.section}.0: ${e.label || e.name}`;
  const section = typeof e.section === 'number' ? e.section : 1;
  const key = 'section ' + section;
  const n = (counts.get(key) || 0) + 1;
  counts.set(key, n);
  return `${section}.${n}: ${e.label || e.name}`;
}

// a chapter's headings: as the window sent them (heads), or one plain heading
function headsOf(e) {
  if (Array.isArray(e.heads)) return e.heads.map((h) => B.normalize(h));
  return e.heading ? [B.heading(e.heading)] : [];
}

function sameKeys(blocks, keys) {
  return blocks.length === keys.length && blocks.every((b, i) => B.blockKey(b) === keys[i]);
}
function keyBlock(k) {
  const [kk, text, marks, align, ind, pb, sa, sb, sz, ls] = JSON.parse(k);
  return { k: kk, text, marks, align, ind, pb, sa, sb, sz, ls };
}
function clip(s) { return s.length > 400 ? s.slice(0, 400) + '…' : s; }

module.exports = { Sync, POLL_MS, bookName };
