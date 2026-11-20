import { defineConfig } from 'vite';

// Relative base so the built site works on GitHub Pages project sites
// (https://<user>.github.io/MeetBook/) as well as at a domain root.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Split the Firebase SDK into its own vendor chunk: it changes
        // rarely, so repeat visits (especially on mobile data) reuse the
        // cached vendor file and only re-download the app code.
        manualChunks: {
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/storage']
        }
      }
    }
  },
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node'
  }
});
