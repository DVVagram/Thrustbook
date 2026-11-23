import assert from 'node:assert/strict';
import {
  DEFAULT_CALIBRATION,
  DEFAULT_MOTION_SETTINGS,
  MotionAnalysis,
  MotionCalibration,
  MotionObject,
  MotionPoint,
  MotionReferencePoint,
  TrackFrame,
  analyseObject,
  applyHomography,
  buildCsv,
  buildPixelCalibration,
  foreshorteningEstimate,
  frameIntervalStats,
  mergeTrackedFrames,
  normaliseTimestamps,
  planTrackingSegments,
  polygonCentroid,
  rectanglePolygon,
  solveHomography,
} from '../src/shared/motion';
import { convertUnit } from '../src/shared/units';
import { buildMotionReport } from '../src/renderer/motion/report';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

function near(actual: number | null | undefined, expected: number, tolerance: number, label: string) {
  assert.equal(typeof actual, 'number', `${label}: expected a number, got ${actual}`);
  assert.ok(Math.abs((actual as number) - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function square(cx: number, cy: number, half = 18): MotionPoint[] {
  return rectanglePolygon({ x: cx - half, y: cy - half }, { x: cx + half, y: cy + half });
}

function refs(cx: number, cy: number, angleDeg = 90): MotionReferencePoint[] {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad) * 20;
  const dy = Math.sin(rad) * 20;
  return [
    { id: 'tail', name: 'Tail', point: { x: cx - dx, y: cy - dy } },
    { id: 'nose', name: 'Nose', point: { x: cx + dx, y: cy + dy } },
  ];
}

function frame(
  index: number,
  time: number,
  cx: number,
  cy: number,
  angleDeg = 90,
  status: TrackFrame['status'] = 'tracked',
  camera?: { dx: number; dy: number; valid?: boolean },
): TrackFrame {
  const polygon = square(cx, cy);
  return {
    frame: index,
    time,
    polygon,
    references: refs(cx, cy, angleDeg),
    bbox: { x: cx - 18, y: cy - 18, width: 36, height: 36 },
    status,
    quality: status === 'uncertain' ? 30 : 95,
    qualityNotes: status === 'uncertain' ? ['review'] : [],
    featureCount: 24,
    inlierRatio: 0.9,
    fbError: 0.2,
    cameraDx: camera?.dx ?? 0,
    cameraDy: camera?.dy ?? 0,
    cameraValid: camera?.valid ?? false,
  };
}

function objectOf(frames: TrackFrame[], actualLength = 0, lengthUnit = 'cm'): MotionObject {
  return {
    id: 'object-1',
    name: 'Test object',
    color: '#5cc8ff',
    initialFrame: frames[0].frame,
    initialPolygon: frames[0].polygon,
    initialReferences: frames[0].references,
    referenceLength: 0,
    actualLength,
    lengthUnit,
    frames,
    manualFrames: frames.filter((f) => f.status === 'manual').map((f) => f.frame),
    notes: '',
  };
}

function calibration(patch: Partial<MotionCalibration> = {}): MotionCalibration {
  return {
    ...DEFAULT_CALIBRATION,
    mode: 'scale',
    scalePointA: { x: 0, y: 0 },
    scalePointB: { x: 100, y: 0 },
    knownLength: 10,
    lengthUnit: 'cm',
    ...patch,
  };
}

const settings = { smoothingWindow: 1, startFrame: 0, endFrame: 0 };

test('stationary object has zero displacement, distance and speed', () => {
  const frames = Array.from({ length: 12 }, (_, i) => frame(i, i / 30, 100, 100));
  const result = analyseObject(objectOf(frames), calibration(), settings);
  near(result.summary.distance, 0, 1e-9, 'distance');
  near(result.summary.displacement, 0, 1e-9, 'displacement');
  near(result.summary.maxSpeed, 0, 1e-9, 'max speed');
  assert.equal(result.summary.calibrated, true);
});

test('constant horizontal motion: calibrated speed and direction', () => {
  const frames = Array.from({ length: 31 }, (_, i) => frame(i, i / 30, 100 + i * 10, 100));
  const result = analyseObject(objectOf(frames), calibration(), settings);
  near(result.summary.maxSpeed, 30, 1e-6, '30 cm/s speed');
  near(result.summary.averageSpeed, 30, 1e-6, '30 cm/s average');
  near(result.summary.distance, 30, 1e-6, '30 cm distance');
  near(result.summary.displacement, 30, 1e-6, '30 cm displacement');
  near(result.frames[0].directionDeg, 0, 1e-6, 'direction');
  near(result.summary.netDirectionDeg, 0, 1e-6, 'net direction');
});

test('constant vertical motion is separated from horizontal motion', () => {
  const frames = Array.from({ length: 20 }, (_, i) => frame(i, i / 20, 100, 200 - i * 8));
  const result = analyseObject(objectOf(frames), calibration(), settings);
  near(result.summary.maxSpeed, 16, 1e-6, 'vertical speed');
  near(result.frames[5].vx, 0, 1e-6, 'vx');
  near(result.frames[5].vy, -16, 1e-6, 'vy');
  near(result.frames[5].directionDeg, -90, 1e-6, 'direction is up in image coordinates');
});

test('diagonal motion: magnitude and components', () => {
  const frames = Array.from({ length: 15 }, (_, i) => frame(i, i / 10, 100 + i * 6, 100 + i * 8));
  const result = analyseObject(objectOf(frames), calibration(), settings);
  near(result.frames[5].vx, 6, 1e-6, 'vx');
  near(result.frames[5].vy, 8, 1e-6, 'vy');
  near(result.frames[5].speed, 10, 1e-6, 'speed magnitude');
  near(result.frames[5].directionDeg, 53.130102, 1e-5, 'direction');
});

test('distance travelled differs from displacement on an out-and-back path', () => {
  const xs = [0, 10, 20, 10, 0];
  const frames = xs.map((x, i) => frame(i, i, 100 + x, 100));
  const result = analyseObject(objectOf(frames), calibration({ knownLength: 100, lengthUnit: 'cm' }), settings);
  near(result.summary.distance, 40, 1e-6, 'distance');
  near(result.summary.displacement, 0, 1e-6, 'displacement');
});

test('constant acceleration is recovered from position samples', () => {
  const frames = Array.from({ length: 31 }, (_, i) => {
    const t = i / 10;
    return frame(i, t, 100 + 0.5 * 10 * t * t, 100);
  });
  const result = analyseObject(objectOf(frames), calibration({ knownLength: 100, lengthUnit: 'cm' }), settings);
  const middle = result.frames[15];
  near(middle.ax, 10, 0.35, 'acceleration approx 10 cm/s²');
  near(middle.speed, 15, 0.05, 'speed approx 15 cm/s at t=1.5 s');
  assert.ok(result.summary.maxAcceleration > 9, 'maximum acceleration should be reported');
});

test('variable frame timing uses actual timestamps, not an assumed FPS', () => {
  const times = [0, 0.1, 0.25, 0.4, 0.7];
  const frames = times.map((t, i) => frame(i, t, 100 + t * 100, 100));
  const result = analyseObject(objectOf(frames), calibration({ knownLength: 10, lengthUnit: 'cm' }), settings);
  near(result.frames[1].speed, 10, 0.2, 'speed at variable interval');
  near(result.frames[3].speed, 10, 1e-6, 'speed at later variable interval');
  near(result.summary.duration, 0.7, 1e-9, 'elapsed time');
  const stats = frameIntervalStats(times);
  assert.equal(stats.variable, true);
});

test('rotated coordinate system projects motion onto user axes', () => {
  const frames = Array.from({ length: 10 }, (_, i) => frame(i, i / 10, 100, 100 + i * 10));
  const cal = calibration({
    mode: 'rotated',
    origin: { x: 100, y: 100 },
    scalePointA: { x: 0, y: 0 },
    scalePointB: { x: 100, y: 0 },
    knownLength: 100,
    lengthUnit: 'cm',
    xAxisPoint: { x: 100, y: 200 },
    yAxisPoint: { x: 0, y: 100 },
  });
  const result = analyseObject(objectOf(frames), cal, settings);
  near(result.frames[1].x, 10, 1e-9, 'X along user X axis');
  near(result.frames[1].y, 0, 1e-9, 'Y perpendicular');
  near(result.frames[1].speed, 100, 1e-6, 'speed in rotated frame');
});

test('unit conversion remains consistent for inches', () => {
  const frames = Array.from({ length: 11 }, (_, i) => frame(i, i / 10, 100 + i * 10, 100));
  const result = analyseObject(objectOf(frames), calibration({ knownLength: 10, lengthUnit: 'in' }), settings);
  assert.equal(result.summary.unit, 'in');
  assert.equal(result.summary.velocityUnit, 'in/s');
  near(result.summary.maxSpeed, 10, 1e-6, '10 in/s');
  near(convertUnit(2.54, 'cm', 'in')!, 1, 1e-12, 'cm to inch');
});

test('four-corner planar homography maps a known plane', () => {
  const cal = calibration({
    mode: 'homography',
    homographyPoints: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    homographyWidth: 10,
    homographyHeight: 10,
    lengthUnit: 'm',
  });
  const pixel = buildPixelCalibration(cal);
  assert.equal(pixel.calibrated, true);
  const mapped = pixel.toMetric({ x: 50, y: 50 });
  near(mapped.x, 5, 1e-9, 'homography x');
  near(mapped.y, 5, 1e-9, 'homography y');
  const h = solveHomography(cal.homographyPoints, [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]);
  assert.ok(h);
  near(applyHomography({ x: 100, y: 100 }, h!)!.x, 10, 1e-9, 'direct homography x');
});

test('incomplete calibration never produces falsely labelled physical results', () => {
  const frames = Array.from({ length: 8 }, (_, i) => frame(i, i / 30, 100 + i * 10, 100));
  const result = analyseObject(objectOf(frames), calibration({ scalePointB: { x: 0, y: 0 } }), settings);
  assert.equal(result.summary.calibrated, false);
  assert.equal(result.summary.unit, 'px');
  assert.equal(result.summary.velocityUnit, 'px/s');
  assert.equal(result.frames[1].calibrated, false);
});

test('object length gives relative distance without claiming absolute scale', () => {
  const frames = Array.from({ length: 11 }, (_, i) => frame(i, i, 100 + i * 10, 100));
  const result = analyseObject(objectOf(frames, 20, 'cm'), calibration({ knownLength: 100, lengthUnit: 'cm' }), settings);
  near(result.frames[5].relativeDistance, 2.5, 1e-6, 'distance / object length');
});

test('relative distance is withheld without a physical calibration', () => {
  const frames = Array.from({ length: 11 }, (_, i) => frame(i, i, 100 + i * 10, 100));
  const result = analyseObject(objectOf(frames, 20, 'cm'), calibration({ mode: 'none' }), settings);
  assert.equal(result.summary.calibrated, false);
  assert.equal(result.frames[5].relativeDistance, null);
});

test('projected orientation and angular velocity are separate from travel direction', () => {
  const frames = [
    frame(0, 0, 100, 100, 90),
    frame(1, 1, 110, 100, 45),
    frame(2, 2, 120, 100, 0),
  ];
  const result = analyseObject(objectOf(frames), calibration({ knownLength: 100, lengthUnit: 'cm' }), settings);
  near(result.frames[0].orientationDeg!, 90, 1e-6, 'initial projected orientation');
  near(result.frames[1].orientationDeg!, 45, 1e-6, 'rotated projected orientation');
  near(result.frames[1].angularVelocityDeg!, -45, 1e-6, 'angular velocity');
  near(result.frames[1].directionDeg!, 0, 1e-6, 'travel direction remains horizontal');
  assert.notEqual(result.frames[1].orientationDeg, result.frames[1].directionDeg);
});

test('foreshortening is labelled as an orthographic estimate and rejects impossible ratios', () => {
  const estimate = foreshorteningEstimate(5, 10);
  assert.equal(estimate.valid, true);
  near(estimate.angleDeg!, 30, 1e-6, 'sin(theta)=0.5');
  assert.match(estimate.reason, /not the camera mounting angle/i);
  assert.equal(foreshorteningEstimate(11, 10).valid, false);
  assert.equal(foreshorteningEstimate(5, 0).valid, false);
});

test('timestamps are normalised without inventing frame timing', () => {
  assert.deepEqual(normaliseTimestamps([0.2, 0, 0.2, -1, Number.NaN, 0.1]), [0, 0.1, 0.2]);
  assert.deepEqual(normaliseTimestamps([]), []);
  assert.equal(frameIntervalStats([]).fps, null);
  assert.equal(frameIntervalStats([0]).fps, null);
});

test('polygon geometry handles rectangles and centroids', () => {
  const rectangle = rectanglePolygon({ x: 20, y: 30 }, { x: 10, y: 10 });
  assert.deepEqual(rectangle, [
    { x: 10, y: 10 },
    { x: 20, y: 10 },
    { x: 20, y: 30 },
    { x: 10, y: 30 },
  ]);
  const centroid = polygonCentroid(rectangle);
  near(centroid.x, 15, 1e-9, 'centroid x');
  near(centroid.y, 20, 1e-9, 'centroid y');
});

test('CSV export preserves units, quality and measurement status', () => {
  const frames = [frame(0, 0, 100, 100, 90, 'manual'), frame(1, 0.1, 110, 100, 90, 'uncertain')];
  const result = analyseObject(objectOf(frames), calibration(), settings);
  const csv = buildCsv(objectOf(frames), result);
  assert.match(csv, /timestamp_s/);
  assert.match(csv, /speed_cm\/s/);
  assert.match(csv, /tracking_quality/);
  assert.match(csv, /manual-corrected/);
  assert.match(csv, /tracked-calibrated/);
  assert.match(csv, /Test object/);
});

test('tracking-quality uncertainty is preserved rather than discarded', () => {
  const frames = [frame(0, 0, 100, 100, 90), frame(1, 0.1, 110, 100, 90, 'uncertain')];
  const result = analyseObject(objectOf(frames), calibration(), settings);
  assert.equal(result.frames[1].status, 'uncertain');
  assert.equal(result.frames[1].quality, 30);
});

test('tracking segments split at every user keyframe', () => {
  assert.deepEqual(planTrackingSegments(1, 100, [20, 40, 60]), [
    { start: 1, end: 19, keyframe: false },
    { start: 20, end: 39, keyframe: true },
    { start: 40, end: 59, keyframe: true },
    { start: 60, end: 100, keyframe: true },
  ]);
  assert.deepEqual(planTrackingSegments(0, 10, []), [{ start: 0, end: 10, keyframe: false }]);
  assert.deepEqual(planTrackingSegments(5, 10, [2, 8]), [{ start: 5, end: 7, keyframe: false }, { start: 8, end: 10, keyframe: true }]);
});

test('tracking merge preserves manual keyframes and out-of-range history', () => {
  const existing = [
    frame(0, 0, 100, 100, 90, 'manual'),
    frame(5, 0.5, 150, 100, 90, 'manual'),
    frame(6, 0.6, 140, 100, 90, 'manual'),
    frame(10, 1, 200, 100, 90, 'manual'),
    frame(20, 2, 300, 100, 90, 'tracked'),
    frame(30, 3, 400, 100, 90, 'tracked'),
  ];
  const generated = [
    frame(6, 0.6, 160, 100),
    frame(10, 1, 999, 100),
    frame(20, 2, 320, 100),
  ];
  const merged = mergeTrackedFrames(existing, generated, [0, 5, 6, 10], 6, 20, null);
  assert.equal(merged.find((f) => f.frame === 5)?.polygon[0].x, 132, 'earlier manual frame preserved');
  assert.equal(merged.find((f) => f.frame === 6)?.polygon[0].x, 122, 'the starting keyframe cannot be overwritten');
  assert.equal(merged.find((f) => f.frame === 6)?.status, 'manual');
  assert.equal(merged.find((f) => f.frame === 10)?.polygon[0].x, 182, 'later keyframe cannot be overwritten');
  assert.equal(merged.find((f) => f.frame === 20)?.polygon[0].x, 302, 'in-range automatic frame recalculated');
  assert.ok(merged.some((f) => f.frame === 30), 'frames after the recalculated interval preserved');
  assert.equal(merged.find((f) => f.frame === 10)?.status, 'manual');
});

test('report identifies keyframes, dimensions, camera assumptions and escapes user text', () => {
  const frames = [frame(0, 0, 40, 100), frame(1, 0.1, 50, 100, 90, 'manual'), frame(2, 0.2, 60, 100)];
  const object = { ...objectOf(frames, 10, 'cm'), actualWidth: 4, actualHeight: 5, name: 'Rocket <A>' };
  const analysis: MotionAnalysis = {
    version: 1,
    name: 'Report test',
    media: {
      kind: 'image',
      path: '',
      name: 'frame.png',
      width: 200,
      height: 200,
      duration: null,
      frameCount: 3,
      fps: 10,
      timestamps: [0, 0.1, 0.2],
      timingSource: 'image-sequence',
      variableFrameRate: false,
    },
    objects: [object],
    calibration: { ...DEFAULT_CALIBRATION, mode: 'scale', knownLength: 10, scalePointB: { x: 100, y: 0 }, lengthUnit: 'cm' },
    settings: { ...DEFAULT_MOTION_SETTINGS, compensateCamera: true },
    selectedObjectId: object.id,
    importantFrames: [],
    notes: 'Camera notes <uncertain>',
  };
  const html = buildMotionReport({
    analysis,
    projectName: 'Project',
    results: { [object.id]: analyseObject(object, analysis.calibration, analysis.settings) },
    frameImage: null,
    selectedFrame: 0,
  });
  assert.match(html, /Keyframes/);
  assert.match(html, /Keyframes \/ manual corrections/);
  assert.match(html, /<td>2<\/td><td>0\.1000<\/td>/);
  assert.match(html, /Known dimensions/);
  assert.match(html, /L 10\.000 · W 4\.000 · H 5\.000 cm/);
  assert.match(html, /background translation/);
  assert.match(html, /Rocket &lt;A&gt;/);
  assert.ok(!html.includes('Rocket <A>'), 'user text was not escaped');
  assert.match(html, /Camera notes &lt;uncertain&gt;/);
  assert.match(html, /not a calibrated probability/);
});

test('camera translation compensation removes background motion without hiding missing estimates', () => {
  const compensatedFrames = Array.from({ length: 6 }, (_, i) =>
    frame(i, i / 10, 100 + i * 10, 100, 90, 'tracked', { dx: i === 0 ? 0 : 10, dy: 0, valid: true }),
  );
  const compensated = analyseObject(
    objectOf(compensatedFrames),
    calibration({ knownLength: 100, lengthUnit: 'cm' }),
    { ...settings, compensateCamera: true },
  );
  assert.equal(compensated.summary.cameraCompensated, true);
  near(compensated.summary.distance, 0, 1e-9, 'background motion removed');
  near(compensated.frames[5].cameraDx, 50, 1e-9, 'cumulative camera offset');
  near(compensated.frames[5].pixelX, 150, 1e-9, 'raw image position stays visible');

  const uncompensated = analyseObject(objectOf(compensatedFrames), calibration(), { ...settings, compensateCamera: false });
  assert.equal(uncompensated.summary.cameraCompensated, false);
  near(uncompensated.summary.distance, 5, 1e-9, 'raw motion without compensation');

  const missing = analyseObject(objectOf(compensatedFrames.map((f) => ({ ...f, cameraValid: false }))), calibration(), {
    ...settings,
    compensateCamera: true,
  });
  assert.equal(missing.summary.cameraCompensated, false);
  assert.ok(missing.frames[1].distance > 0.4, 'missing background estimates must not be silently zero-filled');
});

console.log(`\nMotion analysis tests passed: ${passed}`);
