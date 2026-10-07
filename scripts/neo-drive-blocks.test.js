// NEO-Drive: the Docs model and diff engine (neo-drive/blocks.js), checked
// against the Google Docs stand-in (neo-drive/fake-google.js).
const test = require('node:test');
const assert = require('node:assert');
const B = require('../neo-drive/blocks.js');
const { FakeGoogle } = require('../neo-drive/fake-google.js');

const DOC = 'application/vnd.google-apps.document';
const p = (text, extra = {}) => B.normalize({ k: 'p', text, ...extra });
const brk = () => B.normalize({ k: 'brk' });
const ch = (text) => B.normalize({ k: 'chapter', text });

async function freshDoc(g) { return (await g.createFile({ name: 'T', mimeType: DOC })).id; }
async function write(g, id, want) {
  const doc = await g.getDoc(id);
  const reqs = B.editRequests(doc, want);
  if (reqs.length) await g.batchUpdate(id, reqs);
}
async function read(g, id) { return B.fromDoc(await g.getDoc(id)); }
const keys = (bs) => bs.map(B.blockKey);

test('a new Doc filled with blocks reads back as those blocks', async () => {
  const g = new FakeGoogle();
  const id = await freshDoc(g);
  const want = [ch('Chapter 1: Cold Front'), p('It rained.', { marks: [[3, 9, 'i']] }), brk(), p('Line one\u000bline two', { ind: 'flush' }), p('A poem', { ind: 'poetry' }), p('The end', { align: 'center' })];
  await write(g, id, want);
  assert.deepStrictEqual(keys(await read(g, id)), keys(want));
  // the Doc keeps an empty paragraph at its end
  assert.ok(g.docText(id).endsWith('The end\n\n'));
});

test('typing in one paragraph edits only its characters', async () => {
  const g = new FakeGoogle();
  const id = await freshDoc(g);
  const want = [ch('One'), p('Alpha beta gamma.'), p('Second paragraph.')];
  await write(g, id, want);
  const doc = await g.getDoc(id);
  const reqs = B.editRequests(doc, [ch('One'), p('Alpha beta delta gamma.'), p('Second paragraph.')]);
  const kinds = reqs.map((r) => Object.keys(r)[0]);
  assert.ok(!kinds.includes('deleteContentRange'), 'pure insertion deletes nothing');
  assert.deepStrictEqual(reqs.filter((r) => r.insertText).map((r) => r.insertText.text), ['delta ']);
  await g.batchUpdate(id, reqs);
  assert.strictEqual((await read(g, id))[1].text, 'Alpha beta delta gamma.');
});

test('italics added in the middle of a paragraph come through', async () => {
  const g = new FakeGoogle();
  const id = await freshDoc(g);
  await write(g, id, [p('He was sure.')]);
  await write(g, id, [p('He was sure.', { marks: [[7, 11, 'i']] })]);
  assert.deepStrictEqual((await read(g, id))[0].marks, [[7, 11, 'i']]);
  await write(g, id, [p('He was sure.')]);
  assert.deepStrictEqual((await read(g, id))[0].marks, []);
});

test('deleting the last paragraphs never touches the final newline', async () => {
  const g = new FakeGoogle();
  const id = await freshDoc(g);
  await write(g, id, [p('a'), p('b'), p('c')]);
  await write(g, id, [p('a')]);
  assert.deepStrictEqual(keys(await read(g, id)), keys([p('a')]));
  await write(g, id, []);
  assert.deepStrictEqual(await read(g, id), []);
  await write(g, id, [p('back')]);
  assert.deepStrictEqual(keys(await read(g, id)), keys([p('back')]));
});

test('a Doc whose last paragraph has words (edited on a phone) still updates', async () => {
  const g = new FakeGoogle();
  const id = await freshDoc(g);
  await write(g, id, [p('a'), p('b')]);
  // someone deletes the empty last paragraph: "b\n\n" -> "b\n"
  const t = g.docText(id);
  await g.deleteInDoc(id, t.length - 1, t.length);
  assert.ok(!g.docText(id).endsWith('\n\n'));
  await write(g, id, [p('a')]);
  assert.deepStrictEqual(keys(await read(g, id)), keys([p('a')]));
});

test('empty paragraphs typed in the Doc are ignored, and survive untouched', async () => {
  const g = new FakeGoogle();
  const id = await freshDoc(g);
  await write(g, id, [p('a'), p('b')]);
  await g.typeInDoc(id, g.findText(id, 'b'), '\n\n');
  assert.deepStrictEqual(keys(await read(g, id)), keys([p('a'), p('b')]));
});

test('unchanged paragraphs keep their very characters (comments stay anchored)', async () => {
  const g = new FakeGoogle();
  const id = await freshDoc(g);
  const before = [ch('Chapter 2'), p('Keep me.'), p('Change me.'), p('Keep me too.'), p('Drop me.'), p('And me, kept.')];
  await write(g, id, before);
  const ids = (needle) => {
    const d = g.docs.get(id);
    const at = d.text().indexOf(needle);
    return d.chars.slice(at, at + needle.length);
  };
  const keep1 = ids('Keep me.'), keep2 = ids('Keep me too.'), keep3 = ids('And me, kept.');
  await write(g, id, [ch('Chapter 2'), p('Keep me.'), p('Changed, me.'), p('New one.'), p('Keep me too.'), p('And me, kept.')]);
  for (const [was, needle] of [[keep1, 'Keep me.'], [keep2, 'Keep me too.'], [keep3, 'And me, kept.']]) {
    const now = ids(needle);
    assert.ok(was.every((c, i) => c === now[i]), needle + ' was rewritten');
  }
});

