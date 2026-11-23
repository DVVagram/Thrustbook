/**
 * Pure geometry and image maths for the SAM 2.1 segmentation pipeline.
 *
 * The exported SAM 2.1 decoder takes prompts in the coordinates of a fixed
 * 1024 × 1024 canvas and returns low-resolution mask logits on a 256 × 256 grid
 * over that same canvas. These helpers convert between source pixels, the
 * segmented region of interest (ROI), the letterboxed model canvas and the mask
 * grid, turn logits into a polygon, and score the result. No DOM, Electron or
 * ONNX dependency lives here so the maths can be tested directly.
 */
import { MotionPoint, MotionReferencePoint, pointInPolygon, polygonBounds, polygonCentroid } from './motion';

export interface Roi {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A region of the source image mapped onto the fixed model canvas. */
export interface CanvasMapping {
  roi: Roi;
  /** Canvas pixels per source pixel. */
  scale: number;
  /** Canvas edge length (1024 for SAM 2.1). */
  size: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function polygonArea(points: MotionPoint[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/** Grow a bounding box into a square-ish search region, clamped to the frame. */
export function roiForBounds(
  bounds: { x: number; y: number; width: number; height: number },
  frameWidth: number,
  frameHeight: number,
  margin = 0.5,
  minSide = 0,
): Roi {
  const pad = Math.max(bounds.width, bounds.height) * margin;
  let x = bounds.x - pad;
  let y = bounds.y - pad;
  let width = bounds.width + pad * 2;
  let height = bounds.height + pad * 2;
  const side = Math.max(minSide, width, height);
  if (width < side) {
    x -= (side - width) / 2;
    width = side;
  }
  if (height < side) {
    y -= (side - height) / 2;
    height = side;
  }
  x = clamp(x, 0, Math.max(0, frameWidth - 2));
  y = clamp(y, 0, Math.max(0, frameHeight - 2));
  width = clamp(width, 2, frameWidth - x);
  height = clamp(height, 2, frameHeight - y);
  return { x, y, width, height };
}

export function mappingFor(roi: Roi, size: number): CanvasMapping {
  const scale = size / Math.max(1, Math.max(roi.width, roi.height));
  return { roi, scale, size };
}

export function sourceToCanvas(point: MotionPoint, mapping: CanvasMapping): MotionPoint {
  return { x: (point.x - mapping.roi.x) * mapping.scale, y: (point.y - mapping.roi.y) * mapping.scale };
}

export function canvasToSource(point: MotionPoint, mapping: CanvasMapping): MotionPoint {
  return { x: mapping.roi.x + point.x / mapping.scale, y: mapping.roi.y + point.y / mapping.scale };
}

function bilinear(grid: Float32Array, width: number, height: number, x: number, y: number): number {
  const cx = clamp(x, 0, width - 1);
  const cy = clamp(y, 0, height - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = grid[y0 * width + x0];
  const b = grid[y0 * width + x1];
  const c = grid[y1 * width + x0];
  const d = grid[y1 * width + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Sample one point of the low-resolution mask logits in source coordinates. */
export function sampleLogits(logits: Float32Array, grid: number, mapping: CanvasMapping, point: MotionPoint): number {
  const canvas = sourceToCanvas(point, mapping);
  const cell = mapping.size / grid;
  return bilinear(logits, grid, grid, canvas.x / cell - 0.5, canvas.y / cell - 0.5);
}

/**
 * Resample the previous frame's mask logits into the next frame's ROI. Both
 * frames use the same canvas size, so this is a change of ROI, not of model.
 */
export function resampleMaskInput(
  previous: Float32Array,
  previousMapping: CanvasMapping,
  nextMapping: CanvasMapping,
  grid = 256,
  outside = -8,
): Float32Array {
  const out = new Float32Array(grid * grid);
  const cell = nextMapping.size / grid;
  const previousCell = previousMapping.size / grid;
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const canvasX = (i + 0.5) * cell;
      const canvasY = (j + 0.5) * cell;
      const sourceX = nextMapping.roi.x + canvasX / nextMapping.scale;
      const sourceY = nextMapping.roi.y + canvasY / nextMapping.scale;
      const previousCanvasX = (sourceX - previousMapping.roi.x) * previousMapping.scale;
      const previousCanvasY = (sourceY - previousMapping.roi.y) * previousMapping.scale;
      if (
        previousCanvasX < 0 ||
        previousCanvasY < 0 ||
        previousCanvasX > previousMapping.size ||
        previousCanvasY > previousMapping.size
      ) {
        out[j * grid + i] = outside;
        continue;
      }
      out[j * grid + i] = bilinear(previous, grid, grid, previousCanvasX / previousCell - 0.5, previousCanvasY / previousCell - 0.5);
    }
  }
  return out;
}

export interface MaskBinaryGrid {
  mask: Uint8Array;
  width: number;
  height: number;
  /** Source-pixel position of a grid cell centre. */
  toSource: (x: number, y: number) => MotionPoint;
  cellArea: number;
}

/** Threshold mask logits onto a source-aligned grid covering the ROI. */
/**
 * Rasterise an outline into the decoder's low-resolution mask prompt. Optical
 * flow predicts the object on skipped frames; passing that shape as the prompt
 * lets SAM 2.1 refine it instead of starting from a stale mask.
 */
export function maskPromptFromPolygon(
  polygon: MotionPoint[],
  mapping: CanvasMapping,
  grid = 256,
  inside = 8,
  outside = -8,
): Float32Array {
  const out = new Float32Array(grid * grid);
  if (polygon.length < 3) return out;
  const cell = mapping.size / grid;
  for (let row = 0; row < grid; row++) {
    for (let column = 0; column < grid; column++) {
      const source = canvasToSource({ x: (column + 0.5) * cell, y: (row + 0.5) * cell }, mapping);
      out[row * grid + column] = pointInPolygon(source, polygon) ? inside : outside;
    }
  }
  return out;
}

export function binaryGridFromLogits(logits: Float32Array, grid: number, mapping: CanvasMapping, longSide = 320, threshold = 0): MaskBinaryGrid {
  const aspect = mapping.roi.width / Math.max(1, mapping.roi.height);
  const width = Math.max(32, Math.round(aspect >= 1 ? longSide : longSide * aspect));
  const height = Math.max(32, Math.round(aspect >= 1 ? longSide / Math.max(aspect, 1e-6) : longSide));
  const mask = new Uint8Array(width * height);
  const cell = mapping.size / grid;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = mapping.roi.x + ((x + 0.5) / width) * mapping.roi.width;
      const sourceY = mapping.roi.y + ((y + 0.5) / height) * mapping.roi.height;
      const canvasX = (sourceX - mapping.roi.x) * mapping.scale;
      const canvasY = (sourceY - mapping.roi.y) * mapping.scale;
      const value = bilinear(logits, grid, grid, canvasX / cell - 0.5, canvasY / cell - 0.5);
      mask[y * width + x] = value > threshold ? 1 : 0;
    }
  }
  return {
    mask,
    width,
    height,
    cellArea: (mapping.roi.width / width) * (mapping.roi.height / height),
    toSource: (x: number, y: number) => ({
      x: mapping.roi.x + ((x + 0.5) / width) * mapping.roi.width,
      y: mapping.roi.y + ((y + 0.5) / height) * mapping.roi.height,
    }),
  };
}

/**
 * Keep the connected component under or around the expected position. A mask
 * that leaks into the sky produces one huge component; the seed component is
 * preferred when it is a meaningful fraction of the whole mask.
 */
export function connectedComponent(
  grid: MaskBinaryGrid,
  seed: MotionPoint | null,
): { mask: Uint8Array; area: number; seedArea: number; largestArea: number } {
  const { mask, width, height } = grid;
  const labels = new Int32Array(width * height).fill(-1);
  let largest = -1;
  let largestArea = 0;
  let seedLabel = -1;
  let seedArea = 0;
  let seedIndex = -1;
  if (seed) {
    // Map the seed by scanning for the nearest foreground cell.
    let best = Infinity;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!mask[y * width + x]) continue;
        const p = grid.toSource(x, y);
        const d = Math.hypot(p.x - seed.x, p.y - seed.y);
        if (d < best) {
          best = d;
          seedIndex = y * width + x;
        }
      }
    }
  }
  const queue = new Int32Array(width * height);
  let nextLabel = 0;
  const areas: number[] = [];
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index] || labels[index] >= 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = index;
    labels[index] = nextLabel;
    let area = 0;
    while (head < tail) {
      const current = queue[head++];
      area++;
      const x = current % width;
      const y = (current / width) | 0;
      if (x > 0 && mask[current - 1] && labels[current - 1] < 0) {
        labels[current - 1] = nextLabel;
        queue[tail++] = current - 1;
      }
      if (x + 1 < width && mask[current + 1] && labels[current + 1] < 0) {
        labels[current + 1] = nextLabel;
        queue[tail++] = current + 1;
      }
      if (y > 0 && mask[current - width] && labels[current - width] < 0) {
        labels[current - width] = nextLabel;
        queue[tail++] = current - width;
      }
      if (y + 1 < height && mask[current + width] && labels[current + width] < 0) {
        labels[current + width] = nextLabel;
        queue[tail++] = current + width;
      }
    }
    areas.push(area);
    if (area > largestArea) {
      largestArea = area;
      largest = nextLabel;
    }
    if (seedIndex >= 0 && labels[seedIndex] === nextLabel) {
      seedLabel = nextLabel;
      seedArea = area;
    }
    nextLabel++;
  }
  const chosen = seedLabel >= 0 && seedArea >= Math.max(12, largestArea * 0.05) ? seedLabel : largest;
  if (chosen < 0) return { mask: new Uint8Array(mask.length), area: 0, seedArea, largestArea };
  const out = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index++) out[index] = labels[index] === chosen ? 1 : 0;
  return { mask: out, area: selectedArea(areas, chosen), seedArea, largestArea };
}

