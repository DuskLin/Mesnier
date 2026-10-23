import { build as bundle } from 'esbuild';
import { build as vite } from 'vite';
import react from '@vitejs/plugin-react';
await bundle({ entryPoints: ['apps/desktop/src/main/index.ts'], outfile: 'dist/main/index.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true });
await bundle({ entryPoints: ['apps/desktop/src/preload/index.ts'], outfile: 'dist/preload/index.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true });
await vite({ root: 'apps/desktop', base: './', plugins: [react()], build: { outDir: '../../dist/renderer', emptyOutDir: true } });
