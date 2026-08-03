import { FreeMap, parseMap } from '../editor/MapData';
import data from './default-course.map.json';

/**
 * The course everybody starts on.
 *
 * Authored in the free-mode editor and shipped as data rather than as
 * generating code, which is the whole point of the editor existing: the level
 * is something a human tuned by dragging ramps, and a hand-tuned line is not
 * something worth trying to re-derive from constants afterwards. It replaced
 * the generated approach-and-ring course (`buildSurfCourse`), which is still in
 * `SurfCourse.ts` — that module owns the ramp constants `MapData` reads — but is
 * no longer reachable from the menu.
 *
 * Named here for its *role*, not its title. The map on screen is "MegaFlow Demo
 * V1", and that string lives in the JSON alone — so shipping a V2 is one edit
 * rather than a file rename rippling out through the menu and three docs.
 *
 * Stored in the `compact` shape `MapCode` shares over the wire: no piece ids,
 * coordinates at two decimals. To update it, open the map in the editor, press
 * Share, and re-emit this file from the code — do not hand-edit piece
 * coordinates, because the editor is the only thing that can tell you whether
 * the result is still surfable.
 */
function loadBundled(): FreeMap {
  const map = parseMap(data);
  // Shipped data, so a failure here is a corrupt commit rather than anything a
  // player did — and every path out of it is worse than stopping. Falling back
  // to an empty map drops the player onto a void with no ramps; falling back to
  // the old generated course silently ships a level nobody chose.
  if (!map) {
    throw new Error('default-course.map.json failed to parse — the bundled map is corrupt');
  }
  return map;
}

/**
 * Rebuilt per call rather than shared.
 *
 * `parseMap` hands back fresh piece ids and a mutable object, and the editor
 * mutates the map it is given. A single shared instance would let a trip
 * through the editor edit the built-in course for the rest of the session.
 */
export function defaultCourseMap(): FreeMap {
  return loadBundled();
}

/**
 * Tile name, read off the map rather than written twice — the menu and the
 * course itself can then never disagree about what it is called.
 */
export const DEFAULT_COURSE_NAME = data.name;

/** Blurb for the menu tile. Kept next to the map so the two stay in agreement. */
export const DEFAULT_COURSE_BLURB = 'A long descent into a banked flow line. The default course.';
