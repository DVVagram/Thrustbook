import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CanvasMapping,
  binaryGridFromLogits,
  canvasToSource,
  estimateBackgroundTranslation,
  interiorPromptCandidates,
  mappingFor,
  maskOverlap,
  maskPromptFromPolygon,
  polygonArea,
  promptPointsForPolygon,
  resampleMaskInput,
  roiForBounds,
  scoreSegmentation,
  segmentationFromLogits,
  sourceToCanvas,
  transformReferences,
} from '../src/shared/sam2-geometry';
import { MotionPoint, polygonCentroid } from '../src/shared/motion';

const SIZE = 1024;
const GRID = 256;

function rect(x: number, y: number, width: number, height: number): MotionPoint[] {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function logitsFor(
  mapping: CanvasMapping,
  inside: (point: MotionPoint) => boolean,
  insideValue = 8,
  outsideValue = -8,
): Float32Array {
  const out = new Float32Array(GRID * GRID);
  const cell = mapping.size / GRID;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const canvas = { x: (x + 0.5) * cell, y: (y + 0.5) * cell };
      const source = canvasToSource(canvas, mapping);
      out[y * GRID + x] = inside(source) ? insideValue : outsideValue;
    }
  }
  return out;
}

test('ROI expansion is clamped to the frame and preserves the requested margin', () => {
  const roi = roiForBounds({ x: 100, y: 80, width: 200, height: 100 }, 1280, 720, 0.5);
  assert.equal(roi.x, 0);
  assert.equal(roi.y, 0);
  assert.ok(roi.width <= 1280 && roi.height <= 720);
  const inner = roiForBounds({ x: 600, y: 300, width: 100, height: 60 }, 1280, 720, 0.5);
  assert.ok(inner.x < 600 && inner.y < 300);
  assert.ok(inner.x + inner.width > 700 && inner.y + inner.height > 360);
});

test('canvas mapping round-trips source coordinates', () => {
  const mapping = mappingFor({ x: 40, y: 20, width: 400, height: 300 }, SIZE);
  const point = { x: 210.5, y: 140.25 };
  const back = canvasToSource(sourceToCanvas(point, mapping), mapping);
  assert.ok(Math.abs(back.x - point.x) < 1e-6 && Math.abs(back.y - point.y) < 1e-6);
  const canvas = sourceToCanvas({ x: 440, y: 320 }, mapping);
  assert.ok(canvas.x <= SIZE && canvas.y <= SIZE);
});

test('prompts stay on the model canvas and describe the outlined object', () => {
  const outline = rect(150, 100, 120, 60);
  const mapping = mappingFor(roiForBounds({ x: 150, y: 100, width: 120, height: 60 }, 640, 360, 0.5), SIZE);
  const points = promptPointsForPolygon(outline, mapping);
  assert.ok(points.length >= 1 && points.length <= 3, `expected a small prompt cluster, got ${points.length}`);
  for (const point of points) {
    assert.equal(point.label, 1);
    assert.ok(point.x >= 0 && point.x <= SIZE, `prompt x ${point.x} outside canvas`);
    assert.ok(point.y >= 0 && point.y <= SIZE, `prompt y ${point.y} outside canvas`);
  }
  const sources = points.map((p) => canvasToSource(p, mapping));
  assert.ok(sources.every((p) => p.x >= 140 && p.x <= 280 && p.y >= 90 && p.y <= 170), 'prompts must sit inside the outline');
  const alternatives = interiorPromptCandidates(outline, mapping, 4);
  assert.ok(alternatives.length >= 2, 'expected fallback prompt points');
  assert.ok(alternatives.every((set) => set.length === 1));
});

test('a rectangular mask becomes a polygon with the right area and centre', () => {
  const roi = { x: 100, y: 60, width: 320, height: 240 };
  const mapping = mappingFor(roi, SIZE);
  const object = { x: 160, y: 120, width: 120, height: 60 };
  const logits = logitsFor(
    mapping,
    (p) => p.x >= object.x && p.x <= object.x + object.width && p.y >= object.y && p.y <= object.y + object.height,
  );
  const segment = segmentationFromLogits(logits, GRID, mapping, { frameWidth: 640, frameHeight: 360 });
  assert.ok(segment, 'expected a segmentation');
  const area = polygonArea(segment!.polygon);
  const expected = object.width * object.height;
  assert.ok(Math.abs(area - expected) / expected < 0.12, `area ${area} should be near ${expected}`);
  const centre = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  assert.ok(Math.hypot(segment!.centroid.x - centre.x, segment!.centroid.y - centre.y) < 3, 'centroid should match the rectangle');
  assert.ok(!segment!.touchesEdge);
  assert.ok(segment!.polygon.length >= 3 && segment!.polygon.length <= 40, `polygon points ${segment!.polygon.length}`);
});

