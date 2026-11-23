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

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'thrustbook-keyframe-page-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const examplesDir = path.join(tempRoot, 'examples');
const videoPath = path.join(tempRoot, 'synthetic-launch.webm');

const mediaA = {
  kind: 'video',
  path: videoPath,
  name: 'synthetic-launch.webm',
  width: 320,
  height: 240,
  duration: 1,
  frameCount: 10,
  fps: 10,
  timestamps: Array.from({ length: 10 }, (_, index) => Number((index / 10).toFixed(4))),
  timingSource: 'video-timestamps',
  variableFrameRate: false,
};
const calibrationA = {
  mode: 'scale',
  pointA: { x: 100, y: 200 },
  pointB: { x: 200, y: 200 },
  knownLength: 1,
  lengthUnit: 'm',
  notes: '',
};
const setA = {
  version: 1,
  name: 'Synthetic launch — ascent',
  media: mediaA,
  keyframes: [
    { id: 'a0', frame: 0, time: 0, x: 100, y: 200, notes: '' },
    { id: 'a1', frame: 4, time: 0.4, x: 140, y: 200, notes: '' },
    { id: 'a2', frame: 8, time: 0.8, x: 180, y: 200, notes: '' },
  ],
  calibration: calibrationA,
  notes: 'Synthetic clip recorded for the end-to-end test.',
};
const setB = {
  version: 1,
  name: 'Reusable scaled keyframes',
  media: {
    ...mediaA,
    width: 160,
    height: 120,
    frameCount: 10,
    timestamps: Array.from({ length: 10 }, (_, index) => Number((index / 10).toFixed(4))),
  },
  keyframes: [
    { id: 'b0', frame: 0, time: 0, x: 50, y: 100, notes: '' },
    { id: 'b1', frame: 8, time: 0.8, x: 90, y: 100, notes: '' },
  ],
  calibration: {
    mode: 'scale',
    pointA: { x: 50, y: 100 },
    pointB: { x: 100, y: 100 },
    knownLength: 1,
    lengthUnit: 'm',
    notes: '',
  },
  notes: '',
};

let child;
let cdp;
let stderr = '';

