import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  Group,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { MusicManager } from '../audio/MusicManager';
import { FixedStepLoop } from '../engine/Clock';
import { disposeObject } from '../engine/Dispose';
import { InputSystem, isTextEntryTarget } from '../engine/Input';
import { Editor } from '../editor/Editor';
import { EditorUi } from '../editor/EditorUi';
import { buildFreeWorld } from '../editor/FreeCourse';
import { clearMapCodeFromLocation, decodeMapCode, mapCodeFromLocation } from '../editor/MapCode';
import { createStarterMap, FreeMap } from '../editor/MapData';
import { lastMapName, loadMap, rememberLastMap, uniqueMapName } from '../editor/MapStorage';
import { Game, GameCourse } from '../game/Game';
import { ViewModel } from '../player/ViewModel';
import { mountLogo } from '../ui/Logo';
import { MainMenu } from '../ui/MainMenu';
import { PauseMenu } from '../ui/PauseMenu';
import { renderWorldThumbnail } from '../ui/MapThumbnails';
import { SettingsPanel } from '../ui/SettingsPanel';
import { getSettings, loadSettings, onSettingsChanged, setMusicMuted } from '../game/Settings';
import { MOVEMENT_VERSION_LABEL } from '../player/MovementVersion';
import { buildSkyDome, SKY_HORIZON_COLOR } from '../world/Sky';
import { buildSurfCourse } from '../world/SurfCourse';
import { clearColliders } from '../world/Colliders';

/**
 * Fog and clear colour match the painted dome's horizon, so distant geometry
 * fades into the *sky's* colour rather than a mismatched flat blue.
 */
const SKY_COLOR = SKY_HORIZON_COLOR;

/**
 * How long a resume keeps asking for the pointer lock back, and how often.
 *
 * Chrome refuses a re-lock for about a second after the *user* escaped out of
 * one — and "Escape to pause, Escape to resume" is always well inside that
 * window. The refusal is temporary, so the resume waits it out rather than
 * treating it as a failure; 3 s is several times the observed cooldown, and the
 * poll is short enough that the run picks up the instant the browser relents.
 */
const RELOCK_WINDOW_MS = 3000;
const RELOCK_RETRY_MS = 120;

/** Menu backdrop orbit: slow enough to read as a held shot rather than a spin. */
const MENU_ORBIT_RADIUS = 165;
const MENU_ORBIT_HEIGHT = 95;
const MENU_ORBIT_SPEED = 0.06;
const MENU_LOOK_AT = new Vector3(0, -6, 0);

/**
 * Where the app is. `play` covers both game modes — what differs between them
 * is only which course is loaded and where `M` goes back to.
 */
type AppMode = 'menu' | 'editor' | 'play';

/**
 * Which course a run is on, and therefore where `M` goes back to. Named here
 * rather than imported from the menu now that the menu has three items and no
 * longer describes a "mode" at all.
 */
type PlayMode = 'standard' | 'free';

/**
 * Composition root above `Game`: owns the renderer, the scene, and the one
 * camera everything borrows, and switches between the main menu, the free-mode
 * editor, and a run.
 *
 * `Game` is constructed at most once and re-pointed with `setCourse`, never
 * rebuilt. That is a hard requirement rather than an optimisation: the terminal
 * screens bind their restart handlers in their constructors, so a second `Game`
 * would leave two listeners on the same button and every restart would run
 * twice.
 */
