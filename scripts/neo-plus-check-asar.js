// NEO+: checks a packaged app.asar against its own header — every
// file's bytes where the header says, matching the hash it records. A
// mismatch is an app Electron refuses to start (it exits at once, silently).
// Usage: node scripts/neo-plus-check-asar.js path/to/app.asar
'use strict';

const fs = require('fs');
const crypto = require('crypto');

const file = process.argv[2];
const buf = fs.readFileSync(file);
const headerPickle = buf.readUInt32LE(4);
const jsonLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
const base = 8 + headerPickle;

let checked = 0;
const bad = [];
(function walk(node, at) {
  for (const [name, f] of Object.entries(node.files || {})) {
    const p = at ? at + '/' + name : name;
    if (f.files) { walk(f, p); continue; }
    if (f.unpacked || f.link) continue;
    const start = base + Number(f.offset);
    const bytes = buf.slice(start, start + f.size);
    checked++;
    if (f.integrity && crypto.createHash('sha256').update(bytes).digest('hex') !== f.integrity.hash) bad.push(p);
  }
})(header, '');

console.log(`${checked} files checked in ${file}`);
if (bad.length) {
  console.log(`::error title=app.asar is corrupt::${bad.length} files don't match their hashes, first: ${bad.slice(0, 5).join(', ')}`);
  process.exit(1);
}
console.log('app.asar is whole');
