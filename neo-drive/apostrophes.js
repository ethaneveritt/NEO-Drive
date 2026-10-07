// NEO-Drive: "Fix Quotes" — turns every apostrophe, single quote and double
// quote in a paragraph the right way. Pure string logic, no DOM, so the tests in
// scripts/neo-drive-apostrophes.test.js can load it directly.
//
// Every change is a one-character swap ('  ‘  ’, "  “  ”), so a paragraph's length
// never changes and the bold/italic runs around the text stay where they are.
//
// The rules, in English typography:
//   ’ inside a word ............. don’t, o’clock, rock’n’roll
//   ’ after a word or punctuation  the boys’, goin’, closing a ‘quote’
//   ’ before a number ........... the ’90s, the ’49ers
//   ’ before a known elision .... ’em, ’til, ’cause, ’tis, ’n’
//   ‘ opening a single quotation  “He said ‘go home,’ and left.”
// The one thing text alone can't settle is a ' at the start of a word NEO
// doesn't know as an elision (dialect: 'ere, 'appen). Those are decided by
// whether a closing mark follows in the paragraph, and flagged for review.
//
// Double quotes:
//   “ at the start of a paragraph, or after a space or an opening bracket
//   ” after a word or punctuation ("Wait," she said. / ‘crutch.’”)
//   ” after a dash when nothing follows ("…costs double—" The fourth.)
//   a dash then a word ("he stopped—"Wait.") is taken as opening, flagged
// A lone " between spaces is left alone.
(function (root) {
  'use strict';

  // Words that drop their first letters. Lowercase; matched case-insensitively.
  const ELISIONS = new Set([
    'em', 'im', 'er', 'is', 'ere', 'ave', 'ad', 'alf', 'appen', 'ow', 'ome', 'ouse',
    'til', 'till', 'tis', 'twas', 'twere', 'twill', 'twould', 'cause', 'cos', 'coz',
    'bout', 'round', 'nuff', 'n', 'kay', 'ello', 'sup', 'scuse', 'spose', 'specially',
    'gainst', 'mongst', 'neath', 'fore', 'pon', 'cept', 'twixt', 'ya', 'cha', 's'
  ]);

  const WORD = /[\p{L}\p{M}\p{N}]/u;
  const LETTER = /[\p{L}\p{M}]/u;
  const DIGIT = /\p{N}/u;
  const SPACE = /\s/u;
  // what can stand right before an opening quotation
  const OPENER = /[\s([{“"«—–-]/u;
  const MARKS = new Set(["'", '‘', '’']);
  const DOUBLES = new Set(['"', '“', '”']);
  const DASH = /[—–-]/u;
  // what can stand right before an opening double quotation
  const D_OPENER = /[\s([{‘«]/u;

  // a double quote at i: { to, flag } or null to leave it
  function planDouble(s, i) {
    const prev = s[i - 1] || '';
    const next = s[i + 1] || '';
    const ends = !next || SPACE.test(next);
    if (!prev || D_OPENER.test(prev)) return ends ? null : { to: '“', flag: false };
    if (DASH.test(prev)) {
      if (ends || /[.,;:!?…)\]’”]/u.test(next)) return { to: '”', flag: false };
      return { to: '“', flag: true };
    }
    return { to: '”', flag: false };
  }

  const isWord = (c) => !!c && WORD.test(c);

  // the run of letters starting at i
  function wordAt(s, i) {
    let j = i;
    while (j < s.length && LETTER.test(s[j])) j++;
    return s.slice(i, j);
  }

  // Does a closing single quote follow position i in the paragraph? A mark
  // after something that isn't a space, and not inside a word.
  function closerAfter(s, i) {
    for (let j = i + 1; j < s.length; j++) {
      const c = s[j];
      if (!MARKS.has(c)) continue;
      const prev = s[j - 1] || '';
      const next = s[j + 1] || '';
      if (prev && !SPACE.test(prev) && !(isWord(prev) && isWord(next))) return true;
    }
    return false;
  }

  // One paragraph's text → the swaps to make.
  // Each change: { index, from, to, flag } — flag is set when the decision
  // was a judgment call the writer should look at.
  function planParagraph(s) {
    const changes = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (DOUBLES.has(c)) {
        const d = planDouble(s, i);
        if (d && (d.to !== c || d.flag)) changes.push({ index: i, from: c, to: d.to, flag: d.flag, word: '' });
        continue;
      }
      if (!MARKS.has(c)) continue;
      const prev = s[i - 1] || '';
      const next = s[i + 1] || '';
      let to = c;
      let flag = false;

      if (isWord(prev) && isWord(next)) {
        to = '’'; // contraction or possessive inside a word
      } else if (prev && !OPENER.test(prev)) {
        to = '’'; // after a word or punctuation: closing quote / trailing apostrophe
      } else if (/[—–-]/u.test(prev) && !isWord(next)) {
        to = '’'; // “she said ‘wait—’” — a cut-off quotation closing
      } else if (DIGIT.test(next)) {
        to = '’'; // ’90s
      } else if (LETTER.test(next)) {
        const w = wordAt(s, i + 1);
        if (ELISIONS.has(w.toLowerCase())) {
          to = '’';
        } else if (c === '’') {
          continue; // the writer already typed it as an apostrophe: leave it
        } else if (closerAfter(s, i)) {
          to = '‘'; // a quotation opens here
          flag = true;
        } else {
          to = '’'; // nothing closes it: most likely a dropped letter
          flag = true;
        }
      } else if (next === '“' || next === '"') {
        to = '‘'; // ‘“nested”’ — rare, but unambiguous
      } else {
        continue; // a lone mark between spaces: leave it be
      }

      if (to !== c || flag) changes.push({ index: i, from: c, to, flag, word: LETTER.test(next) ? wordAt(s, i + 1) : '' });
    }
    return changes;
  }

  // Convenience for tests and plain strings.
  // (indices are UTF-16 positions, the same ones a DOM text node uses)
  function fixText(s) {
    let out = s;
    for (const ch of planParagraph(s)) {
      if (ch.to === ch.from) continue;
      out = out.slice(0, ch.index) + ch.to + out.slice(ch.index + 1);
    }
    return out;
  }

  const api = { planParagraph, fixText, ELISIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NeoDriveApostrophes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
