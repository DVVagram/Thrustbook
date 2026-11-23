import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const projectRoot = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'thrustbook-archive-test-'));
const bundlePath = path.join(tempRoot, 'archive-test.cjs');

try {
  await build({
    entryPoints: [path.join(projectRoot, 'tests', 'archive-electron.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: bundlePath,
    logLevel: 'silent',
  });

  const outcome = await new Promise((resolve) => {
    const child = spawn(electronPath, [bundlePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        THRUSTBOOK_WORKSPACE: 'examples',
        THRUSTBOOK_EXAMPLES_ROOT: path.join(tempRoot, 'examples'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(outcome.code, 0, `archive round trip failed:\n${outcome.stdout}\n${outcome.stderr}`);
  assert.match(outcome.stdout, /ARCHIVE_ROUNDTRIP_OK/, `archive round trip produced no result:\n${outcome.stdout}\n${outcome.stderr}`);
  console.log('Project archive test passed: saved keyframe sets survive export and import with their measurements.');
} catch (error) {
  console.error(`Project archive test failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch {
    /* a locked temporary bundle must not turn a passing test into a failure */
  }
}
