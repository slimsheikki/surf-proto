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

/** three.js's default camera up, which `lookAt` uses to build the view basis. */
const WORLD_UP = new Vector3(0, 1, 0);

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
  /**
   * The thing being framed, when a sphere is the wrong shape for it.
   *
   * A radius can only be fitted to one field of view, and the vertical is the
   * smaller — so a sphere fit sizes the shot to the *height* of the tile and
   * leaves whatever the 16:9 width would have allowed unused. Given a box,
   * `renderObject` solves its corners against both half-angles instead and
   * takes whichever binds.
   *
   * Worth having, but not a fix for a course that simply is not the tile's
   * shape: a roughly square plan still fills the height and leaves the sides
   * empty, because that is what a square looks like in a 16:9 frame.
   */
  bounds?: Box3;
}

/**
 * What to point the camera at for a map: the pieces, not the built world.
 *
 * `buildFreeWorld` also hangs a 24-unit boss pillar below the boss marker,
 * which on a course that finishes above it is the lowest thing in the scene by
 * some margin — so it stretches the bounds downward while contributing nothing
 * anyone reads off a tile. Height is usually the binding axis here, so that is
 * the extent least worth spending.
 *
 * `reach` covers the longest piece's half-length, because a piece's stored
 * position is the midpoint of its centre path and its ends run out past it. It
 * is applied to all three axes rather than just the horizontal ones: a pitched
 * piece climbs or drops along that same length.
 */
export function mapFocus(map: FreeMap): ThumbnailFocus {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const point = new Vector3();
  let reach = 0;

  for (const piece of map.pieces) {
    min.min(point.set(piece.x, piece.y, piece.z));
    max.max(point);
    reach = Math.max(reach, piece.length / 2, piece.width / 2);
  }
  min.min(point.set(map.spawn.x, map.spawn.y, map.spawn.z));
  max.max(point);

  // Grown by `reach` so the box covers the geometry, not just the path midpoints.
  min.subScalar(reach);
  max.addScalar(reach);
  const center = min.clone().add(max).multiplyScalar(0.5);
  return {
    center,
    radius: Math.max(1, min.distanceTo(max) / 2),
    bounds: new Box3(min, max),
  };
}

/**
 * Distance at which every corner of `bounds` sits inside the frustum.
 *
 * Replicates three.js's `lookAt` basis — z away from the target, x from
 * `cross(worldUp, z)` — then solves each corner against both half-angles and
 * takes the tightest distance that satisfies all of them. Falls back to the
 * sphere fit when the caller gave no box.
 */
function fitDistance(camera: PerspectiveCamera, focus: ThumbnailFocus): number {
  const tanV = Math.tan(degToRad(camera.fov / 2));
  const tanH = tanV * camera.aspect;
  if (!focus.bounds) return focus.radius / Math.sin(degToRad(camera.fov / 2));

  const z = VIEW_DIRECTION;
  const x = new Vector3().crossVectors(WORLD_UP, z).normalize();
  const y = new Vector3().crossVectors(z, x);

  const { min, max } = focus.bounds;
  const corner = new Vector3();
  let distance = 0;
  for (let i = 0; i < 8; i++) {
    corner
      .set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z)
      .sub(focus.center);
    const depth = corner.dot(z);
    distance = Math.max(
      distance,
      depth + Math.abs(corner.dot(x)) / tanH,
      depth + Math.abs(corner.dot(y)) / tanV,
    );
  }
  return distance;
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

  let fit = focus;
  if (!fit) {
    const sphere = new Box3().setFromObject(object).getBoundingSphere(new Sphere());
    fit = { center: sphere.center, radius: sphere.radius > 1e-3 ? sphere.radius : 1 };
  }

  const center = fit.center;
  const distance = fitDistance(camera, fit) * FRAMING_MARGIN;
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
        thumbnails.set(map.name, renderObject(renderer, world.group, mapFocus(map)));
      } finally {
        disposeObject(world.group);
      }
    }
  } finally {
    renderer.dispose();
  }
  return thumbnails;
}
