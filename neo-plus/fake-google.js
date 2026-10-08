// NEO+: an in-memory stand-in for Google Drive and Google Docs, for
// tests. It keeps Google's own index rules (and refuses what Google
// refuses), so code that edits it correctly edits a real Doc correctly:
//   - a Doc's body starts at index 1 and every paragraph ends in '\n'
//   - text can be inserted anywhere up to just before the final newline
//   - the final newline can never be deleted
//   - inserted text takes the style of the text before it; an inserted
//     newline gives the new paragraph the style of the one it splits
// The interface is the one neo-plus/google.js exposes for the real thing.
'use strict';

let nextId = 1;
const newId = (p) => p + (nextId++).toString(36) + Math.random().toString(36).slice(2, 6);

class FakeDoc {
  constructor() {
    this.chars = [{ c: '\n', ts: {}, ps: { namedStyleType: 'NORMAL_TEXT' } }];
    this.headers = {};
    this.revision = 1;
  }
  get end() { return this.chars.length + 1; } // body endIndex
  // the paragraph (as [startChar, endChar] 0-based, inclusive of its '\n') around char i
  paraBounds(i) {
    let s = i;
    while (s > 0 && this.chars[s - 1].c !== '\n') s--;
    let e = i;
    while (this.chars[e].c !== '\n') e++;
    return [s, e];
  }
  insertText(index, text) {
    if (!(index >= 1 && index <= this.chars.length)) throw new Error(`insertText: index ${index} outside 1..${this.chars.length}`);
    const at = index - 1;
    const [, pe] = this.paraBounds(at);
    const ps = { ...this.chars[pe].ps };
    const before = at > 0 && this.chars[at - 1].c !== '\n' ? this.chars[at - 1].ts : this.chars[at].ts;
    const add = [...text].map((c) => ({ c, ts: { ...before }, ...(c === '\n' ? { ps: { ...ps } } : {}) }));
    this.chars.splice(at, 0, ...add);
  }
  deleteRange(s, e) {
    if (!(s >= 1 && e > s)) throw new Error(`deleteContentRange: bad range ${s}..${e}`);
    if (e > this.chars.length) throw new Error('Invalid deletion range. Cannot delete the requisite newline character at the end of the segment.');
    this.chars.splice(s - 1, e - s);
  }
  // every paragraph the range [s, e) touches
  paragraphs() {
    const out = [];
    let start = 0;
    this.chars.forEach((ch, i) => { if (ch.c === '\n') { out.push([start, i]); start = i + 1; } });
    return out; // [firstChar, newlineChar], 0-based
  }
  paraStyle(s, e, style, fields) {
    const keys = fields.split(',');
    const lo = s - 1, hi = Math.max(e - 1, s); // 0-based [lo, hi)
    for (const [ps, pe] of this.paragraphs()) {
      if (ps < hi && pe >= lo) for (const k of keys) this.chars[pe].ps[k] = style[k];
    }
  }
  textStyle(s, e, style, fields) {
    if (!(s >= 1 && e <= this.chars.length + 1 && e >= s)) throw new Error(`updateTextStyle: bad range ${s}..${e}`);
    const keys = fields.split(',');
    for (let i = s - 1; i < e - 1; i++) for (const k of keys) this.chars[i].ts[k] = style[k];
  }
  toJSON(id, title) {
    const content = [{ startIndex: 0, endIndex: 1, sectionBreak: {} }];
    const same = (x, y) => JSON.stringify(x.ts) === JSON.stringify(y.ts);
    for (const [ps, pe] of this.paragraphs()) {
      const elements = [];
      let rs = ps;
      for (let i = ps; i <= pe; i++) {
        if (i === pe || !same(this.chars[i], this.chars[i + 1])) {
          elements.push({
            startIndex: rs + 1, endIndex: i + 2,
            textRun: { content: this.chars.slice(rs, i + 1).map((x) => x.c).join(''), textStyle: { ...this.chars[rs].ts } }
          });
          rs = i + 1;
        }
      }
      content.push({ startIndex: ps + 1, endIndex: pe + 2, paragraph: { elements, paragraphStyle: { ...this.chars[pe].ps } } });
    }
    const headers = {};
    for (const [hid, h] of Object.entries(this.headers)) headers[hid] = { headerId: hid, content: [{ paragraph: { elements: [{ textRun: { content: h.text } }] } }] };
    return { documentId: id, title, revisionId: 'r' + this.revision, body: { content }, headers };
  }
  text() { return this.chars.map((x) => x.c).join(''); }
}

