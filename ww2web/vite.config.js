import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const srcDir = fileURLToPath(new URL('./src', import.meta.url));

// The dashboard is served by the existing Express service from `/frontend/`.
// `HashRouter` means every client route lives behind `#/`, so only one HTML
// shell is ever requested and the server needs no history fallback.
export default defineConfig({
  base: '/frontend/',
  plugins: [react()],
  define: {
    __UI_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
    __UI_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: { '@': srcDir },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    // Dev convenience only: talk to a locally running gateway. The production
    // build is served by that gateway, so no proxy is needed then.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});
