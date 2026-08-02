import {
  Box3,
  BoxHelper,
  BufferGeometry,
  GridHelper,
  Group,
  Line,
  LineBasicMaterial,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  CatmullRomCurve3,
  Sphere,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import { disposeObject } from '../engine/Dispose';
import { isTextEntryTarget } from '../engine/Input';
import { degToRad, radToDeg } from '../engine/MathUtils';
import { BOSS_ID, buildBossMarker, buildPiece, buildSpawnPad, SPAWN_ID } from './FreeCourse';
import { cloneMap, FreeMap, FreePiece, newPieceId } from './MapData';
import { defFor, pieceFromDef, piecePath, PiecePath } from './RampLibrary';
import { generatePiecesFromSpline } from './SplineGen';

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
/**
 * How close a dragged piece's socket has to come to another piece's before it
 * snaps on. In *piece-position* space, not socket space, so the feel is "the
 * piece clicks into place when it is nearly there".
 */
const SOCKET_SNAP_RADIUS = 6;
/** Vertical nudge per `R`/`F` press, and world units moved per pixel of an Alt-drag. */
const HEIGHT_STEP = 2;
const VERTICAL_DRAG_SCALE = 0.18;
const PITCH_STEP = 2;
/** A face steeper than this stops being rideable and starts being a wall to fall off. */
const MAX_PITCH_DEG = 50;

const SELECTION_COLOR = 0xffd166;
const GHOST_COLOR = 0x7fe8ff;
const GHOST_OPACITY = 0.45;

const SPLINE_COLOR = 0x7fe8ff;
const SPLINE_HANDLE_COLOR = 0x49b8d6;
const SPLINE_HANDLE_SELECTED = 0xffd166;
const SPLINE_HANDLE_RADIUS = 1.6;
/** Shared by every handle — geometry is never per-instance here. */
const SPLINE_HANDLE_GEOMETRY = new SphereGeometry(SPLINE_HANDLE_RADIUS, 12, 10);

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
  /** Primary — the piece under the cursor. The rest of the selection follows it. */
  id: string;
  /** True while `Alt` is held: the drag moves the piece up and down instead of across. */
  vertical: boolean;
  /** World Y of the horizontal plane the drag runs on — the piece's own height when it was grabbed. */
  planeY: number;
  /** Piece position minus the grabbed point, so the piece does not jump to centre under the cursor. */
  grabOffset: Vector3;
  /** Where every selected thing was when the drag began, for group moves. */
  startPositions: Map<string, Vector3>;
  /** Exit/entry sockets of every *unselected* ramp, frozen at drag start. */
  socketTargets: { id: string; path: PiecePath }[];
}

interface SplineDragState {
  index: number;
  vertical: boolean;
  planeY: number;
  grabOffset: Vector3;
  moved: boolean;
}

