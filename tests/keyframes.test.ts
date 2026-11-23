import assert from 'node:assert/strict';
import {
  Keyframe,
  KeyframeCalibration,
  KeyframeMedia,
  KeyframeSet,
  analyseKeyframeSet,
  describeKeyframeScale,
  emptyKeyframeCalibration,
  frameTiming,
  keyframeTime,
  normaliseKeyframeSet,
  removeKeyframeAt,
  reuseKeyframeSet,
  upsertKeyframe,
} from '../src/shared/keyframes';

let passed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}`);
    throw error;
  }
}

function close(actual: number | null | undefined, expected: number, tolerance = 1e-9): void {
  assert.ok(
    actual !== null && actual !== undefined && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, got ${actual}`,
  );
}

function video(overrides: Partial<KeyframeMedia> = {}): KeyframeMedia {
  return {
    kind: 'video',
    path: 'C:/clips/launch.mp4',
    name: 'launch.mp4',
    width: 640,
    height: 360,
    duration: 1,
    frameCount: 3,
    fps: 10,
    timestamps: [0, 0.1, 0.2],
    timingSource: 'video-timestamps',
    variableFrameRate: false,
    ...overrides,
  };
}

function mark(frame: number, time: number | null, x: number, y = 100): Keyframe {
  return { id: `kf-${frame}-${x}-${y}`, frame, time, x, y, notes: '' };
}

function keyframeSet(
  keyframes: Keyframe[],
  calibration: KeyframeCalibration = emptyKeyframeCalibration(),
  media: KeyframeMedia = video(),
): KeyframeSet {
  return { version: 1, name: 'test', media, keyframes, calibration, notes: '' };
}

function knownScale(
  knownLength: number,
  lengthUnit: string,
  pointA = { x: 0, y: 0 },
  pointB = { x: 100, y: 0 },
): KeyframeCalibration {
  return { mode: 'scale', pointA, pointB, knownLength, lengthUnit, notes: '' };
}

console.log('Keyframe analyser measurement tests');

test('two keyframes measure the pixel difference with no calibration', () => {
  const result = analyseKeyframeSet(keyframeSet([mark(0, 0, 100), mark(2, 0.2, 120)]));
  assert.equal(result.rows.length, 2);
  close(result.rows[1].intervalDistance, 20);
  close(result.rows[1].intervalSeconds, 0.2);
  close(result.rows[1].speed, 100);
  close(result.summary.duration, 0.2);
  close(result.summary.totalDistance, 20);
  close(result.summary.displacement, 20);
  close(result.summary.averageSpeed, 100);
  close(result.summary.maxSpeed, 100);
  assert.equal(result.summary.unit, 'px');
  assert.equal(result.summary.velocityUnit, 'px/s');
  assert.equal(result.summary.calibrated, false);
  assert.ok(result.summary.warnings.some((warning) => warning.includes('pixels')));
});

test('a known distance converts interval distance and speed to metres', () => {
  const result = analyseKeyframeSet(
    keyframeSet([mark(0, 0, 100), mark(1, 0.1, 110), mark(2, 0.2, 120)], knownScale(1, 'm')),
  );
  close(result.rows[1].intervalDistance, 0.1);
  close(result.rows[1].speed, 1);
  close(result.rows[2].speed, 1);
  close(result.rows[2].acceleration, 0);
  close(result.summary.totalDistance, 0.2);
  close(result.summary.averageSpeed, 1);
  close(result.summary.maxAcceleration, 0);
  assert.equal(result.summary.calibrated, true);
  assert.equal(result.summary.unit, 'm');
  assert.equal(result.summary.velocityUnit, 'm/s');
  assert.equal(result.summary.accelerationUnit, 'm/s²');
  assert.ok(result.summary.warnings.some((warning) => warning.includes('flat, fronto-parallel')));
});

test('calibration in centimetres keeps centimetre results', () => {
  const media = video({ frameCount: 2, timestamps: [0, 0.5], fps: 2, duration: 0.5 });
  const result = analyseKeyframeSet(
    keyframeSet([mark(0, 0, 10), mark(1, 0.5, 20)], knownScale(100, 'cm', { x: 0, y: 0 }, { x: 50, y: 0 }), media),
  );
  close(result.rows[1].intervalDistance, 20);
  close(result.rows[1].speed, 40);
  assert.equal(result.summary.unit, 'cm');
  assert.equal(result.summary.velocityUnit, 'cm/s');
});

test('acceleration is the second difference of interval speeds', () => {
  const media = video({ frameCount: 3, timestamps: [0, 0.2, 0.4], fps: 5, duration: 0.4 });
  const result = analyseKeyframeSet(
    keyframeSet([mark(0, 0, 0), mark(1, 0.2, 2), mark(2, 0.4, 6)], knownScale(1, 'm', { x: 0, y: 0 }, { x: 1, y: 0 }), media),
  );
  close(result.rows[1].speed, 10);
  close(result.rows[2].speed, 20);
  close(result.rows[2].acceleration, 50);
  close(result.summary.maxAcceleration, 50);
  assert.equal(result.rows[0].acceleration, null);
  assert.equal(result.rows[1].acceleration, null);
});

