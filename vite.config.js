import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  css: { postcss: './postcss.config.js' },
  base: './',
  build: {
    outDir: 'out/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html') }
    },
    assetsDir: 'assets',
    sourcemap: false,
    minify: 'esbuild'
  }
});
