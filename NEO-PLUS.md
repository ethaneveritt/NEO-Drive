# NEO+

Ethan Everitt's personal build of [NEO](https://github.com/hughhowey/neo), Hugh Howey's word processor for authors (MIT license). Everything Hugh ships still arrives here automatically; this fork adds a few things on top.

## What's added

- **Right-click Italic / Bold / Underline** on selected text. (⌘/Ctrl + I, B, U already worked.)
- **Right-click → Fix Quotes in This Chapter.** Turns every apostrophe, single quote and double quote the right way (’em, ’90s, don’t, ‘quoted’), lists the judgment calls so you can check them, and undoes in one step.
- **Read Aloud** (`neo-plus/readaloud.js`): its own menu and right-click items, a player (pause mid-sentence through Web Audio, NEO's own volume via a GainNode, speed, voice, back/forward a sentence, Continue Where I Stopped kept per book), wrapping NEO's `toggleReadAloud` for its shortcut and reusing NEO's `readSentences` / `readRange` and its `neo-speak` highlight. Natural voices (`neo-plus/tts-main.js`, `neo-plus/tts/`): Kokoro-82M (fp32 ONNX) run by ONNX Runtime for Node in a utilityProcess; text → phonemes with phonemizer (eSpeak NG) and kokoro-js's own text preparation (`tts/kokoro-text.js`). The model and runtime aren't in the installer: they're a ~340 MB download from the `kokoro-voices-4` pre-release, built by `.github/workflows/neo-plus-voices.yml`, every file checked against a manifest whose SHA-256 is pinned in `tts-main.js`. Tested end to end on Windows in the release run (`scripts/neo-plus-read.e2e.js`).
- **Edit → Spellcheck With**: NEO's dictionary or the system's (Windows / macOS) spellchecker, through Chromium's own spellcheck (NEO's pass stands aside; suggestions in the right-click menu). Tested on a real Windows machine in the release run (`scripts/neo-plus-spell.e2e.js`).
- **Updates come from this repo**, not Hugh's, so an update never replaces this build with plain NEO.
- **Google Drive sync**: a folder per book, a Master Manuscript Doc (a reading copy: edits there are undone and noted in a comment), a Doc per chapter, edits made in chapter Docs coming back into NEO, version N / version G when both sides changed, deleted chapters kept in a "Deleted chapters" folder. User-facing description: [.github/README.md](.github/README.md).
- **Comments, Chapter Notes, Notepad** in a dock on the right edge (one open at a time; tucks away to an arrow; the page shifts and narrows to make room). It replaces NEO's Notes & Comments pane on the manuscript — hidden by CSS and by wrapping `focusSticky` / `renderStickies` from `panels.js`, not deleted from `app.js`, so Hugh's updates still merge; the Outline keeps the pane for its loose cards. Placeholders (Ctrl+Shift+X) show as comment cards, their flags only while Comments is open. Google Docs comments in the margin by their highlighted passage, with Resolve / Edit / Add Comment; a note per chapter; the book's Notes page. The Notes tab gets the same three as its heading. Notepad and Chapter Notes sync both ways with a Notes folder in Drive (Darlings is a copy).

## How it stays current

`.github/workflows/neo-plus.yml` runs every morning:

1. merges Hugh's newest release tag,
2. runs the NEO+ tests,
3. builds the Windows installer and the Mac apps (Apple silicon and Intel), each tested on its own system, and publishes them together as one release here.

The installed NEO+ on Windows picks the release up on its own, the way NEO always has. The Mac app is only ad-hoc signed (no paid Apple Developer ID), so macOS won't let it install its own updates; on a Mac NEO+ checks the latest release and shows a **Download** note instead (`watchForNewVersion` in `neo-plus/main.js`). It has its own app id (`com.ethaneveritt.neoplus`) and name, so it never mixes with Hugh's NEO on the same Mac. If Hugh changes code that NEO+ also changes, the run stops, opens an issue, and nothing is released until the merge is resolved. Versions are `neo-plus/VERSION` (major.minor) plus a patch number that counts up with each release; Hugh's version is in the release notes.

## Where the code is

To keep merges with Hugh's code painless, nearly everything lives in its own files:

