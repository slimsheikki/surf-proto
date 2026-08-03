/**
 * The ReWind meter, as a half-ring hugging the left side of the crosshair.
 *
 * It moved off the HUD column because that is where it is actually read. The
 * bar is the answer to "can I bail out of this line right now", which is a
 * question asked mid-air at 30 u/s while looking down a ramp — and the eye is
 * on the crosshair, not the bottom of the screen. A half-ring curving around
 * the crosshair sits in the same glance, and its concave side pointing inward
 * keeps the aiming dot itself unobstructed.
 *
 * Built in JS rather than authored in `index.html` because the geometry is
 * derived: the arc length has to match the path exactly for the dash-offset
 * fill to be accurate, and the flame positions are the same radius swept
 * through the same angles. Hand-writing three sets of numbers that must agree
 * is how they stop agreeing.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** viewBox is square and the arc is centred in it, so the SVG centres on the crosshair. */
const VIEW = 200;
const CENTRE = VIEW / 2;
/**
 * Arc radius in viewBox units. Far enough out to clear the crosshair and any
 * hit marker, close enough to be read without moving the eye.
 */
const RADIUS = 62;
const STROKE = 8;

/** Flames licking off the outside of the arc when the meter is full. */
const FLAME_COUNT = 9;
/**
 * Angles, measured clockwise from straight up, that the left half-ring spans.
 * 180 is straight down, 360 straight up — so this is the left semicircle,
 * walked from the bottom (where the fill starts) to the top.
 */
const ARC_START_DEG = 180;
const ARC_END_DEG = 360;

export class UltimateArc {
  private readonly root: HTMLDivElement;
  private readonly fill: SVGPathElement;
  private readonly label: HTMLDivElement;
  private readonly arcLength: number;
  private ready = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'ult-arc';
    this.root.className = 'hidden';

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${VIEW} ${VIEW}`);
    svg.setAttribute('aria-hidden', 'true');

    // Bottom -> left -> top, so the fill climbs. Sweep flag 1 is the
    // clockwise-on-screen direction, and clockwise from six o'clock is the half
    // that passes nine o'clock — the left. Flag 0 draws the mirror of this
    // around the right side, which is where this arc spent its first render.
    const d = `M ${CENTRE} ${CENTRE + RADIUS} A ${RADIUS} ${RADIUS} 0 0 1 ${CENTRE} ${CENTRE - RADIUS}`;

    const track = document.createElementNS(SVG_NS, 'path');
    track.setAttribute('d', d);
    track.setAttribute('class', 'ult-arc-track');
    track.setAttribute('stroke-width', String(STROKE));

    this.fill = document.createElementNS(SVG_NS, 'path');
    this.fill.setAttribute('d', d);
    this.fill.setAttribute('class', 'ult-arc-fill');
    this.fill.setAttribute('stroke-width', String(STROKE));

    svg.append(track, this.fill);
    this.root.appendChild(svg);

    // Measured off the element rather than computed as pi*r: the two agree
    // here, but only while the path stays a true semicircle, and a dash offset
    // derived from a stale formula fills to the wrong place silently.
    this.arcLength = this.fill.getTotalLength?.() || Math.PI * RADIUS;
    this.fill.style.strokeDasharray = String(this.arcLength);

    const flames = document.createElement('div');
    flames.id = 'ult-arc-flames';
    for (let i = 0; i < FLAME_COUNT; i++) {
      const flame = document.createElement('span');
      // Inset from both ends of the sweep by half a step, so the outermost
      // flames sit *on* the arc rather than hanging off its rounded caps.
      const t = (i + 0.5) / FLAME_COUNT;
      const angle = ARC_START_DEG + (ARC_END_DEG - ARC_START_DEG) * t;
      // The radius is in viewBox units and the element is sized in viewBox
      // units too (see the CSS), so the same number places both.
      flame.style.setProperty('--arc-angle', `${angle}deg`);
      flame.style.setProperty('--arc-radius', `${RADIUS}`);
      // Stagger the flicker so the row reads as one body of fire.
      flame.style.animationDelay = `${(-i * 0.17).toFixed(2)}s`;
      flame.style.animationDuration = `${(0.62 + (i % 3) * 0.15).toFixed(2)}s`;
      flames.appendChild(flame);
    }
    this.root.appendChild(flames);

    this.label = document.createElement('div');
    this.label.id = 'ult-arc-label';
    this.root.appendChild(this.label);

    document.body.appendChild(this.root);
    this.setCharge(0);
  }

  setCharge(fraction: number): void {
    const charge = Math.max(0, Math.min(1, fraction));
    this.fill.style.strokeDashoffset = String(this.arcLength * (1 - charge));

    const ready = charge >= 1;
    if (ready === this.ready) return;
    this.ready = ready;
    this.root.classList.toggle('ready', ready);
    // Text only when it is actionable. While charging, the arc *is* the
    // readout, and a percentage next to the crosshair is clutter the player
    // has to look past on every ramp.
    this.label.textContent = ready ? 'HOLD R' : '';
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }
}
