import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Own entry for the theme preview. Run from this folder: `pnpm exec vite`.
// It reads the design system from ../src/theme and the theme plugins from ../../plugins/themes.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1430, strictPort: false, fs: { allow: [repoRoot] } },
  build: { target: 'safari15', outDir: 'dist', emptyOutDir: true },
});
