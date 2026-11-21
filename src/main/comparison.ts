import { computeStats, differenceStats, correlation, resampleLinear, type Stats } from '../shared/analysis';
import { compatUnitInfo, convertUnit, dimensionOf, unitDef } from '../shared/units';
import { getDb } from './db';
import { readChannel } from './datasets';

export interface ComparisonItem {
  datasetId: string;
  channelId: string;
}

export interface ComparisonSpec {
  items: ComparisonItem[];
  mode: 'elapsed' | 'absolute' | 'event' | 'record-start';
  /** Seconds added to each dataset's time axis (event alignment). */
  offsets?: Record<string, number>;
  gridPoints?: number;
  commonRange?: boolean;
  normalization?: 'none' | 'minmax' | 'zscore' | 'peak' | 'zero-initial';
  baseIndex?: number;
}

/** Fill in a unit comparison helper without pulling extra im-ports into the renderer. */
function compatUnitInfoLocal(a: string, b: string) {
  return compatUnitInfo(a, b);
}

function normalizationNote(mode: string): string {
  switch (mode) {
    case 'minmax':
      return 'Normalized per series: (x - min) / (max - min). Shapes are comparable; absolute magnitudes are lost.';
    case 'zscore':
      return 'Standardized per series: (x - mean) / standard deviation (n-1).';
    case 'peak':
      return 'Scaled per series by its maximum absolute value; peak magnitudes become 1.0.';
    case 'zero-initial':
      return 'Offset so the first valid sample of each series is zero.';
    default:
      return 'No normalization applied; values remain in their recorded units.';
  }
}

/**
 * Aligned dataset comparison.
 *
 * The original recordings are never modified. Alignment, interpolation and
 * normalization are reported alongside the results so that assumptions remain
 * visible to the engineer.
 */
