import { Material, Mesh, Object3D } from 'three';

/**
 * Frees every geometry and material under `root` and detaches it from its
 * parent.
 *
 * The editor rebuilds a piece's meshes on every drag step and the app rebuilds
 * the whole world on every mode switch, so these are not one-off teardowns the
 * page unload can be left to handle: `RampCurve` allocates a fresh
 * `BoxGeometry` and `MeshStandardMaterial` per call, and WebGL buffers are not
 * reachable by the GC through the JS objects alone. Without this, dragging a
 * ramp around for a minute leaks a few thousand GPU buffers.
 */
export function disposeObject(root: Object3D): void {
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const material = mesh.material as Material | Material[] | undefined;
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else material?.dispose();
  });
  root.removeFromParent();
}
