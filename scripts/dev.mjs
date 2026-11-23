import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: false,
  external: ['electron', 'electron-updater'],
};

async function bundle() {
  await build({ ...shared, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js' });
  await build({ ...shared, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js' });
}

await bundle();

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = `http://localhost:${server.config.server.port}`;
server.printUrls();

const child = spawn(electronBinary, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' },
});

child.on('close', async () => {
  await server.close();
  process.exit(0);
});
