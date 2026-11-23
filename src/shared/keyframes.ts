/**
 * Rocket video analyser — keyframe-only measurement model.
 *
 * This tool deliberately has no automatic tracking. A keyframe is a manual
 * position of the rocket at one decoded video frame. Every distance, speed and
 * acceleration is derived only from differences between consecutive keyframes:
 *
 *   interval distance = straight line between two marked positions
 *   interval speed    = interval distance / measured frame-time difference
 *   acceleration      = second difference of the interval speeds
 *
 * Image coordinates are pixels with y increasing downwards. A physical result is
 * labelled calibrated only when a complete known-distance scale is present.
 */
import { unitDef } from './units';

export type KeyframeTimingSource = 'video-timestamps' | 'manual-fps' | 'image-sequence' | 'unknown';
export type KeyframeMediaKind = 'video' | 'image';

export interface KeyframePoint {
  x: number;
  y: number;
}

export interface KeyframeMedia {
  kind: KeyframeMediaKind;
  path: string;
  name: string;
  width: number;
  height: number;
  duration: number | null;
  frameCount: number | null;
  fps: number | null;
  timestamps: number[];
  timingSource: KeyframeTimingSource;
  variableFrameRate: boolean;
  fileSize?: number;
}

export interface Keyframe {
  id: string;
  frame: number;
  /** Decoded presentation time, or null when frame timing is not known yet. */
  time: number | null;
  /** Marked position in source pixels. */
  x: number;
  y: number;
  notes: string;
}

export interface KeyframeCalibration {
  mode: 'none' | 'scale';
  pointA: KeyframePoint | null;
  pointB: KeyframePoint | null;
  knownLength: number;
  lengthUnit: string;
  notes: string;
}

