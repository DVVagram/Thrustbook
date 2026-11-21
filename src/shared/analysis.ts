/**
 * Numerical analysis primitives shared by the main process and the renderer.
 * Every routine documents its assumptions; no routine mutates its inputs, and
 * statistics are refused when the data is not valid for them.
 */

export interface Stats {
  n: number;
  valid: number;
  missing: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  stdDev: number | null;
  variance: number | null;
  range: number | null;
  rms: number | null;
  p05: number | null;
  p25: number | null;
  p75: number | null;
  p95: number | null;
  method: string;
}

const EMPTY_STATS = (n: number, missing: number, method: string): Stats => ({
  n,
  valid: 0,
  missing,
  min: null,
  max: null,
  mean: null,
  median: null,
  stdDev: null,
  variance: null,
  range: null,
  rms: null,
  p05: null,
  p25: null,
  p75: null,
  p95: null,
  method,
});

/** Sort-copy of the finite values only. */
export function finiteValues(values: ArrayLike<number>): Float64Array {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) out.push(v);
  }
  return Float64Array.from(out);
}

/** Linear-interpolated percentile of an already sorted array (0..100). */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export function percentile(values: ArrayLike<number>, p: number): number | null {
  const finite = finiteValues(values);
  if (finite.length === 0) return null;
  finite.sort();
  return percentileSorted(finite, p);
}

/**
 * Descriptive statistics.
 * - standard deviation is the sample standard deviation (n-1); for n=1 it is 0
 * - RMS uses all valid values
 * - percentiles use linear interpolation between order statistics
 */
export function computeStats(values: ArrayLike<number>, method = 'Sample statistics over finite values (std dev uses n-1)'): Stats {
  const n = values.length;
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    count++;
    sum += v;
    sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (count === 0) return EMPTY_STATS(n, n - count, method);
  const mean = sum / count;
  const variance = count > 1 ? (sumSq - count * mean * mean) / (count - 1) : 0;
  const finite = finiteValues(values);
  finite.sort();
  return {
    n,
    valid: count,
    missing: n - count,
    min,
    max,
    mean,
    median: percentileSorted(finite, 50),
    stdDev: Math.sqrt(Math.max(0, variance)),
    variance: Math.max(0, variance),
    range: max - min,
    rms: Math.sqrt(sumSq / count),
    p05: percentileSorted(finite, 5),
    p25: percentileSorted(finite, 25),
    p75: percentileSorted(finite, 75),
    p95: percentileSorted(finite, 95),
    method,
  };
}

/** Derivative dy/dx with finite differences. Non-positive or missing dx yields NaN. */
export function rateOfChange(x: ArrayLike<number>, y: ArrayLike<number>): Float64Array {
  const n = Math.min(x.length, y.length);
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      if (n > 1) {
        const dx = x[1] - x[0];
        out[0] = dx > 0 && Number.isFinite(y[1]) && Number.isFinite(y[0]) ? (y[1] - y[0]) / dx : NaN;
      }
    } else {
      const dx = x[i] - x[i - 1];
      out[i] = dx > 0 && Number.isFinite(y[i]) && Number.isFinite(y[i - 1]) ? (y[i] - y[i - 1]) / dx : NaN;
    }
  }
  return out;
}