async function clickStage(cdp, mediaX, mediaY) {
  await evaluate(cdp, `document.querySelector('canvas.keyframe-overlay').scrollIntoView({ block: 'center' })`);
  await sleep(250);
  const point = await evaluate(
    cdp,
    `(() => {
      const canvas = document.querySelector('canvas.keyframe-overlay');
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + (${mediaX} / 320) * rect.width, y: rect.top + (${mediaY} / 240) * rect.height };
    })()`,
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function dragStage(cdp, fromX, fromY, toX, toY) {
  await evaluate(cdp, `document.querySelector('canvas.keyframe-overlay').scrollIntoView({ block: 'center' })`);
  await sleep(250);
  const points = await evaluate(
    cdp,
    `(() => {
      const canvas = document.querySelector('canvas.keyframe-overlay');
      const rect = canvas.getBoundingClientRect();
      return {
        from: { x: rect.left + (${fromX} / 320) * rect.width, y: rect.top + (${fromY} / 240) * rect.height },
        to: { x: rect.left + (${toX} / 320) * rect.width, y: rect.top + (${toY} / 240) * rect.height },
      };
    })()`,
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.from.x, y: points.from.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.to.x, y: points.to.y, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.to.x, y: points.to.y, button: 'left', clickCount: 1 });
}

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

  // Record a real, short WebM in the renderer so the analyser can decode a
  // genuine video file. This keeps the test independent of machine assets.
  const recording = await evaluate(
    cdp,
    `(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(10);
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start();
      for (let index = 0; index < 12; index++) {
        context.fillStyle = '#0a1520';
        context.fillRect(0, 0, 320, 240);
        context.fillStyle = '#f0b75a';
        context.fillRect(20 + index * 8, 190 - index * 5, 14, 36);
        await new Promise((resolve) => setTimeout(resolve, 90));
      }
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());
      const buffer = await new Blob(chunks).arrayBuffer();
      return Array.from(new Uint8Array(buffer));
    })()`,
  );
  assert.ok(Array.isArray(recording) && recording.length > 500, 'the synthetic WebM recording produced no usable video');
  writeFileSync(videoPath, Buffer.from(recording));

  const projects = await evaluate(cdp, `window.rocketlab.invoke('records.list', { entity: 'project', limit: 5 })`);
  assert.equal(projects.ok, true, projects.error);
  let projectId = projects.data?.[0]?.id;
  if (!projectId) {
    const project = await evaluate(
      cdp,
      `window.rocketlab.invoke('records.create', ${JSON.stringify({ entity: 'project', data: { name: 'Keyframe analyser test', status: 'Testing' } })})`,
    );
    assert.equal(project.ok, true, project.error);
    projectId = project.data.id;
  }

  const createdA = await evaluate(
    cdp,
    `window.rocketlab.invoke('keyframes.save', ${JSON.stringify({ projectId, set: setA, name: setA.name })})`,
  );
  assert.equal(createdA.ok, true, createdA.error);
  assert.ok(createdA.data?.id, 'the keyframe set was not created');
  const idA = createdA.data.id;
  assert.equal(createdA.data.set.keyframes.length, 3);

  const createdB = await evaluate(
    cdp,
    `window.rocketlab.invoke('keyframes.save', ${JSON.stringify({ projectId, set: setB, name: setB.name })})`,
  );
  assert.equal(createdB.ok, true, createdB.error);
  const idB = createdB.data.id;

  const listed = await evaluate(cdp, `window.rocketlab.invoke('keyframes.list', { projectId: ${JSON.stringify(projectId)} })`);
  assert.equal(listed.ok, true, listed.error);
  assert.equal(listed.data.length, 2, 'both reusable keyframe sets must be in the library');

  const stored = await evaluate(cdp, `window.rocketlab.invoke('keyframes.get', { id: ${JSON.stringify(idA)} })`);
  assert.equal(stored.ok, true, stored.error);
  assert.equal(stored.data.set.keyframes.length, 3);
  assert.equal(stored.data.set.media.timestamps.length, 10);
  assert.equal(stored.data.set.calibration.lengthUnit, 'm');
  assert.equal(stored.data.media_path, videoPath, 'the saved record must point at the test video');
  const createdAt = stored.data.created_at;

  const renamed = await evaluate(
    cdp,
    `window.rocketlab.invoke('keyframes.save', ${JSON.stringify({ id: idA, set: { ...setA, name: 'Renamed ascent' }, name: 'Renamed ascent' })})`,
  );
  assert.equal(renamed.ok, true, renamed.error);
  assert.equal(renamed.data.id, idA, 'updating a set must keep its id');
  assert.equal(renamed.data.name, 'Renamed ascent');
  assert.equal(renamed.data.created_at, createdAt, 'updating a set must keep its creation time');
  const listedAfterRename = await evaluate(cdp, `window.rocketlab.invoke('keyframes.list', { projectId: ${JSON.stringify(projectId)} })`);
  assert.equal(listedAfterRename.data.length, 2, 'renaming must not duplicate the set');

  const mediaInfo = await evaluate(cdp, `window.rocketlab.invoke('keyframes.mediaUrl', { path: ${JSON.stringify(videoPath)} })`);
  assert.equal(mediaInfo.ok, true, mediaInfo.error);
  assert.ok(String(mediaInfo.data.url).startsWith('http://127.0.0.1:'), 'video must use the loopback media service');
  const forbidden = await evaluate(cdp, `window.rocketlab.invoke('keyframes.mediaUrl', { path: ${JSON.stringify(path.join(projectRoot, 'package.json'))} })`);
  assert.equal(forbidden.ok, false, 'a file not referenced by a keyframe set must be refused');

  const directPlayback = await evaluate(
    cdp,
    `(async () => {
      const info = await window.rocketlab.invoke('keyframes.mediaUrl', { path: ${JSON.stringify(videoPath)} });
      const probe = document.createElement('video');
      probe.muted = true;
      probe.src = info.data.url;
      document.body.appendChild(probe);
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ state: 'timeout', ready: probe.readyState, src: probe.getAttribute('src'), current: probe.currentSrc }), 8000);
        probe.addEventListener('loadedmetadata', () => {
          clearTimeout(timer);
          resolve({ state: 'ok', duration: probe.duration, width: probe.videoWidth, height: probe.videoHeight, src: probe.getAttribute('src') });
        }, { once: true });
        probe.addEventListener('error', () => {
          clearTimeout(timer);
          resolve({ state: 'error', ready: probe.readyState, src: probe.getAttribute('src'), current: probe.currentSrc, error: probe.error ? { code: probe.error.code, message: probe.error.message } : null });
        }, { once: true });
        probe.load();
      });
      probe.remove();
      return { url: info.data.url, outcome };
    })()`,
  );
  assert.equal(directPlayback.outcome.state, 'ok', `the media protocol could not play the recorded video: ${JSON.stringify(directPlayback)}`);

  await evaluate(cdp, `location.hash = '#/keyframes?set=${idA}'`);
  await waitFor(cdp, `document.querySelectorAll('.keyframe-item').length === 3`, 20_000, 'saved keyframes to open');
  try {
    await waitFor(cdp, `document.querySelector('video')?.readyState >= 1`, 20_000, 'decoded test video');
  } catch (error) {
    const state = await evaluate(
      cdp,
      `(async () => {
        const video = document.querySelector('video');
        const url = video?.currentSrc || '';
        let fetched = null;
        try {
          const response = await fetch(url);
          fetched = { status: response.status, type: response.headers.get('content-type'), length: response.headers.get('content-length') };
        } catch (fetchError) {
          fetched = { error: String(fetchError) };
        }
        return {
          url,
          readyState: video?.readyState ?? null,
          networkState: video?.networkState ?? null,
          error: video?.error ? { code: video.error.code, message: video.error.message } : null,
          fetched,
          srcAttribute: video?.getAttribute('src') ?? null,
          missing: document.querySelector('.keyframe-missing')?.textContent || '',
          mediaError: document.querySelector('.keyframe-warn')?.textContent || '',
        };
      })()`,
    );
    throw new Error(`${error.message} ${JSON.stringify(state)}`);
  }
  assert.match(await evaluate(cdp, `document.querySelector('.page-head h1')?.textContent || ''`), /Rocket Video Analyser/);
  assert.match(await evaluate(cdp, `document.querySelector('.page-sub')?.textContent || ''`), /3 keyframes/);

  const statValue = (label) =>
    evaluate(
      cdp,
      `[...document.querySelectorAll('.stat')].find((stat) => stat.querySelector('.stat-label')?.textContent === ${JSON.stringify(label)})?.querySelector('.stat-value')?.textContent || ''`,
    );
  assert.match(await statValue('Total distance'), /0\.800 m/);
  assert.match(await statValue('Max interval speed'), /1\.000 m\/s/);
  assert.match(await statValue('Max acceleration'), /0\.00 m\/s²/);
  assert.match(await statValue('Net direction'), /0\.0°/);
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.keyframe-results tbody tr').length`), 3, 'one result row per keyframe');
  assert.match(await evaluate(cdp, `document.querySelector('.keyframe-results')?.textContent || ''`), /1\.000/, 'measured speed must be shown');

  // Add a keyframe on a new frame by clicking the rocket on the stage.
  for (let index = 0; index < 5; index++) {
    await evaluate(cdp, `document.querySelector('button[title="Next frame"]').click()`);
  }
  await waitFor(cdp, `document.querySelector('input[aria-label="Keyframe frame"]')?.value === '6'`, 5_000, 'frame 5 selection');
  await clickStage(cdp, 220, 120);
  await waitFor(cdp, `document.querySelectorAll('.keyframe-item').length === 4`, 5_000, 'clicked keyframe');
  await sleep(2_200);
  const withAdded = await evaluate(cdp, `window.rocketlab.invoke('keyframes.get', { id: ${JSON.stringify(idA)} })`);
  const added = withAdded.data.set.keyframes.find((entry) => entry.frame === 5);
  assert.ok(added, 'the clicked keyframe was not saved');
  assert.ok(Math.abs(added.x - 220) < 1.5 && Math.abs(added.y - 120) < 1.5, `saved click position was ${added.x},${added.y}`);
  assert.ok(Math.abs(added.time - 0.5) < 1e-6, `saved click time was ${added.time}`);

  // Delete it through the confirmation dialog and confirm persistence.
  await evaluate(cdp, `[...document.querySelectorAll('.keyframe-item')].at(-1).querySelector('button[title="Delete keyframe"]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-foot .btn-danger')`, 5_000, 'delete confirmation');
  await evaluate(cdp, `document.querySelector('.modal-foot .btn-danger').click()`);
  await waitFor(cdp, `document.querySelectorAll('.keyframe-item').length === 3`, 5_000, 'deleted keyframe');
  await sleep(2_200);
  const afterDelete = await evaluate(cdp, `window.rocketlab.invoke('keyframes.get', { id: ${JSON.stringify(idA)} })`);
  assert.equal(afterDelete.data.set.keyframes.length, 3, 'deleting a keyframe must persist');

  // Drag the frame-4 marker and check the stored position moves with it.
  await evaluate(cdp, `[...document.querySelectorAll('.keyframe-item button.link-btn')].find((button) => button.textContent.includes('frame 5')).click()`);
  await waitFor(cdp, `document.querySelector('input[aria-label="Keyframe frame"]')?.value === '5'`, 5_000, 'frame 4 selection');
  await dragStage(cdp, 140, 200, 146, 196);
  await sleep(2_200);
  const afterDrag = await evaluate(cdp, `window.rocketlab.invoke('keyframes.get', { id: ${JSON.stringify(idA)} })`);
  const dragged = afterDrag.data.set.keyframes.find((entry) => entry.frame === 4);
  assert.ok(dragged, 'the dragged keyframe disappeared');
  assert.ok(Math.abs(dragged.x - 146) < 2 && Math.abs(dragged.y - 196) < 2, `dragged position was ${dragged.x},${dragged.y}`);

  // Reuse a saved set on the open video. Its 160x120 marks must scale to the
  // 320x240 clip and its calibration must scale with them.
  const applyClicked = await evaluate(
    cdp,
    `(() => {
      const item = [...document.querySelectorAll('.keyframe-library-item')].find((node) => node.textContent.includes('Reusable scaled keyframes'));
      if (!item) return false;
      const button = [...item.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Apply');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
  );
  assert.equal(applyClicked, true, 'the saved keyframe set must offer Apply');
  await waitFor(cdp, `!!document.querySelector('.modal-foot .btn-primary')`, 5_000, 'replace-keyframes confirmation');
  await evaluate(cdp, `document.querySelector('.modal-foot .btn-primary').click()`);
  await waitFor(cdp, `document.querySelectorAll('.keyframe-item').length === 2`, 5_000, 'reused keyframes');
  await sleep(2_200);
  const afterApply = await evaluate(cdp, `window.rocketlab.invoke('keyframes.get', { id: ${JSON.stringify(idA)} })`);
  const reused = afterApply.data.set.keyframes;
  assert.deepEqual(reused.map((entry) => entry.frame), [0, 8], 'reused frames were not kept');
  assert.ok(Math.abs(reused[0].x - 100) < 0.01 && Math.abs(reused[0].y - 200) < 0.01, 'reused marks were not scaled to 320x240');
  assert.ok(Math.abs(reused[1].x - 180) < 0.01, 'second reused mark was not scaled');
  assert.ok(Math.abs(reused[1].time - 0.8) < 1e-6, 'reused time was not taken from this clip');
  assert.equal(afterApply.data.set.calibration.pointB.x, 200, 'reused scale points must scale with the keyframes');
  assert.equal(afterApply.data.set.calibration.knownLength, 1);

  // Reloading the library view and reopening the set must show the reused marks.
  await evaluate(cdp, `[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Library').click()`);
  await waitFor(cdp, `!!document.querySelector('.keyframe-steps')`, 5_000, 'keyframe library');
  await evaluate(cdp, `location.hash = '#/keyframes?set=${idA}'`);
  await waitFor(cdp, `document.querySelectorAll('.keyframe-item').length === 2`, 10_000, 'reopened saved keyframes');

  assert.ok(!cdp.errors.length, `renderer errors: ${cdp.errors.slice(0, 3).join(' | ')}`);

  console.log(
    'Keyframe page tests passed: storage and rename, media authorisation, page render, measured intervals, click add/delete, marker drag, and scaled keyframe reuse.',
  );
} catch (error) {
  console.error(`Keyframe page test failed: ${error.message}`);
  if (stderr) process.stderr.write(stderr);
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
    // A locked temporary profile must not turn a passing test into a failure.
  }
}
