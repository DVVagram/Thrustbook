import assert from 'node:assert/strict';
import {
  buildFlowTrack,
  flowAxisPoints,
  flowQuality,
  polygonIou,
  samplePolygon,
  shouldRunSam,
  warpFlowPolygon,
  type FlowReply,
} from '../src/shared/flow';
import type { MotionPoint, TrackFrame } from '../src/shared/motion';

const rect = (x: number, y: number, width: number, height: number): MotionPoint[] => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
];

function track(polygon: MotionPoint[]): TrackFrame {
  return {
    frame: 2,
    time: 0.2,
    polygon,
    references: [{ id: 'nose', name: 'Nose', point: { x: polygon[1].x - 4, y: polygon[0].y + 4 } }],
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    status: 'tracked',
    quality: 95,
    qualityNotes: [],
    featureCount: 20,
    inlierRatio: 0.9,
    fbError: 0.2,
    engine: 'sam2',
  };
}

// --- samplePolygon ---------------------------------------------------------
{
  const points = samplePolygon(rect(10, 20, 100, 30), 20);
  assert.ok(points.length >= 8 && points.length <= 30, `unexpected sample count ${points.length}`);
  for (const point of points) {
    const onEdge = point.x === 10 || point.x === 110 || point.y === 20 || point.y === 50;
    assert.ok(onEdge || (point.x >= 10 && point.x <= 110 && point.y >= 20 && point.y <= 50), 'samples must stay on the outline');
  }
  assert.ok(points.some((point) => point.x === 10 && point.y === 20), 'vertices are kept');
}

// --- axis points -----------------------------------------------------------
{
  const axis = flowAxisPoints(rect(0, 0, 100, 20), { x: 1, y: 0 });
  assert.ok(Math.abs(axis.centre.x - 50) < 0.5 && Math.abs(axis.centre.y - 10) < 0.5, 'centre is the centroid');
  assert.ok(axis.nose.x > axis.tail.x, 'the nose points along the motion direction');
  assert.equal(axis.nose.x, 100);
  assert.equal(axis.tail.x, 0);
  const reversed = flowAxisPoints(rect(0, 0, 100, 20), { x: -1, y: 0 });
  assert.ok(reversed.nose.x < reversed.tail.x, 'reversing the motion flips the nose');

  const vertical = flowAxisPoints(rect(0, 0, 20, 100), { x: 0, y: 1 });
  assert.equal(vertical.nose.y, 100);
  assert.equal(vertical.tail.y, 0);
}

// --- affine / warp ---------------------------------------------------------
{
  const warped = warpFlowPolygon(rect(0, 0, 10, 10), { a: 1, b: 0, tx: 5, c: 0, d: 1, ty: -2 });
  assert.deepEqual(warped[0], { x: 5, y: -2 });
  const scaled = warpFlowPolygon(rect(0, 0, 10, 10), { a: 2, b: 0, tx: 0, c: 0, d: 2, ty: 0 });
  assert.deepEqual(scaled[2], { x: 20, y: 20 });
}

// --- quality / IoU ---------------------------------------------------------
{
  assert.ok(flowQuality({ inlierRatio: 1, fbError: 0, areaRatio: 1 }).quality >= 95);
  assert.ok(flowQuality({ inlierRatio: 0.3, fbError: 2.5, areaRatio: 1.6 }).quality < 55);
  assert.ok(flowQuality({ inlierRatio: 0.5, fbError: 1, areaRatio: 1 }).quality > 40);
  assert.equal(polygonIou(rect(0, 0, 40, 20), rect(0, 0, 40, 20)), 1);
  assert.equal(polygonIou(rect(0, 0, 40, 20), rect(100, 100, 40, 20)), 0);
  const half = polygonIou(rect(0, 0, 40, 20), rect(20, 0, 40, 20));
  assert.ok(half > 0.2 && half < 0.6, `half overlap was ${half}`);
}

// --- buildFlowTrack --------------------------------------------------------
const previous = track(rect(100, 100, 80, 30));
const shifted = (dx: number, dy: number): FlowReply => ({
  affine: { a: 1, b: 0, tx: dx, c: 0, d: 1, ty: dy },
  points: [],
  inlierRatio: 0.9,
  fbError: 0.2,
  features: 42,
  confidence: 0.9,
  roi: { x: 80, y: 80, width: 140, height: 100 },
});

