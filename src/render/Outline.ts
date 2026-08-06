/**
 * Inverted-hull outlines — the bold black line that reads a character's
 * silhouette against a loud sky, the other half of the JSR look.
 *
 * A back-face copy of the mesh, expanded along its normal in *clip* space and
 * scaled by `w`, so the line holds a constant screen-space width at any distance
 * (a world-space shell would balloon up close and vanish far away). Pure black,
 * depth-writing, drawn just before its owner.
 *
 * The outline is added as a **render-only child of the mesh**: colliders are
 * registered only through explicit `registerCollider`/`registerPrism` calls, so
 * a child added to the scene graph can never enter the collision world. It also
 * shares the owner's `BufferGeometry` — no vertex duplication — and one shared
 * material, so every outline in the game is a single program whose width folds
 * to zero when NPR is toggled off (`uOutlineWidth * uNprEnabled`).
 */

import { BackSide, Mesh, type Object3D, ShaderMaterial } from 'three';
import { nprUniforms } from './NprUniforms';

const outlineMaterial = new ShaderMaterial({
  uniforms: {
    uOutlineWidth: nprUniforms.uOutlineWidth,
    uOutlineColor: nprUniforms.uOutlineColor,
    uNprEnabled: nprUniforms.uNprEnabled,
  },
  vertexShader: /* glsl */ `
    uniform float uOutlineWidth;
    uniform float uNprEnabled;
    void main() {
      vec4 clip = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      vec3 viewNormal = normalize( normalMatrix * normal );
      vec4 projNormal = projectionMatrix * vec4( viewNormal, 0.0 );
      vec2 dir = length( projNormal.xy ) > 1e-5 ? normalize( projNormal.xy ) : vec2( 0.0 );
      clip.xy += dir * uOutlineWidth * uNprEnabled * clip.w;
      gl_Position = clip;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uOutlineColor;
    void main() {
      gl_FragColor = vec4( uOutlineColor, 1.0 );
    }
  `,
  side: BackSide,
});

export interface OutlineOptions {
  /** Return true to leave a given mesh un-outlined (e.g. tiny inner parts). */
  skip?: (mesh: Mesh) => boolean;
}

/**
 * Give every mesh under `target` a black inverted-hull outline. Idempotent per
 * mesh (skips meshes that already carry, or already are, an outline).
 */
export function addOutline(target: Object3D, options: OutlineOptions = {}): void {
  const owners: Mesh[] = [];
  target.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh || mesh.userData.isOutline || mesh.userData.hasOutline) return;
    if (options.skip?.(mesh)) return;
    owners.push(mesh);
  });
  for (const mesh of owners) {
    const outline = new Mesh(mesh.geometry, outlineMaterial);
    outline.userData.isOutline = true;
    outline.frustumCulled = mesh.frustumCulled;
    // Drawn just before its owner; the owner's front faces then overwrite the
    // shell's interior, leaving only the silhouette lip.
    outline.renderOrder = (mesh.renderOrder || 0) - 1;
    mesh.userData.hasOutline = true;
    mesh.add(outline);
  }
}
