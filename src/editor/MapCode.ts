import { FreeMap, parseMap } from './MapData';

/**
 * Turning a free-mode map into a string you can paste to someone.
 *
 * Maps live in `localStorage`, which is per-browser and per-device, and the
 * game is deployed as static files on GitHub Pages — no backend, no accounts,
 * nowhere to upload to. So the map has to travel inside the thing being shared:
 * a link whose fragment *is* the map.
 *
 * The fragment, specifically, and not a query string. A `#` fragment is never
 * sent to the server, so no host's URL-length limit applies and GitHub Pages
 * never sees the payload at all.
 *
 * Measured on real maps: a grid-snapped 33-piece map lands around 600
 * characters, a sprawling 200-piece one with unsnapped positions around 8.5k.
 * The first is an unremarkable URL; the second still works when pasted but is
 * long enough that the editor shows the length so it is not a surprise.
 */

/** URL fragment key. `…/surf-proto/#map=<code>`. */
const HASH_KEY = 'map=';

/**
 * Leading character of a code, describing how the bytes after it are packed.
 *
 * Deliberately *not* `FREE_MAP_VERSION`. That versions the shape of a map and
 * is already checked inside `parseMap`; this versions the envelope around it,
 * which `parseMap` cannot see because it never gets the bytes. Keeping them
 * separate means a future compression change does not have to pretend to be a
 * map-format change, and vice versa.
 */
const TAG_DEFLATED = '1';
const TAG_PLAIN = '0';

/**
 * Ceiling on a decoded payload, checked before parsing.
 *
 * A share code is untrusted input from whoever sent the link. Deflate happily
 * expands a few hundred bytes into hundreds of megabytes, so without a cap a
 * hostile — or merely corrupt — code could exhaust memory before anything got
 * to validate it. A megabyte is about fifty times the largest plausible map.
 */
const MAX_DECODED_BYTES = 1_000_000;

/** Coordinates and angles are rounded to this many decimals before encoding. See `compact`. */
const DECIMALS = 2;

function round(value: number): number {
  const factor = 10 ** DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * The map as it goes over the wire.
 *
 * Two reductions, both free:
 *
 * - **`id` is dropped.** `parseMap` already ignores whatever id it is given and
 *   calls `newPieceId()`, so the field is pure payload — about twelve bytes a
 *   piece before compression, and it would be discarded on arrival anyway.
 * - **Numbers are rounded to two decimals.** One game unit is 45 Hammer units,
 *   so a hundredth of a unit is far below anything a player can perceive or a
 *   collider can act on. It also strips float noise like `-71.99999999999999`,
 *   which costs sixteen characters to say nothing.
 */
function compact(map: FreeMap): unknown {
  return {
    version: map.version,
    name: map.name,
    spawn: {
      x: round(map.spawn.x),
      y: round(map.spawn.y),
      z: round(map.spawn.z),
      yawDeg: round(map.spawn.yawDeg),
    },
    boss: { x: round(map.boss.x), y: round(map.boss.y), z: round(map.boss.z) },
    pieces: map.pieces.map((piece) => ({
      def: piece.def,
      x: round(piece.x),
      y: round(piece.y),
      z: round(piece.z),
      yawDeg: round(piece.yawDeg),
      pitchDeg: round(piece.pitchDeg),
      rollDeg: round(piece.rollDeg),
      length: round(piece.length),
      width: round(piece.width),
      // Optional curve/taper parameters ride along only when set — a straight
      // constant-width piece costs the same bytes it did in version 1.
      ...(piece.endWidth !== undefined ? { endWidth: round(piece.endWidth) } : {}),
      ...(piece.yawSweepDeg !== undefined ? { yawSweepDeg: round(piece.yawSweepDeg) } : {}),
      ...(piece.endPitchDeg !== undefined ? { endPitchDeg: round(piece.endPitchDeg) } : {}),
    })),
    ...(map.spline && map.spline.length > 0
      ? { spline: map.spline.map((p) => ({ x: round(p.x), y: round(p.y), z: round(p.z) })) }
      : {}),
  };
}

/**
 * `CompressionStream` is native and needs no dependency, but it only landed in
 * Firefox 113 and Safari 16.4. Where it is missing the code is emitted plain —
 * three times longer, still perfectly shareable — rather than the feature
 * simply not existing on that browser.
 */
function hasCompression(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

/**
 * `Blob` needs an `ArrayBuffer`-backed part, and a `Uint8Array` is only ever a
 * *view* — possibly onto a larger, or shared, buffer. Copying into an
 * exact-size buffer is both what the types want and what keeps this correct if
 * a caller ever passes a subarray.
 */
function toBlob(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer]);
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = toBlob(bytes).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = toBlob(bytes).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  // Checked after inflating as well as before: the guard that matters is on the
  // *expanded* size, which is the one a malicious code inflates without bound.
  if (out.byteLength > MAX_DECODED_BYTES) throw new Error('decoded payload too large');
  return out;
}

