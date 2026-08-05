/**
 * The painted HP / XP / DASH panel in the top-left corner.
 *
 * The art is a set of layers exported from a design file
 * (`public/MEGAFLOW_HP_DASH_UI_ELEMENTS/`) plus a placement reference render.
 * Everything below is measured off those PNGs rather than eyeballed — the
 * numbers in `HP_SLOT` / `XP_SLOT` / `DASH_TRACK` are the alpha bounds of the
 * dark bar recesses drawn *into* the frames, so the fills sit in their sockets
 * at any scale. If a frame PNG is ever re-exported, re-measure those and
 * nothing else has to move.
 *
 * Two things about the art that drive the whole implementation:
 *
 * **Every bar is a parallelogram**, so a bar that fills by shrinking a box
 * would cut a *vertical* edge across a slanted bar and read as broken. The
 * fills are full-size images cut down by a `clip-path` polygon whose leading
 * edge carries the bar's own slant, so a half-full bar ends on a line parallel
 * to its own end cap — which is exactly what `UI_HP_HPBar_Damaged.png` (the
 * artist's own mock of a partly-drained bar) shows. That asset is otherwise
 * unused: it is `Full` with the empty half baked in, and the clip produces it.
 *
 * **The dash pips are drawn, not blitted.** They are the one element whose
 * *width* changes at runtime — 2 charges fill the track, and buying a third
 * re-splits the same track three ways — and a stretched sprite means a
 * stretched rim and a slant that flattens as the count drops. So a pip is a
 * plain box in a skewed row, wearing the colours sampled out of
 * `UI_DASH_GaugeBar_Active/InActive.png`; the rim stays one pixel and the lean
 * stays `PIP_SLANT` whatever the charge count is. The sprites remain the
 * reference for those colours.
 */

/** Natural pixel size of `UI_HP_BackgroundElement.png`, and the drawn part of it. */
const HP_FRAME = { w: 901, h: 578 };
/** Alpha bounds of the frame art inside that image — the rest is export padding. */
const HP_CONTENT = { x: 17, y: 127, w: 865, h: 253 };

/** The dark recess the HP bar sits in, in `HP_FRAME` pixels. */
const HP_SLOT = { x: 301, y: 254, w: 522, h: 70 };
/**
 * How far the top edge of a bar leads its bottom edge, as a fraction of the
 * bar's own width. Measured off the same recess: 43 px of lean over 522 px.
 */
const HP_SLANT = 43 / HP_SLOT.w;

/** `UI_XP_XPBar_BackgroundElement.png`, and the recess inside it. */
const XP_FRAME = { w: 400, h: 93 };
const XP_SLOT = { x: 100, y: 17, w: 251, h: 48 };
/** `UI_HP_XPBar_Full.png` leans 28 px over its 240 px width. */
const XP_SLANT = 28 / 240;
/** The blue fill is smaller than its track — inset it rather than let it spill. */
const XP_FILL_INSET = { x: 0.04, y: 0.1 };

/** `UI_DASH_BackgroundElement.png`, and where `UI_DASH_GaugeBarBackground.png` lands on it. */
const DASH_FRAME = { w: 517, h: 172 };
const DASH_TRACK = { x: 197, y: 65, w: 287, h: 62 };

/**
 * Pip lean, as x per y. `UI_DASH_GaugeBar_Active.png` walks its edges 22 px
 * left over 45 px of height; `skewX` wants that as an angle.
 */
const PIP_SLANT = 0.5;
const PIP_SKEW_DEG = (Math.atan(PIP_SLANT) * 180) / Math.PI;

/** Placement of the three frames, relative to the HP frame's drawn box. */
const XP_PLACEMENT = { left: 52.4, top: -1, width: 46.2 };
const DASH_PLACEMENT = { left: 8, top: 118, width: 55 };

/**
 * Bar easing, in e-folds per second. HP is the slower of the two on purpose:
 * a hit is worth watching land, whereas XP trickles in continuously and a lazy
 * XP bar just reads as lag.
 */
const HP_RATE = 9;
const XP_RATE = 12;
/** The level-up sweep. Fast — it is a flourish between two real states. */
const XP_FLUSH_RATE = 16;
/** Seconds the XP bar stays lit after a level-up. */
const FLASH_SECONDS = 0.5;