export class App {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly viewModel = new ViewModel();
  private readonly input: InputSystem;
  private readonly loop = new FixedStepLoop();
  private readonly mainMenu = new MainMenu();
  /**
   * Background music. Owned here rather than by `Game` because it outlives a
   * run: the menu and the editor have a bed too, and the manager is what knows
   * which track played last so the next run can avoid repeating it.
   */
  private readonly music = new MusicManager();
  /**
   * Field of view, sensitivity, and music volume, on `Escape`, and the run's
   * pause screen — see `SettingsPanel` for why those have to be the same thing.
   * It also hosts the movement tuning bench under Advanced Settings, which is
   * why there is no separate movement panel here any more.
   */
  private readonly settingsPanel = new SettingsPanel(() => this.closeSettings(), {
    isMuted: () => this.music.isMuted,
    // Through the manager, then persisted from what it settled on — one owner
    // of the live state, one place it is written down.
    toggleMute: () => setMusicMuted(this.music.toggleMute()),
  });
  /** Mid-run `Escape`: Continue / Restart / Settings / Quit. */
  private readonly pauseMenu = new PauseMenu();
  /**
   * Whether the settings screen was opened *from* the pause menu, and so should
   * hand back to it rather than straight to the game.
   *
   * Without this, `O` pressed mid-flight to nudge a convar would dump the
   * player back into the pause menu they never opened, and `Settings` reached
   * from the pause menu would silently resume the run on close. The two entry
   * points want different exits.
   */
  private settingsFromPause = false;
  /**
   * Whether the player has taken pointer lock at least once this run.
   *
   * It decides which screen a *loss* of pointer lock produces: before the first
   * lock the player has not started yet and wants "click to start"; after it,
   * losing the lock means they pressed Escape (or tabbed away), and the right
   * answer is the settings/pause screen.
   */
  private hasStartedRun = false;
  /**
   * When a resume in progress gives up, as `performance.now()` milliseconds.
   * Zero when no resume is pending — see `resumeRun`.
   */
  private relockUntilMs = 0;
  /** The pending retry, so a screen change can cancel it. */
  private relockTimer: number | null = null;
  /**
   * Distance fog, applied only while a run is in progress.
   *
   * During play it is part of the look and part of the read — it tells the
   * player which ramp is the next one. In the editor it is actively harmful:
   * anything past 220 units fades into the sky, so a map long enough to need
   * the overview would disappear exactly when the player pulled back to see it.
   */
  private readonly playFog = new Fog(SKY_COLOR, 40, 220);
  private readonly skyDome: ReturnType<typeof buildSkyDome>;

  private readonly startOverlay = document.getElementById('start-overlay')!;
  private readonly hudEl = document.getElementById('hud')!;

  private mode: AppMode = 'menu';
  /** Which mode a run belongs to — decides whether `M` goes to the menu or back to the editor. */
  private playMode: PlayMode = 'standard';

  private game: Game | null = null;
  /** The world currently in the scene. Owned here, disposed on every swap. */
  private world: Group | null = null;

  private editor: Editor | null = null;
  private editorUi: EditorUi | null = null;

  private lastFrameSeconds: number | null = null;
  private menuElapsed = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // The viewmodel pass composites on top of the finished world image, so the
    // renderer must stop clearing between the two `render` calls.
    this.renderer.autoClear = false;

    this.scene.background = new Color(SKY_COLOR);
    // The painted sky. Mesh-only (no collider), fog-exempt, re-centred on the
    // camera every frame in `frame()` — a skybox, not a place.
    this.skyDome = buildSkyDome();
    this.scene.add(this.skyDome);
    this.scene.add(new AmbientLight(0xffffff, 0.55));
    const sun = new DirectionalLight(0xffffff, 1.1);
    sun.position.set(40, 60, 20);
    this.scene.add(sun);

    // Far plane well past the ring's 220-unit fog wall, because free maps are
    // not bounded by it: a player can lay ramps out over hundreds of units and
    // the editor has to be able to pull back far enough to see all of them.
    this.camera = new PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
    this.input = new InputSystem(canvas);