/**
 * base64url rather than plain base64: `+` and `/` are not safe unescaped in a
 * URL, and a trailing `=` gets eaten or escaped by enough chat clients that
 * links start arriving broken.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encodes a map into a shareable code. Never throws; falls back to uncompressed. */
export async function encodeMapCode(map: FreeMap): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(compact(map)));
  if (!hasCompression()) return TAG_PLAIN + toBase64Url(json);
  try {
    return TAG_DEFLATED + toBase64Url(await deflate(json));
  } catch {
    return TAG_PLAIN + toBase64Url(json);
  }
}

/**
 * Decodes a share code back into a map, or null if it is not one.
 *
 * Accepts a bare code or a whole URL, because people paste both and there is no
 * reason to make that their problem.
 *
 * Nothing here trusts the input, and the last step is the important one: the
 * decoded object goes through the same `parseMap` that guards `localStorage`.
 * A share code arrives from whoever sent the link, so it deserves at least the
 * scrutiny already applied to data the player wrote themselves — and that
 * function is where "a NaN coordinate produces a collider that never terminates
 * a sweep" is already handled.
 */
export async function decodeMapCode(input: string): Promise<FreeMap | null> {
  const code = extractCode(input);
  if (!code) return null;

  const tag = code[0];
  const body = code.slice(1);
  if (tag !== TAG_DEFLATED && tag !== TAG_PLAIN) return null;

  try {
    const raw = fromBase64Url(body);
    if (raw.byteLength > MAX_DECODED_BYTES) return null;
    const bytes = tag === TAG_DEFLATED ? await inflate(raw) : raw;
    return parseMap(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    // Truncated, re-wrapped by an email client, hand-edited, or simply not a
    // share code. All of those are the same answer to the caller.
    return null;
  }
}

/** Pulls the code out of a full share URL, a bare `#map=…` fragment, or a bare code. */
function extractCode(input: string): string {
  const trimmed = input.trim();
  const at = trimmed.lastIndexOf(HASH_KEY);
  return (at === -1 ? trimmed : trimmed.slice(at + HASH_KEY.length)).trim();
}

/**
 * The link to hand someone.
 *
 * Built from `location` rather than from Vite's `base`, so it is correct on the
 * dev server at `/` and on Pages at `/surf-proto/` without either knowing about
 * the other. `search` is dropped deliberately — nothing in the app reads it,
 * and carrying a stale query string into a share link is just noise.
 */
export function shareUrlFor(code: string): string {
  return `${location.origin}${location.pathname}#${HASH_KEY}${code}`;
}

/** The code in the current URL, if the page was opened from a share link. */
export function mapCodeFromLocation(): string | null {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!hash.startsWith(HASH_KEY)) return null;
  const code = hash.slice(HASH_KEY.length).trim();
  return code || null;
}

/**
 * Drops the `#map=` fragment without reloading or adding a history entry.
 *
 * Called right after an import, and it is not cosmetic: leave the fragment in
 * place and the recipient's next refresh silently throws away everything they
 * have edited since and puts the shared version back.
 */
export function clearMapCodeFromLocation(): void {
  if (!mapCodeFromLocation()) return;
  history.replaceState(null, '', location.pathname + location.search);
}
