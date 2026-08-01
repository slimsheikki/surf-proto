import { defineConfig } from 'vite';

/**
 * `base` has to match wherever the built site is served from. GitHub Pages
 * serves a project site under /<repo>/, so production builds default to that;
 * the dev server stays at the root. Override with BASE_PATH=/ when deploying
 * somewhere that serves from the domain root (Netlify, Vercel, a plain static
 * host) — otherwise every asset URL gets the /surf-proto/ prefix and 404s.
 */
export default defineConfig(({ command }) => ({
  root: '.',
  base: process.env.BASE_PATH ?? (command === 'build' ? '/surf-proto/' : '/'),
  server: {
    host: true,
  },
}));