{
  const built = buildFlowTrack({
    frame: 3,
    time: 0.3,
    previous,
    flow: shifted(6, -2),
    scaleX: 1,
    scaleY: 1,
    frameWidth: 640,
    frameHeight: 360,
    sourceWidth: 1280,
    sourceHeight: 720,
    references: [{ id: 'nose', name: 'Nose', point: { x: 183, y: 98 } }],
    qualityThreshold: 45,
  });
  assert.ok(built, 'a clean translation must produce a frame');
  const result = built!.track;
  assert.equal(result.engine, 'opencv');
  assert.equal(result.polygon[0].x, 106);
  assert.equal(result.status, 'tracked');
  assert.ok(result.quality >= 80, `quality ${result.quality}`);
  assert.ok(result.flow && result.flow.skipped, 'flow frames are marked as skipped SAM frames');
  assert.equal(result.flow.nose.x, 186);
  assert.equal(result.flow.tail.x, 106);
  assert.ok(Math.abs(result.flow.centre.x - 146) < 0.01);
  assert.equal(result.references[0].point.x, 183);
  assert.ok(result.featureCount >= 42);
}

{
  // Two-times scale change is not plausible frame-to-frame.
  const blownUp = buildFlowTrack({
    frame: 3,
    time: 0.3,
    previous,
    flow: { ...shifted(0, 0), affine: { a: 2.4, b: 0, tx: 0, c: 0, d: 2.4, ty: 0 } },
    scaleX: 1,
    scaleY: 1,
    frameWidth: 640,
    frameHeight: 360,
    sourceWidth: 1280,
    sourceHeight: 720,
    references: [],
    qualityThreshold: 45,
  });
  assert.equal(blownUp, null, 'implausible area changes fall back to SAM');
}

{
  const noAffine = buildFlowTrack({
    frame: 3,
    time: 0.3,
    previous,
    flow: { ...shifted(0, 0), affine: null },
    scaleX: 1,
    scaleY: 1,
    frameWidth: 640,
    frameHeight: 360,
    sourceWidth: 1280,
    sourceHeight: 720,
    references: [],
    qualityThreshold: 45,
  });
  assert.equal(noAffine, null);
}

{
  const weak = buildFlowTrack({
    frame: 3,
    time: 0.3,
    previous,
    flow: { ...shifted(3, 0), confidence: 0.2, inlierRatio: 0.2 },
    scaleX: 1,
    scaleY: 1,
    frameWidth: 640,
    frameHeight: 360,
    sourceWidth: 1280,
    sourceHeight: 720,
    references: [],
    qualityThreshold: 45,
  });
  assert.equal(weak, null, 'low-confidence flow must not replace SAM');
}

// Frame coordinates are mapped back to source pixels.
{
  const scaled = buildFlowTrack({
    frame: 3,
    time: 0.3,
    previous,
    flow: shifted(3, -1),
    scaleX: 0.5,
    scaleY: 0.5,
    frameWidth: 320,
    frameHeight: 180,
    sourceWidth: 1280,
    sourceHeight: 720,
    references: [],
    qualityThreshold: 45,
  });
  assert.ok(scaled, 'half-resolution frames are supported');
  assert.equal(scaled!.track.polygon[0].x, 106);
  assert.equal(scaled!.track.polygon[0].y, 98);
}

// --- SAM scheduling --------------------------------------------------------
{
  assert.equal(shouldRunSam({ hasPrevious: false, framesSinceSam: 0, confidence: 0.99 }), true);
  assert.equal(shouldRunSam({ hasPrevious: true, framesSinceSam: 1, confidence: 0.9 }), false);
  assert.equal(shouldRunSam({ hasPrevious: true, framesSinceSam: 2, confidence: 0.9 }), true, 'SAM runs at least every third frame');
  assert.equal(shouldRunSam({ hasPrevious: true, framesSinceSam: 0, confidence: 0.2 }), true);
  assert.equal(shouldRunSam({ hasPrevious: true, framesSinceSam: 1, confidence: null }), true);
  assert.equal(shouldRunSam({ hasPrevious: true, framesSinceSam: 1, confidence: 0.9, maxGap: 1 }), true);
  assert.equal(shouldRunSam({ hasPrevious: true, framesSinceSam: 0, confidence: 0.9, maxGap: 0 }), true, 'camera compensation disables flow-only gaps');
}

console.log('Optical-flow tests passed: sampling, axis points, transform, quality, flow frames, scheduling.');
