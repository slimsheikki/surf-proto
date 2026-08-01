import {
  Box3,
  BoxHelper,
  GridHelper,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Sphere,
  Vector2,
  Vector3,
} from 'three';
import { disposeObject } from '../engine/Dispose';
import { degToRad, radToDeg } from '../engine/MathUtils';
import { BOSS_ID, buildBossMarker, buildPiece, buildSpawnPad, SPAWN_ID } from './FreeCourse';
import { cloneMap, findPreset, FreeMap, FreePiece, newPieceId, pieceFromPreset } from './MapData';

/** Fly speed, and the multiplier `Shift` applies. Sized against the course, not the tick — this is a camera, not a player. */
const FLY_SPEED = 45;
const FLY_BOOST = 3.5;
const LOOK_SENSITIVITY = 0.0025;
/** Same clamp the player camera has: past this the horizon flips. */
const MAX_PITCH = Math.PI / 2 - 0.01;

/** How far in front of the camera a piece lands when it is dropped over empty sky. */
const DROP_DISTANCE = 60;

const POSITION_SNAP = 2;
const YAW_SNAP = 15;
/** Vertical nudge per `R`/`F` press, and world units moved per pixel of an Alt-drag. */
const HEIGHT_STEP = 2;
const VERTICAL_DRAG_SCALE = 0.18;
const PITCH_STEP = 2;
/** A face steeper than this stops being rideable and starts being a wall to fall off. */
const MAX_PITCH_DEG = 50;

const SELECTION_COLOR = 0xffd166;
const GHOST_COLOR = 0x7fe8ff;
const GHOST_OPACITY = 0.45;

/**
 * The opening view: tilted down, swung off the map's own heading, and pulled
 * back to fit.
 *
 * The yaw offset is what earns the screen space. Looking straight down the run
 * — the obvious choice, and the first one tried — foreshortens the whole length
 * of the course into a short smear near the horizon, so a 200-unit map read as
 * a cluster of small shapes. From three-quarters on, that length lies across
 * the view instead.
 */
const FRAMING_PITCH = -0.5;
const FRAMING_YAW_OFFSET_DEG = 38;
const FRAMING_SLACK = 0.85;
/**
 * Fraction of the view width the opening shot is nudged sideways, so the map
 * centres in the space *left over* by the palette rather than behind it. The
 * palette is a fixed 236 px on the left; half of that as a share of a typical
 * viewport is about this.
 */
const FRAMING_PANEL_BIAS = 0.09;

const GRID_EXTENT = 600;
const GRID_DIVISIONS = 60;

export interface EditorCallbacks {
  /** Fired whenever the selection or the map changes, so the UI can redraw its status line. */
  onChange: () => void;
}

interface DragState {
  id: string;
  /** True while `Alt` is held: the drag moves the piece up and down instead of across. */
  vertical: boolean;
  /** World Y of the horizontal plane the drag runs on — the piece's own height when it was grabbed. */
  planeY: number;
  /** Piece position minus the grabbed point, so the piece does not jump to centre under the cursor. */
  grabOffset: Vector3;
}

/**
 * The free-mode map editor: a free-flying camera over a live map, with pieces
 * dragged in from the palette and moved in place.
 *
 * It deliberately does **not** use pointer lock. The standard game does, and
 * that is what makes a mouse-driven editor impossible there — under lock the
 * cursor is hidden and every click is delivered to the canvas, so a palette you
 * drag from and buttons you press cannot both exist. Look is therefore on the
 * right mouse button, which costs nothing here because the editor has no
 * combat to interrupt.
 *
 * The editor's world carries **no colliders**. Nothing in it is simulated, and
 * `registerCollider` caches per-box state with no way to retire an entry, so
 * registering during editing would pile up a stale box for every step of every
 * drag. The collidable world is built once, from the map, when the player hits
 * play.
 */
export class Editor {
  /** Everything the editor draws. Added to the scene by the app while free mode is open. */
  readonly root = new Group();
  /** Pieces only — the raycast target, so the grid never eats a click. */
  private readonly world = new Group();
  private readonly helpers = new Group();

  private map: FreeMap;
  /** id → built group, for every piece plus the two fixtures. */
  private readonly built = new Map<string, Group>();

