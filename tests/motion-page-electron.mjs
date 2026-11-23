import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const projectRoot = process.cwd();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPage(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Electron is still starting.
    }
    await sleep(200);
  }
  throw new Error(`Electron did not expose a page within ${timeoutMs / 1000}s`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const errors = [];
    let nextId = 0;
    socket.addEventListener('open', () => {
      resolve({
        errors,
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            pending.set(id, { res, rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener('error', () => reject(new Error('Could not connect to the Electron renderer')));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        errors.push(message.params?.exceptionDetails?.exception?.description ?? 'renderer exception');
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        errors.push(message.params.args?.map((arg) => arg.value ?? arg.description ?? '').join(' '));
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.rej(new Error(message.error.message));
      else waiter.res(message.result);
    });
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'Renderer evaluation failed');
  }
  return result.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 15_000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function stopApp(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'thrustbook-motion-page-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const examplesDir = path.join(tempRoot, 'examples');
const imagePath = path.join(tempRoot, 'frame.png');
writeFileSync(imagePath, Buffer.from(PNG_1X1, 'base64'));

const polygon = (cx) => [
  { x: cx - 20, y: 80 },
  { x: cx + 20, y: 80 },
  { x: cx + 20, y: 120 },
  { x: cx - 20, y: 120 },
];
const frame = (index, cx) => ({
  frame: index,
  time: index / 10,
  polygon: polygon(cx),
  references: [],
  bbox: { x: cx - 20, y: 80, width: 40, height: 40 },
  status: index === 0 || index === 2 ? 'manual' : 'tracked',
  quality: index === 0 || index === 2 ? 100 : 90,
  qualityNotes: [],
  featureCount: 20,
  inlierRatio: 0.9,
  fbError: 0.2,
});
const analysis = {
  version: 1,
  name: 'Page smoke analysis',
  media: {
    kind: 'image',
    path: imagePath,
    name: 'frame.png',
    width: 320,
    height: 240,
    duration: null,
    frameCount: 3,
    fps: 10,
    timestamps: [0, 0.1, 0.2],
    timingSource: 'image-sequence',
    variableFrameRate: false,
  },
  objects: [
    {
      id: 'page-object',
      name: 'Rocket body',
      color: '#5cc8ff',
      initialFrame: 0,
      initialPolygon: polygon(100),
      initialReferences: [],
      referenceLength: 0,
      actualLength: 10,
      actualWidth: 2,
      actualHeight: 2,
      lengthUnit: 'cm',
      frames: [frame(0, 100), frame(1, 110), frame(2, 120)],
      manualFrames: [0, 2],
      history: [
        {
          id: 'history-1',
          at: new Date().toISOString(),
          frame: 2,
          time: 0.2,
          polygon: polygon(150),
          references: [],
          action: 'Keyframe replaced',
        },
      ],
      notes: '',
    },
  ],
  calibration: {
    mode: 'none',
    origin: { x: 0, y: 0 },
    xAxisPoint: { x: 100, y: 0 },
    yAxisPoint: { x: 0, y: 100 },
    scalePointA: { x: 0, y: 0 },
    scalePointB: { x: 100, y: 0 },
    knownLength: 1,
    lengthUnit: 'cm',
    homographyPoints: [],
    homographyWidth: 1,
    homographyHeight: 1,
    notes: '',
  },
  settings: {
    smoothingWindow: 1,
    processingMaxWidth: 1280,
    qualityThreshold: 45,
    maxFeatures: 160,
    displayLengthUnit: 'm',
    displayVelocityUnit: 'm/s',
    displayAccelerationUnit: 'm/s2',
    startFrame: 0,
    endFrame: 0,
    showOutline: true,
    showBoundingBox: false,
    showReferences: true,
    showAxes: true,
    showTrajectory: true,
    showReadout: true,
    compensateCamera: false,
  },
  selectedObjectId: 'page-object',
  importantFrames: [],
  notes: '',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let child;
let cdp;
let stderr = '';
try {
  const port = await freePort();
  const electronArgs = ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`];
  if (process.env.CI) electronArgs.push('--no-sandbox', '--disable-gpu');
  child = spawn(electronPath, electronArgs, {
    cwd: projectRoot,
    env: {
      ...process.env,
      THRUSTBOOK_WORKSPACE: 'examples',
      THRUSTBOOK_DATA_DIR: dataDir,
      THRUSTBOOK_EXAMPLES_ROOT: examplesDir,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
  });

  const page = await waitForPage(port);
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(cdp, `!!document.querySelector('.app-shell') && !!window.rocketlab`, 30_000, 'application shell');

  const projects = await evaluate(cdp, `window.rocketlab.invoke('records.list', { entity: 'project', limit: 5 })`);
  assert.equal(projects.ok, true, projects.error);
  assert.ok(projects.data.length > 0, 'example workspace has no project');
  const projectId = projects.data[0].id;

  const created = await evaluate(
    cdp,
    `window.rocketlab.invoke('records.create', ${JSON.stringify({
      entity: 'motion_analysis',
      data: {
        project_id: projectId,
        name: analysis.name,
        media_type: 'image',
        media_path: analysis.media.path,
        media_paths_json: [],
        data_json: analysis,
        notes: '',
      },
    })})`,
  );
  assert.equal(created.ok, true, created.error);
  assert.ok(created.data?.id, 'motion analysis was not created');

  await evaluate(cdp, `location.hash = '#/motion?analysis=${created.data.id}'`);
  await waitFor(cdp, `!!document.querySelector('.motion-page') && !!document.querySelector('.motion-history-list')`, 20_000, 'motion workspace');
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.motion-keyframe-list .motion-keyframe-item').length`), 2, 'initial keyframe list count');
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.motion-history-list .motion-keyframe-item').length`), 1, 'initial correction history count');

  // Restore a keyframe from history: the page must seek to that frame and
  // replace only that frame's geometry.
  await evaluate(cdp, `document.querySelector('.motion-history-list button').click()`);
  await waitFor(cdp, `document.querySelector('input[aria-label="Frame number"]').value === '3'`, 5_000, 'restored frame selection');
  await sleep(2_000);
  const restoredRow = await evaluate(cdp, `window.rocketlab.invoke('records.get', { entity: 'motion_analysis', id: ${JSON.stringify(created.data.id)} })`);
  assert.equal(restoredRow.ok, true, restoredRow.error);
  assert.equal(restoredRow.data?.data?.objects?.[0]?.frames?.find((item) => item.frame === 2)?.polygon?.[0]?.x, 130, 'restored keyframe geometry was not saved');

  // Make another keyframe, then remove it through the confirmation dialog.
  await evaluate(cdp, `document.querySelector('button[title="Previous frame"]').click()`);
  await waitFor(cdp, `document.querySelector('input[aria-label="Frame number"]').value === '2'`, 5_000, 'previous frame');
  await evaluate(cdp, `[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Add keyframe here')).click()`);
  await waitFor(cdp, `document.querySelectorAll('.motion-keyframe-list .motion-keyframe-item').length === 3`, 5_000, 'added keyframe');
  await evaluate(cdp, `document.querySelectorAll('.motion-keyframe-list .motion-keyframe-item .icon-btn.danger')[1].click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-foot .btn-danger')`, 5_000, 'delete confirmation');
  await evaluate(cdp, `document.querySelector('.modal-foot .btn-danger').click()`);
  await waitFor(cdp, `document.querySelectorAll('.motion-keyframe-list .motion-keyframe-item').length === 2`, 5_000, 'deleted keyframe');

  // Auto-save must persist the edited keyframes and history.
  await sleep(2_500);
  const finalRow = await evaluate(cdp, `window.rocketlab.invoke('records.get', { entity: 'motion_analysis', id: ${JSON.stringify(created.data.id)} })`);
  assert.equal(finalRow.ok, true, finalRow.error);
  const finalAnalysis = finalRow.data?.data;
  assert.ok(finalAnalysis?.objects?.[0], 'saved analysis lost its object');
  assert.deepEqual(finalAnalysis.objects[0].manualFrames, [0, 2], 'saved keyframes changed unexpectedly');
  assert.ok((finalAnalysis.objects[0].history?.length ?? 0) >= 2, 'correction history was not persisted');
  // The independent outline overlay switch must remove the tracked polygon
  // while leaving the rest of the workspace usable.
  // Select an existing keyframe so there is geometry at the sampled frame;
  // the deleted test keyframe intentionally removed its frame from the track.
  await evaluate(cdp, `document.querySelector('.motion-keyframe-list button').click()`);
  await waitFor(cdp, `document.querySelector('input[aria-label="Frame number"]').value === '1'`, 5_000, 'first keyframe frame');
  await evaluate(cdp, `[...document.querySelectorAll('.tabs button')].find((button) => button.textContent.includes('Calibration')).click()`);
  await waitFor(cdp, `[...document.querySelectorAll('label.checkbox')].some((label) => label.textContent.includes('Outline'))`, 5_000, 'outline overlay setting');
  const sampleOutline = `(() => {
    const canvas = document.querySelector('canvas.motion-overlay');
    const context = canvas.getContext('2d');
    const x = Math.round((80 / 320) * canvas.width);
    const y = Math.round((100 / 240) * canvas.height);
    const data = context.getImageData(Math.max(0, x - 3), Math.max(0, y - 3), 7, 7).data;
    let visible = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 20) visible++;
    return visible;
  })()`;
  const outlineBefore = await evaluate(cdp, sampleOutline);
  assert.ok(outlineBefore > 0, 'tracked outline was not visible before toggling');
  await evaluate(cdp, `[...document.querySelectorAll('label.checkbox')].find((label) => label.textContent.includes('Outline')).querySelector('input').click()`);
  await waitFor(cdp, `(() => {
    const canvas = document.querySelector('canvas.motion-overlay');
    const context = canvas.getContext('2d');
    const x = Math.round((80 / 320) * canvas.width);
    const y = Math.round((100 / 240) * canvas.height);
    const data = context.getImageData(Math.max(0, x - 3), Math.max(0, y - 3), 7, 7).data;
    let visible = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 20) visible++;
    return visible;
  })() === 0`, 5_000, 'outline hidden');

  assert.ok(!cdp.errors.length, `renderer errors: ${cdp.errors.slice(0, 3).join(' | ')}`);

  console.log('Motion page smoke tests passed: load, history restore/seek, add/delete keyframe, auto-save persistence, outline overlay toggle.');
} catch (error) {
  console.error(`Motion page smoke test failed: ${error.message}`);
  if (child?.stderr) process.stderr.write(stderr);
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (child) {
    stopApp(child);
    await sleep(500);
  }
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch {
    // A locked temporary profile must not turn a passing smoke test into a failure.
  }
}
