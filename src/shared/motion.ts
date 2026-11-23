/**
 * Video & Image Analysis — measurement model and scientific calculations.
 *
 * Image coordinates are pixels with y increasing downwards. Physical coordinate
 * results are in metres after a valid calibration. No result is labelled
 * "calibrated" unless the required calibration data is complete and valid.
 */
import { convertUnit, unitDef } from './units';

export type MotionMediaKind = 'image' | 'video' | 'sequence';
export type TimingSource = 'video-timestamps' | 'manual-fps' | 'image-sequence' | 'unknown';
export type CalibrationMode = 'none' | 'scale' | 'rotated' | 'homography';
export type TrackStatus = 'tracked' | 'uncertain' | 'manual' | 'lost';

export interface MotionPoint {
  x: number;
  y: number;
}

export interface MotionReferencePoint {
  id: string;
  name: string;
  point: MotionPoint;
}

export interface MotionMedia {
  kind: MotionMediaKind;
  path: string;
  paths?: string[];
  name: string;
  mime?: string;
  width: number;
  height: number;
  duration: number | null;
  frameCount: number | null;
  fps: number | null;
  timestamps: number[];
  timingSource: TimingSource;
  variableFrameRate: boolean;
  fileSize?: number;
}

export interface TrackFrame {
  frame: number;
  time: number;
  polygon: MotionPoint[];
  references: MotionReferencePoint[];
  bbox: { x: number; y: number; width: number; height: number };
  status: TrackStatus;
  quality: number;
  qualityNotes: string[];
  featureCount: number;
  inlierRatio: number;
  fbError: number;
  /** Per-frame background translation estimate in source pixels. */
  cameraDx?: number;
  cameraDy?: number;
  cameraValid?: boolean;
  /** Engine that produced this frame. Manual frames are user-owned corrections. */
  engine?: 'sam2' | 'opencv' | 'manual';
  /** Supporting OpenCV optical-flow measurement for this frame. */
  flow?: MotionFlowTrack;
  /** SAM 2.1 decoder confidence for the chosen mask (0–1). */
  predictedIou?: number;
  /** Overlap with the previous frame's mask (0–1), when propagated. */
  maskIou?: number;
  /** Segmented mask area in source pixels. */
  maskArea?: number;
}

export interface MotionFlowTrack {
  method: 'lk';
  confidence: number;
  inlierRatio: number;
  fbError: number;
  trackedFeatures: number;
  /** Uniform scale and rotation of the partial-affine transform. */
  scale: number;
  rotationDeg: number;
  /** Object centroid motion in source pixels. */
  dx: number;
  dy: number;
  nose: MotionPoint;
  tail: MotionPoint;
  centre: MotionPoint;
  /** Masked template-match score that anchored the translation, when available. */
  templateScore?: number;
  /** True when SAM 2.1 was deliberately skipped for this frame. */
  skipped: boolean;
  /** Intersection-over-union with the SAM 2.1 outline, where it ran. */
  agreement?: number;
}

export interface MotionHistoryEntry {
  id: string;
  at: string;
  frame: number;
  time: number;
  polygon: MotionPoint[];
  references: MotionReferencePoint[];
  action: string;
}

export interface MotionObject {
  id: string;
  name: string;
  color: string;
  initialFrame: number;
  initialPolygon: MotionPoint[];
  initialReferences: MotionReferencePoint[];
  referenceLength: number;
  actualLength: number;
  /** Known physical width and height, when available. */
  actualWidth?: number;
  actualHeight?: number;
  lengthUnit: string;
  frames: TrackFrame[];
  manualFrames: number[];
  /** Snapshots of replaced/deleted keyframes for recovery after reopening. */
  history?: MotionHistoryEntry[];
  notes: string;
}

export interface MotionCalibration {
  mode: CalibrationMode;
  origin: MotionPoint;
  xAxisPoint: MotionPoint;
  yAxisPoint: MotionPoint;
  scalePointA: MotionPoint;
  scalePointB: MotionPoint;
  knownLength: number;
  lengthUnit: string;
  homographyPoints: MotionPoint[];
  homographyWidth: number;
  homographyHeight: number;
  notes: string;
}

