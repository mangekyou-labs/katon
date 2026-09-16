import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'apps/solana-web',
  plugins: [react()],
  resolve: { alias: { global: 'globalThis' } },
  server: { proxy: { '/v1': 'http://localhost:8787' } },
  build: { outDir: '../../dist/solana-web', emptyOutDir: true, modulePreload: { polyfill: false } },
});
