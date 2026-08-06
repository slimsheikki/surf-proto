import { BoxGeometry, Group, Mesh } from 'three';
import { characterMaterial } from '../render/NprMaterials';

/**
 * The gloved hands, as geometry — no animation, no scene.
 *
 * Successor to `KnifeHand.ts`: the combat knife was cut (a melee weapon in a
 * game whose whole brief is "never stop surfing to fight" went unused), and
 * the fists stayed. Both views build from here — the first-person viewmodel
 * and the third-person block character — because two hand-tuned copies of the
 * same fist are a copy that drifts. The builders return groups posed in the
 * first-person convention (**-Z forward, +X right, +Y up**), which is also the
 * convention a character mesh facing its own -Z is built in, so they drop into
 * either view unrotated.
 *
 * Authored at world scale; the third-person character scales the assembly up
 * as one group (see `PlayerModel.HAND_SCALE`) rather than re-proportioning it.
 */

const GLOVE_COLOR = 0x33383f;
const CUFF_COLOR = 0x4a515a;

function box(width: number, height: number, depth: number, color: number): Mesh {
  return new Mesh(
    new BoxGeometry(width, height, depth),
    characterMaterial({ color, metalness: 0.15, roughness: 0.8 }),
  );
}

/** Blocky gloved fist, canted slightly inward — a surfer's loose lead hand. */
export function buildRightHand(): Group {
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
