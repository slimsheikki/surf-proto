/**
 * The patch-notes chip in the bottom-left corner of the front menu, and the
 * panel it opens.
 *
 * Closed it names the newest merge — `LATEST PATCH #39` and one line of what
 * changed. Open it lists the last five. That is the whole feature.
 *
 * Three things about it are decisions rather than details:
 *
 * It lives *outside* `#menu-stack`. The front menu binds its number keys by
 * iterating `#menu-stack [data-action]`, so a fourth row in that nav would have
 * silently become key 4 — and would have put a changelog at the same visual
 * weight as PLAY. A corner chip takes its own letter, `N`, the way the mode
 * switch already took `B`.
 *
 * It owns no keydown listener. `MainMenu` routes `N` and `Escape` into the
 * methods below from the one listener it already has. That is deliberate: the
 * bug CLAUDE.md records for `PauseMenu` and `UpgradeMenu` is two panels each
 * gated only on "am I open" both answering the same key, and the way to not
 * have it a third time is to not add a third listener. It also means the number
 * keys keep working with the panel open, which is right — the panel is a corner
 * dropdown, not a modal, and it covers nothing.
 *
 * It carries the *note* rather than the PR title. At this width there is no
 * room for both, and a note that needed a title beside it to be understood was
 * not written properly. See `scripts/patch-notes.mjs` for where the text comes
 * from and the heading a PR has to carry to appear here at all.
 */

interface PatchNoteEntry {
  number: number;
  /** Pre-formatted at build time ("5 Aug") — no date maths in the client. */
  date: string;
  note: string;
}

export class PatchNotes {
  private readonly host = document.getElementById('patch-notes')!;

  private readonly panel = document.createElement('div');
  private readonly entriesEl = document.createElement('div');
  private readonly chip = document.createElement('button');
  private readonly chipNumber = document.createElement('span');
  private readonly chipNote = document.createElement('span');

  private opened = false;

  constructor() {
    this.buildChrome();
    this.chip.addEventListener('click', () => this.toggle());
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /**
   * Reads the file the deploy generated. Everything about the failure path is
   * the same as the empty path on purpose: no file, a 404, malformed JSON and
   * zero entries all end with the host hidden and nothing on the menu. A
   * changelog is not worth an error state on the front screen, and `npm run
   * dev` takes this path every time.
   */
  async load(): Promise<void> {
    let entries: PatchNoteEntry[];
    try {
      // Built off BASE_URL, not written absolute: Vite rewrites `url()` in CSS
      // for the deploy's base path but leaves a hard-coded `/patch-notes.json`
      // alone, so an absolute path 404s on Pages and works only on localhost.
      // The logo hit this first; `index.html` documents it there.
      //
      // `cache: 'no-cache'` because this is the one file in the build whose
      // name never changes. Everything else Vite emits carries a content hash,
      // so a new deploy is a new URL and the browser cannot serve a stale one;
      // `patch-notes.json` is copied out of `public/` verbatim, so a returning
      // player holds a cached copy and sees the *previous* deploy's notes —
      // which reads as the panel running a merge behind. This still uses the
      // cache, it just revalidates first, so an unchanged file costs a 304.
      const response = await fetch(`${import.meta.env.BASE_URL}patch-notes.json`, {
        cache: 'no-cache',
      });
      if (!response.ok) return;
      entries = await response.json();
    } catch {
      return;
    }

    if (!Array.isArray(entries) || entries.length === 0) return;

    this.render(entries);
    this.host.classList.remove('hidden');
  }

  toggle(): void {
    this.setOpen(!this.opened);
  }

  close(): void {
    this.setOpen(false);
  }

  private setOpen(open: boolean): void {
    this.opened = open;
    this.host.classList.toggle('is-open', open);
    this.chip.setAttribute('aria-expanded', String(open));
    this.panel.setAttribute('aria-hidden', String(!open));
  }

  /**
   * The parts that do not depend on the data, built once in the constructor so
   * `load()` only ever fills the list. `index.html` holds an empty div; the
   * rest is here, the way `MegaflowHud` builds its panel.
   */
  private buildChrome(): void {
    this.panel.id = 'patch-panel';
    this.panel.setAttribute('aria-hidden', 'true');

    const inner = document.createElement('div');
    inner.className = 'patch-panel-inner';

    const head = document.createElement('div');
    head.className = 'patch-head';
    const title = document.createElement('strong');
    title.textContent = 'Patch Notes';
    head.appendChild(title);

    this.entriesEl.className = 'patch-entries';

    const foot = document.createElement('div');
    foot.className = 'patch-foot';
    const newest = document.createElement('span');
    newest.textContent = 'Newest first';
    const closes = document.createElement('span');
    closes.textContent = 'N closes';
    foot.append(newest, closes);

    inner.append(head, this.entriesEl, foot);
    this.panel.appendChild(inner);

    this.chip.type = 'button';
    this.chip.className = 'patch-chip';
    this.chip.setAttribute('aria-expanded', 'false');
    this.chip.setAttribute('aria-controls', 'patch-panel');

    const top = document.createElement('span');
    top.className = 'patch-chip-top';
    const label = document.createElement('span');
    label.textContent = 'Latest patch';
    this.chipNumber.className = 'patch-num';
    const key = document.createElement('span');
    key.className = 'patch-kb';
    key.textContent = 'N';
    const caret = document.createElement('span');
    caret.className = 'patch-caret';
    caret.textContent = '▾';
    key.appendChild(caret);
    top.append(label, this.chipNumber, key);

    this.chipNote.className = 'patch-chip-note';

    this.chip.append(top, this.chipNote);

    // Panel first: it opens *upward*, so the chip stays pinned to the bottom of
    // the column and never moves out from under the cursor that opened it.
    this.host.append(this.panel, this.chip);
  }

  private render(entries: PatchNoteEntry[]): void {
    const [newest] = entries;
    this.chipNumber.textContent = `#${newest.number}`;
    this.chipNote.textContent = newest.note;

    this.entriesEl.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'patch-entry';

      const top = document.createElement('div');
      top.className = 'patch-entry-top';
      const number = document.createElement('span');
      number.className = 'patch-num';
      number.textContent = `#${entry.number}`;
      const date = document.createElement('span');
      date.className = 'patch-date';
      date.textContent = entry.date;
      top.append(number, date);

      const note = document.createElement('div');
      note.className = 'patch-note';
      note.textContent = entry.note;

      row.append(top, note);
      this.entriesEl.appendChild(row);
    }
  }
}
