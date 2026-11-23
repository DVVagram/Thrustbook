/**
 * Optical-flow helpers shared by the renderer and the tests.
 *
 * OpenCV runs in a worker and reports a partial-affine transform plus the
 * tracked positions of the prompt points. These pure functions turn that into a
 * `TrackFrame` that matches the SAM 2.1 output, so the motion/physics evaluator
 * receives identical data from both engines.
 */
import {
  MotionFlowTrack,
  MotionPoint,
  MotionReferencePoint,
  TrackFrame,
  pointInPolygon,
  polygonBounds,
  polygonCentroid,
} from './motion';

/** x' = a·x + b·y + tx, y' = c·x + d·y + ty (uniform scale + rotation). */
export interface FlowAffine {
  a: number;
  b: number;
  tx: number;
  c: number;
  d: number;
  ty: number;
}

export interface FlowPointTrack {
  index: number;
  found: boolean;
  point: MotionPoint;
  fbError: number;
}

export interface FlowReply {
  affine: FlowAffine | null;
  points: FlowPointTrack[];
  inlierRatio: number;
  fbError: number;
  features: number;
  confidence: number;
  roi: { x: number; y: number; width: number; height: number };
  translation?: { dx: number; dy: number; score: number } | null;
}

/**
 * Run SAM 2.1 at least every third frame when optical flow is healthy. The
 * flow-only frames in between are what keep the model from encoding every
 * frame of a long clip.
 */
