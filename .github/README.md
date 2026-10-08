# NEO+

**[NEO](https://github.com/hughhowey/neo)** — Hugh Howey's distraction-free word processor for novelists — **plus** Google Drive built in, comments and notes beside the page, natural-voice Read Aloud with audio export, and more.

Every book you write in NEO gets a folder in your Google Drive, a Master Manuscript Google Doc you can share for comments, and a Google Doc for each chapter. They stay in step with NEO as you write, and edits you make to a chapter Doc (on your phone, say) come back into NEO.

> NEO+ is an unofficial build by [Ethan Everitt](https://github.com/ethaneveritt). NEO itself is Hugh Howey's work, MIT-licensed; every release of NEO is merged in here automatically. Please send NEO+ problems [here](https://github.com/ethaneveritt/NEO-Drive/issues), not to Hugh.

## Install (Windows)

1. Download **NEO-Plus-Setup-*.exe** from the [latest release](https://github.com/ethaneveritt/NEO-Drive/releases/latest).
2. Run it. If Windows says "Windows protected your PC", click **More info → Run anyway** (the installer isn't signed with a paid certificate).
3. That's it. It installs over plain NEO if you have it, and keeps your library, books and settings exactly as they were.

NEO+ updates itself, the way NEO does: each morning it picks up Hugh's latest NEO along with NEO+'s own changes.

## Connect Google Drive

1. In NEO, open the **Google Drive** menu → **Connect Google Drive…**
2. Your browser opens Google's sign-in. Pick your account and allow access.
3. Open a book. Within a few seconds its folder appears in your Drive.

NEO+ asks Google for one permission only: **the files NEO+ itself creates.** It cannot see or change anything else in your Drive. Your words go only between your computer and your own Google account. See the [privacy policy](../PRIVACY.md).

## How it works

```
The Lighthouse: Book One/              the book (named by title, subtitle, or both)
├── The Lighthouse: Book One           the Master Manuscript: the whole book, a reading copy to share
├── Notes/
│   ├── Notepad                        NEO's Notes page — write in either place
│   ├── Chapter Notes                  each chapter's notes, under its name — write in either place
│   └── Darlings                       what you cut, a copy for safekeeping
└── Chapters/
    ├── 0.1: Epigraph                  a Doc per chapter, numbered by part
    ├── 0.2: Prologue
    └── Part I: The Crossing/          a folder per part, holding its chapters
        ├── 1.1: The Keeper’s House
        └── 1.2: Low Tide
The Lighthouse: Book One Deleted Chapters/
                                       a chapter deleted in NEO goes here — nothing is ever deleted.
                                       Made beside the book's folder; move it anywhere you like.
```

Chapter Docs are numbered by part: what comes before the first part is part 0, and anything after the last part (an epilogue, an author's note) takes the number after it. A book without parts numbers its chapters as part 1: `0.1: Epigraph`, `0.2: Prologue`, `1.1: Chapter 1` … `1.100: Chapter 100`, `2.1: Epilogue`.

The book's folder and the Master Manuscript can each be named by the book's title, its subtitle, or both: **Google Drive → Name Book Folders By** and **Name the Master Manuscript By**.

The **chapter Docs** are set like a manuscript: Times New Roman 12, double-spaced, a bold centered heading (“Chapter 2: *Low Tide*”), `***` for scene breaks, italics and bold as you wrote them.

The **Master Manuscript** is laid out the way NEO's own Word export lays out a book — a title page, a contents page, a page for each part (“PART I:” over its title), each chapter starting a new page — in the chapters' own plain look; part pages are set like the title page (“PART I:” 20 pt bold over the part's title, 14 pt italic), and the contents show part and chapter titles in italic.

Move a chapter to another part in NEO and its Doc moves folders with it. Move the book's folder anywhere in your Drive and it keeps working.

**Writing in NEO.** A few seconds after you pause, the chapter's Doc and the Master Manuscript are updated — only the paragraphs that changed, so comments on the rest stay put. Each update lands in the Doc's version history (**File → Version history**).

**Editing a chapter Doc.** Your edits come back into NEO within about fifteen seconds while NEO is open, or as soon as you open the book. Suggestions (Suggesting mode) and comments do **not** change your manuscript; only direct edits do. Share chapter Docs with readers as **Commenter**, so their changes can only ever be suggestions.

**The Master Manuscript is a reading copy.** Readers comment on it. If anyone types in it, the edit is undone within seconds, a comment on the Doc quotes what was typed and says where to make the change, and NEO shows it to you. (Google Docs files a comment made by an app under **All comments** — the speech-bubble button at the top right of the Doc — rather than in the margin.)

**Comments, Chapter Notes, Notepad.** A small bar sticks out from the right edge of the window. Click one to open it: Chapter Notes and the Notepad as a soft box over the right side of the page, comments as cards beside their words. Click it again to close it. One is open at a time. The page moves over to make room, and narrows in a small window. The arrow (›) tucks the bar into the edge, leaving only ‹ to bring it back. This takes the place of NEO's own Notes & Comments pane on the manuscript.

- **Comments**: open comments from the chapter Docs and the Master Manuscript, level with the words they're on, which are highlighted. Each shows who wrote it and its replies, with **Resolve** (resolved in Google Docs too); your own also have **Edit**. To make one, select words and right-click → **Add Comment…** (or Ctrl+Alt+M); it goes to the chapter's Google Doc. Comments never touch your text. Choose where they come from in **Google Drive → Show Google Docs Comments in NEO**: chapters and the Master, chapters only, or off.
- Colors tell them apart: Google Docs comments are **yellow**, your own **blue**, placeholders **red**.
- **Placeholders** are comments too: Ctrl+Shift+X while writing plants a flag and opens its note beside it; type what needs doing, press Enter, and you're back in the page past the flag. Flags show in the page only while Comments is open. Placeholders stay in NEO (they don't go to Google Docs).
- **Chapter Notes**: a note for the chapter you're in; it follows you from chapter to chapter.
- **Notepad**: the whole book's notes (NEO's Notes page).

The **Notes** tab has the same three at its top: **Notepad** (the Notes page as always), **Comments** (every comment and placeholder, by chapter, with **Jump to**) and **Chapter Notes** (every chapter's note in one place).

The Notepad and Chapter Notes are in the book's **Notes** folder in Drive, and they work both ways: jot an idea into the Notepad Doc on your phone and it's in NEO next time it syncs. If a note changed in both places at once, nothing is lost: what's new in the Doc is added under what's in NEO. The Darlings Doc is a copy of your Darlings tab, kept for safekeeping; change Darlings in NEO.

**Edited in both places at once** (or offline on both sides)? Nothing is thrown away: NEO keeps its version as **version N**, and the Doc's comes in right after it as **version G**. Merge them yourself, then delete the one you don't need.

**Things to know**

- A book syncs while it's open in NEO. Books you don't open aren't touched.
- It isn't live keystroke-by-keystroke typing — Google doesn't offer that to outside apps — but it's a matter of seconds.
- Chapter titles come from NEO: renaming a heading inside a Doc doesn't rename the chapter.
- Screenplays aren't synced.

**Disconnect** any time from the Google Drive menu, or at [myaccount.google.com/permissions](https://myaccount.google.com/permissions). Your Docs stay in your Drive.

## Also in NEO+

- **Right-click → Italic / Bold / Underline** on selected text (Ctrl+I / B / U work too).
- **Read Aloud** (its own menu, and right-click): read a chapter from the beginning or from where you are, the highlighted passage, the page on screen, or the whole manuscript, and **Continue Where I Stopped** next time. A small player sits above the bottom bar while it reads: back a sentence, pause and play (it picks up mid-sentence), forward a sentence, stop, **NEO's own volume** (separate from your computer's), speed and voice. Ctrl+Shift+U pauses and plays.
- **Read Aloud → Export as Audio**: a chapter, or the whole manuscript (one file, or a file per chapter), saved as MP3s in the natural voice — to listen to on your phone or anywhere. It runs in the background while you write.
- **Natural voices for Read Aloud** (Read Aloud → Download Natural Voices, about 340 MB, once): Kokoro, an open-source voice model that sounds like an audiobook narrator, with American and British voices. It runs entirely on your computer — nothing you write is sent anywhere — and it's free. Without it, Read Aloud uses your computer's own voice.
- **Edit → Spellcheck With → Windows Spellchecker** (or macOS Spellchecker on a Mac): NEO's Spellcheck Pass (Ctrl+;) uses your computer's own spellchecker — the one Word uses — instead of NEO's built-in dictionary. Right-click an underlined word for suggestions or to add it to the dictionary. Switch back any time.
- **View → Show “What happens here…” in the Chapters Pane**: untick it to hide the empty outline-note line under each chapter in the left pane (notes you've written still show).
- **Right-click → Fix Quotes in This Chapter**: turns every apostrophe, single quote and double quote the right way — ’em, ’90s, don’t, ‘quoted’ — lists the judgment calls for you to check, and undoes in one step.

## For developers

How the fork is built, tested and kept in step with Hugh's NEO: [NEO-DRIVE.md](../NEO-DRIVE.md). Hugh's own README: [README.md](../README.md).
