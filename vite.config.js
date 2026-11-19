import { defineConfig } from 'vite';

// Relative base so the built site works on GitHub Pages project sites
// (https://<user>.github.io/MeetBook/) as well as at a domain root.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200
  },
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node'
  }
});