export interface MegaflowHudState {
  hpFraction: number;
  xpFraction: number;
  level: number;
  /** Whole charges available right now. */
  dashCharges: number;
  /** Charge cap — the number of pips the track is split into. */
  dashMaxCharges: number;
  /** 0..1 of the *whole* meter: whole charges plus progress toward the next. */
  dashFraction: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Frame-rate independent approach — the same curve at 30 fps and at 128 Hz. */
function approach(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

/**
 * The lit part of a leaning bar, as a clip polygon.
 *
 * `slant` is the lead of the top edge over the bottom one as a fraction of the
 * width, so at `fraction` 1 this is the bar's own outline and at 0 it collapses
 * to a zero-area line — no special-casing at either end.
 */
function barClip(fraction: number, slant: number): string {
  const s = slant * 100;
  const run = fraction * (100 - s);
  return `polygon(${s.toFixed(2)}% 0%, ${(s + run).toFixed(2)}% 0%, ${run.toFixed(2)}% 100%, 0% 100%)`;
}

function div(className: string, parent?: HTMLElement): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  parent?.append(el);
  return el;
}

/** Percentages of a containing box, from a rect measured in that box's own pixels. */
function place(el: HTMLElement, rect: { x: number; y: number; w: number; h: number }, box: { w: number; h: number }, origin = { x: 0, y: 0 }): void {
  el.style.left = `${((rect.x - origin.x) / box.w) * 100}%`;
  el.style.top = `${((rect.y - origin.y) / box.h) * 100}%`;
  el.style.width = `${(rect.w / box.w) * 100}%`;
  el.style.height = `${(rect.h / box.h) * 100}%`;
}

export class MegaflowHud {
  private readonly root: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly xpFrame: HTMLDivElement;
  private readonly xpFill: HTMLDivElement;
  private readonly pipRow: HTMLDivElement;
  private pips: HTMLDivElement[] = [];

  /** Displayed values, chasing the real ones. See `update`. */
  private hpShown = 1;
  private xpShown = 0;
  private level = 0;
  /** Mid level-up flourish: run the bar out to full before dropping it back. */
  private flushing = false;
  private flash = 0;

  /** Last values written to the DOM, so a settled bar stops touching style. */
  private hpWritten = -1;
  private xpWritten = -1;
  private flashWritten = -1;
  private pipsWritten: number[] = [];

  constructor() {
    this.root = div('hidden');
    this.root.id = 'mf-hud';

    // The HP frame carries 127 px of transparent export padding above the art,
    // which would otherwise push the panel down the screen by half its height.
    // The box is sized to the *drawn* rect and the image hung off it oversized.
    const vitals = div('mf-vitals', this.root);
    vitals.style.aspectRatio = `${HP_CONTENT.w} / ${HP_CONTENT.h}`;
    const hpArt = div('mf-hp-art', vitals);
    hpArt.style.left = `${(-HP_CONTENT.x / HP_CONTENT.w) * 100}%`;
    hpArt.style.top = `${(-HP_CONTENT.y / HP_CONTENT.h) * 100}%`;
    hpArt.style.width = `${(HP_FRAME.w / HP_CONTENT.w) * 100}%`;
    hpArt.style.height = `${(HP_FRAME.h / HP_CONTENT.h) * 100}%`;

    const hpSlot = div('mf-hp-slot', vitals);
    place(hpSlot, HP_SLOT, HP_CONTENT, HP_CONTENT);
    this.hpFill = div('mf-hp-fill', hpSlot);

    this.xpFrame = div('mf-xp-frame', vitals);
    this.xpFrame.style.left = `${XP_PLACEMENT.left}%`;
    this.xpFrame.style.top = `${XP_PLACEMENT.top}%`;
    this.xpFrame.style.width = `${XP_PLACEMENT.width}%`;
    this.xpFrame.style.aspectRatio = `${XP_FRAME.w} / ${XP_FRAME.h}`;
    const xpSlot = div('mf-xp-slot', this.xpFrame);
    place(xpSlot, XP_SLOT, XP_FRAME);
    this.xpFill = div('mf-xp-fill', xpSlot);
    this.xpFill.style.inset = `${XP_FILL_INSET.y * 100}% ${XP_FILL_INSET.x * 100}%`;

    const dash = div('mf-dash', vitals);
    dash.style.left = `${DASH_PLACEMENT.left}%`;
    dash.style.top = `${DASH_PLACEMENT.top}%`;
    dash.style.width = `${DASH_PLACEMENT.width}%`;
    dash.style.aspectRatio = `${DASH_FRAME.w} / ${DASH_FRAME.h}`;
    const dashTrack = div('mf-dash-track', dash);
    place(dashTrack, DASH_TRACK, DASH_FRAME);
    this.pipRow = div('mf-pip-row', dashTrack);
    // The whole row leans, so the pips inside it are plain boxes and flexbox
    // can do the splitting. Padding and gap therefore lean with them, which is
    // what keeps the end pips parallel to the track's own ends.
    this.pipRow.style.transform = `skewX(${-PIP_SKEW_DEG}deg)`;

    document.body.append(this.root);
  }

