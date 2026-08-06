import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  NearestFilter,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from 'three';

/**
 * The prototype grid every ramp surface wears, and the UV maths that makes it
 * tile at a fixed world scale rather than being stretched across whatever the
 * piece happens to measure.
 *
 * `public/images/textures/texture_01.png` is 1024x1024 and genuinely seamless:
 * a `#333335` field, faint `#474749` rules every 128 px, and a hard white rule
 * on the tile's centre lines *and* on all four borders — so two neighbouring
 * copies each contribute a pixel and the boundary reads as the same white rule
 * as the middle. One repeat is therefore a **2 x 2 block of white-bordered
 * cells**, each subdivided 4 x 4 by the faint rules. `GRID_CELL_HAMMER` sizes
 * that white-bordered cell, and everything else here follows from it.
 *
 * The whole module exists because the alternative — one material with the
 * default 0..1 box UVs — smears a single copy of the grid over a 50-unit ramp
 * and a 1.4-unit edge alike, which reads as neither a grid nor a scale.
 */

/** The project-wide scale. Documented in `MovementConfig`; repeated here because the tile size is quoted in Hammer units. */
const HAMMER_UNITS_PER_UNIT = 45;

/**
 * Side of one white-bordered cell, in Hammer units.
 *
 * 128 hu is the major division on Source's own `dev_measure*` textures, and it
 * lands where it should against this geometry: the player is 72 hu tall, so a
 * cell is a little under two of them, and a standard `RAMP_FACE_WIDTH` face is
 * a touch over six cells across. Enough divisions to read the ramp's width and
 * the speed of travel at a glance; few enough that the face is not noise.
 */
const GRID_CELL_HAMMER = 128;

/** World size of one white-bordered cell. */
export const GRID_CELL_UNITS = GRID_CELL_HAMMER / HAMMER_UNITS_PER_UNIT;

/** Cells per texture repeat — the image is a 2 x 2 block of them. */
const CELLS_PER_TILE = 2;

/**
 * Fits the grid to a face's across-travel extent: the cell size closest to
 * `GRID_CELL_UNITS` that divides `extent` a whole number of times.
 *
 * Only the *width* is fitted, and the fitted size is then used along the length
 * as well so the cells stay square. The reason is what the player looks at: a
 * face's high and low edges frame the view for the entire ride and are both
 * always on screen, so a half-cell sliver along either one is the one
 * misalignment that reads as sloppy. A piece's far end is usually across an air
 * gap, where nothing lines up with anything anyway.
 *
 * The cost is that pieces of different widths tile at slightly different scales
 * — at the widths in play (18, 12, 8) the fit lands within 6% of the target,
 * which is not visible between two pieces separated by a gap.
 */
export function gridCellFor(extent: number): number {
  const cells = Math.max(1, Math.round(extent / GRID_CELL_UNITS));
  return extent > 1e-6 ? extent / cells : GRID_CELL_UNITS;
}

/** UV distance covered by one world unit, at a given fitted cell size. */
export function uvPerUnit(cell: number): number {
  return 1 / (cell * CELLS_PER_TILE);
}

/** sRGB → linear, the one direction needed here. Three does this per texel; the gain below has to match it. */
const linear = (srgb: number): number => ((srgb + 0.055) / 1.055) ** 2.4;

/** The texture's field colour — `#333335`, 98% of its pixels. */
const FIELD_SRGB = 0x33 / 255;

/**
 * Albedo the field is aimed at, and the gain that gets it there.
 *
 * The map multiplies the material colour, so at a colour of 1 a ramp's albedo
 * *is* `#333335` — near black, which under this scene's one sun and 0.55
 * ambient reads as a silhouette against a painted sunset rather than as a
 * surface. The old greybox value (`#8a9299`) is the other extreme: reaching it
 * needs a gain near 7.7, and the white rules are already at 1.0, so they and
 * the faint rules would clip together and the grid would flatten into glare.
 *
 * `#6e6e6e` is the middle picked by looking at it — dark enough that the level
 * still reads as a prototype greybox, light enough to hold its own against the
 * sky, and it leaves the two rule weights a legible step apart. Because the
 * gain multiplies a *hue-normalised* colour it is pure exposure: it cannot
 * shift a segment's tint, so this is the one number to touch if the ramps want
 * to be lighter or darker.
 */
const FIELD_TARGET_SRGB = 0x6e / 255;
const TINT_GAIN = linear(FIELD_TARGET_SRGB) / linear(FIELD_SRGB);

/**
 * Turns one of the greybox palette colours into a ramp tint.
 *
 * The palette's job is to say *which* piece you are looking at — the segment
 * tints differ by a couple of points of hue, and the pitched approach pieces
 * are warm where the ring is cool. That signal is worth keeping, but its
 * brightness is not: the texture now owns the value, so the colour is
 * normalised to its own brightest channel (hue and saturation intact, value
 * discarded) and scaled by `TINT_GAIN`. A tint therefore always lands the
 * texture at the same exposure, whatever palette entry it came from.
 */
export function rampTint(color: number): Color {
  const tint = new Color(color);
  const peak = Math.max(tint.r, tint.g, tint.b);
  if (peak > 1e-6) tint.multiplyScalar(1 / peak);
  return tint.multiplyScalar(TINT_GAIN);
}

const TEXTURE_URL = `${import.meta.env.BASE_URL}images/textures/texture_01.png`;