/**
 * The free-mode map editor: a free-flying camera over a live map, with modular
 * library pieces dragged in from the palette, snapped socket-to-socket, and a
 * design spline that assembles pieces automatically (see `SplineGen`).
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

  /** Multi-selection, in click order. The first entry drives group operations. */
  private selectedIds: string[] = [];
  private selectionHelpers: BoxHelper[] = [];

  private readonly camPosition = new Vector3();
  private camYaw = 0;
  private camPitch = 0;

  private readonly keys = new Set<string>();
  private looking = false;
  private drag: DragState | null = null;
  /** Non-null between a palette `dragstart` and its `dragend`/`drop`. */
  private pendingDef: string | null = null;
  private ghost: Group | null = null;

  snapEnabled = true;

  // ---- spline tool state
  splineMode = false;
  private splinePoints: Vector3[] = [];
  /** Pieces owned by the current spline generation — replaced wholesale on regen. */
  private splineGeneratedIds = new Set<string>();
  private selectedHandle: number | null = null;
  private splineDrag: SplineDragState | null = null;
  private readonly splineGroup = new Group();
  private splineLine: Line | null = null;
  private splineHandles: Mesh[] = [];

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
    this.helpers.add(this.splineGroup);

    const grid = new GridHelper(GRID_EXTENT, GRID_DIVISIONS, 0x5a6672, 0x3c4550);
    // Transparent so the grid reads as a reference plane rather than a floor —
    // free maps routinely live above and below y = 0 and it must not look solid.
    const gridMaterial = grid.material as Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.35;
    this.helpers.add(grid);

    this.installListeners();
    this.adoptSplineFromMap();
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
    this.splineDrag = null;
    this.clearGhost();
  }

  getMap(): FreeMap {
    this.syncSplineIntoMap();
    return cloneMap(this.map);
  }

  /** Replaces the whole map — loading a saved one, or starting a new one. */
  setMap(map: FreeMap): void {
    this.map = cloneMap(map);
    this.selectedIds = [];
    this.splineGeneratedIds.clear();
    this.adoptSplineFromMap();
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

  get splinePointCount(): number {
    return this.splinePoints.length;
  }

  /**
   * Whether `deleteSelected` would do anything. The start pad and the boss
   * cylinder are selectable and movable but never removable, so the toolbar
   * button greys out on them rather than looking broken when it is pressed.
   */
  get canDeleteSelection(): boolean {
    return this.selectedIds.some((id) => id !== SPAWN_ID && id !== BOSS_ID);
  }

  /** Human-readable description of what is selected, for the editor's status line. */
  get selectionSummary(): string {
    if (this.splineMode) {
      return this.splinePoints.length < 2
        ? 'Spline: click the world to lay guide points — ramps generate along them.'
        : `Spline: ${this.splinePoints.length} points, ${this.splineGeneratedIds.size} generated pieces. Drag points to reshape; Delete removes one.`;
    }
    if (this.selectedIds.length === 0) return 'Nothing selected — click a piece, shift-click to add more.';
    if (this.selectedIds.length > 1) return `${this.selectedIds.length} pieces selected — drag moves all, Q/E turns the group.`;
    const id = this.selectedIds[0];
    if (id === SPAWN_ID) return 'Start pad — the run begins here.';
    if (id === BOSS_ID) return 'Boss cylinder — the goal.';
    const piece = this.findPiece(id);
    if (!piece) return '';
    const def = defFor(piece.def);
    const bank = piece.rollDeg === 0 ? 'flat' : `bank ${piece.rollDeg.toFixed(0)}°`;
    const curve =
      piece.yawSweepDeg !== undefined && piece.yawSweepDeg !== 0
        ? ` · sweep ${piece.yawSweepDeg.toFixed(0)}°`
        : '';
    return `${def.label} · yaw ${piece.yawDeg.toFixed(0)}° · pitch ${piece.pitchDeg.toFixed(0)}°${curve} · ${bank} · y ${piece.y.toFixed(1)}`;
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
    for (const helper of this.selectionHelpers) helper.update();
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
    this.clearSelectionHelpers();

    const spawn = buildSpawnPad(this.map.spawn, false);
    this.world.add(spawn.group);
    this.built.set(SPAWN_ID, spawn.group);

    const boss = buildBossMarker(this.map.boss, false);
    this.world.add(boss);
    this.built.set(BOSS_ID, boss);

    for (const piece of this.map.pieces) this.rebuildPiece(piece);
    this.rebuildSplineVisuals();
    this.refreshSelectionHelpers();
  }

  /** Disposes and re-emits one piece's meshes. Cheap: a straight run is a single box. */
  private rebuildPiece(piece: FreePiece): void {
    const existing = this.built.get(piece.id);
    if (existing) disposeObject(existing);
    const group = buildPiece(piece, { colliders: false });
    this.world.add(group);
    this.built.set(piece.id, group);
    if (this.selectedIds.includes(piece.id)) this.refreshSelectionHelpers();
  }

  private rebuildFixture(id: string): void {
    const existing = this.built.get(id);
    if (existing) disposeObject(existing);
    const group =
      id === SPAWN_ID ? buildSpawnPad(this.map.spawn, false).group : buildBossMarker(this.map.boss, false);
    this.world.add(group);
    this.built.set(id, group);
    if (this.selectedIds.includes(id)) this.refreshSelectionHelpers();
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

  select(id: string | null, additive = false): void {
    if (id === null) {
      this.selectedIds = [];
    } else if (additive) {
      // Shift-click toggles membership, so an accidental add is undone the
      // same way it was made.
      const at = this.selectedIds.indexOf(id);
      if (at === -1) this.selectedIds.push(id);
      else this.selectedIds.splice(at, 1);
    } else {
      this.selectedIds = [id];
    }
    this.refreshSelectionHelpers();
    this.callbacks.onChange();
  }

  private clearSelectionHelpers(): void {
    for (const helper of this.selectionHelpers) {
      helper.removeFromParent();
      helper.dispose();
    }
    this.selectionHelpers = [];
  }

  private refreshSelectionHelpers(): void {
    this.clearSelectionHelpers();
    for (const id of this.selectedIds) {
      const group = this.built.get(id);
      if (!group) continue;
      // A world-axis-aligned box around a banked ramp is looser than the ramp
      // itself, which is fine and arguably better: it reads as a selection
      // bracket rather than as an outline the player might mistake for geometry.
      const helper = new BoxHelper(group, SELECTION_COLOR);
      this.helpers.add(helper);
      this.selectionHelpers.push(helper);
    }
  }

  deleteSelected(): void {
    const doomed = this.selectedIds.filter((id) => id !== SPAWN_ID && id !== BOSS_ID);
    if (doomed.length === 0) return;
    for (const id of doomed) {
      const group = this.built.get(id);
      if (group) disposeObject(group);
      this.built.delete(id);
      this.splineGeneratedIds.delete(id);
    }
    const gone = new Set(doomed);
    this.map.pieces = this.map.pieces.filter((piece) => !gone.has(piece.id));
    this.select(null);
  }

  duplicateSelected(): void {
    const originals = this.selectedIds
      .map((id) => this.findPiece(id))
      .filter((piece): piece is FreePiece => piece !== undefined);
    if (originals.length === 0) return;

    // Offset along the first piece's travel rather than sideways, so a
    // duplicate lands where the next piece of a chain wants to be and one
    // keypress extends a run.
    const forward = this.travelDirection(originals[0]);
    const shift = originals[0].length + 6;
    const copies: FreePiece[] = originals.map((piece) => ({
      ...piece,
      id: newPieceId(),
      x: piece.x + forward.x * shift,
      y: piece.y + forward.y * shift,
      z: piece.z + forward.z * shift,
    }));
    this.map.pieces.push(...copies);
    for (const copy of copies) this.rebuildPiece(copy);
    this.selectedIds = copies.map((copy) => copy.id);
    this.refreshSelectionHelpers();
    this.callbacks.onChange();
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

  /** Applies `mutate` to every selected ramp piece and rebuilds them. */
  private nudgeSelected(mutate: (piece: FreePiece) => void): void {
    let touched = false;
    for (const id of this.selectedIds) {
      const piece = this.findPiece(id);
      if (!piece) continue;
      mutate(piece);
      this.rebuildPiece(piece);
      touched = true;
    }
    if (touched) this.callbacks.onChange();
  }

  private rotateSelected(deltaDeg: number): void {
    if (this.selectedIds.length === 0) return;

    // Single selection keeps the old behaviour: turn in place.
    if (this.selectedIds.length === 1) {
      const id = this.selectedIds[0];
      if (id === BOSS_ID) return; // A cylinder has no heading.
      if (id === SPAWN_ID) {
        this.map.spawn.yawDeg = this.wrapYaw(this.map.spawn.yawDeg + deltaDeg);
        this.rebuildById(SPAWN_ID);
        return;
      }
      this.nudgeSelected((piece) => {
        piece.yawDeg = this.wrapYaw(piece.yawDeg + deltaDeg);
      });
      return;
    }

    // Group rotation: every selected thing orbits the selection's centroid and
    // turns with it, so a chain stays a chain instead of shearing apart.
    const positions = this.selectedIds
      .map((id) => ({ id, position: this.positionOf(id) }))
      .filter((entry): entry is { id: string; position: Vector3 } => entry.position !== null);
    if (positions.length === 0) return;
    const centroid = positions
      .reduce((sum, entry) => sum.add(entry.position), new Vector3())
      .divideScalar(positions.length);

    // Positions must orbit by the same turn the headings make. In this yaw
    // convention (yaw 0 = -Z, forwardXZ = (sin, -cos)) that comes out as the
    // matrix below with a *positive* angle — verified against forwardXZ, since
    // a sign slip here shears a chain apart instead of turning it.
    const angle = degToRad(deltaDeg);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const { id, position } of positions) {
      const dx = position.x - centroid.x;
      const dz = position.z - centroid.z;
      const rotated = new Vector3(
        centroid.x + dx * cos - dz * sin,
        position.y,
        centroid.z + dx * sin + dz * cos,
      );
      if (id === SPAWN_ID) {
        this.map.spawn.yawDeg = this.wrapYaw(this.map.spawn.yawDeg + deltaDeg);
      } else if (id !== BOSS_ID) {
        const piece = this.findPiece(id);
        if (piece) piece.yawDeg = this.wrapYaw(piece.yawDeg + deltaDeg);
      }
      this.setPosition(id, rotated);
    }
  }

  private wrapYaw(yawDeg: number): number {
    const wrapped = ((yawDeg % 360) + 360) % 360;
    return this.snapEnabled ? Math.round(wrapped / YAW_SNAP) * YAW_SNAP : wrapped;
  }

  private raiseSelected(delta: number): void {
    for (const id of this.selectedIds) {
      const position = this.positionOf(id);
      if (position) this.setPosition(id, position.setY(position.y + delta));
    }
  }

  private snapVector(position: Vector3): Vector3 {
    if (!this.snapEnabled) return position;
    return new Vector3(
      Math.round(position.x / POSITION_SNAP) * POSITION_SNAP,
      Math.round(position.y / POSITION_SNAP) * POSITION_SNAP,
      Math.round(position.z / POSITION_SNAP) * POSITION_SNAP,
    );
  }

  // ---------------------------------------------------------- socket snapping

  /**
   * Sockets of every ramp except `except` — frozen once per drag, because only
   * the dragged piece moves and re-walking every path per pointer event is
   * waste for nothing.
   */
  private collectSocketTargets(except: Set<string>): { id: string; path: PiecePath }[] {
    const targets: { id: string; path: PiecePath }[] = [];
    for (const piece of this.map.pieces) {
      if (except.has(piece.id) || piece.def === 'platform') continue;
      targets.push({ id: piece.id, path: piecePath(piece) });
    }
    return targets;
  }

  /**
   * Tries to click the dragged piece onto a neighbour: its entry onto some
   * exit (adopting that exit's heading, so chains stay tangent), or its exit
   * onto some entry (keeping its own heading — there is no one yaw that solves
   * that case in general). Returns the snapped placement, or null to leave the
   * grid snap's answer alone.
   */
  private trySocketSnap(
    piece: FreePiece,
    desired: Vector3,
    targets: { id: string; path: PiecePath }[],
  ): { position: Vector3; yawDeg: number } | null {
    let best: { position: Vector3; yawDeg: number; distSq: number } | null = null;

    for (const target of targets) {
      // Entry-to-exit: candidate heading is the exit's, so the piece has to be
      // re-walked at that yaw before its entry offset is known.
      const chained: FreePiece = { ...piece, yawDeg: target.path.endYawDeg };
      const atOrigin = piecePath({ ...chained, x: 0, y: 0, z: 0 });
      const entryPos = new Vector3(
        target.path.end.x - atOrigin.entry.x,
        target.path.end.y - atOrigin.entry.y,
        target.path.end.z - atOrigin.entry.z,
      );
      const entryDistSq = entryPos.distanceToSquared(desired);
      if (entryDistSq < SOCKET_SNAP_RADIUS * SOCKET_SNAP_RADIUS && (!best || entryDistSq < best.distSq)) {
        best = { position: entryPos, yawDeg: target.path.endYawDeg, distSq: entryDistSq };
      }

      // Exit-to-entry: feed the chain from the front, own heading kept.
      const own = piecePath({ ...piece, x: 0, y: 0, z: 0 });
      const exitPos = new Vector3(
        target.path.entry.x - own.end.x,
        target.path.entry.y - own.end.y,
        target.path.entry.z - own.end.z,
      );
      const exitDistSq = exitPos.distanceToSquared(desired);
      if (exitDistSq < SOCKET_SNAP_RADIUS * SOCKET_SNAP_RADIUS && (!best || exitDistSq < best.distSq)) {
        best = { position: exitPos, yawDeg: piece.yawDeg, distSq: exitDistSq };
      }
    }

    return best ? { position: best.position, yawDeg: best.yawDeg } : null;
  }

  // ---------------------------------------------------------- palette dragging

  /** Called from the palette's `dragstart`. The payload is a `RampDefinition` id. */
  beginPalettePlacement(defId: string): void {
    this.pendingDef = defId;
  }

  /** Called from `dragend`, whether or not the drop landed in the world. */
  endPalettePlacement(): void {
    this.pendingDef = null;
    this.clearGhost();
  }

  /** `dragover` on the canvas: shows a translucent preview where the drop would land. */
  previewDrop(event: DragEvent): void {
    if (!this.pendingDef) return;
    const def = defFor(this.pendingDef);
    const target = this.snapVector(this.dropPoint(event));
    const piece = pieceFromDef(def, newPieceId(), target.x, target.y, target.z, this.dropYawDeg());

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

  /** `drop` on the canvas: commits the previewed piece, snapping onto a socket when one is close. */
  completeDrop(event: DragEvent): void {
    const defId = this.pendingDef ?? event.dataTransfer?.getData('text/plain') ?? '';
    this.endPalettePlacement();
    if (!defId) return;
    const def = defFor(defId);

    const target = this.snapVector(this.dropPoint(event));
    const piece = pieceFromDef(def, newPieceId(), target.x, target.y, target.z, this.dropYawDeg());

    if (def.family !== 'platform' && this.snapEnabled) {
      const snapped = this.trySocketSnap(piece, target, this.collectSocketTargets(new Set()));
      if (snapped) {
        piece.x = snapped.position.x;
        piece.y = snapped.position.y;
        piece.z = snapped.position.z;
        piece.yawDeg = snapped.yawDeg;
      }
    }

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

  // ------------------------------------------------------------- spline tool

  setSplineMode(on: boolean): void {
    this.splineMode = on;
    this.selectedHandle = null;
    this.splineDrag = null;
    if (!on) this.select(null);
    this.rebuildSplineVisuals();
    this.callbacks.onChange();
  }

  /** Forgets the guide curve. The generated pieces stay — they are ordinary pieces. */
  clearSpline(): void {
    this.splinePoints = [];
    this.splineGeneratedIds.clear();
    this.selectedHandle = null;
    this.syncSplineIntoMap();
    this.rebuildSplineVisuals();
    this.callbacks.onChange();
  }

  private adoptSplineFromMap(): void {
    this.splinePoints = (this.map.spline ?? []).map((p) => new Vector3(p.x, p.y, p.z));
  }

  private syncSplineIntoMap(): void {
    this.map.spline =
      this.splinePoints.length > 0
        ? this.splinePoints.map((p) => ({ x: p.x, y: p.y, z: p.z }))
        : undefined;
  }

  /**
   * Replaces the previous generation with pieces assembled along the current
   * spline. Runs on every spline edit, per the spec — the guide moves, the
   * ramps follow. Pieces the player has hand-placed are never touched: only
   * ids this generator itself created are replaced.
   */
  private regenerateFromSpline(): void {
    for (const id of this.splineGeneratedIds) {
      const group = this.built.get(id);
      if (group) disposeObject(group);
      this.built.delete(id);
    }
    this.map.pieces = this.map.pieces.filter((piece) => !this.splineGeneratedIds.has(piece.id));
    this.splineGeneratedIds.clear();

    const generated = generatePiecesFromSpline(this.splinePoints);
    for (const piece of generated) {
      this.map.pieces.push(piece);
      this.splineGeneratedIds.add(piece.id);
      this.rebuildPiece(piece);
    }
    this.syncSplineIntoMap();
    this.callbacks.onChange();
  }

  private rebuildSplineVisuals(): void {
    if (this.splineLine) {
      this.splineLine.geometry.dispose();
      (this.splineLine.material as Material).dispose();
      this.splineLine.removeFromParent();
      this.splineLine = null;
    }
    for (const handle of this.splineHandles) {
      (handle.material as Material).dispose();
      handle.removeFromParent();
    }
    this.splineHandles = [];
    this.splineGroup.visible = this.splineMode || this.splinePoints.length > 0;

    if (this.splinePoints.length >= 2) {
      const curve = new CatmullRomCurve3(this.splinePoints, false, 'catmullrom', 0.5);
      const geometry = new BufferGeometry().setFromPoints(curve.getPoints(this.splinePoints.length * 24));
      this.splineLine = new Line(geometry, new LineBasicMaterial({ color: SPLINE_COLOR }));
      this.splineGroup.add(this.splineLine);
    }

    this.splinePoints.forEach((point, index) => {
      const selected = index === this.selectedHandle;
      const handle = new Mesh(
        SPLINE_HANDLE_GEOMETRY,
        new MeshBasicMaterial({ color: selected ? SPLINE_HANDLE_SELECTED : SPLINE_HANDLE_COLOR }),
      );
      handle.position.copy(point);
      handle.userData.splineIndex = index;
      this.splineGroup.add(handle);
      this.splineHandles.push(handle);
    });
  }

  private splineHandleAt(event: PointerEvent): number | null {
    this.setPointer(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    for (const hit of this.raycaster.intersectObjects(this.splineHandles, false)) {
      const index = hit.object.userData.splineIndex;
      if (typeof index === 'number') return index;
    }
    return null;
  }

  private deleteSelectedSplinePoint(): void {
    if (this.splinePoints.length === 0) return;
    const index = this.selectedHandle ?? this.splinePoints.length - 1;
    this.splinePoints.splice(index, 1);
    this.selectedHandle = null;
    this.rebuildSplineVisuals();
    this.regenerateFromSpline();
  }

  private onSplinePointerDown(event: PointerEvent): void {
    const handleIndex = this.splineHandleAt(event);
    if (handleIndex !== null) {
      this.selectedHandle = handleIndex;
      const position = this.splinePoints[handleIndex];
      this.splineDrag = {
        index: handleIndex,
        vertical: event.altKey,
        planeY: position.y,
        grabOffset: position.clone().sub(this.dropPoint(event)),
        moved: false,
      };
      this.canvas.setPointerCapture(event.pointerId);
      this.rebuildSplineVisuals();
      this.callbacks.onChange();
      return;
    }

    // Clicked the world: lay the next guide point there.
    const point = this.snapVector(this.dropPoint(event));
    this.splinePoints.push(point);
    this.selectedHandle = this.splinePoints.length - 1;
    this.rebuildSplineVisuals();
    this.regenerateFromSpline();
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
      if (!this.active || !this.pendingDef) return;
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

    if (this.splineMode) {
      this.onSplinePointerDown(event);
      return;
    }

    const id = this.pieceIdAt(event);
    this.select(id, event.shiftKey);
    if (!id || !this.selectedIds.includes(id)) return;

    const position = this.positionOf(id);
    if (!position) return;
    const grabbed = this.dropPoint(event);

    const startPositions = new Map<string, Vector3>();
    for (const selectedId of this.selectedIds) {
      const start = this.positionOf(selectedId);
      if (start) startPositions.set(selectedId, start);
    }

    const piece = this.findPiece(id);
    this.drag = {
      id,
      vertical: event.altKey,
      planeY: position.y,
      grabOffset: position.clone().sub(grabbed),
      startPositions,
      // Socket snap applies to a single dragged ramp; a group drag or a
      // platform/fixture drag is pure translation.
      socketTargets:
        this.selectedIds.length === 1 && piece && piece.def !== 'platform'
          ? this.collectSocketTargets(new Set(this.selectedIds))
          : [],
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

    if (this.splineDrag) {
      this.moveSplineHandle(event);
      return;
    }

    if (!this.drag) return;
    const primaryStart = this.drag.startPositions.get(this.drag.id);
    if (!primaryStart) return;

    let primaryTarget: Vector3 | null = null;

    if (this.drag.vertical) {
      // Screen-space vertical drag. Distance-independent on purpose: the
      // alternative — scaling by depth so the piece tracks the cursor exactly —
      // makes the same wrist movement worth 2 units up close and 60 far away,
      // and a map is built from both distances.
      const current = this.positionOf(this.drag.id);
      if (!current) return;
      current.y -= event.movementY * VERTICAL_DRAG_SCALE;
      primaryTarget = this.snapVector(current);
    } else {
      // Horizontal drag: intersect the ray with the plane the piece was grabbed
      // on, so it slides at its own height rather than sinking toward whatever
      // is under the cursor.
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
      primaryTarget = this.snapVector(point);
    }

    // Socket snap: a lone ramp near a compatible socket clicks onto it,
    // adopting the neighbour's exit heading so the chain stays tangent.
    if (this.drag.socketTargets.length > 0 && this.snapEnabled) {
      const piece = this.findPiece(this.drag.id);
      if (piece) {
        const snapped = this.trySocketSnap(piece, primaryTarget, this.drag.socketTargets);
        if (snapped) {
          primaryTarget = snapped.position;
          if (piece.yawDeg !== snapped.yawDeg) {
            piece.yawDeg = snapped.yawDeg;
          }
        }
      }
    }

    const delta = primaryTarget.clone().sub(primaryStart);
    for (const [selectedId, start] of this.drag.startPositions) {
      this.setPosition(selectedId, start.clone().add(delta));
    }
  }

  private moveSplineHandle(event: PointerEvent): void {
    const drag = this.splineDrag!;
    const point = this.splinePoints[drag.index];
    if (!point) return;

    if (drag.vertical) {
      point.y -= event.movementY * VERTICAL_DRAG_SCALE;
    } else {
      this.setPointer(event);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const ray = this.raycaster.ray;
      if (Math.abs(ray.direction.y) < 1e-4) return;
      const t = (drag.planeY - ray.origin.y) / ray.direction.y;
      if (t <= 0) return;
      const hit = ray.origin.clone().addScaledVector(ray.direction, t).add(drag.grabOffset);
      hit.y = drag.planeY;
      point.copy(this.snapVector(hit));
    }
    drag.moved = true;

    // Cheap live feedback: move the handle and redraw the line, but leave the
    // (heavier) regeneration for pointerup.
    const handle = this.splineHandles[drag.index];
    if (handle) handle.position.copy(point);
    if (this.splineLine && this.splinePoints.length >= 2) {
      const curve = new CatmullRomCurve3(this.splinePoints, false, 'catmullrom', 0.5);
      this.splineLine.geometry.dispose();
      this.splineLine.geometry = new BufferGeometry().setFromPoints(
        curve.getPoints(this.splinePoints.length * 24),
      );
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.button === 2) this.looking = false;
    if (event.button === 0) {
      this.drag = null;
      if (this.splineDrag) {
        const moved = this.splineDrag.moved;
        this.splineDrag = null;
        if (moved) this.regenerateFromSpline();
      }
    }
    if (this.canvas.hasPointerCapture?.(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.active) return;
    // Never steal keys from a text field. Shared with `InputSystem` rather than
    // re-tested here: the local version only knew about `INPUT`, so typing into
    // the share panel's textarea flew the camera with every W/A/S/D.
    if (isTextEntryTarget(event.target)) return;

    this.keys.add(event.code);

    if (this.splineMode) {
      switch (event.code) {
        case 'KeyP':
          this.setSplineMode(false);
          return;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          this.deleteSelectedSplinePoint();
          return;
        default:
          return;
      }
    }

    switch (event.code) {
      case 'KeyP':
        this.setSplineMode(true);
        break;
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
          if (piece.yawSweepDeg !== undefined) piece.yawSweepDeg = -piece.yawSweepDeg;
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