test('a diagonal edge keeps enough points to draw the shape', () => {
  const roi = { x: 20, y: 20, width: 300, height: 300 };
  const mapping = mappingFor(roi, SIZE);
  const logits = logitsFor(mapping, (p) => p.x + p.y < 240 && p.x > 60 && p.y > 60);
  const segment = segmentationFromLogits(logits, GRID, mapping, { frameWidth: 400, frameHeight: 400 });
  assert.ok(segment);
  assert.ok(segment!.polygon.length >= 3);
  assert.ok(segment!.area > 2000);
});

test('the component nearest the tracked centre is selected when a second blob appears', () => {
  const roi = { x: 0, y: 0, width: 400, height: 400 };
  const mapping = mappingFor(roi, SIZE);
  const logits = logitsFor(
    mapping,
    (p) => (p.x > 40 && p.x < 80 && p.y > 40 && p.y < 80) || (p.x > 250 && p.x < 370 && p.y > 250 && p.y < 350),
  );
  const segment = segmentationFromLogits(logits, GRID, mapping, {
    frameWidth: 400,
    frameHeight: 400,
    seed: { x: 60, y: 60 },
  });
  assert.ok(segment);
  assert.ok(segment!.centroid.x < 120 && segment!.centroid.y < 120, 'the small nearby blob should win');
});

test('mask logits are realigned when the ROI moves between frames', () => {
  const previousRoi = { x: 0, y: 0, width: 400, height: 400 };
  const nextRoi = { x: 120, y: 100, width: 400, height: 400 };
  const previousMapping = mappingFor(previousRoi, SIZE);
  const nextMapping = mappingFor(nextRoi, SIZE);
  const logits = logitsFor(
    previousMapping,
    (p) => p.x > 150 && p.x < 250 && p.y > 150 && p.y < 250,
  );
  const resampled = resampleMaskInput(logits, previousMapping, nextMapping, GRID);
  const indexFor = (point: MotionPoint) =>
    Math.floor(((point.y - nextRoi.y) / nextRoi.height) * GRID) * GRID +
    Math.floor(((point.x - nextRoi.x) / nextRoi.width) * GRID);
  assert.ok(resampled[indexFor({ x: 200, y: 200 })] > 0, 'the object should still be inside the mask prompt after the ROI moved');
  assert.ok(resampled[indexFor({ x: 470, y: 460 })] < 0, 'background outside the previous ROI should stay background');
  const nextLogits = logitsFor(nextMapping, (p) => p.x > 150 && p.x < 250 && p.y > 150 && p.y < 250);
  assert.ok(maskOverlap(nextLogits, resampled) > 0.6, 'the prompt should still agree with the object after realignment');
});

test('reference points follow the outline without flinging markers on a bad frame', () => {
  const previous = rect(100, 100, 100, 40);
  const sameSize = rect(140, 130, 100, 40);
  const references = [
    { id: 'nose', name: 'Nose', point: { x: 195, y: 120 } },
    { id: 'tail', name: 'Tail', point: { x: 105, y: 120 } },
  ];
  const translated = transformReferences(previous, sameSize, references);
  assert.ok(Math.abs(translated[0].point.x - 235) < 1.5, `nose x ${translated[0].point.x}`);
  assert.ok(Math.abs(translated[0].point.y - 150) < 1.5, `nose y ${translated[0].point.y}`);
  assert.ok(Math.abs(translated[1].point.x - 145) < 1.5, `tail x ${translated[1].point.x}`);

  // A mask that doubles in area in one frame must not move a marker twice as far.
  const bloomed = rect(50, 70, 200, 100);
  const bounded = transformReferences(previous, bloomed, references);
  const centre = polygonCentroid(bloomed);
  assert.ok(Math.hypot(bounded[0].point.x - 195, bounded[0].point.y - 120) < 60, `bloomed nose moved to ${bounded[0].point.x}, ${bounded[0].point.y}`);
  assert.ok(Math.hypot(bounded[0].point.x - centre.x, bounded[0].point.y - centre.y) < 70, 'marker must stay near the object');
});

