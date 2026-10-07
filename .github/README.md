# NEO-Drive

**[NEO](https://github.com/hughhowey/neo)** — Hugh Howey's distraction-free word processor for novelists — **with Google Drive built in.**

Every book you write in NEO gets a folder in your Google Drive, a Master Manuscript Google Doc you can share for comments, and a Google Doc for each chapter. They stay in step with NEO as you write, and edits you make to a chapter Doc (on your phone, say) come back into NEO.

> NEO-Drive is an unofficial build by [Ethan Everitt](https://github.com/ethaneveritt). NEO itself is Hugh Howey's work, MIT-licensed; every release of NEO is merged in here automatically. Please send NEO-Drive problems [here](https://github.com/ethaneveritt/NEO-Drive/issues), not to Hugh.

## Install (Windows)

1. Download **NEO-Setup-*.exe** from the [latest release](https://github.com/ethaneveritt/NEO-Drive/releases/latest).
2. Run it. If Windows says "Windows protected your PC", click **More info → Run anyway** (the installer isn't signed with a paid certificate).
3. That's it. It installs over plain NEO if you have it, and keeps your library, books and settings exactly as they were.

NEO-Drive updates itself, the way NEO does: each morning it picks up Hugh's latest NEO along with NEO-Drive's own changes.

## Connect Google Drive

1. In NEO, open the **Google Drive** menu → **Connect Google Drive…**
2. Your browser opens Google's sign-in. Pick your account and allow access.
3. Open a book. Within a few seconds its folder appears in your Drive.

NEO-Drive asks Google for one permission only: **the files NEO-Drive itself creates.** It cannot see or change anything else in your Drive. Your words go only between your computer and your own Google account. See the [privacy policy](../PRIVACY.md).

## How it works

| In NEO | In Google Drive |
|---|---|
| A book | A folder named for the book — its title, its subtitle, or both (**Google Drive → Name Book Folders By**) |
| The whole book | **Master Manuscript** Doc — a reading copy to share |
| Each chapter (and part, prologue…) | Its own Doc, `01 · Chapter 1 — …`, `02 · …` |
| Deleting a chapter | Its Doc moves to a **Deleted chapters** folder. Nothing is ever deleted. |

Docs are set plainly: Times New Roman, double-spaced, bold headings for parts and chapters, `***` for scene breaks, italics and bold as you wrote them.

**Writing in NEO.** A few seconds after you pause, the chapter's Doc and the Master Manuscript are updated — only the paragraphs that changed, so comments on the rest stay put. Each update lands in the Doc's version history (**File → Version history**).

**Editing a chapter Doc.** Your edits come back into NEO within about fifteen seconds while NEO is open, or as soon as you open the book. Suggestions (Suggesting mode) and comments do **not** change your manuscript; only direct edits do. Share chapter Docs with readers as **Commenter**, so their changes can only ever be suggestions.

**The Master Manuscript is a reading copy.** Readers comment on it. If anyone types in it, the edit is undone within seconds, a comment on the Doc quotes what was typed and says where to make the change, and NEO shows it to you.

**Edited in both places at once** (or offline on both sides)? Nothing is thrown away: NEO keeps its version as **version N**, and the Doc's comes in right after it as **version G**. Merge them yourself, then delete the one you don't need.

**Things to know**

- A book syncs while it's open in NEO. Books you don't open aren't touched.
- It isn't live keystroke-by-keystroke typing — Google doesn't offer that to outside apps — but it's a matter of seconds.
- Chapter titles come from NEO: renaming a heading inside a Doc doesn't rename the chapter.
- Screenplays aren't synced.

**Disconnect** any time from the Google Drive menu, or at [myaccount.google.com/permissions](https://myaccount.google.com/permissions). Your Docs stay in your Drive.

## Also in NEO-Drive

- **Right-click → Italic / Bold / Underline** on selected text (Ctrl+I / B / U work too).
- **Right-click → Fix Apostrophes in This Chapter**: turns every apostrophe and single quote the right way — ’em, ’90s, don’t, ‘quoted’ — lists the judgment calls for you to check, and undoes in one step.

## For developers

How the fork is built, tested and kept in step with Hugh's NEO: [NEO-DRIVE.md](../NEO-DRIVE.md). Hugh's own README: [README.md](../README.md).