export function compareDatasets(spec: ComparisonSpec): any {
  const db = getDb();
  const items = (spec.items ?? []).filter((i) => i.datasetId && i.channelId);
  if (items.length < 1) throw new Error('Select at least one channel to compare');
  if (items.length < 2) {
    // A single dataset comparison is still useful for statistics; report it as such.
  }

  interface Loaded {
    item: ComparisonItem;
    dataset: any;
    channel: any;
    time: Float64Array;
    values: Float64Array;
    unit: string;
    originalUnit: string;
    unitConverted: boolean;
  }

  const loaded: Loaded[] = items.map((item) => {
    const { dataset, channel, time, values } = readChannel(item.datasetId, item.channelId);
    return {
      item,
      dataset,
      channel,
      time: Float64Array.from(time),
      values: Float64Array.from(values),
      unit: channel.unit,
      originalUnit: channel.unit,
      unitConverted: false,
    };
  });

  // Unit compatibility across all selected channels.
  const units = loaded.map((l) => l.unit);
  const dims = units.map((u) => dimensionOf(u));
  const hasUnknownDim = dims.some((d) => d === null);
  const distinctDims = new Set(dims.filter(Boolean));
  const targetUnit = units[0];
  const convertedNote: string[] = [];
  let compatible = true;
  let incompatibility: string | null = null;

  if (!hasUnknownDim && distinctDims.size > 1) {
    compatible = false;
    incompatibility = `Selected channels measure different physical dimensions (${Array.from(distinctDims).join(', ')}). Choose channels with the same dimension, or compare them separately.`;
  } else if (hasUnknownDim && new Set(units).size > 1) {
    compatible = false;
    incompatibility = `Channels with unclassified units (${Array.from(new Set(units)).join(', ')}) cannot be compared numerically. Assign a unit in the channel metadata or compare separately.`;
  } else if (distinctDims.size === 1) {
    for (const l of loaded) {
      if (l.unit !== targetUnit) {
        const converted = compatUnitInfoLocal(l.unit, targetUnit).compatible;
        if (!converted) {
          compatible = false;
          incompatibility = `Unit ${l.unit} is not compatible with ${targetUnit}.`;
          break;
        }
        const next = new Float64Array(l.values.length);
        for (let i = 0; i < l.values.length; i++) {
          const v = convertUnit(l.values[i], l.unit, targetUnit);
          next[i] = v === null ? NaN : v;
        }
        convertedNote.push(`${l.dataset.name} · ${l.channel.name}: ${l.unit} → ${targetUnit}`);
        l.values = next;
        l.unit = targetUnit;
        l.unitConverted = true;
      }
    }
  }

  const warnings: string[] = [];
  const xUnit = 's';
  const mode = spec.mode ?? 'record-start';

  // Time axes according to alignment mode.
  for (const l of loaded) {
    const offset = spec.offsets?.[l.dataset.id] ?? spec.offsets?.[l.item.datasetId] ?? 0;
    const xs = new Float64Array(l.time.length);
    for (let i = 0; i < l.time.length; i++) xs[i] = l.time[i] + offset;
    if (mode === 'absolute') {
      const recorded = Date.parse(l.dataset.recorded_at);
      if (Number.isFinite(recorded)) {
        const base = recorded / 1000;
        for (let i = 0; i < xs.length; i++) xs[i] = base + xs[i];
      } else {
        warnings.push(`${l.dataset.name} has no usable recording timestamp; absolute alignment falls back to elapsed time.`);
      }
    }
    l.time = xs;
  }

  const ranges = loaded
    .map((l) => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < l.time.length; i++) {
        const t = l.time[i];
        if (!Number.isFinite(t)) continue;
        if (t < min) min = t;
        if (t > max) max = t;
      }
      return { l, min, max };
    })
    .filter((r) => Number.isFinite(r.min) && Number.isFinite(r.max) && r.max > r.min);

  if (ranges.length === 0) throw new Error('The selected recordings contain no usable timestamps');

  const commonFrom = Math.max(...ranges.map((r) => r.min));
  const commonTo = Math.min(...ranges.map((r) => r.max));
  const unionFrom = Math.min(...ranges.map((r) => r.min));
  const unionTo = Math.max(...ranges.map((r) => r.max));
  const commonRange = spec.commonRange !== false;
  let from = commonRange ? commonFrom : unionFrom;
  let to = commonRange ? commonTo : unionTo;
  if (!(to > from)) {
    warnings.push('The recordings do not overlap in time. A union range with missing coverage is shown instead.');
    from = unionFrom;
    to = unionTo;
  }

  const gridPoints = Math.max(50, Math.min(200000, Math.round(spec.gridPoints ?? 2000)));
  const grid = new Float64Array(gridPoints);
  for (let i = 0; i < gridPoints; i++) grid[i] = from + ((to - from) * i) / (gridPoints - 1);

  const series = loaded.map((l) => {
    const aligned = resampleLinear(l.time, l.values, grid);
    const coverage = gridPoints > 0 ? aligned.covered / gridPoints : 0;
    if (coverage < 0.999) {
      warnings.push(
        `${l.dataset.name} · ${l.channel.name}: ${(100 * (1 - coverage)).toFixed(1)}% of the aligned grid is outside the recording or missing. Values are left blank rather than extrapolated.`,
      );
    }
    let values = aligned.values;
    const raw = Float64Array.from(values);
    if ((spec.normalization ?? 'none') !== 'none') {
      const stat = computeStats(raw);
      values = new Float64Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        const v = raw[i];
        if (!Number.isFinite(v)) {
          values[i] = NaN;
          continue;
        }
        switch (spec.normalization) {
          case 'minmax':
            values[i] = stat.max !== null && stat.min !== null && stat.max !== stat.min ? (v - stat.min) / (stat.max - stat.min) : 0;
            break;
          case 'zscore':
            values[i] = stat.stdDev ? (v - (stat.mean ?? 0)) / stat.stdDev : 0;
            break;
          case 'peak': {
            const peak = Math.max(Math.abs(stat.max ?? 0), Math.abs(stat.min ?? 0));
            values[i] = peak ? v / peak : 0;
            break;
          }
          case 'zero-initial': {
            let firstValid = NaN;
            for (let j = 0; j < raw.length; j++) {
              if (Number.isFinite(raw[j])) {
                firstValid = raw[j];
                break;
              }
            }
            values[i] = Number.isFinite(firstValid) ? v - firstValid : v;
            break;
          }
        }
      }
    }
    return {
      datasetId: l.dataset.id,
      datasetName: l.dataset.name,
      datasetRecordedAt: l.dataset.recorded_at,
      channelId: l.channel.id,
      channelName: l.channel.name,
      type: l.channel.type,
      unit: l.unit,
      originalUnit: l.originalUnit,
      unitConverted: l.unitConverted,
      samplingHz: l.dataset.sampling_hz,
      sourcePoints: l.time.length,
      points: raw.length,
      coverage,
      interpolatedPoints: aligned.covered,
      stats: computeStats(raw),
      displayStats: computeStats(values),
      x: Array.from(grid),
      y: Array.from(values, (v) => (Number.isFinite(v) ? Number(v.toPrecision(12)) : null)),
      raw,
      display: values,
      aligned: raw,
    };
  });

  // Pairwise comparison against the baseline series (index 0 by default).
  const baseIdx = Math.max(0, Math.min(spec.baseIndex ?? 0, series.length - 1));
  const baseline = series[baseIdx];
  const pairs = series
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => i !== baseIdx)
    .map(({ s, i }) => {
      const diff = differenceStats(s.aligned, baseline.aligned);
      const pct = new Float64Array(s.aligned.length).fill(NaN);
      let undefinedPct = 0;
      for (let j = 0; j < s.aligned.length; j++) {
        const a = s.aligned[j];
        const b = baseline.aligned[j];
        if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
          undefinedPct++;
          continue;
        }
        pct[j] = ((a - b) / Math.abs(b)) * 100;
      }
      return {
        otherIndex: i,
        otherName: `${s.datasetName} · ${s.channelName}`,
        baselineName: `${baseline.datasetName} · ${baseline.channelName}`,
        stats: diff,
        percent: {
          mean: computeStats(pct).mean,
          max: computeStats(pct).max,
          min: computeStats(pct).min,
          undefinedPoints: undefinedPct,
          note: 'Percentage difference uses (other - baseline) / |baseline| × 100. Points with a zero or missing baseline are excluded.',
        },
        rmsDifference: diff.rms,
      };
    });

  const limitations = [
    'Alignment and interpolation are analysis aids; they do not prove that two recordings represent the same physical conditions.',
    'Correlation coefficients describe linear association only and are not evidence of causation.',
    'Differences are only meaningful where both series actually recorded data in the aligned window.',
  ];
  if (convertedNote.length) limitations.push(`Unit conversions applied: ${convertedNote.join('; ')}.`);
  if (series.some((s) => s.samplingHz && series[0].samplingHz && Math.abs(s.samplingHz - series[0].samplingHz) > 1e-9 * series[0].samplingHz)) {
    limitations.push('The selected recordings have different sampling rates; interpolation onto a common grid smooths the faster recording.');
  }
  if ((spec.normalization ?? 'none') !== 'none') limitations.push(normalizationNote(spec.normalization!));

  return {
    compatible,
    incompatibility,
    mode,
    alignmentLabel:
      mode === 'absolute'
        ? 'Absolute timestamp alignment (recorded date + elapsed time)'
        : mode === 'event'
          ? 'Event alignment (user offsets applied to elapsed time)'
          : 'Start-of-recording alignment (elapsed time)',
    range: { from, to, commonRange, commonFrom, commonTo, unionFrom, unionTo },
    xUnit,
    normalization: spec.normalization ?? 'none',
    normalizationNote: normalizationNote(spec.normalization ?? 'none'),
    gridPoints,
    targetUnit,
    series,
    pairs,
    warnings,
    limitations,
    metadata: series.map((s) => ({
      datasetId: s.datasetId,
      datasetName: s.datasetName,
      channelName: s.channelName,
      recordingDate: s.datasetRecordedAt,
      samplingHz: s.samplingHz,
      sourcePoints: s.sourcePoints,
      duration: s.sourcePoints && s.samplingHz ? s.sourcePoints / s.samplingHz : null,
      unit: s.unit,
    })),
    computedAt: new Date().toISOString(),
    method: 'Linear interpolation onto a uniform shared time grid; no extrapolation beyond recorded coverage.',
  };
}