  /**
   * `dt` is the sim tick, which is what drives the easing — the bars are read
   * during play and nowhere else, so freezing them with the sim is correct.
   */
  update(state: MegaflowHudState, dt: number): void {
    this.updateHp(state, dt);
    this.updateXp(state, dt);
    this.updateDash(state);
  }

  private updateHp(state: MegaflowHudState, dt: number): void {
    // The bar is a *fraction*, which is the whole answer to "keep it inside the
    // frame when max HP grows": a bigger pool moves the bar less per hit and
    // the art never has to change size.
    this.hpShown = approach(this.hpShown, clamp01(state.hpFraction), HP_RATE, dt);
    if (Math.abs(this.hpShown - this.hpWritten) < 0.0005) return;
    this.hpWritten = this.hpShown;
    this.hpFill.style.clipPath = barClip(this.hpShown, HP_SLANT);
  }

  private updateXp(state: MegaflowHudState, dt: number): void {
    const target = clamp01(state.xpFraction);
    // A level-up drops the bar from nearly-full to nearly-empty in one tick.
    // Sliding backwards through that reads as *losing* progress, so the bar
    // finishes its sweep to full first and only then snaps to the new level.
    if (state.level > this.level) {
      this.flushing = true;
      this.flash = FLASH_SECONDS;
    }
    this.level = state.level;

    if (this.flushing) {
      this.xpShown = approach(this.xpShown, 1, XP_FLUSH_RATE, dt);
      if (this.xpShown > 0.995) {
        this.xpShown = target;
        this.flushing = false;
      }
    } else if (target < this.xpShown - 0.15) {
      // A drop with no level-up behind it is a restart or a rewind, and both
      // want the bar where the run actually is, not a flourish.
      this.xpShown = target;
    } else {
      this.xpShown = approach(this.xpShown, target, XP_RATE, dt);
    }

    if (Math.abs(this.xpShown - this.xpWritten) >= 0.0005) {
      this.xpWritten = this.xpShown;
      this.xpFill.style.clipPath = barClip(this.xpShown, XP_SLANT);
    }

    this.flash = Math.max(0, this.flash - dt);
    const lit = this.flash / FLASH_SECONDS;
    if (Math.abs(lit - this.flashWritten) >= 0.01) {
      this.flashWritten = lit;
      this.xpFrame.style.setProperty('--mf-flash', lit.toFixed(3));
    }
  }

  private updateDash(state: MegaflowHudState): void {
    const cap = Math.max(1, Math.round(state.dashMaxCharges));
    if (this.pips.length !== cap) this.rebuildPips(cap);

    // `dashFraction` is the meter as a whole, so scaling it back up by the cap
    // gives charges-plus-progress and the partial pip falls out of the
    // remainder. Reading it this way means an upgrade that changes the cap or
    // the recharge time needs no new HUD field.
    const filled = clamp01(state.dashFraction) * cap;
    for (let i = 0; i < cap; i += 1) {
      const amount = clamp01(filled - i);
      if (Math.abs(amount - this.pipsWritten[i]) < 0.005) continue;
      this.pipsWritten[i] = amount;
      const fill = this.pips[i].firstElementChild as HTMLElement;
      fill.style.clipPath = `inset(0 ${((1 - amount) * 100).toFixed(2)}% 0 0)`;
      this.pips[i].classList.toggle('ready', amount >= 1);
    }
  }

  private rebuildPips(count: number): void {
    this.pipRow.replaceChildren();
    this.pips = [];
    this.pipsWritten = [];
    for (let i = 0; i < count; i += 1) {
      const pip = div('mf-pip', this.pipRow);
      div('mf-pip-fill', pip);
      this.pips.push(pip);
      this.pipsWritten.push(-1);
    }
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  /**
   * Drops the easing so a fresh run opens on its real state rather than
   * sweeping in from the last one's.
   */
  reset(): void {
    this.hpShown = 1;
    this.xpShown = 0;
    this.level = 0;
    this.flushing = false;
    this.flash = 0;
    this.hpWritten = -1;
    this.xpWritten = -1;
    this.flashWritten = -1;
    this.pipsWritten = this.pipsWritten.map(() => -1);
  }
}
