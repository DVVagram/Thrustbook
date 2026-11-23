/**
 * End-to-end SAM 2.1 tracking test through the real application.
 *
 * Seeds an image-sequence analysis with synthetic rocket frames, opens Video &
 * Image Analysis, clicks Track and checks the saved result: engine tag, outline
 * area, mask centroid, reference points, and that the Track button is usable
 * again afterwards. Frames are processed at `PROCESSING_MAX_WIDTH` (384 by
 * default) so the downscaled coordinate path is exercised too.
 *
 * The 143 MB component is not part of the repository: install it through the
 * app or point THURSTBOOK_SAM2_DIR at an installed component directory. Without
 * it the test reports that it was skipped.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const projectRoot = process.cwd();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WIDTH = 640;
const HEIGHT = 360;
const FRAMES = 5;
const PROCESSING_MAX_WIDTH = Number(process.env.PROCESSING_MAX_WIDTH || 384);
const COMPENSATE = process.env.COMPENSATE === '1';

const appDataRoot =
  process.env.APPDATA ||
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'));
const modelDir =
  process.env.THURSTBOOK_SAM2_DIR || path.join(appDataRoot, 'Thrustbook', 'models', 'sam2.1-hiera-small');

if (
  !existsSync(path.join(modelDir, 'sam2.1_hiera_small.encoder.onnx')) ||
  !existsSync(path.join(modelDir, 'sam2.1_hiera_small.decoder.onnx'))
) {
  console.log('SAM 2.1 tracking UI test skipped: the model component is not installed.');
  console.log(`Looked in ${modelDir}. Install it in the app or set THURSTBOOK_SAM2_DIR.`);
  process.exit(0);
}

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
    const logs = [];
    let nextId = 0;
    socket.addEventListener('open', () => {
      resolve({
        errors,
        logs,
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
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = message.params.args?.map((arg) => arg.value ?? arg.description ?? '').join(' ');
        if (message.params?.type === 'error') errors.push(text);
        else logs.push(text);
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

// --- minimal PNG writer (no dependencies) ---
function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function writePng(file, rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
function drawFrame(index) {
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  const body = { x: 72 + 6 * index, y: 176 - 1.4 * index, width: 92, height: 28 };
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const value =
        120 + 46 * Math.sin(x * 0.11) + 34 * Math.cos(y * 0.15) + ((Math.floor(x / 40) + Math.floor(y / 30)) % 2) * 10;
      const offset = (y * WIDTH + x) * 4;
      rgba[offset] = value * 0.8;
      rgba[offset + 1] = value * 0.9;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  for (let y = Math.round(body.y); y < Math.round(body.y + body.height); y++) {
    for (let x = Math.round(body.x); x < Math.round(body.x + body.width); x++) {
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
      const offset = (y * WIDTH + x) * 4;
      rgba[offset] = 238;
      rgba[offset + 1] = 240;
      rgba[offset + 2] = 244;
    }
  }
  for (let dy = -14; dy <= 14; dy++) {
    const width = 14 - Math.abs(dy);
    for (let dx = 0; dx < width; dx++) {
      const x = Math.round(body.x + body.width + dx - width);
      const y = Math.round(body.y + body.height / 2 + dy);
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
      const offset = (y * WIDTH + x) * 4;
      rgba[offset] = 230;
      rgba[offset + 1] = 232;
      rgba[offset + 2] = 236;
    }
  }
  return rgba;
}
function polygonArea(polygon) {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}
function polygonCentroid(polygon) {
  let area = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  return { x: x / (3 * area), y: y / (3 * area) };
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'thrustbook-sam2-ui-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const examplesDir = path.join(tempRoot, 'examples');
const framePaths = [];
for (let index = 0; index < FRAMES; index++) {
  const file = path.join(tempRoot, `frame-${index}.png`);
  writePng(file, drawFrame(index), WIDTH, HEIGHT);
  framePaths.push(file);
}

const rect = (x, y, width, height) => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
];
const analysis = {
  version: 1,
  name: 'SAM tracking UI test',
  media: {
    kind: 'sequence',
    path: framePaths[0],
    paths: framePaths,
    name: 'synthetic sequence',
    width: WIDTH,
    height: HEIGHT,
    duration: FRAMES / 10,
    frameCount: FRAMES,
    fps: 10,
    timestamps: Array.from({ length: FRAMES }, (_, i) => i / 10),
    timingSource: 'image-sequence',
    variableFrameRate: false,
  },
  objects: [
    {
      id: 'ui-object',
      name: 'Rocket',
      color: '#5cc8ff',
      initialFrame: 0,
      initialPolygon: rect(60, 160, 116, 58),
      initialReferences: [{ id: 'nose', name: 'Nose', point: { x: 172, y: 176 } }],
      frames: [],
      manualFrames: [],
      corrections: [],
      actualLength: 0,
      actualWidth: 0,
      actualHeight: 0,
      lengthUnit: 'cm',
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
    processingMaxWidth: PROCESSING_MAX_WIDTH,
    compensateCamera: COMPENSATE,
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
    compensateCamera: COMPENSATE,
  },
  selectedObjectId: 'ui-object',
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
      THURSTBOOK_SAM2_DIR: modelDir,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  const page = await waitForPage(port);
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(cdp, '!!document.querySelector(".app-shell") && !!window.rocketlab', 30_000, 'application shell');

  const projects = await evaluate(cdp, 'window.rocketlab.invoke("records.list", { entity: "project", limit: 5 })');
  assert.equal(projects.ok, true, projects.error);
  const created = await evaluate(
    cdp,
    `window.rocketlab.invoke('records.create', ${JSON.stringify({
      entity: 'motion_analysis',
      data: {
        project_id: projects.data[0].id,
        name: analysis.name,
        media_type: 'sequence',
        media_path: framePaths[0],
        media_paths_json: JSON.stringify(framePaths),
        data_json: analysis,
        notes: '',
      },
    })})`,
  );
  assert.equal(created.ok, true, created.error);
  const analysisId = created.data.id;

  await evaluate(cdp, `location.hash = '#/motion?analysis=${analysisId}'`);
  await waitFor(cdp, '!!document.querySelector(".motion-page")', 20_000, 'motion page');
  await waitFor(cdp, 'document.querySelector(".motion-engine")?.textContent.includes("Remove model")', 20_000, 'installed SAM panel');
  await sleep(600);

  const buttonBefore = await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('through keyframes'));
      return button ? { text: button.textContent.trim(), disabled: button.disabled } : null;
    })()`,
  );
  assert.ok(buttonBefore, 'the track button was not rendered');
  assert.equal(buttonBefore.disabled, false, `the track button is disabled: ${JSON.stringify(buttonBefore)}`);

  await evaluate(
    cdp,
    `(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent.includes('through keyframes')).click();
      return true;
    })()`,
  );

  const deadline = Date.now() + 180_000;
  let progress = null;
  while (Date.now() < deadline) {
    progress = await evaluate(
      cdp,
      `(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('through keyframes'));
        return {
          text: button ? button.textContent.trim() : null,
          meta: document.querySelector('.motion-object-meta')?.textContent || '',
        };
      })()`,
    );
    if (progress.text?.startsWith('Track ') && !progress.text.includes('Tracking') && progress.meta.includes(' frames')) break;
    await sleep(500);
  }
  if (!progress || !progress.meta.includes(' frames')) {
    throw new Error(`tracking did not finish: ${JSON.stringify(progress)}`);
  }
  await sleep(2500);

  const record = await evaluate(
    cdp,
    `window.rocketlab.invoke('records.get', { entity: 'motion_analysis', id: ${JSON.stringify(analysisId)} })`,
  );
  assert.equal(record.ok, true, record.error);
  const dataJson = typeof record.data.data_json === 'string' ? JSON.parse(record.data.data_json) : record.data.data_json;
  const tracks = dataJson.objects[0].frames;
  assert.ok(tracks.length >= FRAMES, `saved ${tracks.length} tracked frames`);
  assert.ok(
    tracks.every((track) => track.engine === 'sam2' || track.engine === 'opencv'),
    'tracked frames must be produced by SAM 2.1 or OpenCV optical flow',
  );
  assert.ok(
    tracks.some((track) => track.engine === 'sam2'),
    'SAM 2.1 must remain the primary engine',
  );
  const flowFrames = tracks.filter((track) => track.engine === 'opencv');
  if (COMPENSATE) {
    // Camera compensation needs SAM's mask on every frame, but flow still
    // measures the object and feeds the prompt/agreement cross-check.
    assert.ok(tracks.every((track) => track.engine === 'sam2'), 'camera-compensated runs segment every frame');
    assert.ok(tracks.slice(1).every((track) => track.flow?.skipped === false), 'every later frame must carry a flow measurement');
  } else {
    assert.ok(flowFrames.length > 0, 'OpenCV optical flow should take over at least one frame');
    assert.ok(
      tracks.filter((track) => track.engine === 'sam2').length >= 2,
      'SAM 2.1 must resume after flow-only frames',
    );
    const resumed = tracks.filter((track, index) => index > 0 && track.engine === 'sam2' && tracks[index - 1].engine === 'opencv');
    assert.ok(resumed.length > 0, 'a SAM frame after flow-only frames must exercise the flow-seeded prompt');
    for (const frame of resumed) {
      assert.ok((frame.flow?.agreement ?? 0) > 0.4, `flow/SAM agreement ${frame.flow?.agreement}`);
    }
  }
  for (const frame of flowFrames) {
    assert.equal(frame.flow?.method, 'lk');
    assert.equal(frame.flow?.skipped, true);
    assert.ok((frame.flow?.confidence ?? 0) > 0.5, `flow confidence ${frame.flow?.confidence}`);
    assert.ok((frame.flow?.templateScore ?? 0) > 0.5, `template-match score ${frame.flow?.templateScore}`);
    for (const point of [frame.flow.nose, frame.flow.tail, frame.flow.centre]) {
      assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y), 'nose/tail/centre must be finite');
    }
  }
  assert.ok(
    tracks.every((track) => track.polygon.length >= 3 && polygonArea(track.polygon) > 1500),
    `every outline must cover the rocket rather than a degenerate sliver: ${JSON.stringify(
      tracks.map((track) => ({ frame: track.frame, engine: track.engine, area: Math.round(polygonArea(track.polygon)), quality: Math.round(track.quality), scale: track.flow?.scale, iou: track.predictedIou, overlap: track.maskIou, maskArea: track.maskArea, notes: track.qualityNotes })),
    )}`,
  );

  const errors = tracks.map((track) => {
    const centre = polygonCentroid(track.polygon);
    return Math.hypot(centre.x - (118 + 6 * track.frame), centre.y - (190 - 1.4 * track.frame));
  });
  const referenceErrors = tracks.map((track) =>
    Math.hypot(
      track.references[0].point.x - (172 + 6 * track.frame),
      track.references[0].point.y - (176 - 1.4 * track.frame),
    ),
  );
  const buttonAfter = await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('through keyframes'));
      return button ? button.disabled : null;
    })()`,
  );

  const result = {
    processingMaxWidth: PROCESSING_MAX_WIDTH,
    compensateCamera: COMPENSATE,
    frames: tracks.length,
    maxCentroidError: Math.max(...errors),
    maxReferenceError: Math.max(...referenceErrors),
    qualities: tracks.map((track) => Math.round(track.quality)),
    engines: tracks.map((track) => track.engine),
    centroidErrors: errors.map((value) => Number(value.toFixed(2))),
    referenceErrors: referenceErrors.map((value) => Number(value.toFixed(2))),
    flowMotion: tracks.map((track) => (track.flow ? { dx: Number(track.flow.dx.toFixed(2)), dy: Number(track.flow.dy.toFixed(2)), scale: Number(track.flow.scale.toFixed(3)), template: track.flow.templateScore == null ? null : Number(track.flow.templateScore.toFixed(2)) } : null)),
    flowConfidence: flowFrames.map((frame) => Number((frame.flow?.confidence ?? 0).toFixed(2))),
    statuses: tracks.map((track) => track.status),
  };
  assert.ok(result.maxCentroidError < 14, `centroid error ${result.maxCentroidError}`);
  assert.ok(
    result.maxReferenceError < 14,
    `reference error ${result.maxReferenceError}: ${JSON.stringify(result.referenceErrors)} engines ${JSON.stringify(result.engines)}`,
  );
  assert.equal(buttonAfter, false, 'the track button must be usable again after a run');
  assert.equal(cdp.errors.length, 0, `renderer errors: ${cdp.errors.join(' | ')}`);
  console.log(JSON.stringify(result, null, 2));
  console.log(
    `SAM 2.1 tracking UI test passed at ${PROCESSING_MAX_WIDTH}px processing width: tracking, saved outlines, references and engine state.`,
  );
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  if (stderr) console.error(stderr.slice(-1500));
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  if (child) stopApp(child);
  await sleep(500);
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  } catch {
    /* best effort */
  }
}