/** Metadata used by the comparison dataset picker. */
export function comparisonCandidates(projectId?: string): any[] {
  const db = getDb();
  const datasets = db.all<any>(
    `SELECT d.*, p.name AS project_name, t.name AS test_name, f.name AS flight_name, r.label AS run_label
     FROM datasets d
     LEFT JOIN projects p ON p.id = d.project_id
     LEFT JOIN tests t ON t.id = d.test_id
     LEFT JOIN flights f ON f.id = d.flight_id
     LEFT JOIN runs r ON r.id = d.run_id
     ${projectId ? 'WHERE d.project_id = ?' : ''}
     ORDER BY d.created_at DESC`,
    projectId ? [projectId] : [],
  );
  const channelRows = db.all<any>('SELECT * FROM channels ORDER BY rowid');
  const byDataset = new Map<string, any[]>();
  for (const c of channelRows) {
    if (!byDataset.has(c.dataset_id)) byDataset.set(c.dataset_id, []);
    byDataset.get(c.dataset_id)!.push({
      id: c.id,
      name: c.name,
      type: c.type,
      unit: c.unit,
      typeLabel: unitDef(c.unit)?.dimension ?? 'unclassified',
    });
  }
  return datasets.map((d) => ({
    ...d,
    channels: byDataset.get(d.id) ?? [],
  }));
}
