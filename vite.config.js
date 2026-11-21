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
        // Split the Supabase SDK into its own vendor chunk: it changes
        // rarely, so repeat visits (especially on mobile data) reuse the
        // cached vendor file and only re-download the app code.
        manualChunks: {
          supabase: ['@supabase/supabase-js']
        }
      }
    }
  },
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node'
  }
});