function selectedArea(areas: number[], label: number): number {
  return areas[label] ?? 0;
}

/** Moore-neighbour boundary trace. Returns an ordered, closed pixel chain. */
export function traceBoundary(mask: Uint8Array, width: number, height: number): MotionPoint[] {
  let start = -1;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index]) {
      start = index;
      break;
    }
  }
  if (start < 0) return [];
  const neighbours = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];
  const sx = start % width;
  const sy = (start / width) | 0;
  const points: MotionPoint[] = [{ x: sx, y: sy }];
  let cx = sx;
  let cy = sy;
  // The first scan starts from the pixel to the west of the start pixel.
  let backDX = -1;
  let backDY = 0;
  // A closed 8-connected contour cannot be much longer than the frame border;
  // anything beyond that is a tracing loop that never returned to its start.
  const limit = Math.max(64, 4 * (width + height) + 64);
  // A staircase mask can make the walk re-enter a state without landing on the
  // exact start pixel. Repeating a (pixel, entry direction) state means the
  // boundary loop is closed, whichever pixel it started from.
  const seen = new Set<number>();
  const directionIndex = (dx: number, dy: number): number => {
    for (let d = 0; d < 8; d++) if (neighbours[d][0] === dx && neighbours[d][1] === dy) return d;
    return 0;
  };
  let closed = false;
  for (let guard = 0; guard < limit; guard++) {
    const state = (cy * width + cx) * 8 + directionIndex(backDX, backDY);
    if (seen.has(state)) {
      closed = points.length > 2;
      break;
    }
    seen.add(state);
    let startDir = -1;
    for (let d = 0; d < 8; d++) {
      if (neighbours[d][0] === backDX && neighbours[d][1] === backDY) {
        startDir = d;
        break;
      }
    }
    if (startDir < 0) break;
    let foundX = -1;
    let foundY = -1;
    let previousDX = 0;
    let previousDY = 0;
    for (let step = 1; step <= 8; step++) {
      const d = (startDir + step) % 8;
      const nx = cx + neighbours[d][0];
      const ny = cy + neighbours[d][1];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!mask[ny * width + nx]) continue;
      foundX = nx;
      foundY = ny;
      previousDX = neighbours[(d + 7) % 8][0];
      previousDY = neighbours[(d + 7) % 8][1];
      break;
    }
    if (foundX < 0) break; // isolated pixel
    backDX = previousDX;
    backDY = previousDY;
    cx = foundX;
    cy = foundY;
    if (cx === sx && cy === sy) {
      closed = true;
      break;
    }
    points.push({ x: cx, y: cy });
  }
  // An unclosed walk (guard reached) describes an unknown path: report nothing
  // so the caller can fall back to the mask extent instead of a sliver.
  return closed ? points : [];
}

