import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'apps/base-web',
  plugins: [react()],
  build: {
    outDir: '../../dist/base-web',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
  },
});