export interface MotionSettings {
  smoothingWindow: number;
  processingMaxWidth: number;
  qualityThreshold: number;
  maxFeatures: number;
  displayLengthUnit: string;
  displayVelocityUnit: string;
  displayAccelerationUnit: string;
  startFrame: number;
  endFrame: number;
  showOutline: boolean;
  showBoundingBox: boolean;
  showReferences: boolean;
  showAxes: boolean;
  showTrajectory: boolean;
  showReadout: boolean;
  /** Estimate and remove background translation before measurements. */
  compensateCamera: boolean;
}

export interface MotionAnalysis {
  version: 1;
  name: string;
  media: MotionMedia;
  objects: MotionObject[];
  calibration: MotionCalibration;
  settings: MotionSettings;
  selectedObjectId: string;
  importantFrames: number[];
  notes: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MotionFrameResult {
  frame: number;
  time: number;
  pixelX: number;
  pixelY: number;
  x: number;
  y: number;
  calibrated: boolean;
  dx: number;
  dy: number;
  displacement: number;
  distance: number;
  speedRaw: number;
  vxRaw: number;
  vyRaw: number;
  axRaw: number;
  ayRaw: number;
  speed: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  directionDeg: number | null;
  orientationDeg: number | null;
  angularVelocityDeg: number | null;
  apparentLengthPx: number;
  apparentLength: number;
  relativeDistance: number | null;
  quality: number;
  status: TrackStatus;
  manual: boolean;
  cameraCompensated: boolean;
  /** Cumulative background translation subtracted from the image position. */
  cameraDx: number;
  cameraDy: number;
}

export interface MotionSummary {
  frameCount: number;
  duration: number;
  distance: number;
  displacement: number;
  maxSpeed: number;
  minSpeed: number;
  averageSpeed: number;
  maxAcceleration: number;
  maxAbsoluteVerticalVelocity: number;
  netDirectionDeg: number | null;
  calibrated: boolean;
  cameraCompensated: boolean;
  unit: string;
  velocityUnit: string;
  accelerationUnit: string;
}

export interface CalibrationDescription {
  active: boolean;
  calibrated: boolean;
  label: string;
  detail: string;
  warnings: string[];
  metresPerPixel: number | null;
}

export const DEFAULT_CALIBRATION: MotionCalibration = {
  mode: 'none',
  origin: { x: 0, y: 0 },
  xAxisPoint: { x: 100, y: 0 },
  yAxisPoint: { x: 0, y: 100 },
  scalePointA: { x: 0, y: 0 },
  scalePointB: { x: 100, y: 0 },
  knownLength: 1,
  lengthUnit: 'm',
  homographyPoints: [],
  homographyWidth: 1,
  homographyHeight: 1,
  notes: '',
};

export const DEFAULT_MOTION_SETTINGS: MotionSettings = {
  smoothingWindow: 3,
  processingMaxWidth: 1280,
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
  compensateCamera: false,
};

export const EMPTY_MEDIA: MotionMedia = {
  kind: 'image',
  path: '',
  name: '',
  width: 0,
  height: 0,
  duration: null,
  frameCount: null,
  fps: null,
  timestamps: [],
  timingSource: 'unknown',
  variableFrameRate: false,
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function distance(a: MotionPoint, b: MotionPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function polygonCentroid(points: MotionPoint[]): MotionPoint {
  if (!points.length) return { x: 0, y: 0 };
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    return {
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    };
  }
  area *= 0.5;
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

export function polygonBounds(points: MotionPoint[]): { x: number; y: number; width: number; height: number } {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function pointInPolygon(point: MotionPoint, polygon: MotionPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-12) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export interface TrackingSegment {
  start: number;
  end: number;
  keyframe: boolean;
}

/** Split a track range at every user keyframe after the starting frame. */
export function planTrackingSegments(startFrame: number, endFrame: number, manualFrames: number[]): TrackingSegment[] {
  const start = Math.max(0, Math.round(startFrame));
  const end = Math.max(start, Math.round(endFrame));
  const keyframes = [...new Set(manualFrames.filter((f) => f > start && f <= end))].sort((a, b) => a - b);
  return [start, ...keyframes].map((frame, index, all) => ({
    start: frame,
    end: index + 1 < all.length ? Math.min(end, all[index + 1] - 1) : end,
    keyframe: frame !== start || manualFrames.includes(frame),
  }));
}

/**
 * Merge a tracking pass without destroying keyframes or frames outside the
 * recalculated interval. Manual keyframes always win; only the frame where a
 * new pass starts may replace its own previous manual state.
 */
export function mergeTrackedFrames(
  existing: TrackFrame[],
  generated: TrackFrame[],
  manualFrames: number[],
  startFrame: number,
  endFrame: number,
  stoppedAt: number | null,
): TrackFrame[] {
  const manual = new Set([...manualFrames, startFrame]);
  // A correction at the starting frame is still user-owned. Tracking may fill
  // automatic frames, but it must never overwrite an existing manual outline.
  const existingManual = new Set(existing.filter((track) => track.status === 'manual').map((track) => track.frame));
  const merged = new Map<number, TrackFrame>();
  for (const track of existing) {
    const preserve =
      track.frame < startFrame ||
      track.frame > endFrame ||
      manual.has(track.frame) ||
      (stoppedAt !== null && track.frame >= stoppedAt);
    if (preserve) merged.set(track.frame, track);
  }
  for (const track of generated) {
    if (existingManual.has(track.frame)) continue;
    if (track.frame !== startFrame && manual.has(track.frame)) continue;
    if (track.frame < startFrame || track.frame > endFrame) continue;
    merged.set(track.frame, track);
  }
  return [...merged.values()].sort((a, b) => a.frame - b.frame);
}

export function rectanglePolygon(a: MotionPoint, b: MotionPoint): MotionPoint[] {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.abs(b.x - a.x);
  const height = Math.abs(b.y - a.y);
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

export function movingAverage(values: Array<number | null>, window: number): Array<number | null> {
  const radius = Math.max(0, Math.floor((Math.max(1, window) - 1) / 2));
  if (radius === 0) return [...values];
  return values.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      const v = values[j];
      if (v !== null && Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    return count ? sum / count : null;
  });
}

/** Sort and drop duplicate/invalid timestamps. */
export function normaliseTimestamps(values: number[]): number[] {
  return [...new Set(values.filter((v) => Number.isFinite(v) && v >= 0).map((v) => Number(v.toFixed(9))))].sort((a, b) => a - b);
}

export function frameIntervalStats(timestamps: number[]): { fps: number | null; variable: boolean; meanInterval: number | null; minInterval: number | null; maxInterval: number | null } {
  if (timestamps.length < 2) return { fps: null, variable: false, meanInterval: null, minInterval: null, maxInterval: null };
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const dt = timestamps[i] - timestamps[i - 1];
    if (dt > 1e-9) intervals.push(dt);
  }
  if (!intervals.length) return { fps: null, variable: false, meanInterval: null, minInterval: null, maxInterval: null };
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const min = Math.min(...intervals);
  const max = Math.max(...intervals);
  const variable = intervals.some((dt) => Math.abs(dt - mean) > mean * 0.01);
  return { fps: mean > 0 ? 1 / mean : null, variable, meanInterval: mean, minInterval: min, maxInterval: max };
}

export function manualTimestamps(duration: number, fps: number): number[] {
  if (!(duration > 0) || !(fps > 0)) return [];
  const count = Math.max(1, Math.round(duration * fps));
  return Array.from({ length: count }, (_, i) => Number((i / fps).toFixed(9)));
}

/** Solve an 8x8 linear system with partial pivoting. */
function solveLinear(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const div = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (!factor) continue;
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

export interface Homography {
  h: number[];
  invert?: number[];
}

export function solveHomography(src: MotionPoint[], dst: MotionPoint[]): Homography | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const matrix: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    matrix.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    rhs.push(u);
    matrix.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    rhs.push(v);
  }
  const solved = solveLinear(matrix, rhs);
  return solved ? { h: [...solved, 1] } : null;
}

export function applyHomography(point: MotionPoint, homography: Homography): MotionPoint | null {
  const h = homography.h;
  const w = h[6] * point.x + h[7] * point.y + h[8];
  if (Math.abs(w) < 1e-12) return null;
  return {
    x: (h[0] * point.x + h[1] * point.y + h[2]) / w,
    y: (h[3] * point.x + h[4] * point.y + h[5]) / w,
  };
}

function metres(unit: string, value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const converted = convertUnit(value, unit, 'm');
  return converted !== null && Number.isFinite(converted) ? converted : null;
}

export interface PixelCalibration {
  valid: boolean;
  calibrated: boolean;
  metresPerPixel: number | null;
  toMetric: (point: MotionPoint) => MotionPoint;
  description: CalibrationDescription;
}

/**
 * Build a pixel-to-metric transform. Simple and rotated modes are isotropic
 * scale models and are only valid in the image plane under the stated
 * assumptions. Homography requires four ordered corners and a planar target.
 */
export function buildPixelCalibration(calibration: MotionCalibration): PixelCalibration {
  const warnings: string[] = [];
  const unit = calibration.lengthUnit || 'm';
  const active = calibration.mode !== 'none';

  if (!active) {
    return {
      valid: true,
      calibrated: false,
      metresPerPixel: null,
      toMetric: (p) => ({ x: p.x - calibration.origin.x, y: p.y - calibration.origin.y }),
      description: {
        active: false,
        calibrated: false,
        label: 'Image-plane only',
        detail: 'Positions are pixel offsets from the chosen origin. No physical scale is active.',
        warnings: ['Distances, speeds and accelerations are in pixels, not physical units.'],
        metresPerPixel: null,
      },
    };
  }

  if (calibration.mode === 'homography') {
    if (calibration.homographyPoints.length !== 4) warnings.push('Four planar reference corners are required.');
    const widthM = metres(unit, calibration.homographyWidth);
    const heightM = metres(unit, calibration.homographyHeight);
    if (!(widthM && widthM > 0) || !(heightM && heightM > 0)) warnings.push('Enter positive physical width and height for the reference rectangle.');
    const h = solveHomography(
      calibration.homographyPoints,
      [
        { x: 0, y: 0 },
        { x: calibration.homographyWidth, y: 0 },
        { x: calibration.homographyWidth, y: calibration.homographyHeight },
        { x: 0, y: calibration.homographyHeight },
      ],
    );
    if (!h) warnings.push('The four reference corners do not form a solvable quadrilateral.');
    const valid = !!h && warnings.length === 0;
    return {
      valid,
      calibrated: valid,
      metresPerPixel: null,
      toMetric: (p) => (valid ? applyHomography(p, h!) ?? { x: NaN, y: NaN } : p),
      description: {
        active: true,
        calibrated: valid,
        label: 'Planar homography',
        detail: valid
          ? `Four-corner planar calibration maps the marked quadrilateral to ${calibration.homographyWidth} × ${calibration.homographyHeight} ${unit}. Assumes those points lie on one plane.`
          : 'The planar calibration is incomplete.',
        warnings: [
          ...warnings,
          'Valid only for points on the calibrated plane. Depth changes and lens distortion are not corrected.',
        ],
        metresPerPixel: null,
      },
    };
  }

  const scalePixels = distance(calibration.scalePointA, calibration.scalePointB);
  const knownM = metres(unit, calibration.knownLength);
  if (!(scalePixels > 0)) warnings.push('Choose two distinct scale reference points.');
  if (!(knownM && knownM > 0)) warnings.push('Enter a positive known distance.');
  const unitsPerPixel = scalePixels > 0 && calibration.knownLength > 0 ? calibration.knownLength / scalePixels : null;
  const metresPerPixel = unitsPerPixel !== null ? convertUnit(unitsPerPixel, unit, 'm') : null;
  const valid = unitsPerPixel !== null && warnings.length === 0;

  let xUnit = { x: 1, y: 0 };
  let yUnit = { x: 0, y: 1 };
  if (calibration.mode === 'rotated') {
    const ax = calibration.xAxisPoint.x - calibration.origin.x;
    const ay = calibration.xAxisPoint.y - calibration.origin.y;
    const bx = calibration.yAxisPoint.x - calibration.origin.x;
    const by = calibration.yAxisPoint.y - calibration.origin.y;
    const axl = Math.hypot(ax, ay);
    const byl = Math.hypot(bx, by);
    if (axl < 1e-6 || byl < 1e-6) warnings.push('Draw distinct X and Y axis directions.');
    else {
      xUnit = { x: ax / axl, y: ay / axl };
      yUnit = { x: bx / byl, y: by / byl };
      const dot = xUnit.x * yUnit.x + xUnit.y * yUnit.y;
      if (Math.abs(dot) > 0.08) warnings.push('The X and Y axes are not approximately perpendicular; coordinates are oblique projections.');
    }
  }

  const calibrated = valid && warnings.every((w) => !/required|Enter a positive|distinct|not approximately/.test(w));
  return {
    valid: calibrated,
    calibrated,
    metresPerPixel,
    toMetric: (p) => {
      const dx = p.x - calibration.origin.x;
      const dy = p.y - calibration.origin.y;
      const x = dx * xUnit.x + dy * xUnit.y;
      const y = dx * yUnit.x + dy * yUnit.y;
      return { x: x * (unitsPerPixel ?? 0), y: y * (unitsPerPixel ?? 0) };
    },
    description: {
      active: true,
      calibrated,
      label: calibration.mode === 'rotated' ? 'Rotated scale' : 'Pixel-to-distance scale',
      detail: calibrated
        ? `${calibration.knownLength} ${unit} over ${scalePixels.toFixed(1)} px${calibration.mode === 'rotated' ? ' with user-defined axes' : ''}. Assumes a flat, fronto-parallel measurement plane.`
        : 'The physical scale is incomplete or invalid.',
      warnings: [
        ...warnings,
        'Scale changes with depth, perspective and lens distortion; do not treat it as globally valid.',
      ],
      metresPerPixel,
    },
  };
}

function orientationFromFrame(frame: TrackFrame, object: MotionObject): number | null {
  if (frame.references.length >= 2) {
    const a = frame.references[0].point;
    const b = frame.references[1].point;
    if (distance(a, b) > 1e-6) return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  }
  if (frame.polygon.length >= 2) {
    let best = 0;
    let angle = 0;
    for (let i = 0; i < frame.polygon.length; i++) {
      for (let j = i + 1; j < frame.polygon.length; j++) {
        const d = distance(frame.polygon[i], frame.polygon[j]);
        if (d > best) {
          best = d;
          angle = (Math.atan2(frame.polygon[j].y - frame.polygon[i].y, frame.polygon[j].x - frame.polygon[i].x) * 180) / Math.PI;
        }
      }
    }
    while (angle >= 90) angle -= 180;
    while (angle < -90) angle += 180;
    if (best > 1e-6) return angle;
  }
  return object.initialPolygon.length ? 0 : null;
}

export function apparentLengthPixels(frame: TrackFrame, object: MotionObject): number {
  if (frame.references.length >= 2) {
    const d = distance(frame.references[0].point, frame.references[1].point);
    if (d > 0) return d;
  }
  const b = frame.bbox;
  return Math.max(b.width, b.height);
}

function derivative(values: number[], times: number[]): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      const dt = times[1] - times[0];
      out[i] = values.length > 1 && dt > 0 ? (values[1] - values[0]) / dt : NaN;
    } else if (i === values.length - 1) {
      const dt = times[i] - times[i - 1];
      out[i] = dt > 0 ? (values[i] - values[i - 1]) / dt : NaN;
    } else {
      const dt = times[i + 1] - times[i - 1];
      out[i] = dt > 0 ? (values[i + 1] - values[i - 1]) / dt : NaN;
    }
  }
  return out;
}