test('unequal intervals use each interval’s own time difference', () => {
  const media = video({ frameCount: 3, timestamps: [0, 0.1, 0.4], fps: null, duration: 0.4 });
  const result = analyseKeyframeSet(keyframeSet([mark(0, 0, 0), mark(1, 0.1, 10), mark(2, 0.4, 40)], emptyKeyframeCalibration(), media));
  close(result.rows[1].speed, 100);
  close(result.rows[2].speed, 100);
  close(result.rows[2].intervalSeconds, 0.3);
  close(result.rows[2].acceleration, 0);
  close(result.summary.averageSpeed, 100);
});

test('keyframes without times report distances but no speeds', () => {
  const media = video({ frameCount: null, timestamps: [], fps: null, timingSource: 'unknown', duration: null });
  const result = analyseKeyframeSet(keyframeSet([mark(0, null, 0), mark(3, null, 30)], emptyKeyframeCalibration(), media));
  close(result.rows[1].intervalDistance, 30);
  assert.equal(result.rows[1].speed, null);
  assert.equal(result.rows[1].intervalSeconds, null);
  assert.equal(result.summary.duration, 0);
  assert.equal(result.summary.maxSpeed, 0);
  assert.ok(result.summary.warnings.some((warning) => warning.includes('no frame time')));
});

test('a zero time difference does not invent an infinite speed', () => {
  const result = analyseKeyframeSet(keyframeSet([mark(0, 0.2, 0), mark(1, 0.2, 10), mark(2, 0.4, 20)]));
  assert.equal(result.rows[1].intervalSeconds, null);
  assert.equal(result.rows[1].speed, null);
  close(result.rows[2].speed, 50);
  assert.equal(result.rows[2].acceleration, null);
  assert.ok(result.summary.warnings.some((warning) => warning.includes('no positive time difference')));
});

test('rows follow frame order even when the saved list is unsorted', () => {
  const result = analyseKeyframeSet(keyframeSet([mark(2, 0.2, 120), mark(0, 0, 100), mark(1, 0.1, 110)]));
  assert.deepEqual(result.rows.map((row) => row.frame), [0, 1, 2]);
  close(result.rows[2].cumulativeDistance, 20);
});

test('direction and net direction use image axes with y downwards', () => {
  const result = analyseKeyframeSet(keyframeSet([mark(0, 0, 100, 100), mark(1, 0.1, 100, 50)]));
  close(result.rows[1].directionDeg, -90);
  close(result.summary.netDirectionDeg, -90);
  close(result.summary.displacement, 50);
});

test('a single keyframe has no interval measurement', () => {
  const result = analyseKeyframeSet(keyframeSet([mark(0, 0, 100)]));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].intervalDistance, null);
  assert.equal(result.summary.keyframes, 1);
  assert.equal(result.summary.timedKeyframes, 1);
  assert.ok(result.summary.warnings.some((warning) => warning.includes('at least two keyframes')));
});

test('an incomplete known distance keeps pixel units and explains why', () => {
  const calibration: KeyframeCalibration = { mode: 'scale', pointA: { x: 0, y: 0 }, pointB: { x: 0, y: 0 }, knownLength: 1, lengthUnit: 'm', notes: '' };
  const result = analyseKeyframeSet(keyframeSet([mark(0, 0, 0), mark(1, 0.1, 10)], calibration));
  assert.equal(result.scale.calibrated, false);
  assert.equal(result.summary.unit, 'px');
  assert.ok(result.summary.warnings.some((warning) => warning.includes('two distinct scale reference points')));
});

test('upsert replaces a keyframe at the same frame and keeps the order', () => {
  const initial = [mark(0, 0, 100), mark(2, 0.2, 120)];
  const updated = upsertKeyframe(initial, mark(1, 0.1, 110));
  assert.deepEqual(updated.map((entry) => entry.frame), [0, 1, 2]);
  const replaced = upsertKeyframe(updated, { ...mark(1, 0.1, 999), id: 'replacement' });
  assert.equal(replaced.length, 3);
  assert.equal(replaced[1].x, 999);
  assert.equal(replaced[1].id, 'replacement');
  assert.deepEqual(removeKeyframeAt(replaced, 1).map((entry) => entry.frame), [0, 2]);
});

test('frame time prefers decoded timestamps and falls back to an explicit FPS only', () => {
  assert.equal(keyframeTime(video(), 1), 0.1);
  const noTimestamps = video({ timestamps: [], fps: 20, frameCount: 10 });
  close(keyframeTime(noTimestamps, 5), 0.25);
  const unknown = video({ timestamps: [], fps: null });
  assert.equal(keyframeTime(unknown, 5), null);
});

