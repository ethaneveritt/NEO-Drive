# NEO-Drive

Ethan Everitt's personal build of [NEO](https://github.com/hughhowey/neo), Hugh Howey's word processor for authors (MIT license). Everything Hugh ships still arrives here automatically; this fork adds a few things on top.

## What's added

- **Right-click Italic / Bold / Underline** on selected text. (⌘/Ctrl + I, B, U already worked.)
- **Right-click → Fix Quotes in This Chapter.** Turns every apostrophe, single quote and double quote the right way (’em, ’90s, don’t, ‘quoted’), lists the judgment calls so you can check them, and undoes in one step.
- **Updates come from this repo**, not Hugh's, so an update never replaces this build with plain NEO.
- **Google Drive sync**: a folder per book, a Master Manuscript Doc (a reading copy: edits there are undone and noted in a comment), a Doc per chapter, edits made in chapter Docs coming back into NEO, version N / version G when both sides changed, deleted chapters kept in a "Deleted chapters" folder. User-facing description: [.github/README.md](.github/README.md).
- **Comments, Chapter Notes, Notepad** in a dock on the right edge (one open at a time; tucks away to an arrow; the page shifts and narrows to make room). It replaces NEO's Notes & Comments pane on the manuscript — hidden by CSS and by wrapping `focusSticky` / `renderStickies` from `panels.js`, not deleted from `app.js`, so Hugh's updates still merge; the Outline keeps the pane for its loose cards. Placeholders (Ctrl+Shift+X) show as comment cards, their flags only while Comments is open. Google Docs comments in the margin by their highlighted passage, with Resolve / Edit / Add Comment; a note per chapter; the book's Notes page. The Notes tab gets the same three as its heading. Notepad and Chapter Notes sync both ways with a Notes folder in Drive (Darlings is a copy).

## How it stays current

`.github/workflows/neo-drive.yml` runs every morning:

1. merges Hugh's newest release tag,
2. runs the NEO-Drive tests,
3. builds the Windows installer and publishes it as a release here.

The installed NEO picks the release up on its own, the way NEO always has. If Hugh changes code that NEO-Drive also changes, the run stops, opens an issue, and nothing is released until the merge is resolved. Versions read as Hugh's version with the last number × 100 plus a build count: Hugh's 1.4.0 ships here as 1.4.1, 1.4.2, …

## Where the code is

To keep merges with Hugh's code painless, nearly everything lives in its own files:

| File | Role |
|---|---|
| `neo-drive/main.js` | Main-process additions: right-click menu items, release location |
| `neo-drive/renderer.js` | Window-side additions: formatting, Fix Quotes and its report, the sync tick |
| `neo-drive/panels.js` | The dock at the right edge, NEO's placeholders as comment cards, margin comments (CSS Highlight API, cards level with their passages), Chapter Notes (`neo-drive-chapter-notes.json` beside the book), the Notepad (NEO's `notes` page), and the Notes tab's heading |
| `neo-drive/apostrophes.js` | The apostrophe rules (pure functions) |
| `scripts/neo-drive-*.test.js` | Unit tests (`node --test scripts/neo-drive-*.test.js`) |
| `scripts/neo-drive.e2e.js` | End-to-end tests on a throwaway library (`npx electron scripts/neo-drive.e2e.js`) |
| `neo-drive/blocks.js` | The manuscript as Google Docs paragraphs ("blocks"), reading a Doc back, and the diff that turns one Doc into another with the fewest edits (so comments stay anchored) |
| `neo-drive/sync.js` | The sync engine: folder, Master Manuscript, chapter Docs; push, pull, conflicts, master edits undone, deleted chapters. State per book in `userData/neo-drive/books/` |
| `neo-drive/google.js` | Google sign-in (desktop loopback flow, PKCE, `drive.file` scope only; refresh token encrypted with `safeStorage` in `userData/neo-drive/`) and the Drive/Docs calls |
| `neo-drive/fake-google.js` | An in-memory Google Drive + Docs that keeps Google's index rules, for tests (`NEO_DRIVE_FAKE=1`) |
| `scripts/neo-drive-sync.e2e.js` | Drive sync end to end inside NEO, against the stand-in |

The window side (`renderer.js`) hands the open book to the engine every five seconds, read with NEO's own export helpers (`parasFromHtml`, `chapterHeading`). Text coming back from Docs is written with `window.neo.writeChapter` and picked up by `refreshFromDisk`, exactly as an edit from another device would be, so NEO's own conflict handling stays in charge. A Doc is only ever written with Google's `requiredRevisionId`, so an edit made in Docs between NEO's read and write is never written over.

The Google client ID and secret come from the repo's Actions secrets `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, written into `neo-drive/google-client.json` at build time (gitignored). For a development run: `NEO_DRIVE_CLIENT_ID=… NEO_DRIVE_CLIENT_SECRET=… npm start`.

Hugh's files are touched only at lines marked `NEO-Drive hook`: the script tags in `index.html` (apostrophes, blocks, panels, renderer), one line in `preload.js` (`window.neo.neoDrive`), and four lines in `main.js` (require, right-click menu, app menu, release location). The README visitors see is `.github/README.md`, so Hugh's `README.md` is never edited.

Hugh's own workflows (`build.yml`, `pocket.yml`) are disabled in this repo's Actions settings, so they never run here.