test('suggested insertions are not the writer\'s text', () => {
  const doc = { body: { content: [
    { startIndex: 0, endIndex: 1, sectionBreak: {} },
    { startIndex: 1, endIndex: 14, paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [
      { startIndex: 1, endIndex: 5, textRun: { content: 'Say ', textStyle: {} } },
      { startIndex: 5, endIndex: 10, textRun: { content: 'very ', textStyle: {}, suggestedInsertionIds: ['s1'] } },
      { startIndex: 10, endIndex: 14, textRun: { content: 'hi.\n', textStyle: {} } }
    ] } }
  ] } };
  assert.strictEqual(B.fromDoc(doc)[0].text, 'Say hi.');
});

test('NEO paragraphs become blocks and back', () => {
  const para = { runs: [{ text: 'He ' }, { text: 'ran', i: true }, { br: true }, { text: 'away', b: true }], align: '', poetry: false, flush: false };
  const b = B.fromNeoPara(para);
  assert.strictEqual(b.text, 'He ran\u000baway');
  assert.deepStrictEqual(b.marks, [[3, 6, 'i'], [7, 11, 'b']]);
  assert.strictEqual(B.toNeoHtml(b), '<p>He <i>ran</i><br><b>away</b></p>');
  assert.strictEqual(B.toNeoHtml(brk()), '<p class="scene-break">***</p>');
});

// random documents and random edits: whatever the edit, the Doc ends up
// reading back as exactly what was asked for
test('fuzz: any edit lands exactly', async () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const words = ['rain', 'the', 'god', 'Mara', 'ran', 'away', '’em', 'stone', 'dark', '—', 'quiet'];
  const randBlock = () => {
    const r = rnd(10);
    if (r === 0) return brk();
    if (r === 1) return ch('Chapter ' + rnd(30));
    const n = 1 + rnd(8);
    const text = Array.from({ length: n }, () => words[rnd(words.length)]).join(' ');
    const marks = rnd(3) === 0 ? [[0, Math.min(text.length, 1 + rnd(text.length)), ['b', 'i', 'u', 'x', 'bi'][rnd(5)]]] : [];
    return p(text, { marks, align: ['left', 'left', 'center', 'justify'][rnd(4)], ind: ['normal', 'flush', 'poetry'][rnd(3)] });
  };
  for (let round = 0; round < 60; round++) {
    const g = new FakeGoogle();
    const id = await freshDoc(g);
    let cur = Array.from({ length: rnd(12) }, randBlock);
    await write(g, id, cur);
    assert.deepStrictEqual(keys(await read(g, id)), keys(cur), 'initial fill, round ' + round);
    for (let step = 0; step < 6; step++) {
      const next = [...cur];
      const ops = 1 + rnd(4);
      for (let o = 0; o < ops; o++) {
        const r = rnd(4);
        if (r === 0 || !next.length) next.splice(rnd(next.length + 1), 0, randBlock());
        else if (r === 1) next.splice(rnd(next.length), 1);
        else if (r === 2) { const i = rnd(next.length); next[i] = B.normalize({ ...next[i], text: next[i].text + ' more' }); }
        else { const i = rnd(next.length); if (next[i].k === 'p') next[i] = B.normalize({ ...next[i], text: next[i].text.slice(0, Math.max(1, rnd(next[i].text.length))) }); }
      }
      await write(g, id, next);
      assert.deepStrictEqual(keys(await read(g, id)), keys(next), `round ${round} step ${step}`);
      cur = next;
    }
  }
});

test('master profile: every kind reads back as written', async () => {
  const g = new FakeGoogle();
  const id = await freshDoc(g);
  const m = (b) => B.normalize(b, 'master');
  const want = [
    m({ k: 'title', text: 'The Lighthouse' }), m({ k: 'subtitle', text: 'Book One' }), m({ k: 'author', text: 'Ethan Everitt' }),
    m({ k: 'heading', text: 'CONTENTS' }), m({ k: 'toc', text: 'Prologue' }), m({ k: 'tocpart', text: 'PART I: TECHNIQUE GOD' }),
    m({ k: 'toc', text: 'Chapter 1 — The Keeper’s House', ind: 'poetry' }),
    m({ k: 'chapter', text: 'PROLOGUE' }), m({ k: 'p', text: 'The lamp was lit.' }), m({ k: 'brk' }),
    m({ k: 'part', text: 'PART I' }), m({ k: 'parttitle', text: 'The Crossing' }),
    m({ k: 'chapter', text: 'CHAPTER 1 — A DEAD GOD’S HOUSE' }), m({ k: 'p', text: 'Mara knew.', marks: [[0, 4, 'i']] })
  ];
  const doc = await g.getDoc(id);
  await g.batchUpdate(id, B.editRequests(doc, want, 'master'));
  const back = B.fromDoc(await g.getDoc(id), 'master');
  assert.deepStrictEqual(keys(back), keys(want));
  // and the look: Georgia, 1.5 lines, a 1/3-inch indent; new pages for headings
  const d = await g.getDoc(id);
  const para = (t) => d.body.content.find((e) => e.paragraph && e.paragraph.elements.map((x) => x.textRun.content).join('').startsWith(t)).paragraph;
  assert.deepStrictEqual([para('The pen').paragraphStyle.lineSpacing, para('The pen').paragraphStyle.indentFirstLine.magnitude], [150, 24]);
  assert.strictEqual(para('The pen').elements[0].textRun.textStyle.weightedFontFamily.fontFamily, 'Georgia');
  assert.strictEqual(para('PROLOGUE').paragraphStyle.pageBreakBefore, true);
  assert.strictEqual(para('PART I\n').paragraphStyle.pageBreakBefore, true);
  assert.strictEqual(para('The Crossing').paragraphStyle.pageBreakBefore, false);
  assert.strictEqual(para('The Lighthouse').paragraphStyle.pageBreakBefore, false);
});