/** Centered moving average over valid samples; edges use the available window. */
export function movingAverage(values: ArrayLike<number>, window: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  if (window < 1) return out;
  const half = Math.floor(window / 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    const from = Math.max(0, i - half);
    const to = Math.min(n - 1, i + half);
    for (let j = from; j <= to; j++) {
      const v = values[j];
      if (Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    if (count > 0) out[i] = sum / count;
  }
  return out;
}

export interface Histogram {
  bins: { from: number; to: number; count: number }[];
  binWidth: number;
  min: number;
  max: number;
  n: number;
}

export function histogram(values: ArrayLike<number>, binCount = 30): Histogram | null {
  const finite = finiteValues(values);
  if (finite.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    return { bins: [{ from: min, to: max, count: finite.length }], binWidth: 0, min, max, n: finite.length };
  }
  const bins = Math.max(1, Math.min(500, binCount));
  const width = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of finite) {
    let idx = Math.floor((v - min) / width);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  }
  return {
    bins: counts.map((count, i) => ({ from: min + i * width, to: min + (i + 1) * width, count })),
    binWidth: width,
    min,
    max,
    n: finite.length,
  };
}

export interface BoxStats {
  min: number | null;
  q1: number | null;
  median: number | null;
  q3: number | null;
  max: number | null;
  iqr: number | null;
  lowerFence: number | null;
  upperFence: number | null;
  outliers: number[];
  n: number;
}

export function boxStats(values: ArrayLike<number>): BoxStats {
  const finite = finiteValues(values);
  finite.sort();
  if (finite.length === 0) {
    return { min: null, q1: null, median: null, q3: null, max: null, iqr: null, lowerFence: null, upperFence: null, outliers: [], n: 0 };
  }
  const q1 = percentileSorted(finite, 25)!;
  const median = percentileSorted(finite, 50)!;
  const q3 = percentileSorted(finite, 75)!;
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  const outliers: number[] = [];
  for (const v of finite) if (v < lowerFence || v > upperFence) outliers.push(v);
  // Whiskers extend to the most extreme values inside the fences (Tukey).
  let whiskLo = q1;
  let whiskHi = q3;
  for (const v of finite) {
    if (v >= lowerFence && v < whiskLo) whiskLo = v;
    if (v <= upperFence && v > whiskHi) whiskHi = v;
  }
  return {
    min: whiskLo,
    q1,
    median,
    q3,
    max: whiskHi,
    iqr,
    lowerFence,
    upperFence,
    outliers: outliers.slice(0, 500),
    n: finite.length,
  };
}

export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number | null {
  const n = Math.min(a.length, b.length);
  let count = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    count++;
    sa += x;
    sb += y;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
  }
  if (count < 2) return null;
  const cov = sab - (sa * sb) / count;
  const va = saa - (sa * sa) / count;
  const vb = sbb - (sb * sb) / count;
  if (va <= 0 || vb <= 0) return null;
  return cov / Math.sqrt(va * vb);
}

export interface DifferenceStats {
  n: number;
  valid: number;
  mean: number | null;
  meanAbs: number | null;
  median: number | null;
  stdDev: number | null;
  min: number | null;
  max: number | null;
  peakAbs: number | null;
  rms: number | null;
  p95Abs: number | null;
  correlation: number | null;
  method: string;
}

/** a - b element-wise, with paired-valid filtering for the statistics. */
export function differenceStats(a: ArrayLike<number>, b: ArrayLike<number>): DifferenceStats {
  const n = Math.min(a.length, b.length);
  const diffs: number[] = [];
  const abs: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d = x - y;
    diffs.push(d);
    abs.push(Math.abs(d));
    left.push(x);
    right.push(y);
  }
  if (diffs.length === 0) {
    return {
      n,
      valid: 0,
      mean: null,
      meanAbs: null,
      median: null,
      stdDev: null,
      min: null,
      max: null,
      peakAbs: null,
      rms: null,
      p95Abs: null,
      correlation: null,
      method: 'Differences computed on paired finite samples (a - b)',
    };
  }
  const s = computeStats(diffs);
  abs.sort((x, y) => x - y);
  return {
    n,
    valid: diffs.length,
    mean: s.mean,
    meanAbs: s.mean === null ? null : abs.reduce((x, y) => x + y, 0) / abs.length,
    median: s.median,
    stdDev: s.stdDev,
    min: s.min,
    max: s.max,
    peakAbs: abs[abs.length - 1],
    rms: s.rms,
    p95Abs: percentileSorted(abs, 95),
    correlation: correlation(left, right),
    method: 'Differences computed on paired finite samples; a - b; correlation is Pearson r over the same pairs',
  };
}

/** Largest-Triangle-Three-Buckets downsampling: keeps visual shape, returns indices. */
export function lttbIndices(x: ArrayLike<number>, y: ArrayLike<number>, threshold: number): number[] {
  const n = Math.min(x.length, y.length);
  if (threshold >= n || threshold <= 2) {
    const all = new Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    return all;
  }
  const sampled: number[] = [0];
  const bucketSize = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const rangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);
    let avgX = 0;
    let avgY = 0;
    let count = 0;
    for (let j = rangeStart; j < rangeEnd; j++) {
      if (!Number.isFinite(x[j]) || !Number.isFinite(y[j])) continue;
      avgX += x[j];
      avgY += y[j];
      count++;
    }
    if (count === 0) {
      avgX = x[rangeStart] ?? 0;
      avgY = y[rangeStart] ?? 0;
    } else {
      avgX /= count;
      avgY /= count;
    }
    const start = Math.floor(i * bucketSize) + 1;
    const end = Math.floor((i + 1) * bucketSize) + 1;
    let maxArea = -1;
    let best = start;
    for (let j = start; j < end && j < n; j++) {
      if (!Number.isFinite(x[j]) || !Number.isFinite(y[j])) continue;
      const area = Math.abs((x[a] - avgX) * (y[j] - y[a]) - (x[a] - x[j]) * (avgY - y[a]));
      if (area > maxArea) {
        maxArea = area;
        best = j;
      }
    }
    sampled.push(best);
    a = best;
  }
  sampled.push(n - 1);
  return sampled;
}

