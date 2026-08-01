import { App } from './app/App';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
new App(canvas).start();
