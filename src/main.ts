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

const game = new Game(scene, camera, course.stages, course.spawnPoint, course.spawnYawDeg);

const input = new InputSystem(canvas);
const requestStart = () => {
  if (!input.isLocked()) input.requestPointerLock();
};
canvas.addEventListener('click', requestStart);
startOverlay.addEventListener('click', requestStart);
document.addEventListener('pointerlockchange', () => {
  startOverlay.classList.toggle('hidden', input.isLocked());
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const loop = new FixedStepLoop();

function frame(nowMs: number): void {
  loop.step(nowMs / 1000, (dt) => game.tick(dt, input.consumeFrame()));
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
