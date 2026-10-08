// NEO+: signing in to Google, and the few Drive and Docs calls the
// sync needs. Main process only.
//
// Sign-in is Google's flow for desktop apps: the browser opens Google's
// page, and Google hands the answer back to a one-time listener on this
// computer (127.0.0.1). One permission is asked for, drive.file: NEO+
// sees only the files it created, nothing else in the person's Drive.
//
// The sign-in that lasts (the refresh token) is kept in NEO's own app-data
// folder, encrypted by the operating system where it can be — never in the
// library, and never sent anywhere but Google.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS = 'id,name,mimeType,parents,appProperties,version,modifiedTime,trashed,md5Checksum,size';
const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

// The app's Google client: written into the build from the repo's secrets
// (see .github/workflows/neo-plus.yml); for a development run, from the
// environment. For a desktop app Google doesn't treat the "secret" as one:
// it ships inside every installed copy.
function clientConfig() {
  try {
    const c = require('./google-client.json');
    if (c.client_id) return c;
  } catch { /* not a release build */ }
  if (process.env.NEO_PLUS_CLIENT_ID) {
    return { client_id: process.env.NEO_PLUS_CLIENT_ID, client_secret: process.env.NEO_PLUS_CLIENT_SECRET || '' };
  }
  return null;
}

class Google {
  // dir: where the sign-in is kept (Electron's userData/neo-plus)
  // safeStorage: Electron's, for encrypting it; openExternal: to open the browser
  constructor({ dir, safeStorage, openExternal, log = () => {} }) {
    this.dir = dir;
    this.safe = safeStorage;
    this.openExternal = openExternal;
    this.log = log;
    this.file = path.join(dir, 'google.json');
    this.access = null; // { token, until }
    this.saved = this.readSaved();
  }

