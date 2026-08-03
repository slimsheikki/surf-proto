import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Object3D,
  PerspectiveCamera,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import { disposeObject } from '../engine/Dispose';
import { buildFreeWorld } from '../editor/FreeCourse';
import { FreeMap } from '../editor/MapData';
import { degToRad } from '../engine/MathUtils';

/**
 * Aerial thumbnails of whole courses, for the play menu's map tiles.
 *
 * Same idea as `editor/Thumbnails.ts` — render the real geometry rather than
 * author a picture, so a tile can never drift out of agreement with the map it
 * stands for — but framed from above instead of three-quarters, because what a
 * player needs off a map tile is its *layout*: where the ramps run and how the
 * course loops. A three-quarter view of a two-hundred-unit course is mostly
 * foreshortening.
 */

/** Rendered at 2x the CSS tile size so it stays crisp on a retina display. */
const THUMB_WIDTH = 384;
const THUMB_HEIGHT = 216;

/**
 * Steep, but not straight down. Dead vertical flattens every ramp to a line —
 * a banked face is a *rotation about its own travel axis*, so the only thing
 * that reads it is a bit of obliqueness. This is about 70 degrees off
 * horizontal: still unmistakably a map view, with enough tilt to show relief.
 */
const VIEW_DIRECTION = new Vector3(0.22, 1, 0.34).normalize();

/** Pulls the frame back off the tight fit so a course is not cropped at the edges. */
const FRAMING_MARGIN = 1.16;

/**
 * Opaque light background rather than the transparent one the palette
 * thumbnails use.
 *
 * Course geometry is dark grey, and dark grey on the tile's dark card is a
 * silhouette of nothing — the first render of this screen came out as three
 * near-black rectangles. A light backdrop turns the same geometry into a
 * legible plan view, which is the entire job of the tile.
 */
const BACKDROP = new Color(0xc3d2e2);

/** Focus override for a course whose bounding sphere is not what you want framed. */
export interface ThumbnailFocus {
  center: Vector3;
  radius: number;
}

/**
 * Renders one already-built world into a data URL.
 *
 * Takes the object rather than a map so the standard course — which is built
 * once at boot and lives in the main scene — can be photographed without being
 * rebuilt. Lights are parented into the object for the duration of the render
 * and taken straight back out: three.js will render any `Object3D` as a root,
 * so this needs no scene of its own and, more importantly, never reparents the
 * caller's object and never risks handing it back somewhere else.
 */
function renderObject(
  renderer: WebGLRenderer,
  object: Object3D,
  focus?: ThumbnailFocus,
): string {
  const camera = new PerspectiveCamera(40, THUMB_WIDTH / THUMB_HEIGHT, 0.1, 8000);

  const ambient = new AmbientLight(0xffffff, 1.15);
  const sun = new DirectionalLight(0xffffff, 1.9);
  sun.position.set(0.6, 1.6, 0.9);
  // A second light from underneath, which a real scene would never have: from
  // straight above, every banked face turns its underside to the camera and
  // half the course renders black without it.
  const fill = new DirectionalLight(0xffffff, 0.55);
  fill.position.set(-0.7, -0.9, -0.5);
  object.add(ambient, sun, fill);

  let center: Vector3;
  let radius: number;
  if (focus) {
    center = focus.center;
    radius = focus.radius;
  } else {
    const sphere = new Box3().setFromObject(object).getBoundingSphere(new Sphere());
    center = sphere.center;
    radius = sphere.radius > 1e-3 ? sphere.radius : 1;
  }

  const distance = (radius / Math.sin(degToRad(camera.fov / 2))) * FRAMING_MARGIN;
  camera.position.copy(center).addScaledVector(VIEW_DIRECTION, distance);
  camera.lookAt(center);

  renderer.render(object, camera);
  const url = renderer.domElement.toDataURL();

  object.remove(ambient, sun, fill);
  ambient.dispose();
  sun.dispose();
  fill.dispose();
  return url;
}

function createRenderer(): WebGLRenderer | null {
  try {
    // preserveDrawingBuffer so toDataURL reads the frame just rendered.
    const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(THUMB_WIDTH, THUMB_HEIGHT);
    renderer.setClearColor(BACKDROP, 1);
    return renderer;
  } catch {
    // No GL context (headless): callers fall back to text-only tiles.
    return null;
  }
}

/**
 * One-off thumbnail of a world that already exists — used for the standard
 * course, which App builds at boot.
 *
 * `focus` matters there. The standard course's bounding sphere is set by the
 * approach descent, which starts six hundred units out; framed to fit it, the
 * endless ring — the thing that actually identifies the course — is a dot in
 * the corner. Pointing the camera at the ring instead crops the approach and
 * shows the course a player would recognise.
 */
export function renderWorldThumbnail(object: Object3D, focus?: ThumbnailFocus): string | null {
  const renderer = createRenderer();
  if (!renderer) return null;
  try {
    return renderObject(renderer, object, focus);
  } finally {
    renderer.dispose();
  }
}

/**
 * Thumbnails for a batch of saved maps, keyed by map name.
 *
 * One renderer for the whole batch and one build-and-dispose per map: holding a
 * second GL context open for the life of the app to serve a screen the player
 * visits occasionally is paying for it forever, and the editor's palette
 * already established that a burst of small renders is milliseconds.
 *
 * **`colliders: false` is not optional.** `buildFreeWorld` registers into a
 * module-level singleton with no per-object removal, so a thumbnail pass that
 * registered would quietly add every map in storage to the collision world.
 */
export function renderMapThumbnails(maps: readonly FreeMap[]): Map<string, string> {
  const thumbnails = new Map<string, string>();
  if (maps.length === 0) return thumbnails;

  const renderer = createRenderer();
  if (!renderer) return thumbnails;

  try {
    for (const map of maps) {
      const world = buildFreeWorld(map, false);
      try {
        thumbnails.set(map.name, renderObject(renderer, world.group));
      } finally {
        disposeObject(world.group);
      }
    }
  } finally {
    renderer.dispose();
  }
  return thumbnails;
}