/** Ramer–Douglas–Peucker simplification for an open chain. */
export function simplify(points: MotionPoint[], epsilon: number): MotionPoint[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDistance = -1;
    let index = -1;
    const a = points[first];
    const b = points[last];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      const d =
        length < 1e-9
          ? Math.hypot(p.x - a.x, p.y - a.y)
          : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / length;
      if (d > maxDistance) {
        maxDistance = d;
        index = i;
      }
    }
    if (index >= 0 && maxDistance > epsilon) {
      keep[index] = 1;
      stack.push([first, index]);
      stack.push([index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export interface Segmentation {
  polygon: MotionPoint[];
  area: number;
  centroid: MotionPoint;
  bbox: { x: number; y: number; width: number; height: number };
  touchesEdge: boolean;
  componentRatio: number;
}

/** Turn mask logits into a simplified source-space polygon. */
export function segmentationFromLogits(
  logits: Float32Array,
  grid: number,
  mapping: CanvasMapping,
  options: { frameWidth: number; frameHeight: number; seed?: MotionPoint | null; longSide?: number; threshold?: number } = {
    frameWidth: mapping.roi.x + mapping.roi.width,
    frameHeight: mapping.roi.y + mapping.roi.height,
  },
): Segmentation | null {
  const binary = binaryGridFromLogits(logits, grid, mapping, options.longSide ?? 300, options.threshold ?? 0);
  const component = connectedComponent(binary, options.seed ?? null);
  if (component.area <= 0) return null;
  binary.mask = component.mask;
  const area = component.area * binary.cellArea;
  const chain = traceBoundary(binary.mask, binary.width, binary.height);
  const sourceChain = chain.length >= 4 ? chain.map((p) => binary.toSource(p.x, p.y)) : [];
  let epsilon = clamp(Math.sqrt(area) * 0.02, 0.6, 6);
  let simplified = sourceChain.length >= 4 ? simplify(sourceChain, epsilon) : [];
  // Thin detail on a noisy mask can keep hundreds of points: coarsen the
  // tolerance instead of dropping every nth point, which would break the shape.
  for (let attempt = 0; attempt < 8 && simplified.length > 160; attempt++) {
    epsilon *= 1.6;
    simplified = simplify(sourceChain, epsilon);
  }
  if (simplified.length > 160) {
    const step = Math.ceil(simplified.length / 160);
    simplified = simplified.filter((_, i) => i % step === 0);
  }
  let polygon = simplified;
  if (polygon.length < 3 || polygonArea(polygon) < area * 0.6) {
    // The contour lost the shape the mask actually has (a tracing failure, a
    // thin bridge or a hole). The mask extent is still correct, so keep
    // tracking with its bounding rectangle rather than a partial outline.
    let minX = binary.width;
    let minY = binary.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < binary.height; y++) {
      for (let x = 0; x < binary.width; x++) {
        if (!binary.mask[y * binary.width + x]) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < minX || maxY < minY) return null;
    const x0 = mapping.roi.x + (minX / binary.width) * mapping.roi.width;
    const x1 = mapping.roi.x + ((maxX + 1) / binary.width) * mapping.roi.width;
    const y0 = mapping.roi.y + (minY / binary.height) * mapping.roi.height;
    const y1 = mapping.roi.y + ((maxY + 1) / binary.height) * mapping.roi.height;
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    polygon = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
  }
  const centroid = polygonCentroid(polygon);
  const bounds = polygonBounds(polygon);
  const edge = 1.5;
  const touchesEdge = polygon.some(
    (p) => p.x <= edge || p.y <= edge || p.x >= options.frameWidth - edge || p.y >= options.frameHeight - edge,
  );
  return {
    polygon,
    area,
    centroid,
    bbox: bounds,
    touchesEdge,
    componentRatio: component.largestArea > 0 ? component.area / component.largestArea : 1,
  };
}

function interiorCentre(polygon: MotionPoint[]): MotionPoint {
  const centre = polygonCentroid(polygon);
  if (polygon.length >= 3 && pointInPolygon(centre, polygon)) return centre;
  const bounds = polygonBounds(polygon);
  const boxCentre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  if (polygon.length >= 3 && pointInPolygon(boxCentre, polygon)) return boxCentre;
  return {
    x: polygon.reduce((sum, p) => sum + p.x, 0) / Math.max(1, polygon.length),
    y: polygon.reduce((sum, p) => sum + p.y, 0) / Math.max(1, polygon.length),
  };
}

/**
 * Prompt for the outlined object. SAM segments the thing under a point, so
 * scattered points across a loose outline (which include background) are
 * counter-productive; the centre plus two nearby interior points is what makes
 * "draw a rough outline, get the rocket" work.
 */
export function promptPointsForPolygon(
  polygon: MotionPoint[],
  mapping: CanvasMapping,
  clusterScale = 0.12,
): Array<{ x: number; y: number; label: 1 }> {
  const centre = interiorCentre(polygon);
  const bounds = polygonBounds(polygon);
  const radius = Math.max(2, Math.min(bounds.width, bounds.height) * clusterScale);
  const sourcePoints = [centre];
  for (const offset of [
    { x: -radius, y: -radius },
    { x: radius, y: radius },
  ]) {
    const point = { x: centre.x + offset.x, y: centre.y + offset.y };
    if (pointInPolygon(point, polygon)) sourcePoints.push(point);
  }
  return sourcePoints.map((point) => {
    const canvas = sourceToCanvas(point, mapping);
    return { x: canvas.x, y: canvas.y, label: 1 as const };
  });
}

/**
 * Alternative single-point prompts spread across the outline. The engine tries
 * these when the centre prompt does not produce a plausible mask, which happens
 * when a loose outline has its centroid on the background.
 */
export function interiorPromptCandidates(
  polygon: MotionPoint[],
  mapping: CanvasMapping,
  count = 4,
): Array<Array<{ x: number; y: number; label: 1 }>> {
  const centre = interiorCentre(polygon);
  const bounds = polygonBounds(polygon);
  const reach = Math.min(bounds.width, bounds.height) * 0.32;
  const ring: MotionPoint[] = [
    { x: centre.x - reach, y: centre.y - reach },
    { x: centre.x + reach, y: centre.y - reach },
    { x: centre.x + reach, y: centre.y + reach },
    { x: centre.x - reach, y: centre.y + reach },
  ];
  const points = ring.filter((point) => pointInPolygon(point, polygon)).slice(0, count);
  return points.map((point) => {
    const canvas = sourceToCanvas(point, mapping);
    return [{ x: canvas.x, y: canvas.y, label: 1 as const }];
  });
}

/** Move named reference points with the segmented outline. */
export function transformReferences(
  previousPolygon: MotionPoint[],
  nextPolygon: MotionPoint[],
  references: MotionReferencePoint[],
): MotionReferencePoint[] {
  if (!references.length) return [];
  const previousCenter = polygonCentroid(previousPolygon);
  const nextCenter = polygonCentroid(nextPolygon);
  const previousArea = polygonArea(previousPolygon);
  const nextArea = polygonArea(nextPolygon);
  // Reference points are attached to the object, not re-fitted from scratch:
  // a mask that blooms for one frame must not fling a nose marker across the
  // image. Scale and rotation are therefore bounded per frame.
  const scale = previousArea > 1 && nextArea > 1 ? clamp(Math.sqrt(nextArea / previousArea), 0.94, 1.06) : 1;
  const previousAngle = principalAngle(previousPolygon);
  const nextAngle = principalAngle(nextPolygon);
  let rotation = nextAngle - previousAngle;
  while (rotation > Math.PI / 2) rotation -= Math.PI;
  while (rotation < -Math.PI / 2) rotation += Math.PI;
  const stable = previousArea > 1 && nextArea > 1 && nextArea / previousArea > 0.8 && nextArea / previousArea < 1.25;
  if (!stable || Math.abs(rotation) > (8 * Math.PI) / 180) rotation = 0;
  const cos = Math.cos(rotation) * scale;
  const sin = Math.sin(rotation) * scale;
  return references.map((reference) => {
    const dx = reference.point.x - previousCenter.x;
    const dy = reference.point.y - previousCenter.y;
    return {
      ...reference,
      point: {
        x: nextCenter.x + dx * cos - dy * sin,
        y: nextCenter.y + dx * sin + dy * cos,
      },
    };
  });
}

function principalAngle(polygon: MotionPoint[]): number {
  if (polygon.length < 3) return 0;
  const center = polygonCentroid(polygon);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of polygon) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx + syy < 1e-6) return 0;
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

export interface SegmentationScore {
  quality: number;
  notes: string[];
}

export function scoreSegmentation(input: {
  predictedIou: number;
  overlap: number | null;
  areaRatio: number | null;
  centroidStep: number;
  clipped: boolean;
  initial: boolean;
  componentRatio?: number;
}): SegmentationScore {
  const notes: string[] = [];
  const predicted = clamp(input.predictedIou, 0, 1);
  const overlap = input.overlap === null ? predicted : clamp(input.overlap, 0, 1);
  const area = input.areaRatio === null ? 1 : clamp(1 - Math.abs(Math.log(Math.max(input.areaRatio, 1e-6))) / 0.8, 0, 1);
  const step = clamp(1 - input.centroidStep / 1.2, 0, 1);
  let quality = 100 * (0.42 * predicted + 0.3 * overlap + 0.16 * area + 0.12 * step);
  if (input.clipped) {
    quality *= 0.9;
    notes.push('The segmented mask reaches the frame edge');
  }
  if (input.areaRatio !== null && (input.areaRatio < 0.55 || input.areaRatio > 1.8)) notes.push('The segmented area changed sharply');
  if (input.centroidStep > 0.5) notes.push('The segmented centre moved abruptly');
  if (overlap < 0.45 && !input.initial) notes.push('Low overlap with the previous mask');
  if (predicted < 0.6) notes.push('The decoder reported a weak mask score');
  if (input.componentRatio !== undefined && input.componentRatio < 0.75) notes.push('Part of the mask was disconnected and discarded');
  if (!notes.length && input.initial) notes.push('Outline refined by SAM 2.1 on this frame');
  return { quality: clamp(quality, 0, 100), notes };
}

/** Intersection-over-union of two aligned binary masks. */
export function maskOverlap(a: Float32Array, b: Float32Array, threshold = 0): number {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const aOn = a[i] > threshold;
    const bOn = b[i] > threshold;
    if (aOn && bOn) intersection++;
    if (aOn || bOn) union++;
  }
  return union ? intersection / union : 0;
}

export function maskArea(logits: Float32Array, threshold = 0): number {
  let count = 0;
  for (let i = 0; i < logits.length; i++) if (logits[i] > threshold) count++;
  return count;
}

/** Mask centroid in normalized grid coordinates (0–1). */
export function maskCentroid(logits: Float32Array, grid: number, threshold = 0): MotionPoint | null {
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      if (logits[y * grid + x] <= threshold) continue;
      const weight = 1;
      sum += weight;
      sx += x * weight;
      sy += y * weight;
    }
  }
  if (!sum) return null;
  return { x: (sx / sum + 0.5) / grid, y: (sy / sum + 0.5) / grid };
}