/** Min/max bucket downsampling — preserves peaks; returns indices. */
export function minMaxIndices(x: ArrayLike<number>, y: ArrayLike<number>, threshold: number): number[] {
  const n = Math.min(x.length, y.length);
  if (threshold >= n) {
    const all = new Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    return all;
  }
  const buckets = Math.max(1, Math.floor(threshold / 2));
  const size = n / buckets;
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size);
    const to = Math.min(n, Math.floor((b + 1) * size));
    let iMin = -1;
    let iMax = -1;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (let i = from; i < to; i++) {
      const v = y[i];
      if (!Number.isFinite(v)) continue;
      if (v < vMin) {
        vMin = v;
        iMin = i;
      }
      if (v > vMax) {
        vMax = v;
        iMax = i;
      }
    }
    if (iMin >= 0) {
      if (iMin === iMax) out.push(iMin);
      else if (iMin < iMax) out.push(iMin, iMax);
      else out.push(iMax, iMin);
    }
  }
  if (out.length === 0) return [];
  return out;
}

/** Linear interpolation of irregular samples onto a target grid. */
export interface ResampleResult {
  values: Float64Array;
  interpolated: Uint8Array;
  covered: number;
  extrapolated: number;
}

export function resampleLinear(
  srcX: ArrayLike<number>,
  srcY: ArrayLike<number>,
  targetX: ArrayLike<number>,
): ResampleResult {
  const n = targetX.length;
  const values = new Float64Array(n).fill(NaN);
  const interpolated = new Uint8Array(n);
  let covered = 0;
  let extrapolated = 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const x = targetX[i];
    while (j < srcX.length - 1 && srcX[j + 1] < x) j++;
    const x0 = srcX[j];
    const x1 = srcX[Math.min(j + 1, srcX.length - 1)];
    const y0 = srcY[j];
    const y1 = srcY[Math.min(j + 1, srcY.length - 1)];
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
    if (x < x0 || x > x1) {
      // Outside the source range: no extrapolation, values stay missing.
      continue;
    }
    if (x === x0 || !Number.isFinite(x1) || x1 === x0 || !Number.isFinite(y1)) {
      values[i] = y0;
      interpolated[i] = x === x0 ? 0 : 1;
      covered++;
      continue;
    }
    const frac = (x - x0) / (x1 - x0);
    values[i] = y0 + (y1 - y0) * frac;
    interpolated[i] = 1;
    covered++;
  }
  if (covered === 0) extrapolated = n;
  return { values, interpolated, covered, extrapolated };
}

/** Sample times of a channel (elapsed seconds or absolute seconds). */
export function uniformGrid(from: number, to: number, points: number): Float64Array {
  const n = Math.max(2, Math.min(2_000_000, Math.round(points)));
  const out = new Float64Array(n);
  const span = to - from;
  for (let i = 0; i < n; i++) out[i] = from + (span * i) / (n - 1);
  return out;
}

export function sampleIntervalStats(x: ArrayLike<number>): {
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  nonMonotonic: number;
  duplicateTimestamps: number;
} {
  let count = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let nonMonotonic = 0;
  let duplicate = 0;
  const diffs: number[] = [];
  for (let i = 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    if (!Number.isFinite(d)) continue;
    if (d < 0) nonMonotonic++;
    if (d === 0) duplicate++;
    if (d > 0) {
      diffs.push(d);
      count++;
      sum += d;
      if (d < min) min = d;
      if (d > max) max = d;
    }
  }
  diffs.sort((a, b) => a - b);
  return {
    mean: count ? sum / count : null,
    median: diffs.length ? percentileSorted(diffs, 50) : null,
    min: count ? min : null,
    max: count ? max : null,
    nonMonotonic,
    duplicateTimestamps: duplicate,
  };
}
