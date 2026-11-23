/**
 * End-to-end SAM 2.1 engine test.
 *
 * Runs the real ONNX component inside Electron on synthetic rocket footage and
 * checks that the outline is refined, the mask is propagated, corrections start
 * a new track, and background translation is measured. The 143 MB model is not
 * part of the repository: point THURSTBOOK_SAM2_DIR at an installed component
 * directory (or install it through the app) and run `npm run test:sam2-engine`.
 * Without the model the test reports that it was skipped.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const projectRoot = process.cwd();
const temp = path.join(projectRoot, 'build', 'sam2-engine-test');
const bundle = path.join(temp, 'sam2-engine.cjs');
const mainPath = path.join(temp, 'main.cjs');

const WIDTH = 640;
const HEIGHT = 360;
const FRAMES = 10;

const harness = String.raw`
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Look in the same user-data folder the packaged app installs the component into.
app.setName('Thrustbook');
app.setPath('userData', path.join(app.getPath('appData'), 'Thrustbook'));

const WIDTH = ${WIDTH};
const HEIGHT = ${HEIGHT};
const FRAMES = ${FRAMES};

function centroid(polygon) {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area) < 1e-6) {
    return polygon.reduce((acc, p) => ({ x: acc.x + p.x / polygon.length, y: acc.y + p.y / polygon.length }), { x: 0, y: 0 });
  }
  area *= 0.5;
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

function plane(index, camera) {
  const x = 72 + index * 6 + camera;
  const y = 176 - index * 1.4;
  return {
    body: { x, y, width: 92, height: 28 },
    nose: { x: x + 92, y: y + 14 },
  };
}

function drawFrame(index, camera = 0) {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const sx = x - camera;
      const value = 120 + 46 * Math.sin(sx * 0.11) + 34 * Math.cos(y * 0.15) + ((Math.floor(sx / 40) + Math.floor(y / 30)) % 2) * 10;
      const offset = (y * WIDTH + x) * 4;
      data[offset] = value * 0.8;
      data[offset + 1] = value * 0.9;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const { body, nose } = plane(index, camera);
  for (let y = Math.round(body.y); y < Math.round(body.y + body.height); y++) {
    for (let x = Math.round(body.x); x < Math.round(body.x + body.width); x++) {
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
      const offset = (y * WIDTH + x) * 4;
      data[offset] = 238;
      data[offset + 1] = 240;
      data[offset + 2] = 244;
    }
  }
  for (let dy = -14; dy <= 14; dy++) {
    const width = 14 - Math.abs(dy);
    for (let dx = 0; dx < width; dx++) {
      const x = Math.round(nose.x + dx - width);
      const y = Math.round(nose.y + dy);
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
      const offset = (y * WIDTH + x) * 4;
      data[offset] = 230;
      data[offset + 1] = 232;
      data[offset + 2] = 236;
    }
  }
  return data;
}

function rect(x, y, width, height) {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

async function runTrack(engine, label, settings) {
  const request = {
    object: {
      id: label,
      name: label,
      polygon: settings.polygon,
      references: settings.references || [],
    },
    sourceWidth: settings.sourceWidth || WIDTH,
    sourceHeight: settings.sourceHeight || HEIGHT,
    scale: settings.scale || 1,
    startFrame: settings.start,
    endFrame: settings.end,
    frameCount: FRAMES,
    qualityThreshold: 45,
    compensateCamera: !!settings.compensateCamera,
  };
  const info = await engine.startSam2Session({ request });
  const tracks = [];
  let stopped = null;
  for (let index = settings.start; index <= settings.end; index++) {
    const data = drawFrame(index, settings.camera ? index * 3 : 0);
    const reply = await engine.stepSam2Session({
      sessionId: info.sessionId,
      frame: { index, time: index / 30, width: WIDTH, height: HEIGHT, data },
    });
    if (reply.type !== 'track') {
      stopped = reply;
      break;
    }
    tracks.push(reply.track);
    if (process.env.SAM2_TRACE) console.log('TRACE', label, reply.track.frame, reply.track.quality.toFixed(1), centroid(reply.track.polygon));
  }
  return { tracks, stopped };
}

app.whenReady().then(async () => {
  const engine = require('./sam2-engine.cjs');
  const output = { ok: false };
  try {
    const status = engine.sam2Status();
    output.status = { installed: status.installed, directory: status.directory, bytes: status.bytes, error: status.error };
    if (!status.installed) {
      console.log('SAM2_ENGINE_RESULT:' + JSON.stringify({ ok: true, skipped: true, status: output.status }));
      app.exit(0);
      return;
    }
    const started = Date.now();

    const firstPolygon = rect(60, 160, 116, 58);
    const first = await runTrack(engine, 'primary', {
      polygon: firstPolygon,
      start: 0,
      end: ${FRAMES - 1},
      references: [
        { id: 'nose', name: 'Nose', point: { x: 172, y: 176 } },
        { id: 'tail', name: 'Tail', point: { x: 64, y: 176 } },
      ],
    });
    const centres = first.tracks.map((track) => centroid(track.polygon));
    const errors = first.tracks.map((track, index) => {
      const truth = plane(track.frame, 0).body;
      return Math.hypot(centres[index].x - (truth.x + truth.width / 2), centres[index].y - (truth.y + truth.height / 2));
    });
    const last = first.tracks[first.tracks.length - 1];
    const refMove = last ? Math.hypot(last.references[0].point.x - 172, last.references[0].point.y - 176) : 0;

    const corrected = await runTrack(engine, 'correction', {
      polygon: rect(70, 168, 130, 70),
      start: 4,
      end: 7,
    });
    const correctionError = corrected.tracks.length
      ? Math.hypot(
          centroid(corrected.tracks[0].polygon).x - (plane(4, 0).body.x + 46),
          centroid(corrected.tracks[0].polygon).y - (plane(4, 0).body.y + 14),
        )
      : null;

    // A downscaled video: frames are half the source size, so every outline and
    // reference point is in source coordinates and the engine must map them.
    const scaled = await runTrack(engine, 'scaled', {
      polygon: rect(120, 320, 232, 116),
      references: [{ id: 'nose', name: 'Nose', point: { x: 344, y: 352 } }],
      start: 0,
      end: 2,
      sourceWidth: WIDTH * 2,
      sourceHeight: HEIGHT * 2,
    });
    const scaledCentres = scaled.tracks.map((t) => centroid(t.polygon));
    const scaledExpected = scaled.tracks.map((t) => ({ x: (plane(t.frame, 0).body.x + 46) * 2, y: (plane(t.frame, 0).body.y + 14) * 2 }));
    const scaledErrors = scaledCentres.map((c, i) => Math.hypot(c.x - scaledExpected[i].x, c.y - scaledExpected[i].y));
    const scaledReferenceErrors = scaled.tracks.map((t) => {
      const expected = { x: (plane(t.frame, 0).body.x + 100) * 2, y: plane(t.frame, 0).body.y * 2 };
      const point = t.references[0].point;
      return Math.hypot(point.x - expected.x, point.y - expected.y);
    });

    const camera = await runTrack(engine, 'camera', {
      polygon: rect(60, 160, 116, 58),
      start: 0,
      end: 5,
      compensateCamera: true,
      camera: true,
    });
    const cameraFrames = camera.tracks.slice(1);
    const meanDx = cameraFrames.length ? cameraFrames.reduce((sum, t) => sum + (t.cameraDx || 0), 0) / cameraFrames.length : 0;
    const validFrames = cameraFrames.filter((t) => t.cameraValid).length;

    output.ok = true;
    output.elapsedMs = Date.now() - started;
    output.primary = {
      count: first.tracks.length,
      stopped: first.stopped,
      maxError: Math.max(...errors),
      meanError: errors.reduce((a, b) => a + b, 0) / Math.max(1, errors.length),
      minQuality: Math.min(...first.tracks.map((t) => t.quality)),
      predictedIou: first.tracks.map((t) => t.predictedIou),
      engine: first.tracks.every((t) => t.engine === 'sam2'),
      refMove,
      refs: first.tracks.map((t) => Number(t.references[0].point.x.toFixed(1))),
      centres: centres.map((c) => Number(c.x.toFixed(1))),
      polygonPoints: first.tracks.map((t) => t.polygon.length),
    };
    output.correction = {
      count: corrected.tracks.length,
      stopped: corrected.stopped,
      error: correctionError,
      area: corrected.tracks[0] ? Math.round(corrected.tracks[0].maskArea || 0) : null,
      polygon: corrected.tracks[0] ? corrected.tracks[0].polygon : null,
      centroid: corrected.tracks[0] ? centroid(corrected.tracks[0].polygon) : null,
      trackCentroids: corrected.tracks.map((t) => centroid(t.polygon)),
    };
    output.scaled = {
      count: scaled.tracks.length,
      stopped: scaled.stopped,
      maxError: scaledErrors.length ? Math.max(...scaledErrors) : null,
      maxReferenceError: scaledReferenceErrors.length ? Math.max(...scaledReferenceErrors) : null,
      area: scaled.tracks[0] ? Math.round(scaled.tracks[0].maskArea || 0) : null,
      first: scaledCentres[0] || null,
    };
    output.camera = {
      count: camera.tracks.length,
      meanDx,
      validFrames,
      stopped: camera.stopped,
    };
    if (process.env.SAM2_RESULT_OUT) fs.writeFileSync(process.env.SAM2_RESULT_OUT, JSON.stringify(output));
    console.log('SAM2_ENGINE_RESULT:' + JSON.stringify(output));
  } catch (error) {
    output.ok = false;
    output.error = error && error.stack ? error.stack : String(error);
    console.log('SAM2_ENGINE_RESULT:' + JSON.stringify(output));
    console.error(error);
  } finally {
    app.exit(0);
  }
});
`;

try {
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  buildSync({
    entryPoints: [path.join(projectRoot, 'src', 'main', 'sam2.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: bundle,
    external: ['electron', 'onnxruntime-node'],
    logLevel: 'warning',
  });
  writeFileSync(mainPath, harness, 'utf8');

  const child = spawnSync(electronPath, [mainPath], {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0', SAM2_RESULT_OUT: path.join(temp, 'result.json') },
    encoding: 'utf8',
    timeout: 600_000,
  });
  if (child.error) throw child.error;
  const line = (child.stdout || '')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('SAM2_ENGINE_RESULT:'));
  if (!line) {
    process.stderr.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    throw new Error(`SAM 2.1 engine test produced no result (status ${child.status})`);
  }
  const result = JSON.parse(line.slice('SAM2_ENGINE_RESULT:'.length));
  if (result.skipped) {
    console.log('SAM 2.1 engine test skipped: the model component is not installed.');
    console.log(`Looked in ${result.status?.directory}. Install it in the app or set THURSTBOOK_SAM2_DIR.`);
    process.exitCode = 0;
  } else {
    if (!result.ok) {
      process.stderr.write(child.stdout || '');
      process.stderr.write(child.stderr || '');
      throw new Error(result.error || 'SAM 2.1 engine test failed');
    }
    console.log(JSON.stringify(result, null, 2));
    assert.equal(result.status.installed, true, 'the component should report as installed');
    assert.ok(result.primary.count >= FRAMES - 1, `tracked only ${result.primary.count} frames`);
    assert.equal(result.primary.stopped, null, `tracking stopped: ${JSON.stringify(result.primary.stopped)}`);
    assert.ok(result.primary.meanError < 6, `mean centroid error ${result.primary.meanError}`);
    assert.ok(result.primary.maxError < 12, `maximum centroid error ${result.primary.maxError}`);
    assert.ok(result.primary.minQuality >= 45, `minimum quality ${result.primary.minQuality}`);
    assert.ok(result.primary.engine, 'tracks should be tagged with the SAM 2.1 engine');
    assert.ok(result.primary.refMove > 40, `references should follow the object (moved ${result.primary.refMove} px)`);
    assert.ok(result.correction.count >= 3, `correction segment produced ${result.correction.count} frames`);
    assert.ok(result.correction.error !== null && result.correction.error < 8, `corrected outline error ${result.correction.error}`);
    assert.ok(result.scaled.count >= 3, `scaled segment produced ${result.scaled.count} frames`);
    assert.equal(result.scaled.stopped, null, `scaled tracking stopped: ${JSON.stringify(result.scaled.stopped)}`);
    assert.ok(result.scaled.maxError !== null && result.scaled.maxError < 10, `scaled centroid error ${result.scaled.maxError}`);
    assert.ok(result.scaled.maxReferenceError !== null && result.scaled.maxReferenceError < 10, `scaled reference error ${result.scaled.maxReferenceError}`);
    assert.ok(Math.abs(result.scaled.area - 10304) < 1200, `scaled mask area ${result.scaled.area} should be in source pixels`);
    assert.ok(result.camera.count >= 5, `camera segment produced ${result.camera.count} frames`);
    assert.ok(result.camera.validFrames >= 3, `only ${result.camera.validFrames} frames had a valid background estimate`);
    assert.ok(Math.abs(result.camera.meanDx - 3) < 2, `camera dx ${result.camera.meanDx} should be near 3 px`);
    console.log('\nSAM 2.1 engine integration passed: outline refinement, mask propagation, keyframe correction and background translation.');
  }
} finally {
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (error) {
    console.error(`Could not remove the temporary engine test directory: ${error.message}`);
  }
}