test('frame timing reports variable intervals', () => {
  const regular = frameTiming([0, 0.1, 0.2, 0.3]);
  close(regular.fps ?? 0, 10);
  assert.equal(regular.variable, false);
  const variable = frameTiming([0, 0.1, 0.2, 0.5]);
  assert.equal(variable.variable, true);
  assert.equal(frameTiming([]).fps, null);
});

test('scale description names the unit and pixels', () => {
  const calibration = knownScale(2, 'm', { x: 10, y: 10 }, { x: 210, y: 10 });
  const result = analyseKeyframeSet(keyframeSet([mark(0, 0, 10, 10), mark(1, 1, 210, 10)], calibration));
  const text = describeKeyframeScale(result.scale, calibration);
  assert.ok(text.includes('2 m over 200.0 px'));
  assert.ok(text.includes('m/px'));
});

test('normalising a saved set drops invalid marks and repairs a bad calibration', () => {
  const normalised = normaliseKeyframeSet({
    name: 'Launch',
    media: { kind: 'video', path: 'clip.mp4', width: '640', height: 360, timestamps: [0.2, 0, 0.1, 0.1], fps: '10' },
    keyframes: [
      { frame: 5, x: 1, y: 2 },
      { frame: 2, x: '3', y: 4, time: 0.2 },
      { frame: 5, x: 9, y: 9, time: 0.5 },
      { frame: -1, x: 0, y: 0 },
      { frame: 1, x: 'bad', y: 1 },
    ],
    calibration: { mode: 'homography', knownLength: -4, lengthUnit: 'kg' },
  });
  assert.equal(normalised.keyframes.length, 2);
  assert.deepEqual(normalised.keyframes.map((entry) => entry.frame), [2, 5]);
  assert.equal(normalised.keyframes[1].x, 9);
  assert.deepEqual(normalised.media.timestamps, [0, 0.1, 0.2]);
  assert.equal(normalised.calibration.mode, 'none');
  assert.equal(normalised.calibration.knownLength, 1);
  assert.equal(normalised.calibration.lengthUnit, 'm');
  assert.equal(normalised.version, 1);
});

test('reusing a saved set scales positions to another resolution and retimes marks', () => {
  const source = keyframeSet(
    [mark(0, 0, 100), mark(5, 0.5, 200), mark(20, 2, 300)],
    knownScale(1, 'm', { x: 0, y: 0 }, { x: 100, y: 100 }),
    video({ width: 640, height: 360, frameCount: 21, timestamps: Array.from({ length: 21 }, (_, index) => index / 10) }),
  );
  const targetMedia = video({
    width: 320,
    height: 180,
    frameCount: 10,
    fps: 10,
    timestamps: Array.from({ length: 10 }, (_, index) => index / 10),
  });
  const reused = reuseKeyframeSet(source, targetMedia);
  assert.equal(reused.keyframes.length, 2);
  assert.equal(reused.dropped, 1);
  assert.equal(reused.scaled, true);
  assert.deepEqual(reused.keyframes.map((entry) => entry.frame), [0, 5]);
  close(reused.keyframes[0].x, 50);
  close(reused.keyframes[0].y, 50);
  close(reused.keyframes[1].x, 100);
  close(reused.keyframes[1].time, 0.5);
  close(reused.calibration.pointB!.x, 50);
  close(reused.calibration.pointB!.y, 50);
  assert.notEqual(reused.keyframes[0].id, source.keyframes[0].id);
});

test('reusing a set at the same resolution keeps positions exact', () => {
  const source = keyframeSet([mark(0, 0, 123.25), mark(1, 0.1, 456.75)]);
  const reused = reuseKeyframeSet(source, video());
  assert.equal(reused.scaled, false);
  assert.equal(reused.dropped, 0);
  close(reused.keyframes[0].x, 123.25);
  close(reused.keyframes[1].x, 456.75);
});

test('a reused calibration measures in the target resolution’s units', () => {
  const source = keyframeSet(
    [mark(0, 0, 100), mark(5, 0.5, 200)],
    knownScale(1, 'm', { x: 0, y: 0 }, { x: 100, y: 0 }),
    video({ width: 640, height: 360 }),
  );
  const target = video({ width: 1280, height: 720, frameCount: 10, timestamps: Array.from({ length: 10 }, (_, index) => index / 10) });
  const reused = reuseKeyframeSet(source, target);
  const result = analyseKeyframeSet({ ...source, media: target, keyframes: reused.keyframes, calibration: reused.calibration });
  close(result.summary.totalDistance, 1);
  close(result.summary.maxSpeed, 2);
});

console.log(`\nKeyframe analyser tests passed: ${passed}`);
