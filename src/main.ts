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

const game = new Game(scene, camera, course);
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
});

const loop = new FixedStepLoop();

function frame(nowMs: number): void {
  loop.step(nowMs / 1000, (dt) => game.tick(dt, input.consumeFrame()));
  // Game-over and victory are the only panels the player must click, so the
  // cursor is handed back the moment one appears. Without this the pointer stays
  // locked, the cursor stays hidden, every click goes to the canvas, and the
  // restart button is unreachable — the run would simply dead-end.
  if (game.isMenuOpen && input.isLocked()) input.releasePointerLock();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