class FakeGoogle {
  constructor() {
    this.files = new Map();
    this.docs = new Map();
    this.comments = new Map();
    this.calls = { read: 0, write: 0 };
    this.offline = false;
  }
  check() { if (this.offline) { const e = new Error('offline'); e.offline = true; throw e; } }
  touch(f) { f.version = String(Number(f.version || 0) + 1); f.modifiedTime = new Date(Date.now() + Number(f.version)).toISOString(); }

  // ---- Drive
  async createFile({ name, mimeType, parents = [], appProperties = {} }) {
    this.check(); this.calls.write++;
    const id = newId(mimeType && mimeType.includes('folder') ? 'fold' : 'doc');
    const f = { id, name, mimeType, parents: [...parents], appProperties: { ...appProperties }, trashed: false, version: '1', modifiedTime: new Date().toISOString() };
    this.files.set(id, f);
    if (mimeType === 'application/vnd.google-apps.document') { this.docs.set(id, new FakeDoc()); this.comments.set(id, []); }
    return { ...f };
  }
  async getFile(id) {
    this.check(); this.calls.read++;
    const f = this.files.get(id);
    if (!f) { const e = new Error('File not found: ' + id); e.status = 404; throw e; }
    return { ...f, parents: [...f.parents], appProperties: { ...f.appProperties } };
  }
  async updateFile(id, { name, addParents = [], removeParents = [], appProperties, trashed }) {
    this.check(); this.calls.write++;
    const f = this.files.get(id);
    if (!f) { const e = new Error('File not found: ' + id); e.status = 404; throw e; }
    if (name !== undefined) f.name = name;
    if (appProperties) Object.assign(f.appProperties, appProperties);
    if (trashed !== undefined) f.trashed = trashed;
    f.parents = f.parents.filter((p) => !removeParents.includes(p)).concat(addParents.filter((p) => !f.parents.includes(p)));
    return { ...f };
  }
  // q: clauses joined by " and ": 'ID' in parents | trashed = false |
  // mimeType = '...' | appProperties has { key='k' and value='v' }
  async listFiles(q) {
    this.check(); this.calls.read++;
    const clauses = [];
    const re = /appProperties has \{ key='([^']*)' and value='([^']*)' \}|'([^']+)' in parents|trashed = (true|false)|mimeType = '([^']+)'/g;
    let m;
    while ((m = re.exec(q))) clauses.push(m);
    return [...this.files.values()].filter((f) => clauses.every((c) => {
      if (c[1] !== undefined) return f.appProperties[c[1]] === c[2];
      if (c[3] !== undefined) return f.parents.includes(c[3]);
      if (c[4] !== undefined) return f.trashed === (c[4] === 'true');
      if (c[5] !== undefined) return f.mimeType === c[5];
      return true;
    })).map((f) => ({ ...f }));
  }
  async updateComment(fileId, commentId, content) {
    this.check(); this.calls.write++;
    const c = (this.comments.get(fileId) || []).find((x) => x.id === commentId);
    if (!c) { const e = new Error('Comment not found'); e.status = 404; throw e; }
    if (!c.author.me) { const e = new Error('The user does not have permission to edit this comment.'); e.status = 403; throw e; }
    c.content = content;
    return { id: c.id, content };
  }
  async createComment(fileId, content, quote) {
    this.check(); this.calls.write++;
    const c = { id: newId('cm'), content, createdTime: new Date().toISOString(), resolved: false, author: { displayName: 'Me', me: true }, ...(quote ? { quotedFileContent: { mimeType: 'text/plain', value: quote } } : {}) };
    this.comments.get(fileId).push(c);
    return c;
  }
  async resolveComment(fileId, commentId) {
    this.check(); this.calls.write++;
    const c = (this.comments.get(fileId) || []).find((x) => x.id === commentId);
    if (!c) { const e = new Error('Comment not found'); e.status = 404; throw e; }
    c.resolved = true;
    (c.replies = c.replies || []).push({ id: newId('rp'), content: 'Resolved in NEO.', action: 'resolve', author: { displayName: 'NEO+', me: true } });
    return { id: c.replies[c.replies.length - 1].id };
  }
  // tests: a reader's comment on a passage
  addReaderComment(fileId, { content, quote = '', author = 'A Reader', replies = [] }) {
    const c = {
      id: newId('cm'), content, createdTime: new Date().toISOString(), resolved: false, deleted: false,
      author: { displayName: author, me: false },
      ...(quote ? { quotedFileContent: { mimeType: 'text/html', value: quote } } : {}),
      replies: replies.map((r) => ({ id: newId('rp'), content: r.content, author: { displayName: r.author || 'A Reader', me: false } }))
    };
    this.comments.get(fileId).push(c);
    return c;
  }
  async listComments(fileId) { this.check(); this.calls.read++; return [...(this.comments.get(fileId) || [])]; }

  // ---- Docs
  async getDoc(id) {
    this.check(); this.calls.read++;
    const d = this.docs.get(id);
    if (!d) { const e = new Error('Doc not found: ' + id); e.status = 404; throw e; }
    return d.toJSON(id, this.files.get(id).name);
  }
  async batchUpdate(id, requests, requiredRevisionId) {
    this.check(); this.calls.write++;
    const d = this.docs.get(id);
    if (requiredRevisionId && requiredRevisionId !== 'r' + d.revision) {
      const e = new Error('The required revision ID does not match the latest revision.');
      e.status = 400; e.stale = true;
      throw e;
    }
    // all or nothing, as Google does
    const snapshot = JSON.stringify({ chars: d.chars, headers: d.headers });
    const replies = [];
    try {
      for (const r of requests) {
        if (r.insertText) {
          const seg = r.insertText.location.segmentId;
          if (seg) { d.headers[seg].text = d.headers[seg].text.replace(/\n$/, '') + r.insertText.text + '\n'; replies.push({}); continue; }
          d.insertText(r.insertText.location.index, r.insertText.text);
        } else if (r.deleteContentRange) {
          d.deleteRange(r.deleteContentRange.range.startIndex, r.deleteContentRange.range.endIndex);
        } else if (r.updateParagraphStyle) {
          const u = r.updateParagraphStyle;
          if (u.range.segmentId) { replies.push({}); continue; }
          d.paraStyle(u.range.startIndex, u.range.endIndex, u.paragraphStyle, u.fields);
        } else if (r.updateTextStyle) {
          const u = r.updateTextStyle;
          if (u.range.segmentId) { replies.push({}); continue; }
          d.textStyle(u.range.startIndex, u.range.endIndex, u.textStyle, u.fields);
        } else if (r.deleteHeader) {
          delete d.headers[r.deleteHeader.headerId];
        } else if (r.createHeader) {
          const hid = newId('hdr');
          d.headers[hid] = { text: '\n' };
          replies.push({ createHeader: { headerId: hid } });
          continue;
        } else {
          throw new Error('fake: unsupported request ' + Object.keys(r)[0]);
        }
        replies.push({});
      }
    } catch (err) {
      const s = JSON.parse(snapshot);
      d.chars = s.chars; d.headers = s.headers;
      err.status = 400;
      throw err;
    }
    d.revision++;
    this.touch(this.files.get(id));
    return { documentId: id, replies };
  }

  // ---- test helpers: a person typing in the Doc on their phone
  docText(id) { return this.docs.get(id).text(); }
  async typeInDoc(id, index, text) { await this.batchUpdate(id, [{ insertText: { location: { index }, text } }]); }
  async deleteInDoc(id, s, e) { await this.batchUpdate(id, [{ deleteContentRange: { range: { startIndex: s, endIndex: e } } }]); }
  findText(id, needle) { return this.docs.get(id).text().indexOf(needle) + 1; } // Doc index of a string
}

module.exports = { FakeGoogle, FakeDoc };
