import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  // Some wallet/SDK deps reference Node's `global` at module scope. esm.sh
  // shimmed this for the vanilla app; a bundler must do it explicitly or the
  // whole module graph dies with "global is not defined" at load.
  define: { global: 'globalThis' },

  resolve: {
    alias: {
      // Node resolves a bare `buffer` import to the BUILT-IN node:buffer, while a
      // browser bundle resolves it to the npm `buffer` package. If Vitest tested
      // the built-in, the golden vectors would not be exercising the code the
      // browser actually runs — which is exactly the substitution they exist to
      // catch. Pin both to the npm package.
      buffer: 'buffer/index.js',
    },
  },

  build: {
    // otc.html is the ONE entry — the desk is the whole app. hero.html /
    // hero.js / styles.css / intent.css / the config scripts live in public/ and
    // are copied verbatim, never bundled, so the hand-written landing keeps
    // shipping exactly as it does today.
    rollupOptions: { input: ['otc.html'] },

    // Vite's modulepreload polyfill is the one inline <script> it would emit.
    // vercel.json's CSP has no 'unsafe-inline' and must never gain one — an
    // injected script could rewrite a swap before the wallet prompt.
    modulePreload: { polyfill: false },
  },

  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
