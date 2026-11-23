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
const temp = mkdtempSync(path.join(tmpdir(), 'thrustbook-stage-test-'));
const bundlePath = path.join(temp, 'stage-harness.js');
const htmlPath = path.join(temp, 'index.html');
const mainPath = path.join(temp, 'main.cjs');
const screenshotPath = path.join(projectRoot, 'release', 'stage-ui-check.png');
const zoomedScreenshotPath = path.join(projectRoot, 'release', 'stage-ui-zoomed.png');

try {
  await build({
    entryPoints: [path.join(projectRoot, 'tests', 'stage-harness.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    jsx: 'automatic',
    outfile: bundlePath,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });

  copyFileSync(path.join(projectRoot, 'src', 'renderer', 'styles.css'), path.join(temp, 'styles.css'));

  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'">
<link rel="stylesheet" href="/styles.css">
<style>#scroller { height: 540px !important; } #scroller .motion-media { visibility: hidden; }</style>
<title>MotionStage UI harness</title></head>
<body style="margin:0;background:#101820"><div id="root"></div>
<script src="/stage-harness.js"></script></body></html>`,
    'utf8',
  );

  writeFileSync(
    mainPath,
    `const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = ${JSON.stringify(temp)};
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(data);
    } catch (err) { res.writeHead(404); res.end(String(err)); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: false, contextIsolation: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => console.error('[renderer]', level, message));
  win.webContents.on('did-fail-load', (_e, code, description) => console.error('[load-failed]', code, description));
  win.webContents.on('render-process-gone', (_e, details) => console.error('[renderer-gone]', JSON.stringify(details)));
  const timeout = setTimeout(() => { console.error('STAGE_MAIN_TIMEOUT'); app.exit(3); }, 60000);
  try {
    await win.loadURL('http://127.0.0.1:' + port + '/index.html');
    win.showInactive();
    win.focus();
    win.webContents.focus();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const readState = () => win.webContents.executeJavaScript(\`(() => {
      const inner = document.querySelector('.motion-stage-inner');
      const canvas = document.querySelector('.motion-overlay');
      const ctx = canvas.getContext('2d');
      const transform = inner ? inner.style.transform : '';
      const match = /translate\\(([-\\d.]+)px, ([-\\d.]+)px\\) scale\\(([\\d.]+)\\)/.exec(transform);
      const panX = match ? Number(match[1]) : 0;
      const panY = match ? Number(match[2]) : 0;
      const scale = match ? Number(match[3]) : 1;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const toCanvas = (x, y) => [
        Math.round((panX + scale * (x / 1024) * rect.width) * (canvas.width / rect.width)),
        Math.round((panY + scale * (y / 768) * rect.height) * (canvas.height / rect.height)),
      ];
      const centerAt = toCanvas(120, 100);
      const edgeAt = toCanvas(270, 100);
      const center = ctx.getImageData(centerAt[0], centerAt[1], 1, 1).data;
      const edge = ctx.getImageData(edgeAt[0], edgeAt[1], 1, 1).data;
      return {
        zoom: document.querySelector('.motion-zoom span').textContent,
        transform,
        scrollTop: document.querySelector('#scroller').scrollTop,
        windowScrollY: window.scrollY,
        stageWidth: document.querySelector('.motion-stage').getBoundingClientRect().width,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        dpr,
        centerPixel: Array.from(center),
        edgePixel: Array.from(edge),
      };
    })()\`);

    const initial = await readState();
    assert.equal(initial.zoom, '100%');
    assert.equal(initial.scrollTop, 0);
    assert.ok(Math.abs(initial.canvasWidth - initial.stageWidth * initial.dpr) <= 1, 'overlay canvas is not at viewport resolution');
    assert.ok(initial.canvasWidth < 1000, 'overlay canvas is using source-video resolution');
    assert.ok(initial.centerPixel[0] > 220 && initial.centerPixel[1] > 220 && initial.centerPixel[2] > 220, 'selected vertex handle is not a light filled point');
    assert.ok(initial.edgePixel[2] > initial.edgePixel[0] + 18, 'selected polygon outline is not visibly blue');

    // Wheel over the footage: must zoom without moving the scroll container.
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 300, y: 200, deltaX: 0, deltaY: 120, canScroll: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const zoomed = await readState();
    assert.notEqual(zoomed.zoom, '100%', 'wheel over footage did not zoom');
    assert.equal(zoomed.scrollTop, 0, 'wheel over footage scrolled the page');
    assert.equal(zoomed.windowScrollY, 0, 'wheel over footage scrolled the window');
    assert.equal(zoomed.canvasWidth, initial.canvasWidth, 'overlay backing resolution changed with zoom');

    const matrix = /translate\\(([-\\d.]+)px, ([-\\d.]+)px\\) scale\\(([\\d.]+)\\)/.exec(zoomed.transform || '');
    assert.ok(matrix, 'stage transform was not in the expected form');
    const panX = Number(matrix[1]);
    const panY = Number(matrix[2]);
    const scale = Number(matrix[3]);
    assert.ok(scale > 1.05 && scale < 1.4, 'unexpected wheel zoom scale: ' + scale);
    // Cursor at (300, 200) must stay over the same media point.
    const expectedPanX = 300 - 300 * scale;
    const expectedPanY = 200 - 200 * scale;
    assert.ok(Math.abs(panX - expectedPanX) < 0.6, 'zoom was not anchored at cursor X: ' + panX + ' vs ' + expectedPanX);
    assert.ok(Math.abs(panY - expectedPanY) < 0.6, 'zoom was not anchored at cursor Y: ' + panY + ' vs ' + expectedPanY);

    const zoomedImage = await win.capturePage();
    fs.writeFileSync(${JSON.stringify(zoomedScreenshotPath)}, zoomedImage.toPNG());

    // Two wheel events before React paints must accumulate, not overwrite each other.
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 300, y: 200, deltaX: 0, deltaY: 120, canScroll: true });
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 300, y: 200, deltaX: 0, deltaY: 120, canScroll: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rapid = await readState();
    const rapidScale = Number(/scale\\(([\\d.]+)\\)/.exec(rapid.transform || '')?.[1]);
    assert.ok(rapidScale > 1.65 && rapidScale < 1.8, 'rapid wheel events did not accumulate: ' + rapidScale);
    assert.equal(rapid.scrollTop, 0, 'rapid wheel over footage scrolled the page');

    const fitLabel = await win.webContents.executeJavaScript("(() => { const b = document.querySelector('.motion-zoom-reset'); b.click(); return b.textContent; })()");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const reset = await readState();
    assert.equal(fitLabel, 'Fit', 'Fit control is missing');
    assert.equal(reset.zoom, '100%');
    assert.match(reset.transform, /translate\\(0px, 0px\\) scale\\(1\\)/);

    // + zooms around the stage center (300, 225), not the top-left corner.
    await win.webContents.executeJavaScript("document.querySelectorAll('.motion-zoom button')[1].click()");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const plus = await readState();
    assert.equal(plus.zoom, '120%');
    assert.match(plus.transform, /translate\\(-60px, -45px\\) scale\\(1.2\\)/);

    // The first vertex is at screen (24.4, 25.3) after the centered zoom.
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 24, y: 25, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 24, y: 25, button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const selectedPoint = await win.webContents.executeJavaScript("window.__selectedPoint ?? -1");
    assert.equal(selectedPoint, 0, 'pointer mapping did not hit the zoomed vertex');

    await win.webContents.executeJavaScript("document.querySelector('.motion-zoom-reset').click()");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const image = await win.capturePage();
    fs.writeFileSync(${JSON.stringify(screenshotPath)}, image.toPNG());
    clearTimeout(timeout);
    console.log('STAGE_JSON:' + JSON.stringify({ initial, zoomed, rapid, reset, plus, screenshot: ${JSON.stringify(screenshotPath)}, zoomedScreenshot: ${JSON.stringify(zoomedScreenshotPath)} }));
    app.exit(0);
  } catch (err) {
    clearTimeout(timeout);
    console.error('STAGE_RUNNER_ERROR:' + (err && err.stack ? err.stack : String(err)));
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
    timeout: 80_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    process.stderr.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    throw new Error(`Stage Electron process exited with status ${child.status}`);
  }
  const line = (child.stdout || '').split(/\r?\n/).find((entry) => entry.startsWith('STAGE_JSON:'));
  if (!line) {
    process.stderr.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    throw new Error('Stage harness produced no result');
  }
  const state = JSON.parse(line.slice('STAGE_JSON:'.length));
  console.log(JSON.stringify(state, null, 2));
  console.log('\nMotionStage UI tests passed: wheel is page-safe, cursor-anchored, overlay is visible, Fit resets the view.');
} finally {
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (err) {
    console.error(`Could not remove temporary stage harness directory: ${err.message}`);
  }
}