let texture: Texture | null = null;
let loaded = false;
/**
 * Materials that asked for the map before the image arrived.
 *
 * A `Texture` whose image has not decoded yet does not render as "no map" — the
 * renderer binds an empty 1x1 in its place, so a piece built during the first
 * few milliseconds of boot would come out flat black or flat white, at the
 * tint's 4x exposure. That is much worse than the thing it replaces, and one of
 * the callers (the menu's map tiles) renders *once* into a data URL and never
 * gets a second chance. So a material only gets the map, and the lifted tint,
 * once there is something to sample; until then it keeps the plain palette
 * colour it always had and looks exactly like the old greybox.
 *
 * The list is emptied and abandoned the moment the image lands, which for a
 * 2.7 KB same-origin PNG is within a frame or two of boot.
 */
let pending: { material: MeshStandardMaterial; color: number }[] | null = [];

/**
 * The shared grid texture. One instance for the whole app: every ramp material
 * points at it, so the image is decoded and uploaded once no matter how many
 * hundreds of ramp meshes a course or a free map ends up with.
 *
 * Note that `Dispose.disposeObject` does not reach it — `Material.dispose()`
 * frees the material, never its maps — which is exactly what a shared texture
 * needs, since the editor disposes and rebuilds a piece's materials on every
 * step of a drag.
 */
function rampTexture(): Texture {
  if (texture) return texture;
  texture = new TextureLoader().load(
    TEXTURE_URL,
    () => {
      loaded = true;
      for (const entry of pending ?? []) attach(entry.material, entry.color);
      pending = null;
    },
    undefined,
    () => {
      // Nothing to wait for any more, and the queue has to be released: the
      // editor rebuilds a piece's materials on every step of a drag, so a
      // queue that is never drained is a queue that grows for the session.
      console.warn(`ramp texture failed to load: ${TEXTURE_URL} — ramps stay untextured`);
      pending = null;
    },
  );
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  // A grid at a grazing angle is the worst case for a mipmap chain — which is
  // exactly what a surf face is, for the whole ride. The renderer clamps this
  // to whatever the device supports.
  texture.anisotropy = 16;
  applyFiltering(texture);
  return texture;
}

/** Whether the NPR "nearest textures" retro toggle is on. */
let nearestFiltering = false;

function applyFiltering(t: Texture): void {
  t.magFilter = nearestFiltering ? NearestFilter : LinearFilter;
  t.minFilter = nearestFiltering ? NearestFilter : LinearMipmapLinearFilter;
  t.needsUpdate = true;
}

/**
 * Flip the shared grid between smooth and crunchy nearest-neighbour — the
 * "nearest textures" NPR retro toggle. Safe before the image loads; the choice
 * is remembered and applied when the texture is created.
 */
export function setRampTextureNearest(nearest: boolean): void {
  nearestFiltering = nearest;
  if (texture) applyFiltering(texture);
}

function attach(material: MeshStandardMaterial, color: number): void {
  material.map = rampTexture();
  material.color.copy(rampTint(color));
  material.needsUpdate = true;
}

/**
 * Points a ramp material at the grid, tinted by `color`. Use this instead of
 * setting `map` by hand: it is what defers the map (and the lifted tint) until
 * the image is actually there. See `pending`.
 */
export function useRampTexture(material: MeshStandardMaterial, color: number): void {
  rampTexture();
  if (loaded) attach(material, color);
  else pending?.push({ material, color });
}

/**
 * True once the image has decoded. Only for tests and probes — nothing in the
 * frame loop needs to ask, because `useRampTexture` handles both cases.
 */
export function rampTextureLoaded(): boolean {
  return loaded;
}

/**
 * Replaces a `BoxGeometry`'s default 0..1 UVs with world-scaled ones, so the
 * grid tiles at `cell` instead of being stretched once over each side.
 *
 * Driven off the vertex normals rather than off the vertex order, because the
 * order is `BoxGeometry`'s business and it has changed between three releases;
 * the normals say which side a vertex is on and that is all this needs.
 *
 * The box's local axes are the ramp segment's: +X across the face, +Y the
 * surface normal, +Z along travel. `along` shifts the travel coordinate, which
 * is what keeps a chain of segments in phase — without it each box would restart
 * the grid at its own leading edge and every seam would show a broken line.
 *
 * The side and end faces are laid out to *continue* the top surface's grid
 * around the edge they share with it (a vertex on the top rim gets the same
 * coordinate from either face, and the mapping runs on down the side from
 * there), so a slab reads as one gridded solid rather than six unrelated
 * stickers.
 */
export function applyBoxGridUv(
  geometry: BufferGeometry,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  cell: number,
  along = 0,
): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const k = uvPerUnit(cell);
  const uv: number[] = [];

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    // Distance from the top surface down the side, for the wrap-around.
    const drop = sizeY / 2 - y;
    const nx = normal.getX(i);
    const ny = normal.getY(i);
    const nz = normal.getZ(i);

    if (Math.abs(ny) >= Math.abs(nx) && Math.abs(ny) >= Math.abs(nz)) {
      uv.push(x * k, (z + along) * k); // top and under-side
    } else if (Math.abs(nx) >= Math.abs(nz)) {
      uv.push((z + along) * k, Math.sign(nx) * (sizeX / 2 + drop) * k); // edge walls
    } else {
      uv.push(x * k, (Math.sign(nz) * (sizeZ / 2 + drop) + along) * k); // end caps
    }
  }

  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
}
