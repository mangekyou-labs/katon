// Buffer global for stellar-sdk internals that expect it ambiently. The npm
// `buffer` package is the same implementation esm.sh served the vanilla app;
// vite.config.ts pins the bare specifier to it so Vitest (Node) and the browser
// bundle resolve identically — the substitution the golden vectors guard.
// This import MUST stay first in main.tsx.

import { Buffer } from 'buffer';

globalThis.Buffer = globalThis.Buffer || Buffer;