/** Convert a normalized mask centroid into canvas pixels. */
export function centroidInCanvas(logits: Float32Array, grid: number, mapping: CanvasMapping): MotionPoint | null {
  const normalized = maskCentroid(logits, grid);
  if (!normalized) return null;
  return { x: normalized.x * mapping.size, y: normalized.y * mapping.size };
}

/**
 * Estimate the dominant background translation between two frames by
 * block matching, ignoring the segmented object. Translation only: zoom,
 * rotation, rolling shutter and parallax are not modelled.
 */
export function estimateBackgroundTranslation(
  previous: Uint8Array,
  next: Uint8Array,
  width: number,
  height: number,
  exclude: { x: number; y: number; width: number; height: number } | null,
  maxShiftFraction = 0.03,
): { dx: number; dy: number; valid: boolean; samples: number; score: number } {
  if (width < 8 || height < 8) return { dx: 0, dy: 0, valid: false, samples: 0, score: Infinity };
  const coarseFactor = 8;
  const coarsePrevious = greyDownsample(previous, width, height, coarseFactor);
  const coarseNext = greyDownsample(next, width, height, coarseFactor);
  const coarseExclude = scaleRect(exclude, 1 / coarseFactor);
  const coarseLimit = Math.max(2, Math.round(((maxShiftFraction * Math.max(width, height)) / coarseFactor) || 2));
  const coarse = searchShift(coarsePrevious, coarseNext, coarseLimit, coarseExclude);
  const fineFactor = 2;
  const finePrevious = greyDownsample(previous, width, height, fineFactor);
  const fineNext = greyDownsample(next, width, height, fineFactor);
  const fineExclude = scaleRect(exclude, 1 / fineFactor);
  const centre = {
    x: Math.round((coarse.dx * coarseFactor) / fineFactor),
    y: Math.round((coarse.dy * coarseFactor) / fineFactor),
  };
  const fine = searchShift(finePrevious, fineNext, 3, fineExclude, centre);
  // Compare against no compensation, not just the centre of the refined window.
  const zero = matchScore(finePrevious, fineNext, 0, 0, fineExclude).score;
  const dx = fine.dx * fineFactor;
  const dy = fine.dy * fineFactor;
  const moved = Math.hypot(dx, dy) > 0;
  // A marginally better score is noise: prefer no compensation over jitter.
  if (moved && !(fine.score < zero - 0.6)) return { dx: 0, dy: 0, valid: fine.samples >= 200, samples: fine.samples, score: zero };
  const valid = fine.samples >= 200 && Number.isFinite(fine.score) && fine.score < 45;
  return { dx: valid ? dx : 0, dy: valid ? dy : 0, valid, samples: fine.samples, score: fine.score };
}