test('segmentation scoring rewards confident, consistent masks', () => {
  const good = scoreSegmentation({ predictedIou: 0.95, overlap: 0.93, areaRatio: 1.01, centroidStep: 0.03, clipped: false, initial: false });
  const weak = scoreSegmentation({ predictedIou: 0.3, overlap: 0.15, areaRatio: 2.6, centroidStep: 1.1, clipped: true, initial: false });
  assert.ok(good.quality > 85, `good quality ${good.quality}`);
  assert.ok(weak.quality < 30, `weak quality ${weak.quality}`);
  assert.ok(weak.notes.length >= 2);
  const initial = scoreSegmentation({ predictedIou: 0.9, overlap: null, areaRatio: null, centroidStep: 0, clipped: false, initial: true });
  assert.ok(initial.notes[0].includes('SAM 2.1'));
});

function textureFrame(width: number, height: number, shiftX: number, shiftY: number, objectX = 200): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = 128 + 60 * Math.sin((x - shiftX) * 0.13) + 50 * Math.cos((y - shiftY) * 0.17);
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value * 0.9;
      data[offset + 2] = value * 0.8;
      data[offset + 3] = 255;
      if (x - shiftX > objectX && x - shiftX < objectX + 60 && y - shiftY > 80 && y - shiftY < 120) {
        data[offset] = 250;
        data[offset + 1] = 250;
        data[offset + 2] = 250;
      }
    }
  }
  return data;
}

test('background translation is recovered while ignoring the object', () => {
  const width = 320;
  const height = 240;
  const previous = textureFrame(width, height, 0, 0);
  const next = textureFrame(width, height, 6, -4);
  const result = estimateBackgroundTranslation(previous, next, width, height, { x: 195, y: 75, width: 70, height: 50 });
  assert.ok(result.valid, 'translation should be valid');
  assert.ok(Math.abs(result.dx - 6) <= 2, `dx ${result.dx}`);
  assert.ok(Math.abs(result.dy + 4) <= 2, `dy ${result.dy}`);
  const still = estimateBackgroundTranslation(previous, previous, width, height, null);
  assert.ok(still.valid);
  assert.equal(still.dx, 0);
  assert.equal(still.dy, 0);
});

test('binary grid thresholding keeps the mask aligned with the logits', () => {
  const roi = { x: 0, y: 0, width: 256, height: 256 };
  const mapping = mappingFor(roi, SIZE);
  const logits = logitsFor(mapping, (p) => p.x > 64 && p.x < 192 && p.y > 64 && p.y < 192);
  const grid = binaryGridFromLogits(logits, GRID, mapping, 120);
  const on = grid.mask.reduce((sum, value) => sum + value, 0);
  assert.ok(on > 0);
  const fraction = on / grid.mask.length;
  assert.ok(Math.abs(fraction - 0.25) < 0.05, `foreground fraction ${fraction}`);
});

test('flow-predicted outlines become the decoder mask prompt', () => {
  const mapping = mappingFor({ x: 0, y: 0, width: 512, height: 512 }, 1024);
  const polygon = [
    { x: 128, y: 128 },
    { x: 384, y: 128 },
    { x: 384, y: 384 },
    { x: 128, y: 384 },
  ];
  const grid = 256;
  const prompt = maskPromptFromPolygon(polygon, mapping, grid);
  assert.equal(prompt.length, grid * grid);
  const cell = 512 / grid;
  const sample = (x: number, y: number) => prompt[Math.floor(y / cell) * grid + Math.floor(x / cell)];
  assert.equal(sample(256, 256), 8, 'the object interior is a positive prompt');
  assert.equal(sample(10, 10), -8, 'the surrounding background is negative');
  assert.equal(sample(400, 256), -8);
  assert.ok(maskPromptFromPolygon([], mapping, grid).every((value) => value === 0), 'an empty outline leaves the prompt unset');
});