export interface KeyframeSet {
  version: 1;
  name: string;
  media: KeyframeMedia;
  keyframes: Keyframe[];
  calibration: KeyframeCalibration;
  notes: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface KeyframeRow {
  id: string;
  frame: number;
  time: number | null;
  pixelX: number;
  pixelY: number;
  x: number;
  y: number;
  intervalSeconds: number | null;
  intervalDistance: number | null;
  speed: number | null;
  acceleration: number | null;
  directionDeg: number | null;
  cumulativeDistance: number;
  displacement: number;
  notes: string;
}

export interface KeyframeSummary {
  keyframes: number;
  timedKeyframes: number;
  duration: number;
  totalDistance: number;
  displacement: number;
  averageSpeed: number;
  maxSpeed: number;
  maxAcceleration: number;
  netDirectionDeg: number | null;
  calibrated: boolean;
  unit: string;
  velocityUnit: string;
  accelerationUnit: string;
  warnings: string[];
}

export interface KeyframeScale {
  calibrated: boolean;
  /** Pixels per one calibration unit, e.g. px per metre. */
  pixelsPerUnit: number | null;
  /** Calibration units per pixel, e.g. metres per pixel. */
  unitsPerPixel: number | null;
  pixelDistance: number | null;
  warnings: string[];
}

export interface KeyframeAnalysis {
  rows: KeyframeRow[];
  summary: KeyframeSummary;
  scale: KeyframeScale;
}

export function keyframeId(): string {
  const cryptoObject = globalThis.crypto as Crypto | undefined;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') return cryptoObject.randomUUID();
  return `kf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyKeyframeCalibration(): KeyframeCalibration {
  return {
    mode: 'none',
    pointA: null,
    pointB: null,
    knownLength: 1,
    lengthUnit: 'm',
    notes: '',
  };
}

export function normaliseTimestamps(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .map((value) => Number(value.toFixed(9))),
    ),
  ].sort((a, b) => a - b);
}

export function frameTiming(timestamps: number[]): { fps: number | null; variable: boolean; meanInterval: number | null } {
  if (timestamps.length < 2) return { fps: null, variable: false, meanInterval: null };
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const dt = timestamps[i] - timestamps[i - 1];
    if (dt > 1e-9) intervals.push(dt);
  }
  if (!intervals.length) return { fps: null, variable: false, meanInterval: null };
  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const variable = intervals.some((dt) => Math.abs(dt - mean) > mean * 0.01);
  return { fps: mean > 0 ? 1 / mean : null, variable, meanInterval: mean };
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalPositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalisePoint(value: any): KeyframePoint | null {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function normaliseCalibration(input: any): KeyframeCalibration {
  const raw = input ?? {};
  const unit = String(raw.lengthUnit ?? 'm');
  return {
    mode: raw.mode === 'scale' ? 'scale' : 'none',
    pointA: normalisePoint(raw.pointA),
    pointB: normalisePoint(raw.pointB),
    knownLength: optionalPositive(raw.knownLength) ?? 1,
    lengthUnit: unitDef(unit)?.dimension === 'length' ? unit : 'm',
    notes: String(raw.notes ?? ''),
  };
}

export function normaliseKeyframeSet(input: any): KeyframeSet {
  const rawMedia = input?.media ?? {};
  const timestamps = normaliseTimestamps(rawMedia.timestamps);
  const frameCountValue = Number(rawMedia.frameCount);
  const media: KeyframeMedia = {
    kind: rawMedia.kind === 'image' ? 'image' : 'video',
    path: typeof rawMedia.path === 'string' ? rawMedia.path : '',
    name: typeof rawMedia.name === 'string' ? rawMedia.name : '',
    width: Math.max(0, finiteNumber(rawMedia.width, 0)),
    height: Math.max(0, finiteNumber(rawMedia.height, 0)),
    duration: optionalPositive(rawMedia.duration),
    frameCount: Number.isFinite(frameCountValue) && frameCountValue >= 0 ? Math.round(frameCountValue) : timestamps.length || null,
    fps: optionalPositive(rawMedia.fps),
    timestamps,
    timingSource:
      rawMedia.timingSource === 'video-timestamps' ||
      rawMedia.timingSource === 'manual-fps' ||
      rawMedia.timingSource === 'image-sequence'
        ? rawMedia.timingSource
        : 'unknown',
    variableFrameRate: rawMedia.variableFrameRate === true,
    ...(optionalPositive(rawMedia.fileSize) ? { fileSize: Number(rawMedia.fileSize) } : {}),
  };

  const byFrame = new Map<number, Keyframe>();
  for (const entry of Array.isArray(input?.keyframes) ? input.keyframes : []) {
    const frame = Number(entry?.frame);
    const x = Number(entry?.x);
    const y = Number(entry?.y);
    if (!Number.isInteger(frame) || frame < 0 || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const timeValue = entry?.time === null || entry?.time === undefined ? NaN : Number(entry.time);
    byFrame.set(frame, {
      id: typeof entry?.id === 'string' && entry.id ? entry.id : keyframeId(),
      frame,
      time: Number.isFinite(timeValue) && timeValue >= 0 ? timeValue : null,
      x,
      y,
      notes: String(entry?.notes ?? ''),
    });
  }
  const keyframes = [...byFrame.values()].sort((a, b) => a.frame - b.frame);

  return {
    version: 1,
    name: String(input?.name ?? 'Keyframe analysis') || 'Keyframe analysis',
    media,
    keyframes,
    calibration: normaliseCalibration(input?.calibration),
    notes: String(input?.notes ?? ''),
    ...(typeof input?.createdAt === 'string' ? { createdAt: input.createdAt } : {}),
    ...(typeof input?.updatedAt === 'string' ? { updatedAt: input.updatedAt } : {}),
  };
}

/** Presentation time for a frame index. Never assumes a frame rate silently. */
export function keyframeTime(media: KeyframeMedia, frame: number): number | null {
  const timestamp = media.timestamps[frame];
  if (Number.isFinite(timestamp) && timestamp >= 0) return timestamp;
  if (media.fps && media.fps > 0 && Number.isInteger(frame) && frame >= 0) return frame / media.fps;
  return null;
}

export function upsertKeyframe(keyframes: Keyframe[], keyframe: Keyframe): Keyframe[] {
  return [...keyframes.filter((entry) => entry.frame !== keyframe.frame), keyframe].sort((a, b) => a.frame - b.frame);
}

export function removeKeyframeAt(keyframes: Keyframe[], frame: number): Keyframe[] {
  return keyframes.filter((entry) => entry.frame !== frame);
}

export function keyframeScale(calibration: KeyframeCalibration): KeyframeScale {
  if (calibration.mode !== 'scale') {
    return { calibrated: false, pixelsPerUnit: null, unitsPerPixel: null, pixelDistance: null, warnings: [] };
  }
  const warnings: string[] = [];
  const a = calibration.pointA;
  const b = calibration.pointB;
  const pixelDistance = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : null;
  if (!(pixelDistance && pixelDistance > 1e-9)) warnings.push('Choose two distinct scale reference points.');
  if (!(calibration.knownLength > 0)) warnings.push('Enter a positive known distance.');
  if (unitDef(calibration.lengthUnit)?.dimension !== 'length') warnings.push('Choose a length unit for the known distance.');
  const valid = warnings.length === 0 && pixelDistance !== null;
  return {
    calibrated: valid,
    pixelsPerUnit: valid ? pixelDistance! / calibration.knownLength : null,
    unitsPerPixel: valid ? calibration.knownLength / pixelDistance! : null,
    pixelDistance,
    warnings,
  };
}

export function describeKeyframeScale(scale: KeyframeScale, calibration: KeyframeCalibration): string {
  if (!scale.calibrated) {
    return calibration.mode === 'scale'
      ? 'The known-distance scale is incomplete. Positions and speeds remain in pixels.'
      : 'No physical scale. Positions are pixel coordinates; distances and speeds are in pixels.';
  }
  return `${calibration.knownLength} ${calibration.lengthUnit} over ${scale.pixelDistance!.toFixed(1)} px = ${scale.unitsPerPixel!.toPrecision(5)} ${calibration.lengthUnit}/px.`;
}

/**
 * Measure a keyframe set. Only the differences between marked keyframes are
 * used; nothing is interpolated and no positions are invented between them.
 */
export function analyseKeyframeSet(set: KeyframeSet): KeyframeAnalysis {
  const calibration = normaliseCalibration(set.calibration);
  const scale = keyframeScale(calibration);
  const sorted = [...set.keyframes].sort((a, b) => a.frame - b.frame);
  const toUnits = (value: number) => (scale.calibrated && scale.unitsPerPixel !== null ? value * scale.unitsPerPixel : value);
  const origin = sorted[0] ? { x: toUnits(sorted[0].x), y: toUnits(sorted[0].y) } : null;

  let cumulative = 0;
  let previousSpeed: number | null = null;
  let previousInterval: number | null = null;

  const rows: KeyframeRow[] = sorted.map((keyframe, index) => {
    const x = toUnits(keyframe.x);
    const y = toUnits(keyframe.y);
    const previous = index > 0 ? sorted[index - 1] : null;
    let intervalSeconds: number | null = null;
    let intervalDistance: number | null = null;
    let speed: number | null = null;
    let acceleration: number | null = null;
    let directionDeg: number | null = null;

    if (previous) {
      const dx = x - toUnits(previous.x);
      const dy = y - toUnits(previous.y);
      intervalDistance = Math.hypot(dx, dy);
      cumulative += intervalDistance;
      if (Math.abs(dx) > 1e-12 || Math.abs(dy) > 1e-12) {
        directionDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
      }
      if (keyframe.time !== null && previous.time !== null) {
        const dt = keyframe.time - previous.time;
        if (dt > 1e-9) {
          intervalSeconds = dt;
          speed = intervalDistance / dt;
        }
      }
      if (
        speed !== null &&
        intervalSeconds !== null &&
        previousSpeed !== null &&
        previousInterval !== null &&
        intervalSeconds + previousInterval > 1e-9
      ) {
        // Second difference over the two interval midpoints.
        acceleration = (2 * (speed - previousSpeed)) / (intervalSeconds + previousInterval);
      }
    }

    if (speed !== null && intervalSeconds !== null) {
      previousSpeed = speed;
      previousInterval = intervalSeconds;
    } else {
      previousSpeed = null;
      previousInterval = null;
    }

    return {
      id: keyframe.id,
      frame: keyframe.frame,
      time: keyframe.time,
      pixelX: keyframe.x,
      pixelY: keyframe.y,
      x,
      y,
      intervalSeconds,
      intervalDistance,
      speed,
      acceleration,
      directionDeg,
      cumulativeDistance: cumulative,
      displacement: origin ? Math.hypot(x - origin.x, y - origin.y) : 0,
      notes: keyframe.notes,
    };
  });

  const timedRows = rows.filter((row) => row.time !== null);
  const duration =
    timedRows.length > 1 ? Math.max(0, timedRows[timedRows.length - 1].time! - timedRows[0].time!) : 0;
  const speeds = rows.map((row) => row.speed).filter((value): value is number => value !== null && Number.isFinite(value));
  const accelerations = rows
    .map((row) => row.acceleration)
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .map((value) => Math.abs(value));
  const totalDistance = rows.length ? rows[rows.length - 1].cumulativeDistance : 0;
  const last = rows[rows.length - 1];
  const netDirectionDeg =
    rows.length > 1 && last && (last.x !== origin!.x || last.y !== origin!.y)
      ? (Math.atan2(last.y - origin!.y, last.x - origin!.x) * 180) / Math.PI
      : null;

  const unit = scale.calibrated ? calibration.lengthUnit : 'px';
  const warnings = [...scale.warnings];
  if (rows.length < 2) warnings.push('Add at least two keyframes to measure an interval.');
  const untimed = rows.filter((row) => row.time === null).length;
  if (untimed > 0) {
    warnings.push(
      `${untimed} keyframe${untimed === 1 ? '' : 's'} ${untimed === 1 ? 'has' : 'have'} no frame time. Scan the video's real timestamps or enter an FPS.`,
    );
  }
  const unusableIntervals = rows.filter((row, index) => index > 0 && row.intervalSeconds === null).length;
  if (unusableIntervals > 0 && rows.length > 1) {
    warnings.push(
      `${unusableIntervals} interval${unusableIntervals === 1 ? '' : 's'} ${unusableIntervals === 1 ? 'has' : 'have'} no positive time difference; speeds for those intervals are not reported.`,
    );
  }
  if (!scale.calibrated) {
    warnings.push('Distances and speeds are in pixels. Add a known distance to report physical units.');
  } else {
    warnings.push('The pixel scale is isotropic and assumes a flat, fronto-parallel measurement plane; depth changes are not corrected.');
  }

  return {
    rows,
    scale,
    summary: {
      keyframes: rows.length,
      timedKeyframes: timedRows.length,
      duration,
      totalDistance,
      displacement: last?.displacement ?? 0,
      averageSpeed: duration > 0 ? totalDistance / duration : 0,
      maxSpeed: speeds.length ? Math.max(...speeds) : 0,
      maxAcceleration: accelerations.length ? Math.max(...accelerations) : 0,
      netDirectionDeg,
      calibrated: scale.calibrated,
      unit,
      velocityUnit: `${unit}/s`,
      accelerationUnit: `${unit}/s²`,
      warnings,
    },
  };
}

