import {
  AmbientLight,
  Box3,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import { degToRad } from '../engine/MathUtils';
import { disposeObject } from '../engine/Dispose';
import { buildPiece } from './FreeCourse';
import { pieceFromDef, RAMP_LIBRARY } from './RampLibrary';

/** Square thumbnail edge, px. Rendered at 2x the CSS tile size so it stays crisp on retina. */
const THUMB_SIZE = 128;
/** Slightly high three-quarter view — the angle that reads bank, taper and curve at once. */
const VIEW_DIRECTION = new Vector3(0.85, 0.62, 1).normalize();

/**
 * Renders each library definition into a small data-URL image for the palette
 * — the `Thumbnail` field the ramp-library spec asks for, generated from the
 * real geometry rather than authored, so a definition can never drift out of
 * agreement with its own picture.
 *
 * Uses a private offscreen `WebGLRenderer` for one synchronous pass at editor
 * startup, then disposes it: ~13 renders of a dozen boxes each is milliseconds,
 * and holding a second GL context open for the life of the editor would be
 * paying for it forever. Returns an empty map when a context is unavailable
 * (headless tests); the palette falls back to text-only tiles.
 */
export function generateThumbnails(): Map<string, string> {
  const thumbnails = new Map<string, string>();

  let renderer: WebGLRenderer;
  try {
    // preserveDrawingBuffer so toDataURL reads the frame just rendered.
    renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return thumbnails;
  }
  renderer.setSize(THUMB_SIZE, THUMB_SIZE);

  const scene = new Scene();
  scene.add(new AmbientLight(0xffffff, 0.8));
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(1.5, 2.2, 1.8);
  scene.add(sun);
  const camera = new PerspectiveCamera(35, 1, 0.1, 1000);

  for (const def of RAMP_LIBRARY) {
    const piece = pieceFromDef(def, `thumb-${def.id}`, 0, 0, 0, 0);
    const group = buildPiece(piece, { colliders: false });
    scene.add(group);

    const sphere = new Box3().setFromObject(group).getBoundingSphere(new Sphere());
    const distance = (sphere.radius / Math.sin(degToRad(camera.fov / 2))) * 1.1;
    camera.position.copy(sphere.center).addScaledVector(VIEW_DIRECTION, distance);
    camera.lookAt(sphere.center);

    renderer.render(scene, camera);
    thumbnails.set(def.id, renderer.domElement.toDataURL());

    scene.remove(group);
    disposeObject(group);
  }

  renderer.dispose();
  return thumbnails;
}
