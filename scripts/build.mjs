import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'info',
  external: ['electron', 'electron-updater', 'onnxruntime-node'],
};

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

await build({ ...shared, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js' });
await build({ ...shared, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js' });

console.log('main + preload built');
