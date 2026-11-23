import { MotionPoint, MotionReferencePoint, TrackFrame, mergeTrackedFrames, polygonCentroid } from '../src/shared/motion';
import { TrackerClient } from '../src/renderer/motion/trackerClient';

declare global {
  interface Window {
    __trackerDone?: boolean;
    __trackerResult?: any;
  }
}

console.log('TRACKER_HARNESS_START');
window.addEventListener('error', (event) => {
  window.__trackerResult = { ok: false, error: `Unhandled error: ${event.message}`, stack: event.error?.stack };
  window.__trackerDone = true;
});
window.addEventListener('unhandledrejection', (event) => {
  window.__trackerResult = { ok: false, error: `Unhandled rejection: ${String(event.reason)}`, stack: event.reason?.stack };
  window.__trackerDone = true;
});

const WIDTH = 320;
const HEIGHT = 240;
const FRAMES = 30;
const canvas = document.createElement('canvas');
canvas.width = WIDTH;
canvas.height = HEIGHT;
const context = canvas.getContext('2d', { willReadFrequently: true })!;

function drawBackground() {
  context.fillStyle = '#20262d';
  context.fillRect(0, 0, WIDTH, HEIGHT);
  for (let i = 0; i < 120; i++) {
    const x = (i * 73) % WIDTH;
    const y = (i * 41) % HEIGHT;
    context.fillStyle = i % 3 === 0 ? '#39434e' : '#2b333c';
    context.fillRect(x, y, 2 + (i % 3), 2 + (i % 5));
  }
  context.strokeStyle = '#45525f';
  context.lineWidth = 1;
  for (let x = 20; x < WIDTH; x += 40) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, HEIGHT);
    context.stroke();
  }
}

function drawCheckerObject(x: number, y: number, w: number, h: number, angle: number, bright: boolean) {
  context.save();
  context.translate(x + w / 2, y + h / 2);
  context.rotate(angle);
  const cell = 8;
  for (let row = 0; row < Math.ceil(h / cell); row++) {
    for (let column = 0; column < Math.ceil(w / cell); column++) {
      const light = (row + column) % 2 === 0;
      context.fillStyle = bright
        ? light
          ? '#f5f1df'
          : '#1a2229'
        : light
          ? '#8fe0c0'
          : '#173b32';
      context.fillRect(-w / 2 + column * cell, -h / 2 + row * cell, cell, cell);
    }
  }
  context.strokeStyle = bright ? '#ffd166' : '#b7f0ff';
  context.lineWidth = 2;
  context.strokeRect(-w / 2, -h / 2, w, h);
  context.fillStyle = bright ? '#d34f4f' : '#f0b75a';
  context.fillRect(-w / 2 + 2, -h / 2 + 2, 5, 5);
  context.restore();
}

function drawFrame(index: number, cameraMotion = false) {
  const cameraX = cameraMotion ? index * 2 : 0;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, WIDTH, HEIGHT);
  context.save();
  context.translate(cameraX, 0);
  drawBackground();
  // With cameraMotion the whole scene translates, so the object is stationary
  // relative to its background while moving in the image.
  drawCheckerObject(30 + (cameraMotion ? 0 : index * 4), 100, 60, 40, 0, true);
  drawCheckerObject(225 - (cameraMotion ? 0 : index * 2.5), 55 + (cameraMotion ? 0 : index * 0.5), 44, 44, cameraMotion ? 0 : (index * 3 * Math.PI) / 180, false);
  context.restore();
}

