import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { FixedStepLoop } from './engine/Clock';
import { InputSystem } from './engine/Input';
import { Game } from './game/Game';
import { ViewModel } from './player/ViewModel';
import { buildSurfCourse } from './world/SurfCourse';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const startOverlay = document.getElementById('start-overlay')!;

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();
scene.background = new Color(0x9fc8e8);
scene.fog = new Fog(0x9fc8e8, 40, 220);

const camera = new PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);

scene.add(new AmbientLight(0xffffff, 0.55));
const sun = new DirectionalLight(0xffffff, 1.1);
sun.position.set(40, 60, 20);
scene.add(sun);

const course = buildSurfCourse();
scene.add(course.group);

// The viewmodel lives in its own scene with its own camera; see ViewModel for
// why. `main` owns it because `main` owns the renderer and therefore the pass
// order — `Game` only drives its animation.
const viewModel = new ViewModel();

const game = new Game(scene, camera, course, viewModel);
// The start overlay is up until the first click, so begin suspended rather than
// simulating a run the user can't yet control.
game.setPaused(true);

const input = new InputSystem(canvas);
const requestStart = () => {
  if (!input.isLocked()) input.requestPointerLock();
};
canvas.addEventListener('click', requestStart);
startOverlay.addEventListener('click', requestStart);
document.addEventListener('pointerlockchange', () => {
  const locked = input.isLocked();
  // Never surface "click to start" on top of a game-over or victory panel.
  startOverlay.classList.toggle('hidden', locked || game.isMenuOpen);
  // Don't simulate while the user isn't holding the controls — otherwise drones
  // keep spawning and the player slides off a ramp behind the start overlay.
  game.setPaused(!locked);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  viewModel.resize(window.innerWidth, window.innerHeight);
});

const loop = new FixedStepLoop();

// The viewmodel pass composites on top of the finished world image, so the
// renderer must stop clearing between the two `render` calls — hence the manual
// clear at the top of each frame.
renderer.autoClear = false;

function frame(nowMs: number): void {
  loop.step(nowMs / 1000, (dt) => game.tick(dt, input.consumeFrame()));
  // Game-over and victory are the only panels the player must click, so the
  // cursor is handed back the moment one appears. Without this the pointer stays
  // locked, the cursor stays hidden, every click goes to the canvas, and the
  // restart button is unreachable — the run would simply dead-end.
  if (game.isMenuOpen && input.isLocked()) input.releasePointerLock();

  renderer.clear();
  renderer.render(scene, camera);
  // Second pass over a wiped depth buffer: the knife is always in front of the
  // level, so riding with your shoulder against a ramp can never saw it in
  // half. Only in first person — in third person the player is looking at
  // themselves from five units back and a pair of floating fists makes no sense.
  if (game.cameraRig.mode === 'first') {
    renderer.clearDepth();
    renderer.render(viewModel.scene, viewModel.camera);
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
