/**
 * The movement build currently shipping.
 *
 * The movement is being tuned against a human's judgement rather than a test,
 * so every build gets a name and a number that appear on screen. A review note
 * that says "the strafe felt floaty" is worth nothing unless it is attached to
 * a specific build — and "the version I played last Tuesday" is not one.
 *
 * `docs/MOVEMENT_VERSIONS.md` holds the patch note for each entry here. Bump
 * both together, always.
 */
export const MOVEMENT_VERSION = {
  id: 'v1',
  name: 'Source Parity',
} as const;

export const MOVEMENT_VERSION_LABEL = `MOVE ${MOVEMENT_VERSION.id} · ${MOVEMENT_VERSION.name}`;