function areaOf(points: MotionPoint[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

export const FLOW_MAX_GAP = 2;
export const FLOW_MIN_CONFIDENCE = 0.5;
const FLOW_MIN_INLIERS = 0.35;
const FLOW_MAX_FB_ERROR = 3;

/** Evenly spaced points around a closed polygon, keeping its vertices. */
export function samplePolygon(points: MotionPoint[], limit = 24): MotionPoint[] {
  if (points.length < 3 || limit < 4) return points.map((point) => ({ ...point }));
  const closed = [...points, points[0]];
  let perimeter = 0;
  for (let index = 0; index < closed.length - 1; index++) {
    perimeter += Math.hypot(closed[index + 1].x - closed[index].x, closed[index + 1].y - closed[index].y);
  }
  if (perimeter <= 0) return points.map((point) => ({ ...point }));
  const stride = perimeter / limit;
  const out: MotionPoint[] = points.map((point) => ({ ...point }));
  let carry = 0;
  for (let index = 0; index < closed.length - 1; index++) {
    const from = closed[index];
    const to = closed[index + 1];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length <= 1e-6) continue;
    let travelled = stride - carry;
    while (travelled <= length) {
      out.push({ x: from.x + ((to.x - from.x) * travelled) / length, y: from.y + ((to.y - from.y) * travelled) / length });
      travelled += stride;
    }
    carry = (carry + length) % stride;
  }
  const deduped: MotionPoint[] = [];
  for (const point of out) {
    if (deduped.every((other) => Math.hypot(other.x - point.x, other.y - point.y) > 1.2)) deduped.push(point);
  }
  return deduped;
}

export function applyFlowAffine(affine: FlowAffine, point: MotionPoint): MotionPoint {
  return { x: affine.a * point.x + affine.b * point.y + affine.tx, y: affine.c * point.x + affine.d * point.y + affine.ty };
}

export function warpFlowPolygon(polygon: MotionPoint[], affine: FlowAffine): MotionPoint[] {
  return polygon.map((point) => applyFlowAffine(affine, point));
}

/**
 * Nose, tail and centre from the outline's principal axis. `direction` (the
 * recent centroid motion) decides which end is the nose when the object is
 * close to symmetric.
 */
export function flowAxisPoints(
  polygon: MotionPoint[],
  direction?: MotionPoint,
): { nose: MotionPoint; tail: MotionPoint; centre: MotionPoint } {
  const centre = polygonCentroid(polygon);
  if (polygon.length < 3) return { nose: { ...centre }, tail: { ...centre }, centre };
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let weight = 0;
  for (let index = 0; index < polygon.length; index++) {
    const from = polygon[index];
    const to = polygon[(index + 1) % polygon.length];
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const edge = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const dx = mid.x - centre.x;
    const dy = mid.y - centre.y;
    sxx += dx * dx * edge;
    syy += dy * dy * edge;
    sxy += dx * dy * edge;
    weight += edge;
  }
  if (weight > 0) {
    sxx /= weight;
    syy /= weight;
    sxy /= weight;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let axis = { x: Math.cos(angle), y: Math.sin(angle) };
  if (direction && Math.hypot(direction.x, direction.y) > 0.5) {
    if (axis.x * direction.x + axis.y * direction.y < 0) axis = { x: -axis.x, y: -axis.y };
  }
  let nose = polygon[0];
  let tail = polygon[0];
  let max = -Infinity;
  let min = Infinity;
  for (const point of polygon) {
    const projection = (point.x - centre.x) * axis.x + (point.y - centre.y) * axis.y;
    if (projection > max) {
      max = projection;
      nose = point;
    }
    if (projection < min) {
      min = projection;
      tail = point;
    }
  }
  return { nose: { ...nose }, tail: { ...tail }, centre };
}

/** Quality comparable to the SAM 2.1 score, from a 0–100 heuristic. */
export function flowQuality(input: { inlierRatio: number; fbError: number; areaRatio: number }): {
  quality: number;
  notes: string[];
} {
  const inliers = Math.min(1, Math.max(0, input.inlierRatio));
  const fb = Math.max(0, input.fbError);
  const agreement = Math.max(0, 1 - Math.min(1, Math.abs(Math.log(Math.max(1e-6, input.areaRatio))) / 0.5));
  const quality = Math.round(100 * Math.min(1, 0.55 * inliers + 0.25 * Math.exp(-fb / 1.5) + 0.2 * agreement));
  const notes: string[] = ['OpenCV optical flow (SAM 2.1 skipped for this frame)'];
  if (inliers < 0.7) notes.push('Few optical-flow points survived the consistency check');
  if (fb > 1) notes.push('Forward–backward flow error is elevated');
  return { quality, notes };
}

/** Intersection-over-union of two simple polygons, sampled on their joint bounds. */
export function polygonIou(first: MotionPoint[], second: MotionPoint[], grid = 48): number {
  if (first.length < 3 || second.length < 3) return 0;
  const a = polygonBounds(first);
  const b = polygonBounds(second);
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) return 0;
  let insideA = 0;
  let insideB = 0;
  let both = 0;
  for (let row = 0; row < grid; row++) {
    for (let column = 0; column < grid; column++) {
      const point = { x: minX + ((column + 0.5) * width) / grid, y: minY + ((row + 0.5) * height) / grid };
      const inA = pointInPolygon(point, first);
      const inB = pointInPolygon(point, second);
      if (inA) insideA++;
      if (inB) insideB++;
      if (inA && inB) both++;
    }
  }
  const union = insideA + insideB - both;
  return union > 0 ? both / union : 0;
}

export interface FlowTrackInput {
  frame: number;
  time: number;
  /** Previous tracked frame, in source coordinates. */
  previous: TrackFrame;
  flow: FlowReply;
  /** Frame pixels per source pixel. */
  scaleX: number;
  scaleY: number;
  frameWidth: number;
  frameHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Reference points tracked by the worker, in frame coordinates. */
  references: MotionReferencePoint[];
  qualityThreshold: number;
}

/**
 * Turn an optical-flow reply into a tracked frame, or null when the flow is not
 * trustworthy enough to stand in for SAM 2.1. Callers then run SAM instead.
 */
export function buildFlowTrack(input: FlowTrackInput): { track: TrackFrame; confidence: number } | null {
  const { flow, previous, scaleX, scaleY } = input;
  if (!flow.affine) return null;
  const affine = flow.affine;
  if (![affine.a, affine.b, affine.c, affine.d, affine.tx, affine.ty].every(Number.isFinite)) return null;
  if (flow.confidence < 0.35 || flow.inlierRatio < FLOW_MIN_INLIERS || flow.fbError > FLOW_MAX_FB_ERROR) return null;

  const clampSource = (point: MotionPoint): MotionPoint => ({
    x: Math.min(input.sourceWidth, Math.max(0, point.x)),
    y: Math.min(input.sourceHeight, Math.max(0, point.y)),
  });
  const toFrame = (point: MotionPoint) => ({ x: point.x * scaleX, y: point.y * scaleY });
  const toSource = (point: MotionPoint) => clampSource({ x: point.x / Math.max(1e-6, scaleX), y: point.y / Math.max(1e-6, scaleY) });

  const previousFrame = previous.polygon.map(toFrame);
  const warped = warpFlowPolygon(previousFrame, affine);
  if (!warped.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
  const previousArea = areaOf(previousFrame);
  const warpedArea = areaOf(warped);
  if (previousArea <= 4 || warpedArea <= 4) return null;
  const areaRatio = warpedArea / previousArea;
  if (areaRatio < 0.55 || areaRatio > 1.8) return null;
  const warpedBounds = polygonBounds(warped);
  if (warpedBounds.x < -2 || warpedBounds.y < -2 || warpedBounds.x + warpedBounds.width > input.frameWidth + 2 || warpedBounds.y + warpedBounds.height > input.frameHeight + 2) {
    return null;
  }

  const previousCentre = polygonCentroid(previousFrame);
  const centre = polygonCentroid(warped);
  const step = Math.hypot(centre.x - previousCentre.x, centre.y - previousCentre.y);
  const diagonal = Math.hypot(warpedBounds.width, warpedBounds.height);
  // A jump larger than the object itself is motion the flow cannot justify.
  if (step > Math.max(24, diagonal * 0.75)) return null;

  const polygon = warped.map(toSource);
  const references = previous.references.map((reference, index) => {
    const tracked = input.references[index];
    const point = tracked?.point && Number.isFinite(tracked.point.x) ? tracked.point : applyFlowAffine(affine, toFrame(reference.point));
    return { ...reference, point: toSource(point) };
  });
  const axis = flowAxisPoints(warped, { x: centre.x - previousCentre.x, y: centre.y - previousCentre.y });
  const score = flowQuality({ inlierRatio: flow.inlierRatio, fbError: flow.fbError, areaRatio });
  const status = score.quality >= input.qualityThreshold ? 'tracked' : 'uncertain';
  if (status === 'uncertain') score.notes.push('Optical-flow confidence is below the review threshold');

  const scale = Math.hypot(affine.a, affine.c);
  const track: TrackFrame = {
    frame: input.frame,
    time: input.time,
    polygon,
    references,
    bbox: polygonBounds(polygon),
    status,
    quality: score.quality,
    qualityNotes: score.notes,
    featureCount: Math.max(3, Math.round(flow.features)),
    inlierRatio: flow.inlierRatio,
    fbError: flow.fbError,
    cameraDx: 0,
    cameraDy: 0,
    cameraValid: false,
    engine: 'opencv',
    maskArea: areaOf(polygon),
    flow: {
      method: 'lk',
      confidence: flow.confidence,
      inlierRatio: flow.inlierRatio,
      fbError: flow.fbError,
      trackedFeatures: Math.round(flow.features),
      scale,
      rotationDeg: (Math.atan2(affine.c, affine.a) * 180) / Math.PI,
      dx: polygonCentroid(polygon).x - polygonCentroid(previous.polygon).x,
      dy: polygonCentroid(polygon).y - polygonCentroid(previous.polygon).y,
      nose: toSource(axis.nose),
      tail: toSource(axis.tail),
      centre: toSource(axis.centre),
      templateScore: flow.translation?.score,
      skipped: true,
    },
  };
  return { track, confidence: flow.confidence };
}

/** Whether a flow prediction is good enough to skip SAM 2.1 on this frame. */
export function shouldRunSam(input: {
  hasPrevious: boolean;
  framesSinceSam: number;
  confidence: number | null;
  maxGap?: number;
}): boolean {
  if (!input.hasPrevious) return true;
  if (input.framesSinceSam >= (input.maxGap ?? FLOW_MAX_GAP)) return true;
  return input.confidence === null || input.confidence < FLOW_MIN_CONFIDENCE;
}