    document.getElementById('movement-tag')!.textContent = MOVEMENT_VERSION_LABEL;
    // The start screen's wordmark. Mounted at boot rather than when the overlay
    // first shows, so the image is decoded and turning by the time a run opens
    // on it instead of popping in a frame late.
    mountLogo(
      document.getElementById('start-logo-img') as HTMLImageElement,
      document.getElementById('start-logo-fallback')!,
    );
    // Camera FOV follows the setting, including the one restored from storage
    // by `loadSettings` below — which is why the listener is registered first.
    onSettingsChanged(({ fov, musicVolume, musicMuted }) => {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
      // Pushed rather than pulled, so the stored volume reaches the manager on
      // the `loadSettings` call below without the audio having to start first.
      this.music.setVolume(musicVolume);
      this.music.setMuted(musicMuted);
    });
    loadSettings();
    this.camera.fov = getSettings().fov;
    this.camera.updateProjectionMatrix();
    this.installListeners();
    const standard = this.loadStandardWorld();
    // Photographed here and nowhere else. This is the only moment the standard
    // course is guaranteed to be live: `setWorld` disposes whatever it replaces,
    // so a reference kept for a lazy render would be pointing at freed geometry
    // the first time the player visited the editor. One small render at boot
    // buys a tile that is always correct. `this.world` is what
    // `loadStandardWorld` just installed.
    const standardShot = this.world
      ? renderWorldThumbnail(this.world, {
          center: standard.islandCenter.clone().setY(standard.trackY),
          // The ring plus a margin. Fitting the whole course instead would frame
          // the approach, which starts 600 units out and shrinks the ring to a dot.
          radius: standard.trackRadius * 1.5,
        })
      : null;
    this.mainMenu.setStandardThumbnailSource(() => standardShot);
    void this.bootFromUrl();
  }

  /**
   * Opens the main menu, or — if the page was opened from a share link — the
   * editor with that map already loaded.
   *
   * Async because decoding is: `DecompressionStream` is stream-based. The menu
   * is not shown first and then replaced, because a menu that appears and then
   * yanks itself away reads as a bug; the decode is fast enough that the extra
   * frames before either appears are invisible.
   */
  private async bootFromUrl(): Promise<void> {
    const code = mapCodeFromLocation();
    if (!code) {
      this.openMenu();
      return;
    }

    const map = await decodeMapCode(code);
    // Dropped whether or not the decode worked: a bad code should not survive a
    // refresh either, and a good one must not silently revert the recipient's
    // edits the next time they reload.
    clearMapCodeFromLocation();

    if (!map) {
      this.openMenu();
      return;
    }
    // Renamed before it reaches the editor, so the name in the field is the one
    // Save will actually use rather than something quietly changed underneath.
    map.name = uniqueMapName(map.name);
    this.openEditor(map);
  }

  start(): void {
    requestAnimationFrame((now) => this.frame(now));
  }

  // ------------------------------------------------------------- world swaps

  /**
   * Replaces the scene's world. Every path that changes what is collidable goes
   * through here, because the collider registry is a module-level singleton
   * with no per-object removal — the only correct way to unload a world is to
   * clear the whole registry and rebuild.
   */
  private setWorld(group: Group, disposeOld = true): void {
    if (this.world) {
      this.scene.remove(this.world);
      // The editor's root is long-lived and reused across visits, so it is
      // detached rather than destroyed.
      if (disposeOld) disposeObject(this.world);
    }
    this.world = group;
    this.scene.add(group);
  }

  private loadStandardWorld(): GameCourse {
    clearColliders();
    const course = buildSurfCourse();
    this.setWorld(course.group, this.world !== this.editor?.root);
    return course;
  }

  private loadFreeWorld(map: FreeMap): GameCourse {
    clearColliders();
    const built = buildFreeWorld(map, true);
    this.setWorld(built.group, this.world !== this.editor?.root);
    return built.course;
  }

  // -------------------------------------------------------------- mode: menu

  private openMenu(): void {
    this.mode = 'menu';
    this.menuElapsed = 0;
    this.pauseMenu.hide();
    this.settingsPanel.hide();
    this.input.releasePointerLock();
    this.editorUi?.hide();
    this.editor?.exit();
    this.startOverlay.classList.add('hidden');
    this.hudEl.classList.add('hidden');
    this.game?.setHudVisible(false);
    this.game?.setRunVisible(false);
    this.scene.fog = null;
    // Crossfades whatever the run was playing out underneath it. At boot this
    // is the one start that can be refused by autoplay policy — the manager
    // re-arms on the first click or keypress, which is the same gesture that
    // picks a menu entry, so the menu is silent for at most a beat.
    this.music.playMenuMusic();
    this.mainMenu.show({
      onStandard: () => this.startStandardRun(),
      onEditor: () => this.openEditor(),
      onSettings: () => this.settingsPanel.show('back'),
      onFreeMap: (map) => this.startMapRun(map),
    });
  }

  /**
   * Plays a saved map straight from the menu, without a trip through the
   * editor. The editor is still handed the map, because leaving a free run with
   * `M` goes *back to the editor* — arriving there on a different map than the
   * one just played would be baffling.
   */
  private startMapRun(map: FreeMap): void {
    rememberLastMap(map.name);
    this.editor?.setMap(map);
    const course = this.loadFreeWorld(map);
    this.playMode = 'free';
    this.beginRun(course);
  }

  // ------------------------------------------------------------ mode: editor

  /** `map` is supplied when arriving from a share link; otherwise the editor keeps whatever it had. */
  private openEditor(map?: FreeMap): void {
    this.mode = 'editor';
    this.input.releasePointerLock();
    this.startOverlay.classList.add('hidden');
    this.hudEl.classList.add('hidden');
    this.game?.setHudVisible(false);
    this.game?.setRunVisible(false);
    this.scene.fog = null;
    // The editor keeps the menu bed rather than falling silent: arriving from a
    // scored menu into nothing reads as the audio having broken. Coming back
    // from a playtest this is a no-op if the same track is already up.
    this.music.playMenuMusic();

    if (!this.editor) {
      this.editor = new Editor(this.canvas, this.camera, this.initialMap(), {
        onChange: () => this.editorUi?.refresh(),
      });
      this.editorUi = new EditorUi(this.editor, {
        onPlay: () => this.startFreeRun(),
        onExitToMenu: () => this.openMenu(),
        onNewMap: () => this.editor?.setMap(createStarterMap()),
      });
    }

    // Applied before `show`, so the toolbar's name field picks up the imported
    // name rather than the one the editor was constructed with.
    if (map) this.editor.setMap(map);

    // The editor world carries no colliders, so nothing needs clearing here —
    // the registry is wiped again the moment a map is handed over to be played.
    this.setWorld(this.editor.root, this.world !== this.editor.root);
    this.editor.enter();
    this.editorUi!.show();
    if (map) this.editorUi!.flashImported(map.name);
  }

  /** The last map the player worked on, or a generated starter the first time through. */
  private initialMap(): FreeMap {
    const name = lastMapName();
    if (name) {
      const saved = loadMap(name);
      if (saved) return saved;
    }
    return createStarterMap();
  }

  // -------------------------------------------------------------- mode: play

  private startStandardRun(): void {
    const course = this.loadStandardWorld();
    this.playMode = 'standard';
    this.beginRun(course);
  }

  private startFreeRun(): void {
    if (!this.editor) return;
    const map = this.editor.getMap();
    rememberLastMap(map.name);
    this.editor.exit();
    this.editorUi?.hide();
    const course = this.loadFreeWorld(map);
    this.playMode = 'free';
    this.beginRun(course);
  }

  private beginRun(course: GameCourse): void {
    this.mode = 'play';
    this.hudEl.classList.remove('hidden');
    this.scene.fog = this.playFog;

    if (!this.game) {
      this.game = new Game(this.scene, this.camera, course, this.viewModel, {
        // Every fresh run draws a new track, and a restart off the game-over
        // screen is a fresh run — `Game` restarts itself from there without
        // coming back through here, so the hook is the only place that sees it.
        onRunStart: () => this.music.playGameplayMusic(),
      });
      // The constructor does not go through `restart`, so the first run of the
      // session is started here; every later one arrives via `setCourse` below.
      this.music.playGameplayMusic();
      // Dev-only handle on the live run, for driving the game from a headless
      // browser: the late game is gated behind ten levels and a 2200 HP boss,
      // which no scripted input can reach in reasonable time, so without this
      // the endless-run code path is untestable outside of playing it. Vite
      // constant-folds `import.meta.env.DEV` to false and drops the branch from
      // the production bundle.
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__surf = this.game;
      }
    } else {
      this.game.setCourse(course);
    }
    // After the Game exists: the crosshair and the ultimate arc live outside
    // `#hud` (they are centre-screen) and it owns them. Held back until the
    // click that takes pointer lock — they are aiming aids for a run that has
    // not started, and dead centre is where the start screen's own prompt is.
    // The `pointerlockchange` handler is what brings them in.
    this.game.setHudVisible(false);
    // The HUD follows pointer lock, but the player's body follows the *mode*:
    // it has to be back the moment the course is on screen, start overlay or
    // not, or the third-person camera opens the run pointed at nothing.
    this.game.setRunVisible(true);
    // Suspended until the click that takes pointer lock, so drones don't spawn
    // and the player doesn't slide off a ramp behind the start overlay.
    this.game.setPaused(true);
    this.hasStartedRun = false;
    this.cancelResume();
    this.settingsPanel.hide();
    this.pauseMenu.hide();
    this.startOverlay.classList.remove('hidden');
  }

  /**
   * Back into the run: takes the pointer lock, and keeps asking for it while
   * the browser refuses.
   *
   * Every way back into a run goes through here rather than calling
   * `requestPointerLock` directly, because they all share one problem. Chrome
   * will not re-lock for about a second after the user escaped out of a lock,
   * and *every* one of these paths begins with exactly that: Escape opened the
   * screen the player is now dismissing. A single attempt lands inside the
   * cooldown and fails, and the old handler read that failure as "the player is
   * stuck on a paused world, put the panel back" — so pressing Escape to leave
   * the pause menu appeared to reopen it. It is a wait, not a failure.
   */
  private resumeRun(): void {
    this.relockUntilMs = performance.now() + RELOCK_WINDOW_MS;
    this.attemptLock();
  }

  private attemptLock(): void {
    this.relockTimer = null;
    // A retry outlives the moment it was scheduled in, so it re-checks that the
    // run is still what is on screen. Without this a resume left over from a
    // dismissed pause menu could snatch the lock back out from under the
    // settings panel the player opened instead.
    if (
      this.mode !== 'play' ||
      this.settingsPanel.isOpen ||
      this.pauseMenu.isOpen ||
      this.game?.isMenuOpen
    ) {
      this.cancelResume();
      return;
    }
    this.input.requestPointerLock();
  }

  private cancelResume(): void {
    this.relockUntilMs = 0;
    if (this.relockTimer !== null) {
      window.clearTimeout(this.relockTimer);
      this.relockTimer = null;
    }
  }

  /**
   * The resume ran out of patience. Whatever is wrong is no longer a cooldown,
   * so the player gets a screen with a way back in rather than a frozen world
   * and no prompt — which one depends on whether the run has started.
   */
  private abandonResume(): void {
    this.cancelResume();
    if (this.hasStartedRun) this.openPauseMenu();
    else this.startOverlay.classList.remove('hidden');
  }

  private openPauseMenu(): void {
    this.cancelResume();
    this.pauseMenu.show({
      onContinue: () => this.resumeRun(),
      onRestart: () => {
        this.game?.restartRun();
        this.resumeRun();
      },
      // Always the front menu, even for a free-mode run. `M` is the one that
      // goes back to the editor, because that is the useful exit while you are
      // iterating on a map; Quit is the one that leaves.
      onQuit: () => this.openMenu(),
      onSettings: () => {
        // Plain — no Advanced. `O` is the shortcut that expands it, and a menu
        // item that dumped a player into a wall of convars would be the wrong
        // first thing to show someone who only wants their FOV back.
        this.settingsFromPause = true;
        this.settingsPanel.show('back');
      },
    });
  }

  private closeSettings(): void {
    this.settingsPanel.hide();
    // Back where it came from: the pause menu if that is where it was opened,
    // otherwise straight into the run.
    if (this.settingsFromPause && this.mode === 'play') {
      this.settingsFromPause = false;
      this.openPauseMenu();
      return;
    }
    if (this.mode === 'play') this.resumeRun();
  }

  /** `M` during a run: back to wherever the run came from. */
  private leaveRun(): void {
    if (this.mode !== 'play') return;
    this.hasStartedRun = false;
    this.cancelResume();
    this.settingsPanel.hide();
    this.pauseMenu.hide();
    this.game?.setPaused(true);
    this.input.releasePointerLock();
    if (this.playMode === 'free') this.openEditor();
    else this.openMenu();
  }

  // ---------------------------------------------------------------- listeners

  private installListeners(): void {
    const requestStart = () => {
      if (this.mode === 'play' && !this.input.isLocked()) this.resumeRun();
    };
    this.canvas.addEventListener('click', requestStart);
    this.startOverlay.addEventListener('click', requestStart);

    // A refused lock is the cooldown far more often than it is a real failure,
    // so it costs the resume a retry rather than the player their run. Only
    // once the window has run out does the panel come back — being left staring
    // at a paused world with no prompt on it is the thing that must not happen.
    document.addEventListener('pointerlockerror', () => {
      if (this.mode !== 'play' || this.input.isLocked()) return;
      if (this.game?.isMenuOpen || this.settingsPanel.isOpen) return;
      if (performance.now() < this.relockUntilMs) {
        this.relockTimer = window.setTimeout(() => this.attemptLock(), RELOCK_RETRY_MS);
        return;
      }
      this.abandonResume();
    });

    document.addEventListener('pointerlockchange', () => {
      if (this.mode !== 'play') return;
      const locked = this.input.isLocked();
      if (locked) {
        this.cancelResume();
        this.hasStartedRun = true;
        this.settingsPanel.hide();
        this.pauseMenu.hide();
      } else if (this.hasStartedRun && this.game?.isKeyboardOverlayOpen) {
        // Escape landed on a power screen. The sim is already frozen and the
        // screen is picked with number keys, so take the lock straight back
        // instead of opening a pause menu — whose digit listener is gated only
        // on "am I open", exactly like the screen underneath it, so `1` would
        // fire both of them.
        this.resumeRun();
      } else if (this.hasStartedRun && !this.game?.isMenuOpen && !this.settingsPanel.isOpen) {
        // This is the Escape path. Under pointer lock the browser consumes the
        // Escape keydown and only releases the lock, so a key handler can never
        // see it — but this event always fires, and the pause it already caused
        // now has a menu on it.
        this.openPauseMenu();
      }
      // Never surface "click to start" on top of another panel.
      this.startOverlay.classList.toggle(
        'hidden',
        locked ||
          !!this.game?.isMenuOpen ||
          !!this.game?.isKeyboardOverlayOpen ||
          this.settingsPanel.isOpen ||
          this.pauseMenu.isOpen,
      );
      // Crosshair and ultimate arc follow the lock: they only mean anything
      // while the sim is running, and they sit exactly where the start screen
      // puts "Click to start".
      this.game?.setHudVisible(locked);
      this.game?.setPaused(!locked);
    });

    window.addEventListener('keydown', (event) => {
      // The shared rule rather than a local INPUT-only check: the editor's
      // share panel is a <textarea>, and typing an `o` into a pasted map code
      // must not open the movement panel.
      if (isTextEntryTarget(event.target)) return;
      // `M` rather than `Escape` for leaving a run: Escape is what the browser
      // uses to drop pointer lock, and the keydown for it is not reliably
      // delivered to the page, so binding it here would work on some browsers
      // and silently do nothing on others.
      // `O` is the movement bench's old shortcut, kept because the tuning loop
      // runs on it. It now opens the settings screen with Advanced already
      // expanded rather than a second floating panel.
      if (event.code === 'KeyO' && this.mode !== 'editor') {
        event.preventDefault();
        this.settingsFromPause = this.pauseMenu.isOpen;
        this.pauseMenu.hide();
        // Resumes the run only when `O` was pressed while playing; from the
        // pause menu it goes back there, and the button has to say so.
        this.settingsPanel.show(
          this.mode === 'play' && !this.settingsFromPause ? 'resume' : 'back',
          true,
        );
        if (this.mode === 'play') this.input.releasePointerLock();
        this.startOverlay.classList.add('hidden');
        return;
      }
      if (event.code === 'Escape' && this.settingsPanel.isOpen) {
        event.preventDefault();
        // Only ever a *close*. In a run, the pause menu is opened by the
        // pointer-lock loss that this same keypress caused, one handler up; in
        // the front menu the Settings item opens it.
        this.closeSettings();
        return;
      }
      if (event.code === 'Escape' && this.pauseMenu.isOpen) {
        event.preventDefault();
        this.pauseMenu.continue();
        return;
      }
      // Escape again during the wait for the lock: the player has changed their
      // mind about resuming, and with no panel up there is nothing else for the
      // key to mean. Gives the menu straight back instead of making them sit
      // out the cooldown they are trying to cancel.
      if (event.code === 'Escape' && this.relockUntilMs > 0) {
        event.preventDefault();
        this.abandonResume();
        return;
      }
      if (event.code === 'KeyM' && this.mode === 'play') {
        event.preventDefault();
        this.leaveRun();
      } else if (event.code === 'Escape' && this.mode === 'editor') {
        event.preventDefault();
        this.openMenu();
      } else if (event.code === 'Enter' && this.mode === 'editor') {
        event.preventDefault();
        this.startFreeRun();
      }
    });

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.viewModel.resize(window.innerWidth, window.innerHeight);
    });
  }

  // -------------------------------------------------------------- frame loop

  private frame(nowMs: number): void {
    const now = nowMs / 1000;
    const renderDt = this.lastFrameSeconds === null ? 0 : Math.min(0.1, now - this.lastFrameSeconds);
    this.lastFrameSeconds = now;

    // Stepped every frame regardless of mode so the accumulator's clock stays
    // current; the callback is what is gated. Skipping the call entirely would
    // bank the whole time spent in the editor and burn it as a burst of ticks
    // on the first frame of the next run.
    this.loop.step(
      now,
      (dt) => {
        if (this.mode === 'play' && this.game) this.game.tick(dt, this.input.consumeFrame());
      },
      // Told up front how many ticks this frame will run so the frame's mouse
      // motion is split evenly across them instead of all landing on the first.
      (steps) => this.input.beginFrame(steps),
    );

    if (this.mode === 'play' && this.game) {
      // Game-over and victory are the only panels the player must click, so the
      // cursor is handed back the moment one appears — under pointer lock it is
      // hidden and every click goes to the canvas, so the restart button would
      // be unreachable and the run would dead-end.
      if (
        (this.game.isMenuOpen || this.settingsPanel.isOpen || this.pauseMenu.isOpen) &&
        this.input.isLocked()
      ) {
        this.input.releasePointerLock();
      }
    } else if (this.mode === 'editor') {
      this.editor?.update(renderDt);
    } else {
      this.updateMenuCamera(renderDt);
    }

    // Skybox behaviour: the dome travels with the camera, so it reads as
    // infinitely far and can never be reached, clipped into, or parallaxed.
    this.skyDome.position.copy(this.camera.position);

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    // Second pass over a wiped depth buffer: the knife is always in front of the
    // level, so riding with your shoulder against a ramp can never saw it in
    // half. First person only — in third person a pair of floating fists five
    // units from the player makes no sense.
    if (this.mode === 'play' && this.game?.cameraRig.mode === 'first') {
      this.renderer.clearDepth();
      this.renderer.render(this.viewModel.scene, this.viewModel.camera);
    }

    requestAnimationFrame((next) => this.frame(next));
  }

  private updateMenuCamera(dt: number): void {
    this.menuElapsed += dt;
    const angle = this.menuElapsed * MENU_ORBIT_SPEED;
    this.camera.position.set(
      Math.sin(angle) * MENU_ORBIT_RADIUS,
      MENU_ORBIT_HEIGHT,
      Math.cos(angle) * MENU_ORBIT_RADIUS,
    );
    this.camera.lookAt(MENU_LOOK_AT);
  }
}