  private selectedId: string | null = null;
  private selectionHelper: BoxHelper | null = null;

  private readonly camPosition = new Vector3();
  private camYaw = 0;
  private camPitch = 0;

  private readonly keys = new Set<string>();
  private looking = false;
  private drag: DragState | null = null;
  /** Non-null between a palette `dragstart` and its `dragend`/`drop`. */
  private pendingPreset: string | null = null;
  private ghost: Group | null = null;

  snapEnabled = true;

  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private active = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: PerspectiveCamera,
    map: FreeMap,
    private readonly callbacks: EditorCallbacks,
  ) {
    this.map = cloneMap(map);
    this.root.add(this.world, this.helpers);

    const grid = new GridHelper(GRID_EXTENT, GRID_DIVISIONS, 0x5a6672, 0x3c4550);
    // Transparent so the grid reads as a reference plane rather than a floor —
    // free maps routinely live above and below y = 0 and it must not look solid.
    const gridMaterial = grid.material as Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.35;
    this.helpers.add(grid);

    this.installListeners();
    this.rebuildAll();
    this.frameOnMap();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Starts consuming input. The app calls this when free mode opens. */
  enter(): void {
    this.active = true;
    this.keys.clear();
    this.callbacks.onChange();
  }

  /** Stops consuming input and drops any half-finished drag. */
  exit(): void {
    this.active = false;
    this.keys.clear();
    this.looking = false;
    this.drag = null;
    this.clearGhost();
  }

  getMap(): FreeMap {
    return cloneMap(this.map);
  }

  /** Replaces the whole map — loading a saved one, or starting a new one. */
  setMap(map: FreeMap): void {
    this.map = cloneMap(map);
    this.selectedId = null;
    this.rebuildAll();
    this.frameOnMap();
    this.callbacks.onChange();
  }

  get mapName(): string {
    return this.map.name;
  }

  set mapName(name: string) {
    this.map.name = name;
  }

  get pieceCount(): number {
    return this.map.pieces.length;
  }

  /** Human-readable description of what is selected, for the editor's status line. */
  get selectionSummary(): string {
    if (!this.selectedId) return 'Nothing selected — click a piece to move it.';
    if (this.selectedId === SPAWN_ID) return 'Start pad — the run begins here.';
    if (this.selectedId === BOSS_ID) return 'Boss cylinder — the goal.';
    const piece = this.findPiece(this.selectedId);
    if (!piece) return '';
    const bank = piece.rollDeg === 0 ? 'flat' : `bank ${piece.rollDeg.toFixed(0)}°`;
    return `${piece.kind} · yaw ${piece.yawDeg.toFixed(0)}° · pitch ${piece.pitchDeg.toFixed(0)}° · ${bank} · y ${piece.y.toFixed(1)}`;
  }

  // ------------------------------------------------------------------- update

  /**
   * Advances the fly camera. Driven by *render* dt, not the fixed step: nothing
   * here is gameplay, and holding an editor camera to 128 Hz would only mean
   * discarding the smoothness a high-refresh monitor is offering.
   */
  update(dt: number): void {
    if (!this.active) return;

    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? FLY_BOOST : 1;
    const speed = FLY_SPEED * boost * dt;

    const forward = this.lookDirection();
    // Strafe axis from yaw alone, so looking up or down never lifts a sideways
    // move off the horizontal — the same reason the player controller builds its
    // wish direction from yaw and not from the camera vector.
    const right = new Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));

    const move = new Vector3();
    if (this.keys.has('KeyW')) move.add(forward);
    if (this.keys.has('KeyS')) move.sub(forward);
    if (this.keys.has('KeyD')) move.add(right);
    if (this.keys.has('KeyA')) move.sub(right);
    if (this.keys.has('Space')) move.y += 1;
    if (this.keys.has('KeyC')) move.y -= 1;
    if (move.lengthSq() > 1e-6) this.camPosition.addScaledVector(move.normalize(), speed);

    this.camera.position.copy(this.camPosition);
    this.camera.rotation.set(this.camPitch, this.camYaw, 0, 'YXZ');
    this.selectionHelper?.update();
  }

  /** Same convention as `CameraRig.lookDirFromAngles`: forward at yaw 0 is -Z. */
  private lookDirection(): Vector3 {
    return new Vector3(
      -Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      -Math.cos(this.camYaw) * Math.cos(this.camPitch),
    ).normalize();
  }

  /**
   * Parks the camera far enough back to see the whole map, looking down its
   * opening heading.
   *
   * Framing on the start pad alone (the obvious first attempt) put the camera
   * nose-to-nose with a 14x20 pad and left every ramp in the map behind or
   * below the view — a player opening the editor saw one grey slab and nothing
   * else. Distance comes from the map's bounding sphere against the camera's
   * own field of view, so it holds for a two-piece starter and a sprawling
   * saved map alike.
   */
  private frameOnMap(): void {
    // The geometry heading convention and the camera's are mirrored (see
    // `SurfCourse.playerYawDegForHeading`), so the camera yaw that looks along
    // the map's opening heading is its negation.
    this.camYaw = degToRad(-this.map.spawn.yawDeg + FRAMING_YAW_OFFSET_DEG);
    this.camPitch = FRAMING_PITCH;

    const box = new Box3().setFromObject(this.world);
    if (box.isEmpty()) {
      this.camPosition.set(this.map.spawn.x, this.map.spawn.y + 20, this.map.spawn.z);
      return;
    }
    const sphere = box.getBoundingSphere(new Sphere());
    const halfFov = degToRad(this.camera.fov / 2);
    // `sin`, not `tan`. Fitting a sphere means the view cone has to be tangent
    // to it, and the tangent distance is r/sin — r/tan is the distance at which
    // the sphere's *centre plane* fits, which leaves the camera inside the
    // sphere for anything wide. Measured on the starter map that put the camera
    // nine units off the start pad, filling the screen with it.
    const distance = Math.max(80, (sphere.radius / Math.sin(halfFov)) * FRAMING_SLACK);
    this.camPosition.copy(sphere.center).addScaledVector(this.lookDirection(), -distance);

    const viewWidth = 2 * distance * Math.tan(halfFov) * this.camera.aspect;
    const right = new Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    this.camPosition.addScaledVector(right, -viewWidth * FRAMING_PANEL_BIAS);
  }

  // -------------------------------------------------------------- map editing

  private findPiece(id: string): FreePiece | undefined {
    return this.map.pieces.find((piece) => piece.id === id);
  }

  private rebuildAll(): void {
    for (const group of this.built.values()) disposeObject(group);
    this.built.clear();
    this.clearSelectionHelper();

    const spawn = buildSpawnPad(this.map.spawn, false);
    this.world.add(spawn.group);
    this.built.set(SPAWN_ID, spawn.group);

    const boss = buildBossMarker(this.map.boss, false);
    this.world.add(boss);
    this.built.set(BOSS_ID, boss);

    for (const piece of this.map.pieces) this.rebuildPiece(piece);
    this.refreshSelectionHelper();
  }

  /** Disposes and re-emits one piece's meshes. Cheap: a straight run is a single box. */
  private rebuildPiece(piece: FreePiece): void {
    const existing = this.built.get(piece.id);
    if (existing) disposeObject(existing);
    const group = buildPiece(piece, { colliders: false });
    this.world.add(group);
    this.built.set(piece.id, group);
    if (this.selectedId === piece.id) this.refreshSelectionHelper();
  }

  private rebuildFixture(id: string): void {
    const existing = this.built.get(id);
    if (existing) disposeObject(existing);
    const group =
      id === SPAWN_ID ? buildSpawnPad(this.map.spawn, false).group : buildBossMarker(this.map.boss, false);
    this.world.add(group);
    this.built.set(id, group);
    if (this.selectedId === id) this.refreshSelectionHelper();
  }

  private rebuildById(id: string): void {
    if (id === SPAWN_ID || id === BOSS_ID) this.rebuildFixture(id);
    else {
      const piece = this.findPiece(id);
      if (piece) this.rebuildPiece(piece);
    }
    this.callbacks.onChange();
  }

  private positionOf(id: string): Vector3 | null {
    if (id === SPAWN_ID) return new Vector3(this.map.spawn.x, this.map.spawn.y, this.map.spawn.z);
    if (id === BOSS_ID) return new Vector3(this.map.boss.x, this.map.boss.y, this.map.boss.z);
    const piece = this.findPiece(id);
    return piece ? new Vector3(piece.x, piece.y, piece.z) : null;
  }

  private setPosition(id: string, position: Vector3): void {
    const target = id === SPAWN_ID ? this.map.spawn : id === BOSS_ID ? this.map.boss : this.findPiece(id);
    if (!target) return;
    target.x = position.x;
    target.y = position.y;
    target.z = position.z;
    this.rebuildById(id);
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.refreshSelectionHelper();
    this.callbacks.onChange();
  }

  private clearSelectionHelper(): void {
    if (!this.selectionHelper) return;
    this.selectionHelper.removeFromParent();
    this.selectionHelper.dispose();
    this.selectionHelper = null;
  }

  private refreshSelectionHelper(): void {
    this.clearSelectionHelper();
    if (!this.selectedId) return;
    const group = this.built.get(this.selectedId);
    if (!group) return;
    // A world-axis-aligned box around a banked ramp is looser than the ramp
    // itself, which is fine and arguably better: it reads as a selection
    // bracket rather than as an outline the player might mistake for geometry.
    this.selectionHelper = new BoxHelper(group, SELECTION_COLOR);
    this.helpers.add(this.selectionHelper);
  }

  deleteSelected(): void {
    if (!this.selectedId || this.selectedId === SPAWN_ID || this.selectedId === BOSS_ID) return;
    const id = this.selectedId;
    const group = this.built.get(id);
    if (group) disposeObject(group);
    this.built.delete(id);
    this.map.pieces = this.map.pieces.filter((piece) => piece.id !== id);
    this.select(null);
  }

  duplicateSelected(): void {
    if (!this.selectedId) return;
    const piece = this.findPiece(this.selectedId);
    if (!piece) return;
    // Offset along travel rather than sideways, so a duplicate lands where the
    // next piece of a chain wants to be and one keypress extends a run.
    const forward = this.travelDirection(piece);
    const copy: FreePiece = {
      ...piece,
      id: newPieceId(),
      x: piece.x + forward.x * (piece.length + 6),
      y: piece.y + forward.y * (piece.length + 6),
      z: piece.z + forward.z * (piece.length + 6),
    };
    this.map.pieces.push(copy);
    this.rebuildPiece(copy);
    this.select(copy.id);
  }

  private travelDirection(piece: FreePiece): Vector3 {
    const yaw = degToRad(piece.yawDeg);
    const pitch = degToRad(piece.pitchDeg);
    return new Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      -Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    );
  }

  private nudgeSelected(mutate: (piece: FreePiece) => void): void {
    if (!this.selectedId) return;
    const piece = this.findPiece(this.selectedId);
    if (!piece) return;
    mutate(piece);
    this.rebuildPiece(piece);
    this.callbacks.onChange();
  }

  private rotateSelected(deltaDeg: number): void {
    if (this.selectedId === BOSS_ID) return; // A cylinder has no heading.
    if (this.selectedId === SPAWN_ID) {
      this.map.spawn.yawDeg = this.wrapYaw(this.map.spawn.yawDeg + deltaDeg);
      this.rebuildById(SPAWN_ID);
      return;
    }
    this.nudgeSelected((piece) => {
      piece.yawDeg = this.wrapYaw(piece.yawDeg + deltaDeg);
    });
  }

  private wrapYaw(yawDeg: number): number {
    const wrapped = ((yawDeg % 360) + 360) % 360;
    return this.snapEnabled ? Math.round(wrapped / YAW_SNAP) * YAW_SNAP : wrapped;
  }

  private raiseSelected(delta: number): void {
    if (!this.selectedId) return;
    const position = this.positionOf(this.selectedId);
    if (!position) return;
    this.setPosition(this.selectedId, position.setY(position.y + delta));
  }

  private snapVector(position: Vector3): Vector3 {
    if (!this.snapEnabled) return position;
    return new Vector3(
      Math.round(position.x / POSITION_SNAP) * POSITION_SNAP,
      Math.round(position.y / POSITION_SNAP) * POSITION_SNAP,
      Math.round(position.z / POSITION_SNAP) * POSITION_SNAP,
    );
  }

  // ---------------------------------------------------------- palette dragging

  /** Called from the palette's `dragstart`. The payload is a preset id. */
  beginPalettePlacement(presetId: string): void {
    this.pendingPreset = presetId;
  }

  /** Called from `dragend`, whether or not the drop landed in the world. */
  endPalettePlacement(): void {
    this.pendingPreset = null;
    this.clearGhost();
  }

  /** `dragover` on the canvas: shows a translucent preview where the drop would land. */
  previewDrop(event: DragEvent): void {
    if (!this.pendingPreset) return;
    const preset = findPreset(this.pendingPreset);
    if (!preset) return;
    const piece = pieceFromPreset(preset, 0, 0, 0, this.dropYawDeg());
    const target = this.snapVector(this.dropPoint(event));
    piece.x = target.x;
    piece.y = target.y;
    piece.z = target.z;

    this.clearGhost();
    this.ghost = buildPiece(piece, { colliders: false, color: GHOST_COLOR });
    this.ghost.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as MeshStandardMaterial;
      material.transparent = true;
      material.opacity = GHOST_OPACITY;
      material.depthWrite = false;
    });
    this.helpers.add(this.ghost);
  }

  /** `drop` on the canvas: commits the previewed piece. */
  completeDrop(event: DragEvent): void {
    const presetId = this.pendingPreset ?? event.dataTransfer?.getData('text/plain') ?? '';
    const preset = findPreset(presetId);
    this.endPalettePlacement();
    if (!preset) return;

    const target = this.snapVector(this.dropPoint(event));
    const piece = pieceFromPreset(preset, target.x, target.y, target.z, this.dropYawDeg());
    this.map.pieces.push(piece);
    this.rebuildPiece(piece);
    this.select(piece.id);
  }

  /**
   * A dropped piece takes the camera's own heading, so a ramp dropped while
   * looking down the run points down the run. Geometry headings are the mirror
   * of camera yaw — see `frameOnSpawn`.
   */
  private dropYawDeg(): number {
    const yawDeg = radToDeg(-this.camYaw);
    return this.wrapYaw(yawDeg);
  }

  /**
   * Where a pointer event lands in the world: on the first piece under the
   * cursor if there is one, otherwise a fixed distance out along the ray.
   *
   * The fallback is deliberately camera-relative rather than an intersection
   * with some build plane. A free map is built in three dimensions and there is
   * no single height that is the right guess; "where I am looking, a bit in
   * front of me" always puts the piece on screen, which is the only property
   * that actually matters before the player drags it into place.
   */
  private dropPoint(event: { clientX: number; clientY: number }): Vector3 {
    this.setPointer(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.world, true);
    if (hits.length > 0) return hits[0].point.clone();
    return this.camPosition.clone().addScaledVector(this.lookDirection(), DROP_DISTANCE);
  }

  private clearGhost(): void {
    if (!this.ghost) return;
    disposeObject(this.ghost);
    this.ghost = null;
  }

  private setPointer(event: { clientX: number; clientY: number }): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** Walks up from a hit mesh to the group that carries the piece id. */
  private pieceIdAt(event: PointerEvent): string | null {
    this.setPointer(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    for (const hit of this.raycaster.intersectObject(this.world, true)) {
      let node: Object3D | null = hit.object;
      while (node) {
        const id = node.userData.pieceId;
        if (typeof id === 'string') return id;
        node = node.parent;
      }
    }
    return null;
  }

  // ----------------------------------------------------------------- listeners

  private installListeners(): void {
    // Right-drag is the look control, so the browser menu has to go or every
    // attempt to turn around opens it.
    this.canvas.addEventListener('contextmenu', (event) => {
      if (this.active) event.preventDefault();
    });

    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    window.addEventListener('pointermove', (event) => this.onPointerMove(event));
    window.addEventListener('pointerup', (event) => this.onPointerUp(event));

    this.canvas.addEventListener('dragover', (event) => {
      if (!this.active || !this.pendingPreset) return;
      // Without preventDefault the browser refuses the drop outright.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      this.previewDrop(event);
    });
    this.canvas.addEventListener('drop', (event) => {
      if (!this.active) return;
      event.preventDefault();
      this.completeDrop(event);
    });

    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('keyup', (event) => {
      if (!this.active) return;
      this.keys.delete(event.code);
    });
    // A key held when focus leaves would otherwise stay latched and fly the
    // camera off on its own when focus comes back.
    window.addEventListener('blur', () => this.keys.clear());
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.active) return;

    if (event.button === 2) {
      this.looking = true;
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;

    const id = this.pieceIdAt(event);
    this.select(id);
    if (!id) return;

    const position = this.positionOf(id);
    if (!position) return;
    const grabbed = this.dropPoint(event);
    this.drag = {
      id,
      vertical: event.altKey,
      planeY: position.y,
      grabOffset: position.clone().sub(grabbed),
    };
    this.canvas.setPointerCapture(event.pointerId);
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.active) return;

    if (this.looking) {
      this.camYaw -= event.movementX * LOOK_SENSITIVITY;
      this.camPitch -= event.movementY * LOOK_SENSITIVITY;
      this.camPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.camPitch));
      return;
    }

    if (!this.drag) return;
    const current = this.positionOf(this.drag.id);
    if (!current) return;

    if (this.drag.vertical) {
      // Screen-space vertical drag. Distance-independent on purpose: the
      // alternative — scaling by depth so the piece tracks the cursor exactly —
      // makes the same wrist movement worth 2 units up close and 60 far away,
      // and a map is built from both distances.
      current.y -= event.movementY * VERTICAL_DRAG_SCALE;
      this.setPosition(this.drag.id, this.snapVector(current));
      return;
    }

    // Horizontal drag: intersect the ray with the plane the piece was grabbed
    // on, so it slides at its own height rather than sinking toward whatever is
    // under the cursor.
    this.setPointer(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const ray = this.raycaster.ray;
    const denominator = ray.direction.y;
    // Near-parallel to the plane: the intersection runs off to infinity, so
    // leave the piece where it is rather than flinging it over the horizon.
    if (Math.abs(denominator) < 1e-4) return;
    const t = (this.drag.planeY - ray.origin.y) / denominator;
    if (t <= 0) return;

    const point = ray.origin.clone().addScaledVector(ray.direction, t).add(this.drag.grabOffset);
    point.y = this.drag.planeY;
    this.setPosition(this.drag.id, this.snapVector(point));
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.button === 2) this.looking = false;
    if (event.button === 0) this.drag = null;
    if (this.canvas.hasPointerCapture?.(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.active) return;
    // Never steal keys from the map-name field.
    const target = event.target;
    if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.isContentEditable)) {
      return;
    }

    this.keys.add(event.code);

    switch (event.code) {
      case 'KeyQ':
        this.rotateSelected(event.altKey ? -1 : -YAW_SNAP);
        break;
      case 'KeyE':
        this.rotateSelected(event.altKey ? 1 : YAW_SNAP);
        break;
      case 'KeyR':
        this.raiseSelected(HEIGHT_STEP);
        break;
      case 'KeyF':
        this.raiseSelected(-HEIGHT_STEP);
        break;
      case 'KeyT':
        this.nudgeSelected((piece) => {
          piece.pitchDeg = Math.max(-MAX_PITCH_DEG, piece.pitchDeg - PITCH_STEP);
        });
        break;
      case 'KeyY':
        this.nudgeSelected((piece) => {
          piece.pitchDeg = Math.min(MAX_PITCH_DEG, piece.pitchDeg + PITCH_STEP);
        });
        break;
      case 'KeyB':
        // Mirroring the bank is the single most-used edit there is: it is how a
        // channel is made and how a descent staircase alternates.
        this.nudgeSelected((piece) => {
          piece.rollDeg = -piece.rollDeg;
        });
        break;
      case 'KeyN':
        this.snapEnabled = !this.snapEnabled;
        this.callbacks.onChange();
        break;
      case 'KeyD':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          this.duplicateSelected();
        }
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        this.deleteSelected();
        break;
      default:
        break;
    }
  }
}
