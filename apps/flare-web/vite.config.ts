import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'apps/flare-web',
  plugins: [react()],
  define: { global: 'globalThis' },
  build: {
    outDir: '../../dist/flare-web',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
  },
});
