import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const temp = mkdtempSync(path.join(tmpdir(), 'thrustbook-motion-tests-'));
const entries = ['tests/motion.test.ts', 'tests/flow.test.ts'];

try {
  for (const entry of entries) {
    const outfile = path.join(temp, path.basename(entry).replace(/\.ts$/, '.mjs'));
    buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile,
      logLevel: 'warning',
    });
    const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: process.cwd() });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