/**
 * Reuse a saved keyframe set on another clip. Marked positions are scaled when
 * the target resolution differs, frame times are taken from the target clip's
 * own timestamps and marks outside the target clip are reported, not clamped.
 */
export function reuseKeyframeSet(
  source: KeyframeSet,
  media: KeyframeMedia,
): { keyframes: Keyframe[]; calibration: KeyframeCalibration; dropped: number; scaled: boolean } {
  const scaleX = source.media.width > 0 && media.width > 0 ? media.width / source.media.width : 1;
  const scaleY = source.media.height > 0 && media.height > 0 ? media.height / source.media.height : 1;
  const scaled = Math.abs(scaleX - 1) > 1e-9 || Math.abs(scaleY - 1) > 1e-9;
  const frameCount = media.frameCount ?? media.timestamps.length;
  let dropped = 0;
  const keyframes: Keyframe[] = [];
  for (const entry of source.keyframes) {
    if (Number.isInteger(frameCount) && frameCount > 0 && entry.frame >= frameCount) {
      dropped++;
      continue;
    }
    keyframes.push({
      id: keyframeId(),
      frame: entry.frame,
      time: keyframeTime(media, entry.frame),
      x: entry.x * scaleX,
      y: entry.y * scaleY,
      notes: entry.notes,
    });
  }
  const sourceCalibration = normaliseCalibration(source.calibration);
  const calibration: KeyframeCalibration = {
    ...sourceCalibration,
    pointA: sourceCalibration.pointA ? { x: sourceCalibration.pointA.x * scaleX, y: sourceCalibration.pointA.y * scaleY } : null,
    pointB: sourceCalibration.pointB ? { x: sourceCalibration.pointB.x * scaleX, y: sourceCalibration.pointB.y * scaleY } : null,
  };
  return { keyframes: keyframes.sort((a, b) => a.frame - b.frame), calibration, dropped, scaled };
}