  // ------------------------------------------------------------- state
  readSaved() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; }
  }
  writeSaved(obj) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, this.file);
    this.saved = obj;
  }
  get connected() { return !!(this.saved && this.saved.refresh); }
  get email() { return (this.saved && this.saved.email) || ''; }
  get available() { return !!clientConfig(); }

  refreshToken() {
    const s = this.saved;
    if (!s || !s.refresh) return null;
    if (s.enc) {
      try { return this.safe.decryptString(Buffer.from(s.refresh, 'base64')); } catch { return null; }
    }
    return s.refresh;
  }
  keepRefreshToken(token, email) {
    const enc = !!(this.safe && this.safe.isEncryptionAvailable && this.safe.isEncryptionAvailable());
    const refresh = enc ? this.safe.encryptString(token).toString('base64') : token;
    this.writeSaved({ refresh, enc, email: email || '' });
  }

  // ----------------------------------------------------------- sign in
  // Opens the browser on Google's page and waits for the answer.
  async connect() {
    const cfg = clientConfig();
    if (!cfg) throw new Error('This build of NEO has no Google client configured.');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    const { port, codePromise, close } = await this.listen(state);
    const redirect = `http://127.0.0.1:${port}`;
    const url = AUTH_URL + '?' + new URLSearchParams({
      client_id: cfg.client_id,
      redirect_uri: redirect,
      response_type: 'code',
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      state
    });
    try {
      await this.openExternal(url);
      const code = await codePromise;
      const tok = await this.tokenRequest({
        code, client_id: cfg.client_id, client_secret: cfg.client_secret,
        redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier
      });
      if (!tok.refresh_token) throw new Error('Google did not grant a lasting sign-in. Try again.');
      this.access = { token: tok.access_token, until: Date.now() + (tok.expires_in - 60) * 1000 };
      let email = '';
      try {
        const me = await this.request('GET', `${DRIVE}/about?fields=user(emailAddress)`);
        email = me.user && me.user.emailAddress || '';
      } catch (err) { this.log('google about', err); }
      this.keepRefreshToken(tok.refresh_token, email);
      return { email };
    } finally {
      close();
    }
  }

  // a one-time listener for Google's redirect; gives up after ten minutes
  listen(state) {
    return new Promise((resolve, reject) => {
      let settle;
      const codePromise = new Promise((_resolve, _reject) => { settle = { res: _resolve, rej: _reject }; });
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        const code = u.searchParams.get('code');
        const err = u.searchParams.get('error');
        const ok = code && u.searchParams.get('state') === state;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>NEO+</title>
          <body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:90vh">
          <p style="font-size:18px">${ok ? 'NEO is connected to Google Drive. You can close this tab.' : 'Google sign-in didn’t finish. You can close this tab and try again from NEO.'}</p>`);
        if (ok) settle.res(code);
        else if (err || code) settle.rej(new Error(err === 'access_denied' ? 'Sign-in was cancelled.' : 'Google sign-in failed: ' + (err || 'state mismatch')));
      });
      const timer = setTimeout(() => settle.rej(new Error('Sign-in timed out.')), 10 * 60 * 1000);
      const close = () => { clearTimeout(timer); try { server.close(); } catch { /* closed */ } };
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, codePromise, close }));
    });
  }

  async tokenRequest(form) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error('Google sign-in: ' + (body.error_description || body.error || res.status));
      e.status = res.status;
      e.code = body.error;
      throw e;
    }
    return body;
  }

  disconnect() {
    const token = this.refreshToken();
    this.access = null;
    try { fs.unlinkSync(this.file); } catch { /* already gone */ }
    this.saved = null;
    // tell Google too, so the app no longer appears in the account; best effort
    if (token) fetch('https://oauth2.googleapis.com/revoke?' + new URLSearchParams({ token }), { method: 'POST' }).catch(() => {});
  }

  async accessToken() {
    if (this.access && Date.now() < this.access.until) return this.access.token;
    const cfg = clientConfig();
    const refresh = this.refreshToken();
    if (!cfg || !refresh) { const e = new Error('Not connected to Google Drive'); e.signedOut = true; throw e; }
    try {
      const tok = await this.tokenRequest({ client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: refresh, grant_type: 'refresh_token' });
      this.access = { token: tok.access_token, until: Date.now() + (tok.expires_in - 60) * 1000 };
      return this.access.token;
    } catch (err) {
      if (err.code === 'invalid_grant') {
        // revoked, or the password changed: the person has to sign in again
        this.access = null;
        const e = new Error('Google Drive needs you to sign in again.');
        e.signedOut = true;
        throw e;
      }
      throw err;
    }
  }

  // ------------------------------------------------------------ calls
  // One call, with the waiting Google asks for when it's busy (429, 5xx),
  // and one fresh token if the old one ran out.
  // raw: { body (Buffer), type (its Content-Type) } in place of a JSON body;
  // binary: the answer as a Buffer; whole: the Response itself (headers too)
  async request(method, url, body, { retries = 5, raw = null, binary = false, whole = false } = {}) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { Authorization: 'Bearer ' + token, ...(raw ? { 'Content-Type': raw.type } : body ? { 'Content-Type': 'application/json' } : {}) },
          body: raw ? raw.body : body ? JSON.stringify(body) : undefined
        });
      } catch (err) {
        const e = new Error('Offline: ' + (err.message || err));
        e.offline = true;
        throw e;
      }
      if (res.status === 401 && !refreshed) { this.access = null; refreshed = true; attempt--; continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = Math.min(32000, 1000 * 2 ** attempt) + Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      if (res.ok && binary) return Buffer.from(await res.arrayBuffer());
      if (res.ok && whole) return res;
      const text = await res.text();
      const data = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
      if (!res.ok) {
        const e = new Error(`Google ${method} ${url.replace(/\?.*/, '')}: ${res.status} ${(data.error && data.error.message) || ''}`.trim());
        e.status = res.status;
        throw e;
      }
      return data;
    }
  }

  // Drive
  createFile({ name, mimeType, parents = [], appProperties = {} }) {
    return this.request('POST', `${DRIVE}/files?fields=${FILE_FIELDS}`, { name, mimeType, parents, appProperties });
  }
  getFile(id) { return this.request('GET', `${DRIVE}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`); }
  updateFile(id, { name, addParents = [], removeParents = [], appProperties, trashed }) {
    const qs = new URLSearchParams({ fields: FILE_FIELDS });
    if (addParents.length) qs.set('addParents', addParents.join(','));
    if (removeParents.length) qs.set('removeParents', removeParents.join(','));
    const body = {};
    if (name !== undefined) body.name = name;
    if (appProperties) body.appProperties = appProperties;
    if (trashed !== undefined) body.trashed = trashed;
    return this.request('PATCH', `${DRIVE}/files/${encodeURIComponent(id)}?${qs}`, body);
  }
  async listFiles(q) {
    const out = [];
    let pageToken = '';
    do {
      const qs = new URLSearchParams({ q, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: '1000', spaces: 'drive' });
      if (pageToken) qs.set('pageToken', pageToken);
      const r = await this.request('GET', `${DRIVE}/files?${qs}`);
      out.push(...(r.files || []));
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  }
  // A plain file's bytes into Drive: a new file (name, parents,
  // appProperties) or new contents for an existing one (id). Small files go
  // in one request, larger ones as a resumable upload (Google's limit for
  // the one-request kind is 5 MB).
  async upload({ id, name, parents = [], appProperties, data, mimeType = 'application/octet-stream' }) {
    const meta = id ? { ...(appProperties ? { appProperties } : {}) } : { name, parents, appProperties: appProperties || {}, mimeType };
    const method = id ? 'PATCH' : 'POST';
    const where = id ? `${UPLOAD}/files/${encodeURIComponent(id)}` : `${UPLOAD}/files`;
    if (data.length <= 4 * 1024 * 1024) {
      const b = 'neoplus' + crypto.randomBytes(12).toString('hex');
      const body = Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mimeType}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${b}--`)
      ]);
      return this.request(method, `${where}?uploadType=multipart&fields=${FILE_FIELDS}`, null, { raw: { body, type: `multipart/related; boundary=${b}` } });
    }
    const start = await this.request(method, `${where}?uploadType=resumable&fields=${FILE_FIELDS}`, null, { raw: { body: Buffer.from(JSON.stringify(meta)), type: 'application/json; charset=UTF-8' }, whole: true });
    const session = start.headers.get('location');
    if (!session) throw new Error('Google Drive didn’t start the upload');
    return this.request('PUT', session, null, { raw: { body: data, type: mimeType } });
  }
  // a plain file's bytes
  download(id) { return this.request('GET', `${DRIVE}/files/${encodeURIComponent(id)}?alt=media`, null, { binary: true }); }

  // quote: the passage the comment is about. (Google Docs shows a comment
  // made this way in its comment list, quoting the passage; it can't be
  // pinned to the text by an outside app.)
  createComment(fileId, content, quote) {
    return this.request('POST', `${DRIVE}/files/${encodeURIComponent(fileId)}/comments?fields=id,content,createdTime,author(displayName,me),quotedFileContent`,
      { content, ...(quote ? { quotedFileContent: { mimeType: 'text/plain', value: quote } } : {}) });
  }
  updateComment(fileId, commentId, content) {
    return this.request('PATCH', `${DRIVE}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}?fields=id,content`, { content });
  }
  async listComments(fileId) {
    const out = [];
    let pageToken = '';
    do {
      const qs = new URLSearchParams({
        fields: 'nextPageToken,comments(id,content,quotedFileContent,author(displayName,me),createdTime,modifiedTime,resolved,deleted,replies(id,content,author(displayName,me),createdTime,deleted))',
        pageSize: '100'
      });
      if (pageToken) qs.set('pageToken', pageToken);
      const r = await this.request('GET', `${DRIVE}/files/${encodeURIComponent(fileId)}/comments?${qs}`);
      out.push(...(r.comments || []));
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  }
  // Resolving a comment is a reply that says so (Drive's own way)
  resolveComment(fileId, commentId) {
    return this.request('POST', `${DRIVE}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}/replies?fields=id`,
      { action: 'resolve', content: 'Resolved in NEO.' });
  }
  // Docs (indices as Google counts them with suggestions in place)
  getDoc(id) { return this.request('GET', `${DOCS}/${encodeURIComponent(id)}?suggestionsViewMode=SUGGESTIONS_INLINE`); }
  // requiredRevisionId: Google refuses the edit if the Doc changed since it
  // was read (someone typing on a phone), instead of landing it in the wrong place
  async batchUpdate(id, requests, requiredRevisionId) {
    try {
      return await this.request('POST', `${DOCS}/${encodeURIComponent(id)}:batchUpdate`,
        { requests, ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}) }, { retries: 2 });
    } catch (err) {
      if (err.status === 400 && requiredRevisionId && /revision/i.test(err.message)) err.stale = true;
      throw err;
    }
  }
}

module.exports = { Google, clientConfig, FOLDER, DOC };
