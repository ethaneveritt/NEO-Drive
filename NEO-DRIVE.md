# NEO-Drive

Ethan Everitt's personal build of [NEO](https://github.com/hughhowey/neo), Hugh Howey's word processor for authors (MIT license). Everything Hugh ships still arrives here automatically; this fork adds a few things on top.

## What's added

- **Right-click Italic / Bold / Underline** on selected text. (⌘/Ctrl + I, B, U already worked.)
- **Right-click → Fix Apostrophes in This Chapter.** Turns every apostrophe and single quote the right way (’em, ’90s, don’t, ‘quoted’), lists the judgment calls so you can check them, and undoes in one step.
- **Updates come from this repo**, not Hugh's, so an update never replaces this build with plain NEO.
- Coming: Google Drive sync (a folder per book, a master manuscript Doc, a Doc per chapter, comments shown in NEO).

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
| `neo-drive/renderer.js` | Window-side additions: formatting, Fix Apostrophes and its report |
| `neo-drive/apostrophes.js` | The apostrophe rules (pure functions) |
| `scripts/neo-drive-*.test.js` | Unit tests (`node --test scripts/neo-drive-*.test.js`) |
| `scripts/neo-drive.e2e.js` | End-to-end tests on a throwaway library (`npx electron scripts/neo-drive.e2e.js`) |

Hugh's files are touched only at lines marked `NEO-Drive hook`: two script tags in `index.html` and three lines in `main.js`.

Hugh's own workflows (`build.yml`, `pocket.yml`) are disabled in this repo's Actions settings, so they never run here.