interface Grey {
  data: Float32Array;
  width: number;
  height: number;
}

function greyDownsample(rgba: Uint8Array, width: number, height: number, factor: number): Grey {
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let count = 0;
      for (let sy = y * factor; sy < Math.min(height, (y + 1) * factor); sy++) {
        const row = sy * width * 4;
        for (let sx = x * factor; sx < Math.min(width, (x + 1) * factor); sx++) {
          const offset = row + sx * 4;
          sum += rgba[offset] * 0.299 + rgba[offset + 1] * 0.587 + rgba[offset + 2] * 0.114;
          count++;
        }
      }
      data[y * w + x] = count ? sum / count : 0;
    }
  }
  return { data, width: w, height: h };
}

function scaleRect(rect: { x: number; y: number; width: number; height: number } | null, factor: number) {
  if (!rect) return null;
  const padX = rect.width * 0.15;
  const padY = rect.height * 0.15;
  return {
    x: (rect.x - padX) * factor,
    y: (rect.y - padY) * factor,
    width: (rect.width + padX * 2) * factor,
    height: (rect.height + padY * 2) * factor,
  };
}

function matchScore(
  a: Grey,
  b: Grey,
  sx: number,
  sy: number,
  exclude: { x: number; y: number; width: number; height: number } | null,
): { score: number; samples: number } {
  const x0 = Math.max(0, -sx);
  const x1 = Math.min(a.width, b.width - sx);
  const y0 = Math.max(0, -sy);
  const y1 = Math.min(a.height, b.height - sy);
  if (x1 <= x0 || y1 <= y0) return { score: Infinity, samples: 0 };
  const stepX = Math.max(1, Math.round((x1 - x0) / 160));
  const stepY = Math.max(1, Math.round((y1 - y0) / 120));
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      if (exclude && x >= exclude.x && x < exclude.x + exclude.width && y >= exclude.y && y < exclude.y + exclude.height) continue;
      sum += Math.abs(a.data[y * a.width + x] - b.data[(y + sy) * b.width + (x + sx)]);
      count++;
    }
  }
  return { score: count ? sum / count : Infinity, samples: count };
}

function searchShift(
  a: Grey,
  b: Grey,
  limit: number,
  exclude: { x: number; y: number; width: number; height: number } | null,
  centre: { x: number; y: number } = { x: 0, y: 0 },
): { dx: number; dy: number; score: number; samples: number } {
  let best = { dx: centre.x, dy: centre.y, score: Infinity, samples: 0 };
  for (let dy = -limit; dy <= limit; dy++) {
    for (let dx = -limit; dx <= limit; dx++) {
      const sx = centre.x + dx;
      const sy = centre.y + dy;
      const match = matchScore(a, b, sx, sy, exclude);
      if (!match.samples) continue;
      if (match.score < best.score) best = { dx: sx, dy: sy, score: match.score, samples: match.samples };
    }
  }
  return best;
}
