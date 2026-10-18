import { defineConfig } from 'vite';

// Relative base so the same build works at https://<user>.github.io/<repo>/ and from any sub-path.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  server: { host: true },
});
