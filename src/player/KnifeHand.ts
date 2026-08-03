import {
  BoxGeometry,
  BufferGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Shape,
  SphereGeometry,
} from 'three';

/**
 * The gloved hands and the combat knife, as geometry — no animation, no scene.
 *
 * Extracted from `ViewModel` when the third-person block character arrived:
 * both views must be holding the *same* knife, and a second hand-tuned copy of
 * a twelve-part model is a copy that drifts. The builders return groups posed
 * in the first-person convention (**-Z forward, +X right, +Y up**), which is
 * also the convention a character mesh facing its own -Z is built in, so the
 * assembly drops into either one unrotated.
 *
 * Everything here is authored at world scale — the blade is 0.235 units, which
 * is 10.6 Hammer units, about a real knife. The third-person character scales
 * the whole assembly up as one (see `PlayerModel`) rather than re-proportioning
 * it, so the grip stays exactly the grip.
 */

/* ------------------------------------------------------------------ *
 * Palette
 * ------------------------------------------------------------------ */

const GLOVE_COLOR = 0x33383f;
const CUFF_COLOR = 0x4a515a;
const BLADE_COLOR = 0xd2d8de;
const GUARD_COLOR = 0x2a2f36;
const HANDLE_COLOR = 0x24282e;
const POMMEL_COLOR = 0x5a616b;
const GRIP_RIDGE_COLOR = 0x14171b;

/* ------------------------------------------------------------------ *
 * Swing timing
 * ------------------------------------------------------------------ */

/**
 * How long a swing's three phases last. Shared, because the first-person
 * viewmodel and the third-person arm are two views of one animation: if they
 * disagree, toggling the camera mid-fight changes how fast the knife appears to
 * move. Only the *poses* differ between them.
 */
export const SWING_TIMING = {
  WINDUP_SECONDS: 0.06,
  SLASH_SECONDS: 0.1,
  RECOVER_SECONDS: 0.09,
} as const;

/* ------------------------------------------------------------------ *
 * Mesh helpers
 * ------------------------------------------------------------------ */

function box(
  width: number,
  height: number,
  depth: number,
  color: number,
  metalness = 0.15,
  roughness = 0.8,
): Mesh {
  return new Mesh(
    new BoxGeometry(width, height, depth),
    new MeshStandardMaterial({ color, metalness, roughness }),
  );
}

/** Like `box`, but clearcoated -- for the polished-metal fittings (guard, pommel). */
function physicalBox(
  width: number,
  height: number,
  depth: number,
  color: number,
  metalness: number,
  roughness: number,
  clearcoat: number,
): Mesh {
  return new Mesh(
    new BoxGeometry(width, height, depth),
    new MeshPhysicalMaterial({ color, metalness, roughness, clearcoat, clearcoatRoughness: 0.12 }),
  );
}

/**
 * Drop-point blade silhouette: a straight ricasso at the guard, an edge that
 * bellies out and sweeps up, a spine that stays flat until it eases down to
 * meet the point near the spine line. Built as a flat 2D outline in (length,
 * width) and extruded for thickness, since that is the natural plane for a
 * blade profile -- the extrude's depth axis becomes the thickness.
 *
 * `rotateY(90deg)` afterwards swaps that thickness onto local X and the
 * length onto local Z: for a point (x, y, z) the rotation gives
 * (x', y', z') = (z, y, -x), so the shape's length axis (x, running 0..L from
 * guard to tip) lands on z' running 0..-L -- tip at negative Z, matching
 * where the rest of this file already expects the blade to point.
 */
function buildBladeGeometry(length: number, baseWidth: number, thickness: number): BufferGeometry {
  const hw = baseWidth / 2;
  const shape = new Shape();
  shape.moveTo(0, hw);
  shape.lineTo(0, -hw);
  shape.lineTo(length * 0.6, -hw * 0.55);
  shape.lineTo(length, hw * 0.05);
  shape.lineTo(length * 0.82, hw * 0.9);
  shape.closePath();

  const geometry = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geometry.rotateY(Math.PI / 2);
  // Centers thickness on X=0 and shifts the base off the knife group's origin
  // to just past the guard, matching the old box blade's -0.128-centred span.
  geometry.translate(-thickness / 2, -hw * 0.05, -0.01);
  return geometry;
}

/* ------------------------------------------------------------------ *
 * Hands
 * ------------------------------------------------------------------ */