function unwrapDegrees(values: Array<number | null>): Array<number | null> {
  let offset = 0;
  let previous: number | null = null;
  return values.map((value) => {
    if (value === null) return null;
    if (previous !== null) {
      let delta = value + offset - previous;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      offset = previous + delta - value;
    }
    const next = value + offset;
    previous = next;
    return next;
  });
}

export function analyseObject(
  object: MotionObject,
  calibration: MotionCalibration,
  settings: Pick<MotionSettings, 'smoothingWindow' | 'startFrame' | 'endFrame'> & Partial<Pick<MotionSettings, 'compensateCamera'>>,
): { frames: MotionFrameResult[]; summary: MotionSummary; calibration: PixelCalibration } {
  const pixelCal = buildPixelCalibration(calibration);
  const lengthUnit = calibration.lengthUnit || 'm';
  const objectLengthInCalibrationUnit =
    convertUnit(object.actualLength, object.lengthUnit || lengthUnit, lengthUnit) ??
    (object.lengthUnit === lengthUnit ? object.actualLength : null);
  const frames = [...object.frames]
    .filter((f) => Number.isFinite(f.time))
    .sort((a, b) => a.frame - b.frame)
    .filter((f) => f.frame >= settings.startFrame && (settings.endFrame <= 0 || f.frame <= settings.endFrame));

  if (!frames.length) {
    return {
      frames: [],
      calibration: pixelCal,
      summary: {
        frameCount: 0,
        duration: 0,
        distance: 0,
        displacement: 0,
        maxSpeed: 0,
        minSpeed: 0,
        averageSpeed: 0,
        maxAcceleration: 0,
        maxAbsoluteVerticalVelocity: 0,
        netDirectionDeg: null,
        calibrated: pixelCal.calibrated,
        cameraCompensated: false,
        unit: pixelCal.calibrated ? lengthUnit : 'px',
        velocityUnit: pixelCal.calibrated ? `${lengthUnit}/s` : 'px/s',
        accelerationUnit: pixelCal.calibrated ? `${lengthUnit}/s²` : 'px/s²',
      },
    };
  }

  const times = frames.map((f) => f.time);
  const compensationRequested = settings.compensateCamera === true;
  const compensationAvailable =
    compensationRequested &&
    frames.every((f) => f.cameraValid === true && Number.isFinite(f.cameraDx) && Number.isFinite(f.cameraDy));
  let cameraCumulativeX = 0;
  let cameraCumulativeY = 0;
  const cameraCumulative = frames.map((f, i) => {
    if (!compensationAvailable) return { x: 0, y: 0 };
    if (i > 0) {
      cameraCumulativeX += f.cameraDx ?? 0;
      cameraCumulativeY += f.cameraDy ?? 0;
    }
    return { x: cameraCumulativeX, y: cameraCumulativeY };
  });
  const points = frames.map((f, i) => {
    const centroid = polygonCentroid(f.polygon);
    return pixelCal.toMetric({
      x: centroid.x - cameraCumulative[i].x,
      y: centroid.y - cameraCumulative[i].y,
    });
  });
  const xRaw = points.map((p) => p.x);
  const yRaw = points.map((p) => p.y);
  const xSmooth = movingAverage(xRaw, settings.smoothingWindow).map((v) => v ?? NaN);
  const ySmooth = movingAverage(yRaw, settings.smoothingWindow).map((v) => v ?? NaN);

  const vxRaw = derivative(xRaw, times);
  const vyRaw = derivative(yRaw, times);
  const vx = derivative(xSmooth, times);
  const vy = derivative(ySmooth, times);
  const axRaw = derivative(vxRaw, times);
  const ayRaw = derivative(vyRaw, times);
  const ax = derivative(vx, times);
  const ay = derivative(vy, times);

  let cumulative = 0;
  const orientations = unwrapDegrees(frames.map((f) => orientationFromFrame(f, object)));
  const totals: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    if (i > 0) cumulative += Math.hypot(xRaw[i] - xRaw[i - 1], yRaw[i] - yRaw[i - 1]);
    totals.push(cumulative);
  }

  const results: MotionFrameResult[] = frames.map((frame, i) => {
    const dx = xRaw[i] - xRaw[0];
    const dy = yRaw[i] - yRaw[0];
    const speedRaw = Math.hypot(vxRaw[i], vyRaw[i]);
    const speed = Math.hypot(vx[i], vy[i]);
    const lengthPx = apparentLengthPixels(frame, object);
    let length = lengthPx;
    if (pixelCal.calibrated) {
      if (frame.references.length >= 2) {
        length = distance(pixelCal.toMetric(frame.references[0].point), pixelCal.toMetric(frame.references[1].point));
      } else {
        const b = frame.bbox;
        const a = b.width >= b.height ? { x: b.x, y: b.y + b.height / 2 } : { x: b.x + b.width / 2, y: b.y };
        const c = b.width >= b.height ? { x: b.x + b.width, y: b.y + b.height / 2 } : { x: b.x + b.width / 2, y: b.y + b.height };
        length = distance(pixelCal.toMetric(a), pixelCal.toMetric(c));
      }
    }
    const directionDeg = Number.isFinite(vx[i]) && Number.isFinite(vy[i]) && (vx[i] !== 0 || vy[i] !== 0) ? (Math.atan2(vy[i], vx[i]) * 180) / Math.PI : null;
    const orientationDeg = orientations[i];
    let angularVelocityDeg: number | null = null;
    if (i > 0 && orientationDeg !== null && orientations[i - 1] !== null) {
      const dt = times[i] - times[i - 1];
      if (dt > 0) angularVelocityDeg = (orientationDeg - orientations[i - 1]!) / dt;
    }
    return {
      frame: frame.frame,
      time: frame.time,
      pixelX: polygonCentroid(frame.polygon).x,
      pixelY: polygonCentroid(frame.polygon).y,
      x: xRaw[i],
      y: yRaw[i],
      calibrated: pixelCal.calibrated,
      dx,
      dy,
      displacement: Math.hypot(dx, dy),
      distance: totals[i],
      speedRaw,
      vxRaw: vxRaw[i],
      vyRaw: vyRaw[i],
      axRaw: axRaw[i],
      ayRaw: ayRaw[i],
      speed,
      vx: vx[i],
      vy: vy[i],
      ax: ax[i],
      ay: ay[i],
      directionDeg,
      orientationDeg,
      angularVelocityDeg,
      apparentLengthPx: lengthPx,
      apparentLength: length,
      // A physical object length can only be compared with a calibrated
      // image-plane distance. Without calibration, dividing pixels by metres
      // would produce a meaningless number.
      relativeDistance: pixelCal.calibrated && objectLengthInCalibrationUnit && objectLengthInCalibrationUnit > 0
        ? totals[i] / objectLengthInCalibrationUnit
        : null,
      quality: frame.quality,
      status: frame.status,
      manual: frame.status === 'manual',
      cameraCompensated: compensationAvailable,
      cameraDx: cameraCumulative[i].x,
      cameraDy: cameraCumulative[i].y,
    };
  });

  const finiteSpeeds = results.map((r) => r.speed).filter((v) => Number.isFinite(v));
  const finiteAccel = results.map((r) => Math.hypot(r.ax, r.ay)).filter((v) => Number.isFinite(v));
  const last = results[results.length - 1];
  const netDirectionDeg = last && (last.dx !== 0 || last.dy !== 0) ? (Math.atan2(last.dy, last.dx) * 180) / Math.PI : null;
  const summary: MotionSummary = {
    frameCount: results.length,
    duration: Math.max(0, last ? last.time - results[0].time : 0),
    distance: last?.distance ?? 0,
    displacement: last?.displacement ?? 0,
    maxSpeed: finiteSpeeds.length ? Math.max(...finiteSpeeds) : 0,
    minSpeed: finiteSpeeds.length ? Math.min(...finiteSpeeds) : 0,
    averageSpeed: finiteSpeeds.length ? finiteSpeeds.reduce((a, b) => a + b, 0) / finiteSpeeds.length : 0,
    maxAcceleration: finiteAccel.length ? Math.max(...finiteAccel) : 0,
    maxAbsoluteVerticalVelocity: results.reduce((m, r) => (Number.isFinite(r.vy) ? Math.max(m, Math.abs(r.vy)) : m), 0),
    netDirectionDeg,
    calibrated: pixelCal.calibrated,
    cameraCompensated: compensationAvailable,
    unit: pixelCal.calibrated ? lengthUnit : 'px',
    velocityUnit: pixelCal.calibrated ? `${lengthUnit}/s` : 'px/s',
    accelerationUnit: pixelCal.calibrated ? `${lengthUnit}/s²` : 'px/s²',
  };
  return { frames: results, summary, calibration: pixelCal };
}