function rect(x: number, y: number, w: number, h: number): MotionPoint[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

function references(cx: number, cy: number): MotionReferencePoint[] {
  return [
    { id: 'tail', name: 'Tail', point: { x: cx - 20, y: cy } },
    { id: 'nose', name: 'Nose', point: { x: cx + 20, y: cy } },
  ];
}

async function trackRun(
  client: TrackerClient,
  name: string,
  polygon: MotionPoint[],
  refs: MotionReferencePoint[],
  protectedFrames: number[],
  cameraMotion = false,
  start = 0,
  end = FRAMES - 1,
): Promise<{ frames: TrackFrame[]; stoppedAt: number | null; reason: string }> {
  await client.start({
    object: { id: name, name, polygon, references: refs },
    sourceWidth: WIDTH,
    sourceHeight: HEIGHT,
    scale: 1,
    startFrame: start,
    endFrame: end,
    frameCount: FRAMES,
    qualityThreshold: 25,
    maxFeatures: 220,
    protectedFrames,
    compensateCamera: cameraMotion,
  });
  const frames: TrackFrame[] = [];
  let stoppedAt: number | null = null;
  let reason = '';
  for (let index = start; index <= end; index++) {
    drawFrame(index, cameraMotion);
    const image = context.getImageData(0, 0, WIDTH, HEIGHT);
    const reply = await client.step(index, index / 30, image);
    if (reply.type === 'stopped') {
      stoppedAt = reply.stoppedAt ?? index;
      reason = reply.reason ?? 'stopped';
      break;
    }
    if (reply.track) frames.push(reply.track);
  }
  return { frames, stoppedAt, reason };
}

function summarize(result: { frames: TrackFrame[]; stoppedAt: number | null; reason: string }) {
  const last = result.frames[result.frames.length - 1];
  const start = result.frames[0];
  return {
    count: result.frames.length,
    stoppedAt: result.stoppedAt,
    reason: result.reason,
    startX: polygonCentroid(start.polygon).x,
    startY: polygonCentroid(start.polygon).y,
    lastX: polygonCentroid(last.polygon).x,
    lastY: polygonCentroid(last.polygon).y,
    lastQuality: last.quality,
    uncertain: result.frames.filter((f) => f.status === 'uncertain').length,
    statuses: [...new Set(result.frames.map((f) => f.status))],
    minimumQuality: Math.min(...result.frames.map((f) => f.quality)),
    maximumQuality: Math.max(...result.frames.map((f) => f.quality)),
    cameraDx: result.frames.reduce((sum, f) => sum + (f.cameraDx ?? 0), 0) / Math.max(1, result.frames.length),
    cameraValidCount: result.frames.filter((f) => f.cameraValid).length,
  };
}

async function run() {
  console.log('TRACKER_HARNESS_RUN');
  const client = new TrackerClient();
  try {
    console.log('TRACKER_HARNESS_LOADING_OPENCV');
    await Promise.race([
      client.ready(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Worker OpenCV load timed out after 45 s')), 45000)),
    ]);
    console.log('TRACKER_HARNESS_OPENCV_READY');

    const first = await trackRun(client, 'Translating', rect(25, 95, 70, 50), references(60, 120), []);
    console.log('TRACKER_HARNESS_FIRST_DONE', first.frames.length);
    const second = await trackRun(client, 'Rotating', rect(198, 28, 82, 82), [], []);
    console.log('TRACKER_HARNESS_SECOND_DONE', second.frames.length);
    const protectedRun = await trackRun(client, 'Protected', rect(25, 95, 70, 50), [], [8]);
    console.log('TRACKER_HARNESS_PROTECTED_DONE', protectedRun.frames.length);
    const cameraRun = await trackRun(client, 'Camera', rect(25, 95, 70, 50), [], [], true);
    console.log('TRACKER_HARNESS_CAMERA_DONE', cameraRun.frames.length);

    // Keyframe workflow: the first segment ends before a corrected keyframe;
    // the second segment restarts from that keyframe's geometry. The page skips
    // the keyframe's generated copy, so the manual geometry survives the merge.
    const keyframe = first.frames[15];
    const firstSegment = await trackRun(client, 'Keyframe A', rect(25, 95, 70, 50), [], [], false, 0, 14);
    const secondSegment = await trackRun(client, 'Keyframe B', keyframe.polygon, keyframe.references, [], false, 15, FRAMES - 1);
    const keyframeAt15 = { ...keyframe, status: 'manual' as const, quality: 100 };
    const merged = mergeTrackedFrames(
      [...first.frames.slice(0, 15), keyframeAt15, ...first.frames.slice(16)],
      [...firstSegment.frames, ...secondSegment.frames.filter((frame) => frame.frame !== 15)],
      [15],
      0,
      FRAMES - 1,
      null,
    );
    console.log('TRACKER_HARNESS_KEYFRAME_DONE', merged.length);

    window.__trackerResult = {
      ok: true,
      first: summarize(first),
      second: summarize(second),
      protected: summarize(protectedRun),
      camera: summarize(cameraRun),
      keyframes: {
        mergedCount: merged.length,
        firstSegmentCount: firstSegment.frames.length,
        secondSegmentCount: secondSegment.frames.length,
        manualFrameCount: merged.filter((frame) => frame.frame === 15).length,
        keyframeX: polygonCentroid(merged.find((frame) => frame.frame === 15)!.polygon).x,
        expectedKeyframeX: polygonCentroid(keyframe.polygon).x,
        finalX: polygonCentroid(merged[merged.length - 1].polygon).x,
      },
    };
  } finally {
    client.dispose();
  }
}

run()
  .catch((err) => {
    console.error('TRACKER_HARNESS_ERROR', err);
    window.__trackerResult = { ok: false, error: err?.message ?? String(err), stack: err?.stack };
  })
  .finally(() => {
    window.__trackerDone = true;
  });
