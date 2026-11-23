import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const projectRoot = process.cwd();
const opencvPath = path.join(projectRoot, 'node_modules', '@techstark', 'opencv-js', 'dist', 'opencv.js');
const workerPath = path.join(projectRoot, 'src', 'renderer', 'motion', 'tracker-worker.js');
const temp = mkdtempSync(path.join(tmpdir(), 'thrustbook-tracker-test-'));
const bundlePath = path.join(temp, 'tracker-harness.js');
const htmlPath = path.join(temp, 'index.html');
const mainPath = path.join(temp, 'main.cjs');
copyFileSync(workerPath, path.join(temp, 'tracker-worker.js'));

const assetPlugin = {
  name: 'asset-urls',
  setup(build) {
    build.onResolve({ filter: /tracker-worker\.js\?url$/ }, () => ({ path: 'worker', namespace: 'asset-url' }));
    build.onResolve({ filter: /opencv\.js\?url$/ }, () => ({ path: 'opencv', namespace: 'asset-url' }));
    build.onLoad({ filter: /.*/, namespace: 'asset-url' }, (args) => ({
      contents: `export default ${JSON.stringify(args.path === 'worker' ? '/tracker-worker.js' : '/opencv.js')};`,
      loader: 'js',
    }));
  },
};

try {
  await build({
    entryPoints: [path.join(projectRoot, 'tests', 'tracker-harness.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    outfile: bundlePath,
    plugins: [assetPlugin],
    logLevel: 'warning',
  });

  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'">
<title>Tracker harness</title></head>
<body style="background:#111;color:#ddd;font-family:monospace"><pre id="status">loading OpenCV in worker…</pre>
<script src="/tracker-harness.js"></script></body></html>`,
    'utf8',
  );

  writeFileSync(
    mainPath,
    `const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = ${JSON.stringify(temp)};
const opencv = ${JSON.stringify(opencvPath)};
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    console.error('[req]', req.url);
    const file = req.url === '/opencv.js' ? opencv : path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(root) && file !== opencv) { res.writeHead(403); res.end(); return; }
    try {
      const data = fs.readFileSync(file);
      const type = file.endsWith('.js') ? 'text/javascript' : 'text/html';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    } catch (err) { res.writeHead(404); res.end(String(err)); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const win = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { sandbox: false, contextIsolation: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => console.error('[renderer]', level, message));
  win.webContents.on('did-fail-load', (_e, code, description) => console.error('[load-failed]', code, description));
  win.webContents.on('render-process-gone', (_e, details) => console.error('[renderer-gone]', JSON.stringify(details)));
  const timeout = setTimeout(() => { console.error('TRACKER_MAIN_TIMEOUT'); app.exit(3); }, 240000);
  try {
    await win.loadURL('http://127.0.0.1:' + port + '/index.html');
    const deadline = Date.now() + 210000;
    let state = null;
    while (Date.now() < deadline) {
      const probe = win.webContents.executeJavaScript('JSON.stringify({done: !!window.__trackerDone, result: window.__trackerResult || null})');
      state = await Promise.race([probe, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('executeJavaScript timeout')), 20000))]);
      if (JSON.parse(state).done) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!state) throw new Error('No harness state');
    clearTimeout(timeout);
    console.log('TRACKER_JSON:' + state);
    app.exit(0);
  } catch (err) {
    clearTimeout(timeout);
    console.error('TRACKER_RUNNER_ERROR:' + (err && err.stack ? err.stack : String(err)));
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});`,
    'utf8',
  );

  const child = spawnSync(electronPath, [mainPath], {
    cwd: temp,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
    encoding: 'utf8',
    timeout: 260_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    process.stderr.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    throw new Error(`Tracker Electron process exited with status ${child.status}`);
  }
  const line = (child.stdout || '').split(/\r?\n/).find((entry) => entry.startsWith('TRACKER_JSON:'));
  if (!line) {
    process.stderr.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    throw new Error('Tracker harness produced no result');
  }
  const state = JSON.parse(line.slice('TRACKER_JSON:'.length));
  if (process.env.TRACKER_DEBUG) process.stderr.write(child.stderr || '');
  const result = state.result;
  if (result?.ok !== true) {
    console.error('TRACKER_STATE:' + JSON.stringify(state));
    process.stderr.write(child.stderr || '');
  }
  assert.equal(result?.ok, true, result?.error ?? 'tracker harness failed');
  console.log(JSON.stringify(result, null, 2));

  assert.ok(result.first.count >= 25, `translation tracking count was ${result.first.count}`);
  assert.ok(Math.abs(result.first.lastX - 176) <= 3, `translation last X was ${result.first.lastX}, expected ~176`);
  assert.ok(Math.abs(result.first.lastY - 120) <= 3, `translation last Y was ${result.first.lastY}, expected ~120`);
  assert.ok(result.first.minimumQuality >= 20, `translation minimum quality was ${result.first.minimumQuality}`);
  assert.ok(!result.first.statuses.includes('lost'), 'translation run reported lost');

  assert.ok(result.second.count >= 22, `rotating tracking count was ${result.second.count}`);
  assert.ok(!result.second.statuses.includes('lost'), 'rotating run reported lost');

  assert.equal(result.protected.stoppedAt, 8, `protected run stopped at ${result.protected.stoppedAt}`);
  assert.equal(result.protected.count, 8, `protected run produced ${result.protected.count} frames`);
  assert.match(result.protected.reason, /manual correction/);

  assert.ok(result.camera.count >= 25, `camera run count was ${result.camera.count}`);
  assert.ok(result.camera.cameraValidCount >= 20, `camera run had only ${result.camera.cameraValidCount} valid background estimates`);
  assert.ok(Math.abs(result.camera.cameraDx - 2) <= 0.6, `camera run mean background dx was ${result.camera.cameraDx}, expected ~2 px`);

  assert.equal(result.keyframes.mergedCount, 30, `keyframe merge produced ${result.keyframes.mergedCount} frames`);
  assert.equal(result.keyframes.manualFrameCount, 1, 'keyframe merge duplicated the manual keyframe');
  assert.ok(Math.abs(result.keyframes.keyframeX - result.keyframes.expectedKeyframeX) <= 1, 'keyframe merge overwrote the manual geometry');
  assert.ok(Math.abs(result.keyframes.finalX - 176) <= 4, `keyframe merge final X was ${result.keyframes.finalX}, expected ~176`);

  console.log('\nTracker integration tests passed: translation, rotating object, protected correction frame, camera translation, two-segment keyframe merge.');
} finally {
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (err) {
    console.error(`Could not remove temporary tracker harness directory: ${err.message}`);
  }
}