export function foreshorteningEstimate(apparent: number, actual: number): { valid: boolean; angleDeg: number | null; ratio: number | null; reason: string } {
  if (!(actual > 0)) return { valid: false, angleDeg: null, ratio: null, reason: 'Enter a positive known object length.' };
  if (!(apparent >= 0)) return { valid: false, angleDeg: null, ratio: null, reason: 'The apparent length is not available.' };
  const ratio = apparent / actual;
  if (ratio > 1.02) return { valid: false, angleDeg: null, ratio, reason: 'Apparent length exceeds the known length; the orthographic model or inputs are inconsistent.' };
  const angle = (Math.asin(clamp(ratio, 0, 1)) * 180) / Math.PI;
  return {
    valid: true,
    angleDeg: angle,
    ratio,
    reason: 'Ideal orthographic estimate of the object-axis angle to the camera viewing direction. This is not the camera mounting angle and ignores perspective and lens distortion.',
  };
}

export function displayValue(metresValue: number, unit: string): number | null {
  return convertUnit(metresValue, 'm', unit);
}

export function unitLabel(unit: string): string {
  return unitDef(unit)?.symbol || unit || '—';
}

export function buildCsv(object: MotionObject, analysis: ReturnType<typeof analyseObject>): string {
  const rows = analysis.frames;
  const unit = analysis.summary.unit;
  const velocityUnit = analysis.summary.velocityUnit;
  const accelerationUnit = analysis.summary.accelerationUnit;
  const header = [
    'object_id',
    'object_name',
    'frame',
    'timestamp_s',
    'x_px',
    'y_px',
    `x_${unit}`,
    `y_${unit}`,
    `dx_${unit}`,
    `dy_${unit}`,
    `displacement_${unit}`,
    `distance_${unit}`,
    `speed_${velocityUnit}`,
    `speed_raw_${velocityUnit}`,
    `vx_${velocityUnit}`,
    `vy_${velocityUnit}`,
    `ax_${accelerationUnit}`,
    `ay_${accelerationUnit}`,
    'direction_deg',
    'orientation_deg',
    'angular_velocity_deg_s',
    `apparent_length_${unit}`,
    'distance_object_lengths',
    'camera_compensated',
    'camera_dx_px',
    'camera_dy_px',
    'tracking_quality',
    'measurement_status',
  ];
  const clean = (v: any) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    return String(v);
  };
  const csvEscape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        object.id,
        object.name,
        row.frame,
        row.time,
        row.pixelX,
        row.pixelY,
        row.x,
        row.y,
        row.dx,
        row.dy,
        row.displacement,
        row.distance,
        row.speed,
        row.speedRaw,
        row.vx,
        row.vy,
        row.ax,
        row.ay,
        row.directionDeg,
        row.orientationDeg,
        row.angularVelocityDeg,
        row.apparentLength,
        row.relativeDistance,
        row.cameraCompensated ? 'yes' : 'no',
        row.cameraDx,
        row.cameraDy,
        row.quality,
        row.manual ? 'manual-corrected' : row.calibrated ? 'tracked-calibrated' : 'tracked-image-plane',
      ]
        .map((v) => csvEscape(clean(v)))
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