| File | Role |
|---|---|
| `neo-plus/main.js` | Main-process additions: right-click menu items, release location |
| `neo-plus/renderer.js` | Window-side additions: formatting, Fix Quotes and its report, the sync tick |
| `neo-plus/panels.js` | The dock at the right edge, NEO's placeholders as comment cards, margin comments (CSS Highlight API, cards level with their passages), Chapter Notes (`neo-drive-chapter-notes.json` beside the book), the Notepad (NEO's `notes` page), and the Notes tab's heading |
| `neo-plus/apostrophes.js` | The apostrophe rules (pure functions) |
| `scripts/neo-plus-*.test.js` | Unit tests (`node --test scripts/neo-plus-*.test.js`) |
| `scripts/neo-plus.e2e.js` | End-to-end tests on a throwaway library (`npx electron scripts/neo-plus.e2e.js`) |
| `neo-plus/blocks.js` | The manuscript as Google Docs paragraphs ("blocks"), reading a Doc back, and the diff that turns one Doc into another with the fewest edits (so comments stay anchored) |
| `neo-plus/library-sync.js` | The whole library kept the same on every computer through a "NEO+ Library" folder in Drive: a file per library file, a three-way comparison per file (this computer, Drive, and what they last agreed on), merges for NEO's JSON, a chapter changed on both kept as two chapters, backups before anything is replaced, and stops before mass removals. State in `userData/neo-plus/library-sync/` |
| `neo-plus/library.js` | The window's side: where the library is, which book is open, and having NEO take in what arrived (its own `refreshFromDisk`); on a Mac, the new-version note |
| `scripts/neo-plus-library-sync.test.js`, `scripts/neo-plus-library*.e2e.js` | Library sync: two computers on the Google stand-in, and inside NEO |
| `neo-plus/sync.js` | The sync engine: folder, Master Manuscript, chapter Docs; push, pull, conflicts, master edits undone, deleted chapters. State per book in `userData/neo-plus/books/` |
| `neo-plus/google.js` | Google sign-in (desktop loopback flow, PKCE, `drive.file` scope only; refresh token encrypted with `safeStorage` in `userData/neo-plus/`) and the Drive/Docs calls |
| `neo-plus/fake-google.js` | An in-memory Google Drive + Docs that keeps Google's index rules, for tests (`NEO_PLUS_FAKE=1`) |
| `scripts/neo-plus-sync.e2e.js` | Drive sync end to end inside NEO, against the stand-in |

The window side (`renderer.js`) hands the open book to the engine every five seconds, read with NEO's own export helpers (`parasFromHtml`, `chapterHeading`). Text coming back from Docs is written with `window.neo.writeChapter` and picked up by `refreshFromDisk`, exactly as an edit from another device would be, so NEO's own conflict handling stays in charge. A Doc is only ever written with Google's `requiredRevisionId`, so an edit made in Docs between NEO's read and write is never written over.

The Google client ID and secret come from the repo's Actions secrets `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, written into `neo-plus/google-client.json` at build time (gitignored). For a development run: `NEO_PLUS_CLIENT_ID=… NEO_PLUS_CLIENT_SECRET=… npm start`.

Hugh's files are touched only at lines marked `NEO+ hook`: the script tags in `index.html` (apostrophes, blocks, panels, renderer), one line in `preload.js` (`window.neo.neoPlus`), and four lines in `main.js` (require, right-click menu, app menu, release location). The README visitors see is `.github/README.md`, so Hugh's `README.md` is never edited.

Hugh's own workflows (`build.yml`, `pocket.yml`) are disabled in this repo's Actions settings, so they never run here.

## The old name

NEO+ was called NEO-Drive until 2.0, and its repo was renamed to NEO-plus in October 2026 (GitHub forwards the old address, so older copies still update). The old name is kept in just two places, both on purpose:
- `neo-plus/main.js` moves the app-data folder `neo-drive` (settings, Google sign-in, sync state, voices) to `neo-plus` once, on first start. This is tested in `scripts/neo-plus.e2e.js`.
- Chapter Notes stay in `neo-drive-chapter-notes.json` beside each book, so NEO+ never renames files inside a writer's library.