/** Blocky gloved fist, angled inward as if closed around the grip. */
function buildRightHand(): Group {
  const hand = new Group();
  const fist = box(0.085, 0.085, 0.11, GLOVE_COLOR);
  fist.position.set(0, 0, 0.03);
  const cuff = box(0.075, 0.078, 0.05, CUFF_COLOR);
  cuff.position.set(0.004, -0.006, 0.115);
  hand.add(fist, cuff);
  hand.rotation.set(0.1, -0.28, 0.18);
  return hand;
}

/** Off-hand: the same fist mirrored, canted the other way. */
export function buildLeftHand(): Group {
  const hand = new Group();
  const fist = box(0.08, 0.08, 0.105, GLOVE_COLOR);
  const cuff = box(0.07, 0.072, 0.05, CUFF_COLOR);
  cuff.position.set(-0.004, -0.008, 0.11);
  hand.add(fist, cuff);
  hand.rotation.set(-0.12, 0.34, -0.22);
  return hand;
}

/**
 * Held in the right fist. The group is canted so the blade runs
 * up-and-across toward screen centre rather than straight down the barrel of
 * the camera — pointing it dead ahead foreshortens it into a stub.
 */
function buildKnife(): Group {
  const knife = new Group();
  const bladeLength = 0.235;
  const handleLength = 0.11;

  const handle = box(0.03, 0.042, handleLength, HANDLE_COLOR, 0.1, 0.85);
  handle.position.set(0, 0, 0.055);

  // Three wrapped bands standing for a ridged tactical grip on an otherwise
  // flat handle box -- the detail that reads as gripped rather than moulded.
  const ridges = [-0.032, 0, 0.032].map((dz) => {
    const ridge = box(0.034, 0.046, 0.012, GRIP_RIDGE_COLOR, 0.05, 0.8);
    ridge.position.set(0, 0, 0.055 + dz);
    return ridge;
  });

  // Pommel: a small polished cap at the butt end, the one place on a real
  // knife's handle where bare metal shows.
  const pommel = new Mesh(
    new SphereGeometry(0.019, 8, 6),
    new MeshPhysicalMaterial({ color: POMMEL_COLOR, metalness: 0.4, roughness: 0.35, clearcoat: 0.4, clearcoatRoughness: 0.15 }),
  );
  pommel.position.set(0, 0, 0.055 + handleLength / 2 + 0.006);

  // A bolster block sits behind the crossguard so blade and grip don't meet
  // in a bare seam, both polished steel rather than the guard's old flat matte.
  const guard = physicalBox(0.085, 0.02, 0.022, GUARD_COLOR, 0.45, 0.35, 0.4);
  const bolster = physicalBox(0.05, 0.03, 0.014, GUARD_COLOR, 0.45, 0.35, 0.4);
  bolster.position.set(0, 0, 0.012);

  // Metalness is deliberately moderate rather than near-1: this scene has no
  // environment map, and a fully metallic PBR material has almost no diffuse
  // term of its own -- it relies on reflections for its colour, so pushed too
  // high it reads as flat black except for one direct specular glint. Kept
  // partly dielectric, the surface still catches the key/fill lights as
  // overall brightness, with the clearcoat layered on for a polished sheen.
  const blade = new Mesh(
    buildBladeGeometry(bladeLength, 0.05, 0.012),
    new MeshPhysicalMaterial({
      color: BLADE_COLOR,
      metalness: 0.55,
      roughness: 0.22,
      clearcoat: 0.5,
      clearcoatRoughness: 0.12,
    }),
  );
  // Slight drop toward the point, as on a real combat knife: the brief asks
  // for a blade angled forward-and-slightly-down while the knife as a whole
  // is canted up across the frame, and this is where the two reconcile.
  blade.rotation.x = -0.08;

  knife.add(handle, ...ridges, pommel, guard, bolster, blade);
  // Pushed forward of the fist's front face so the crossbar is actually
  // visible between glove and blade; the handle stays buried in the grip.
  knife.position.set(0.002, 0.024, -0.055);
  knife.rotation.set(0.38, 0.55, -0.4);
  return knife;
}

/**
 * Right fist with the knife already in it, at the exact relative pose the
 * first-person viewmodel poses them at.
 *
 * The grip is the fragile part of this model — the handle is buried inside the
 * fist and only the guard shows, so a couple of millimetres either way either
 * exposes the grip floating beside the glove or swallows the crossbar. Both
 * views take that relationship from here rather than restating it.
 */
export function buildKnifeHand(): Group {
  const assembly = new Group();
  assembly.add(buildRightHand());
  assembly.add(buildKnife());
  return assembly;
}
