import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeStats,
  movingAverage,
  rateOfChange,
  minMaxIndices,
  lttbIndices,
  sampleIntervalStats,
} from '../shared/analysis';
import { convertUnit, unitDef } from '../shared/units';
import { createRecord, expand, expandOne, logActivity, newId, nowIso, updateRecord } from './repo';
import { getDb } from './db';
import { datasetPath, deletedDir, datasetsDir, safeFileName } from './paths';
import { iterateRows, previewAny, parseTimestamp, type PreviewResult } from './importers';
import type { ImportSpec } from '../shared/types';
import { APP_NAME } from '../shared/constants';

export const SOFTWARE_VERSION = '1.0.0';

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeFloatFile(filePath: string, values: Float64Array): void {
  fs.writeFileSync(filePath, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
}

function readFloatFile(filePath: string): Float64Array | null {
  try {
    const buf = fs.readFileSync(filePath);
    return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  } catch {
    return null;
  }
}

interface ChannelWriter {
  key: string;
  file: string;
  fd: number;
  buffer: Float64Array;
  filled: number;
  min: number;
  max: number;
  sum: number;
  sumSq: number;
  valid: number;
  missing: number;
  flush(): void;
  push(value: number): void;
  close(): void;
}

const FLUSH_AT = 65536;

function openChannelWriter(dir: string, key: string, index: number): ChannelWriter {
  const fileName = `ch_${String(index).padStart(2, '0')}.f64`;
  const file = path.join(dir, fileName);
  const fd = fs.openSync(file, 'w');
  const writer: ChannelWriter = {
    key,
    file: fileName,
    fd,
    buffer: new Float64Array(FLUSH_AT),
    filled: 0,
    min: Infinity,
    max: -Infinity,
    sum: 0,
    sumSq: 0,
    valid: 0,
    missing: 0,
    flush() {
      if (writer.filled === 0) return;
      const slice = writer.buffer.subarray(0, writer.filled);
      fs.writeSync(writer.fd, Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
      writer.filled = 0;
    },
    push(value: number) {
      if (!Number.isFinite(value)) {
        writer.missing++;
      } else {
        writer.valid++;
        writer.sum += value;
        writer.sumSq += value * value;
        if (value < writer.min) writer.min = value;
        if (value > writer.max) writer.max = value;
      }
      writer.buffer[writer.filled++] = Number.isFinite(value) ? value : NaN;
      if (writer.filled === FLUSH_AT) writer.flush();
    },
    close() {
      writer.flush();
      fs.closeSync(writer.fd);
    },
  };
  return writer;
}

export function previewImport(filePath: string, sheetIndex = 0, headerRow?: number): PreviewResult {
  return previewAny(filePath, headerRow, sheetIndex);
}

export interface ImportProgress {
  phase: string;
  rows: number;
  percent: number;
}

const TIME_RATE_UNITS: Record<string, number> = { s: 1, ms: 1000, us: 1e6, min: 1 / 60 };

/**
 * Imports a measurement file into a new immutable dataset.
 * The original file is copied untouched next to the derived column files.
 */
export async function commitImport(
  spec: ImportSpec,
  onProgress?: (p: ImportProgress) => void,
): Promise<any> {
  const db = getDb();
  if (!spec.filePath || !fs.existsSync(spec.filePath)) throw new Error('The selected file no longer exists');
  const project = db.get<any>('SELECT * FROM projects WHERE id = ?', [spec.projectId]);
  if (!project) throw new Error('Select a project before importing a dataset');

  const channels = (spec.channels ?? []).filter((c) => c.enabled && c.name.trim() !== '');
  if (channels.length === 0) throw new Error('Map at least one measurement channel before importing');
  const timeColumn = spec.timeColumn;

  const datasetId = newId();
  const finalDir = datasetPath(datasetId);
  const tempDir = path.join(datasetsDir(), `tmp-${datasetId}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const originalExt = path.extname(spec.filePath) || '.dat';
  const originalName = `original${originalExt}`;
  const originalPath = path.join(tempDir, originalName);

  onProgress?.({ phase: 'Copying original file', rows: 0, percent: 2 });
  fs.copyFileSync(spec.filePath, originalPath);
  const checksum = sha256File(originalPath);

  const warnings: string[] = [];
  const channelWriters = channels.map((c, i) => openChannelWriter(tempDir, c.name, i));
  const timeFile = path.join(tempDir, 'time.f64');
  const timeFd = fs.openSync(timeFile, 'w');
  const timeBuffer = new Float64Array(FLUSH_AT);
  let timeFilled = 0;
  let rowCount = 0;
  let skippedRows = 0;
  let invalidTime = 0;
  let outOfOrder = 0;
  let duplicateTime = 0;
  let firstAbsolute: number | null = null;
  let previousTime: number | null = null;
  let lastTime: number | null = null;

  const flushTime = () => {
    if (timeFilled === 0) return;
    const slice = timeBuffer.subarray(0, timeFilled);
    fs.writeSync(timeFd, Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
    timeFilled = 0;
  };

  const startRow = spec.headerRow >= 0 ? spec.headerRow + 1 : 0;
  const sheetIndex = Math.max(0, (spec as any).sheetIndex ?? 0);

  const parsedRows: { time: number | null; values: number[] }[] = [];
  const rawRows: string[][] = [];
  const collectLimit = 50;

  try {
    for await (const row of iterateRows(spec.filePath, spec.format, spec.delimiter ?? ',', startRow, sheetIndex)) {
      if (row.every((c) => (c ?? '').trim() === '')) continue;
      if (rowCount < collectLimit) rawRows.push(row.slice(0, 24));
      let t: number;
      if (timeColumn === null || timeColumn === undefined || timeColumn < 0) {
        t = spec.timeUnit === 'index' ? rowCount : rowCount / (spec.samplingHz || 1);
      } else {
        const parsed = parseTimestamp(row[timeColumn] ?? '', spec.timeUnit);
        if (parsed === null) {
          t = NaN;
          invalidTime++;
        } else {
          if (spec.timeUnit === 'iso' && firstAbsolute === null) firstAbsolute = parsed;
          t = parsed;
        }
      }
      if (Number.isFinite(t)) {
        if (previousTime !== null) {
          if (t < previousTime) outOfOrder++;
          else if (t === previousTime) duplicateTime++;
        }
        previousTime = t;
      }
      const elapsed = Number.isFinite(t) ? (firstAbsolute !== null ? t - firstAbsolute : t) : NaN;

      const rowValues: number[] = [];
      for (const writer of channelWriters) {
        const col = channels.find((c) => c.name === writer.key)?.column ?? -1;
        const raw = col >= 0 ? (row[col] ?? '').trim() : '';
        const num = raw === '' ? NaN : Number(raw.replace(/,/g, '.'));
        const value = Number.isFinite(num) ? num : NaN;
        rowValues.push(value);
        writer.push(value);
      }

      timeBuffer[timeFilled++] = Number.isFinite(elapsed) ? elapsed : NaN;
      if (timeFilled === FLUSH_AT) flushTime();
      rowCount++;
      if (rowCount % 25000 === 0) onProgress?.({ phase: 'Reading measurements', rows: rowCount, percent: 10 + Math.min(70, (rowCount / 25000) * 0.5) });
    }
  } finally {
    flushTime();
    fs.closeSync(timeFd);
    channelWriters.forEach((w) => w.close());
  }

  const timeValues = readFloatFile(timeFile) ?? new Float64Array(0);
  const durationStats = (() => {
    let first = NaN;
    let last = NaN;
    for (let i = 0; i < timeValues.length; i++) {
      if (Number.isFinite(timeValues[i])) {
        if (!Number.isFinite(first)) first = timeValues[i];
        last = timeValues[i];
      }
    }
    return { first, last };
  })();

  if (rowCount === 0) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error('No data rows were found with the selected header row and columns');
  }
  if (invalidTime > 0) warnings.push(`${invalidTime} row(s) had an unreadable timestamp and are stored as time gaps.`);
  if (outOfOrder > 0) warnings.push(`${outOfOrder} timestamp(s) were out of order; rows were preserved in file order.`);
  if (duplicateTime > 0) warnings.push(`${duplicateTime} duplicate timestamp(s) were detected.`);

  const timeIntervals = sampleIntervalStats(timeValues);
  const samplingHz =
    spec.samplingHz && spec.samplingHz > 0
      ? spec.samplingHz
      : timeIntervals.median && timeIntervals.median > 0
        ? 1 / timeIntervals.median
        : timeColumn === null && spec.timeUnit === 'index'
          ? null
          : null;

  if (!timeIntervals.median && timeColumn !== null) warnings.push('A sampling interval could not be established from the timestamps.');
  if (timeIntervals.max && timeIntervals.median && timeIntervals.max > timeIntervals.median * 5) {
    warnings.push(`Data gap detected: largest interval ${timeIntervals.max.toPrecision(4)} s vs median ${timeIntervals.median.toPrecision(4)} s.`);
  }
  if (timeIntervals.nonMonotonic > 0) warnings.push('Timestamps are not strictly monotonic; alignment by elapsed time may be affected.');

  onProgress?.({ phase: 'Computing statistics', rows: rowCount, percent: 85 });

  const channelRows: any[] = [];
  for (let i = 0; i < channelWriters.length; i++) {
    const writer = channelWriters[i];
    const values = readFloatFile(path.join(tempDir, writer.file)) ?? new Float64Array(0);
    const stats = computeStats(values);
    const spec2 = channels[i];
    const channelId = newId();
    channelRows.push({
      id: channelId,
      dataset_id: datasetId,
      key: `c${i}`,
      name: spec2.name,
      type: spec2.type || 'custom',
      unit: spec2.unit || '',
      axis: spec2.axis || '',
      column_index: spec2.column,
      stats_json: stats,
      min: stats.min,
      max: stats.max,
      points: values.length,
      file: writer.file,
      notes: '',
      derived: 0,
      source_desc: `${spec.filePath.split(/[\\/]/).pop()} · column ${spec2.column + 1}${spec2.axis ? ` · axis ${spec2.axis}` : ''}`,
      calibration: '',
    });
    if (stats.missing > 0) warnings.push(`Channel "${spec2.name}": ${stats.missing} missing or non-numeric value(s).`);
  }

  const recordedAt =
    spec.recordedAt ||
    (firstAbsolute !== null ? new Date(firstAbsolute * 1000).toISOString() : new Date().toISOString());
  const resolvedSampling = spec.samplingHz && spec.samplingHz > 0 ? spec.samplingHz : samplingHz;
  const duration = Number.isFinite(durationStats.last - durationStats.first) ? durationStats.last - durationStats.first : null;

  const quality = {
    status: invalidTime > rowCount * 0.5 ? 'error' : warnings.length ? 'warning' : 'ok',
    warnings,
    rows: rowCount,
    skippedRows,
    invalidTime,
    outOfOrder,
    duplicateTimestamps: duplicateTime,
    missingByChannel: channelRows.map((c) => ({
      name: c.name,
      missing: (typeof c.stats_json === 'string' ? JSON.parse(c.stats_json || '{}') : c.stats_json || {}).missing ?? 0,
    })),
    intervals: timeIntervals,
    checkedAt: nowIso(),
    rawSample: rawRows,
  };

  const provenance = {
    source: 'import',
    imported_at: nowIso(),
    source_file: spec.filePath,
    source_file_name: path.basename(spec.filePath),
    checksum_sha256: checksum,
    format: spec.format,
    time_column: timeColumn,
    time_unit: spec.timeUnit,
    time_origin_absolute: firstAbsolute !== null ? new Date(firstAbsolute * 1000).toISOString() : null,
    channels: channels.map((c) => ({ name: c.name, type: c.type, unit: c.unit, column: c.column, axis: c.axis ?? '' })),
    software: `${APP_NAME} ${SOFTWARE_VERSION}`,
    notes: spec.notes,
  };

  const dataset = createRecord('dataset', {
    id: datasetId,
    project_id: spec.projectId,
    name: spec.datasetName || path.basename(spec.filePath, path.extname(spec.filePath)),
    kind: spec.datasetKind ?? 'imported',
    test_id: spec.attach?.testId ?? '',
    flight_id: spec.attach?.flightId ?? '',
    run_id: spec.attach?.runId ?? '',
    recorded_at: recordedAt,
    sampling_hz: resolvedSampling ? Number(resolvedSampling.toFixed(6)) : null,
    duration: duration !== null ? Number(duration.toFixed(6)) : null,
    points: rowCount,
    channels_count: channels.length,
    units_note: channels.map((c) => c.unit).filter(Boolean).join(', '),
    original_file: originalPath,
    stored_dir: finalDir,
    checksum,
    quality_json: quality,
    provenance_json: provenance,
    processing_json: {},
    import_spec_json: { ...spec, filePath: spec.filePath },
    row_count_raw: rowCount,
    quality_status: quality.status,
    notes: spec.notes ?? '',
  });

  db.transaction(() => {
    for (const channel of channelRows) {
      createRecord('channel', channel);
    }
  });

  // Move the fully written temporary folder into its permanent location.
  try {
    if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tempDir, finalDir);
  } catch (err) {
    // Same-volume rename should work; fall back to a copy.
    fs.cpSync(tempDir, finalDir, { recursive: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  // Rewrite stored dir after the move.
  updateRecord('dataset', datasetId, { stored_dir: finalDir });

  if (spec.templateName) {
    try {
      createRecord('import_template', {
        name: spec.templateName,
        spec_json: stripPaths(spec),
      });
    } catch (err) {
      console.error('Could not save import template', err);
    }
  }

  onProgress?.({ phase: 'Import complete', rows: rowCount, percent: 100 });
  return datasetDetail(datasetId);
}

function stripPaths(spec: ImportSpec): any {
  const { filePath, datasetName, notes, attach, templateName, ...rest } = spec;
  return { ...rest, attach: {}, notes: '' };
}

export function datasetDetail(datasetId: string): any {
  const db = getDb();
  const dataset = expandOne(db.get<any>(
    `SELECT d.*, p.name AS project_name, t.name AS test_name, t.test_no AS test_no, f.name AS flight_name, f.flight_no AS flight_no,
            r.label AS run_label, e.name AS experiment_name
     FROM datasets d
     LEFT JOIN projects p ON p.id = d.project_id
     LEFT JOIN tests t ON t.id = d.test_id
     LEFT JOIN flights f ON f.id = d.flight_id
     LEFT JOIN runs r ON r.id = d.run_id
     LEFT JOIN experiments e ON e.id = r.experiment_id
     WHERE d.id = ?`,
    [datasetId],
  ));
  if (!dataset) throw new Error('Dataset not found');
  const channels = expand(db.all<any>('SELECT * FROM channels WHERE dataset_id = ? ORDER BY rowid', [datasetId]));
  const events = db.all<any>('SELECT * FROM events WHERE dataset_id = ? ORDER BY t', [datasetId]);
  const source = dataset.source_dataset_id ? db.get<any>('SELECT id, name FROM datasets WHERE id = ?', [dataset.source_dataset_id]) : null;
  const derived = db.all<any>('SELECT id, name, created_at FROM datasets WHERE source_dataset_id = ?', [datasetId]);
  const documents = db.all<any>(`SELECT * FROM documents WHERE entity_type = 'dataset' AND entity_id = ?`, [datasetId]);
  const issues = db.all<any>('SELECT * FROM issues WHERE dataset_id = ?', [datasetId]);
  return { ...dataset, channels, events, source, derived, documents, issues };
}

export interface SeriesRequest {
  datasetIds: string[];
  channelIds?: string[];
  channelNames?: string[];
  maxPoints?: number;
  t0?: number | null;
  t1?: number | null;
  downsample?: 'minmax' | 'lttb' | 'none';
}

export interface SeriesOut {
  datasetId: string;
  datasetName: string;
  channelId: string;
  channelName: string;
  component: string;
  type: string;
  unit: string;
  axis: string;
  x: number[];
  y: (number | null)[];
  pointCount: number;
  originalCount: number;
  displayedCount: number;
  downsampled: boolean;
  min: number | null;
  max: number | null;
}

function lowerBound(arr: Float64Array, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Reads one channel plus the shared time axis, applying a time window. */
export function readChannel(datasetId: string, channelId: string, t0?: number | null, t1?: number | null) {
  const db = getDb();
  const dataset = db.get<any>('SELECT * FROM datasets WHERE id = ?', [datasetId]);
  if (!dataset) throw new Error('Dataset not found');
  const channel = db.get<any>('SELECT * FROM channels WHERE id = ? AND dataset_id = ?', [channelId, datasetId]);
  if (!channel) throw new Error('Channel not found');
  const dir = dataset.stored_dir;
  const time = readFloatFile(path.join(dir, 'time.f64')) ?? new Float64Array(0);
  const values = readFloatFile(path.join(dir, channel.file)) ?? new Float64Array(0);
  const n = Math.min(time.length, values.length);
  let start = 0;
  let end = n;
  if (Number.isFinite(t0 as number)) start = Math.max(0, lowerBound(time, t0 as number) - 1);
  if (Number.isFinite(t1 as number)) end = Math.min(n, lowerBound(time, t1 as number) + 1);
  return { dataset, channel, time: time.subarray(start, end), values: values.subarray(start, end), total: n, start, end };
}

export function seriesBundle(req: SeriesRequest): any {
  const db = getDb();
  const out: SeriesOut[] = [];
  const notes: string[] = [];
  const maxPoints = Math.max(100, Math.min(req.maxPoints ?? 4000, 200000));
  let anyDownsampled = false;
  for (const datasetId of req.datasetIds ?? []) {
    const dataset = db.get<any>('SELECT * FROM datasets WHERE id = ?', [datasetId]);
    if (!dataset) continue;
    let channels = db.all<any>('SELECT * FROM channels WHERE dataset_id = ? ORDER BY rowid', [datasetId]);
    if (req.channelIds?.length) channels = channels.filter((c) => req.channelIds!.includes(c.id));
    if (req.channelNames?.length) channels = channels.filter((c) => req.channelNames!.some((n) => n.toLowerCase() === c.name.toLowerCase()));
    if (channels.length === 0) continue;

    const time = readFloatFile(path.join(dataset.stored_dir, 'time.f64')) ?? new Float64Array(0);
    let start = 0;
    let end = time.length;
    if (Number.isFinite(req.t0 as number)) start = Math.max(0, lowerBound(time, req.t0 as number) - 1);
    if (Number.isFinite(req.t1 as number)) end = Math.min(time.length, lowerBound(time, req.t1 as number) + 1);
    if (end <= start) {
      notes.push(`Dataset "${dataset.name}" has no samples in the selected time range.`);
      continue;
    }

    for (const channel of channels) {
      const values = readFloatFile(path.join(dataset.stored_dir, channel.file));
      if (!values) continue;
      const count = Math.min(end, values.length) - start;
      if (count <= 0) continue;

      let indices: number[] | null = null;
      if (count > maxPoints) {
        anyDownsampled = true;
        const down = req.downsample === 'lttb' ? 'lttb' : req.downsample === 'none' ? 'none' : 'minmax';
        if (down === 'none') {
          notes.push(`Channel "${channel.name}" is larger than the display limit and was sampled evenly.`);
          const step = Math.ceil(count / maxPoints);
          indices = [];
          for (let i = 0; i < count; i += step) indices.push(start + i);
        } else if (down === 'lttb') {
          const xs = time.subarray(start, start + count);
          const ys = values.subarray(start, start + count);
          indices = lttbIndices(xs, ys, maxPoints).map((i) => start + i);
        } else {
          const xs = time.subarray(start, start + count);
          const ys = values.subarray(start, start + count);
          indices = minMaxIndices(xs, ys, maxPoints).map((i) => start + i);
        }
      }

      const x: number[] = [];
      const y: (number | null)[] = [];
      const pushPoint = (idx: number) => {
        const xv = time[idx];
        const yv = values[idx];
        x.push(Number.isFinite(xv) ? xv : NaN);
        y.push(Number.isFinite(yv) ? yv : null);
      };
      if (indices) indices.forEach(pushPoint);
      else for (let i = start; i < start + count; i++) pushPoint(i);

      // Peak values come from stored stats when no time window is applied; they
      // are recomputed for a filtered window.
      let min = channel.min;
      let max = channel.max;
      if (Number.isFinite(req.t0 as number) || Number.isFinite(req.t1 as number)) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = start; i < start + count; i++) {
          const v = values[i];
          if (!Number.isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        min = Number.isFinite(lo) ? lo : null;
        max = Number.isFinite(hi) ? hi : null;
      }

      out.push({
        datasetId,
        datasetName: dataset.name,
        channelId: channel.id,
        channelName: channel.name,
        component: channel.axis || '',
        type: channel.type,
        unit: channel.unit,
        axis: channel.axis,
        x,
        y,
        pointCount: count,
        originalCount: Math.min(time.length, values.length),
        displayedCount: x.length,
        downsampled: !!indices,
        min: min ?? null,
        max: max ?? null,
      });
    }
  }
  if (anyDownsampled) notes.push('Graphs are displaying downsampled previews; peak-preserving min/max sampling is used. The full recordings remain available for export and exact inspection.');
  return { series: out, notes, downsampled: anyDownsampled };
}

export function channelValues(datasetId: string, channelId: string, offset: number, count: number) {
  const { time, values, channel, dataset } = readChannel(datasetId, channelId);
  const from = Math.max(0, Math.min(offset, time.length));
  const to = Math.max(from, Math.min(from + Math.max(1, Math.min(count, 5000)), time.length));
  return {
    datasetId,
    datasetName: dataset.name,
    channelName: channel.name,
    unit: channel.unit,
    start: from,
    rows: Array.from({ length: to - from }, (_, i) => ({ t: time[from + i], value: values[from + i] })),
    total: time.length,
  };
}

export function datasetStatistics(datasetId: string, channelId: string, t0?: number | null, t1?: number | null) {
  const { values, channel, time } = readChannel(datasetId, channelId, t0, t1);
  const stats = computeStats(values);
  const intervals = sampleIntervalStats(time);
  return {
    channel: { id: channel.id, name: channel.name, unit: channel.unit, type: channel.type },
    stats,
    intervals,
    window: { t0: t0 ?? null, t1: t1 ?? null },
    note: 'Statistics are computed from the stored measurement values in the selected window. Missing values (NaN) are excluded.',
  };
}

/* ------------------------------------------------------------------ */
/* Derived datasets                                                    */
/* ------------------------------------------------------------------ */

export type DeriveOperation = 'convert_unit' | 'smooth' | 'rate' | 'offset' | 'polynomial' | 'crop' | 'decimate';

export interface DeriveRequest {
  sourceDatasetId: string;
  name: string;
  operation: DeriveOperation;
  channelIds: string[];
  params: { toUnit?: string; window?: number; offset?: number; coefficients?: number[]; t0?: number; t1?: number; factor?: number };
  notes?: string;
}

const OP_LABEL: Record<DeriveOperation, string> = {
  convert_unit: 'Unit conversion',
  smooth: 'Moving average',
  rate: 'Rate of change',
  offset: 'Additive correction',
  polynomial: 'Polynomial calibration',
  crop: 'Time window crop',
  decimate: 'Decimation',
};

/** Creates a new dataset from an existing one. The source is never modified. */
export function deriveDataset(req: DeriveRequest): any {
  const db = getDb();
  const source = db.get<any>('SELECT * FROM datasets WHERE id = ?', [req.sourceDatasetId]);
  if (!source) throw new Error('Source dataset not found');
  const channels = db.all<any>('SELECT * FROM channels WHERE dataset_id = ? ORDER BY rowid', [source.id]).filter((c) =>
    req.channelIds?.length ? req.channelIds.includes(c.id) : true,
  );
  if (channels.length === 0) throw new Error('Select at least one channel to derive from');

  const time = readFloatFile(path.join(source.stored_dir, 'time.f64')) ?? new Float64Array(0);
  let start = 0;
  let end = time.length;
  if (req.operation === 'crop') {
    const t0 = req.params.t0 ?? -Infinity;
    const t1 = req.params.t1 ?? Infinity;
    start = Math.max(0, lowerBound(time, t0) - 1);
    end = Math.min(time.length, lowerBound(time, t1) + 1);
  }
  let timeSlice = time.subarray(start, end);
  if (req.operation === 'decimate') {
    const factor = Math.max(2, Math.round(req.params.factor ?? 2));
    const idx: number[] = [];
    for (let i = 0; i < timeSlice.length; i += factor) idx.push(i);
    const nextTime = new Float64Array(idx.length);
    idx.forEach((v, i) => (nextTime[i] = timeSlice[v]));
    timeSlice = nextTime;
  }

  const datasetId = newId();
  const dir = datasetPath(datasetId);
  writeFloatFile(path.join(dir, 'time.f64'), Float64Array.from(timeSlice));

  const newChannels: any[] = [];
  const steps: any[] = [];
  channels.forEach((channel, i) => {
    const raw = readFloatFile(path.join(source.stored_dir, channel.file));
    if (!raw) return;
    let values = raw.subarray(start, end);
    let unit = channel.unit;
    const notes: string[] = [];
    switch (req.operation) {
      case 'convert_unit': {
        const to = req.params.toUnit || channel.unit;
        const converted = new Float64Array(values.length);
        for (let j = 0; j < values.length; j++) {
          const v = convertUnit(values[j], channel.unit, to);
          converted[j] = v === null ? NaN : v;
        }
        values = converted;
        unit = to;
        notes.push(`Converted ${channel.unit} → ${to}`);
        break;
      }
      case 'smooth':
        values = movingAverage(values, Math.max(1, Math.round(req.params.window ?? 5)));
        notes.push(`Centered moving average, window ${Math.max(1, Math.round(req.params.window ?? 5))} samples`);
        break;
      case 'rate': {
        const r = rateOfChange(timeSlice, values);
        values = r;
        const dim = unitDef(unit)?.dimension;
        const timeBase = 's';
        unit = `${unit}/${timeBase}`;
        notes.push(`Finite-difference derivative over elapsed seconds (${dim ?? 'unknown'} per second)`);
        break;
      }
      case 'offset': {
        const off = req.params.offset ?? 0;
        const shifted = new Float64Array(values.length);
        for (let j = 0; j < values.length; j++) shifted[j] = Number.isFinite(values[j]) ? values[j] + off : NaN;
        values = shifted;
        notes.push(`Added constant offset ${off} ${unit}`);
        break;
      }
      case 'polynomial': {
        const coeffs = req.params.coefficients ?? [0, 1];
        const calc = new Float64Array(values.length);
        for (let j = 0; j < values.length; j++) {
          const v = values[j];
          if (!Number.isFinite(v)) {
            calc[j] = NaN;
            continue;
          }
          let acc = 0;
          for (let k = coeffs.length - 1; k >= 0; k--) acc = acc * v + coeffs[k];
          calc[j] = acc;
        }
        values = calc;
        notes.push(`Applied polynomial y = ${coeffs.map((c, k) => `${c}·x^${k}`).join(' + ')}`);
        break;
      }
      case 'decimate': {
        const factor = Math.max(2, Math.round(req.params.factor ?? 2));
        const decimated = new Float64Array(Math.ceil(values.length / factor));
        for (let j = 0; j < decimated.length; j++) decimated[j] = values[j * factor];
        values = decimated;
        notes.push(`Decimated by factor ${factor}`);
        break;
      }
      case 'crop':
        notes.push('Cropped to selected time window');
        break;
    }
    const file = `ch_${String(i).padStart(2, '0')}.f64`;
    writeFloatFile(path.join(dir, file), Float64Array.from(values));
    const stats = computeStats(values);
    newChannels.push({
      id: newId(),
      dataset_id: datasetId,
      key: `c${i}`,
      name: channel.name,
      type: channel.type,
      unit,
      axis: channel.axis,
      column_index: -1,
      stats_json: stats,
      min: stats.min,
      max: stats.max,
      points: values.length,
      file,
      notes: notes.join('; '),
      derived: 1,
      source_desc: `Derived from ${source.name} · ${channel.name}`,
      calibration: channel.calibration ?? '',
    });
    steps.push({ channel: channel.name, notes });
  });

  const processing = {
    operation: req.operation,
    label: OP_LABEL[req.operation],
    params: req.params,
    applied_at: nowIso(),
    software: `${APP_NAME} ${SOFTWARE_VERSION}`,
    source_dataset_id: source.id,
    source_dataset_name: source.name,
    steps,
    notes: req.notes ?? '',
  };

  const created = createRecord('dataset', {
    id: datasetId,
    project_id: source.project_id,
    name: req.name || `${source.name} (${OP_LABEL[req.operation]})`,
    kind: 'processed',
    test_id: source.test_id,
    flight_id: source.flight_id,
    run_id: source.run_id,
    source_dataset_id: source.id,
    recorded_at: source.recorded_at,
    sampling_hz: req.operation === 'decimate' ? (source.sampling_hz ? source.sampling_hz / Math.max(2, req.params.factor ?? 2) : null) : source.sampling_hz,
    duration: timeSlice.length > 1 ? timeSlice[timeSlice.length - 1] - timeSlice[0] : null,
    points: timeSlice.length,
    channels_count: newChannels.length,
    units_note: newChannels.map((c) => c.unit).join(', '),
    original_file: source.original_file,
    stored_dir: dir,
    checksum: source.checksum,
    quality_json: source.quality_json,
    provenance_json: {
      source: 'derived',
      derived_from: source.id,
      derived_at: nowIso(),
      operations: [processing],
      software: `${APP_NAME} ${SOFTWARE_VERSION}`,
    },
    processing_json: processing,
    quality_status: 'derived',
    notes: req.notes ?? '',
  });

  db.transaction(() => {
    newChannels.forEach((c) => createRecord('channel', c));
    logActivity({
      project_id: source.project_id,
      entity_type: 'dataset',
      entity_id: datasetId,
      kind: 'derive',
      title: 'Derived dataset created',
      detail: `${created.name} from ${source.name} (${OP_LABEL[req.operation]})`,
    });
  });

  return datasetDetail(datasetId);
}

/* ------------------------------------------------------------------ */
/* Deletion                                                            */
/* ------------------------------------------------------------------ */

export function deleteDataset(datasetId: string): { ok: boolean } {
  const db = getDb();
  const dataset = db.get<any>('SELECT * FROM datasets WHERE id = ?', [datasetId]);
  if (!dataset) return { ok: false };
  const derivatives = db.all<any>('SELECT id, name FROM datasets WHERE source_dataset_id = ?', [datasetId]);
  if (derivatives.length > 0) {
    throw new Error(`This dataset is the source of ${derivatives.length} derived dataset(s). Delete or re-derive those first.`);
  }
  const archiveName = `${datasetId}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const archivePath = path.join(deletedDir(), archiveName);
  try {
    if (fs.existsSync(dataset.stored_dir)) fs.cpSync(dataset.stored_dir, archivePath, { recursive: true });
  } catch (err) {
    console.error('Could not archive dataset folder before deletion', err);
  }
  db.transaction(() => {
    db.run('DELETE FROM channels WHERE dataset_id = ?', [datasetId]);
    db.run('DELETE FROM events WHERE dataset_id = ?', [datasetId]);
    db.run(`UPDATE datasets SET source_dataset_id = '' WHERE source_dataset_id = ?`, [datasetId]);
    db.run('DELETE FROM datasets WHERE id = ?', [datasetId]);
    logActivity({
      project_id: dataset.project_id,
      entity_type: 'dataset',
      entity_id: datasetId,
      kind: 'delete',
      title: 'Dataset removed',
      detail: `${dataset.name} (files archived to ${archivePath})`,
    });
  });
  try {
    if (fs.existsSync(dataset.stored_dir)) fs.rmSync(dataset.stored_dir, { recursive: true, force: true });
  } catch (err) {
    console.error('Dataset folder cleanup failed', err);
  }
  return { ok: true };
}

export function exportDatasetCsv(datasetId: string, destination: string): string {
  const detail = datasetDetail(datasetId);
  const time = readFloatFile(path.join(detail.stored_dir, 'time.f64')) ?? new Float64Array(0);
  const channelData = detail.channels.map((c: any) => ({
    channel: c,
    values: readFloatFile(path.join(detail.stored_dir, c.file)) ?? new Float64Array(0),
  }));
  const header = ['elapsed_s', ...detail.channels.map((c: any) => `${c.name}${c.unit ? ` [${c.unit}]` : ''}`)].join(',');
  const lines = [
    `# Dataset: ${detail.name}`,
    `# Project: ${detail.project_name ?? ''}`,
    `# Recorded: ${detail.recorded_at}`,
    `# Points: ${detail.points}`,
    `# Exported: ${nowIso()}`,
    `# Units: elapsed seconds; channel units in brackets`,
    header,
  ];
  for (let i = 0; i < time.length; i++) {
    const cells = [Number.isFinite(time[i]) ? String(time[i]) : ''];
    for (const cd of channelData) {
      const v = cd.values[i];
      cells.push(Number.isFinite(v) ? String(v) : '');
    }
    lines.push(cells.join(','));
  }
  fs.writeFileSync(destination, lines.join('\n'), 'utf8');
  return destination;
}

/* ------------------------------------------------------------------ */
/* Event markers                                                       */
/* ------------------------------------------------------------------ */

export function listEvents(datasetIds: string[]): any[] {
  if (!datasetIds?.length) return [];
  const db = getDb();
  return db.all<any>(
    `SELECT e.*, d.name AS dataset_name FROM events e JOIN datasets d ON d.id = e.dataset_id
     WHERE e.dataset_id IN (${datasetIds.map(() => '?').join(',')}) ORDER BY e.t`,
    datasetIds,
  );
}

export function createEvent(data: any): any {
  const dataset = getDb().get<any>('SELECT * FROM datasets WHERE id = ?', [data.dataset_id]);
  if (!dataset) throw new Error('Dataset not found');
  return createRecord('event', {
    ...data,
    project_id: dataset.project_id,
    source: data.source ?? 'user',
    confirmed: data.confirmed ?? 1,
  });
}

export function updateEvent(id: string, patch: any): any {
  return updateRecord('event', id, patch);
}

export function removeEvent(id: string): any {
  return removeRecordSafe('event', id);
}

function removeRecordSafe(entity: string, id: string) {
  const db = getDb();
  const row = db.get<any>(`SELECT * FROM ${entity === 'event' ? 'events' : entity} WHERE id = ?`, [id]);
  if (row) {
    db.run(`DELETE FROM ${entity === 'event' ? 'events' : entity} WHERE id = ?`, [id]);
    logActivity({
      project_id: row.project_id,
      entity_type: entity,
      entity_id: id,
      kind: 'delete',
      title: 'Event marker removed',
      detail: row.name,
    });
  }
  return { ok: true };
}

/**
 * Algorithmic event suggestions. These are hypotheses derived from the data and
 * are never stored as facts without explicit user confirmation.
 */
export function suggestEvents(datasetId: string): any[] {
  const db = getDb();
  const dataset = db.get<any>('SELECT * FROM datasets WHERE id = ?', [datasetId]);
  if (!dataset) throw new Error('Dataset not found');
  const channels = db.all<any>('SELECT * FROM channels WHERE dataset_id = ? ORDER BY rowid', [datasetId]);
  if (channels.length === 0) return [];
  const time = readFloatFile(path.join(dataset.stored_dir, 'time.f64')) ?? new Float64Array(0);
  const suggestions: any[] = [];
  const push = (name: string, category: string, t: number, description: string, channelKey: string, score: number) => {
    if (!Number.isFinite(t)) return;
    suggestions.push({
      dataset_id: datasetId,
      name,
      category,
      t,
      description,
      channel_key: channelKey,
      score,
      source: 'suggested',
      confirmed: 0,
      basis: 'Algorithmic suggestion from recorded values; requires user confirmation.',
    });
  };

  const preferred = channels.find((c) => c.type === 'altitude') ?? channels.find((c) => c.type === 'acceleration') ?? channels[0];
  const values = readFloatFile(path.join(dataset.stored_dir, preferred.file));
  if (values) {
    const n = Math.min(values.length, time.length);
    let peakIdx = -1;
    let peak = -Infinity;
    let minIdx = -1;
    let low = Infinity;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if (v > peak) {
        peak = v;
        peakIdx = i;
      }
      if (v < low) {
        low = v;
        minIdx = i;
      }
    }
    if (peakIdx >= 0) push(`Peak ${preferred.name}`, 'Peak acceleration', time[peakIdx], `Highest recorded value (${peak.toPrecision(6)} ${preferred.unit}) — algorithmic suggestion.`, preferred.key, 0.9);
    if (minIdx >= 0) push(`Minimum ${preferred.name}`, 'Custom', time[minIdx], `Lowest recorded value (${low.toPrecision(6)} ${preferred.unit}) — algorithmic suggestion.`, preferred.key, 0.5);

    const rate = rateOfChange(time.subarray(0, n), values.subarray(0, n));
    const stat = computeStats(rate);
    if (stat.stdDev && stat.mean !== null) {
      const threshold = stat.mean + 3 * stat.stdDev;
      for (let i = 1; i < rate.length - 1 && suggestions.length < 14; i++) {
        const v = rate[i];
        if (!Number.isFinite(v) || v < threshold) continue;
        if (Number.isFinite(rate[i - 1]) && v <= rate[i - 1]) continue;
        if (Number.isFinite(rate[i + 1]) && v < rate[i + 1]) continue;
        push(`Sharp change in ${preferred.name}`, 'Anomaly', time[i], `Rate of change exceeded mean + 3σ (${v.toPrecision(5)} ${preferred.unit}/s) — algorithmic suggestion.`, preferred.key, 0.6);
        i += Math.max(1, Math.floor(rate.length / 60));
      }
    }

    // Data gaps are factual observations about the recording.
    for (let i = 1; i < n; i++) {
      const dt = time[i] - time[i - 1];
      if (Number.isFinite(dt) && dt > 1 && dt > (1 / (dataset.sampling_hz || 1)) * 10) {
        push('Recording gap', 'Data gap', time[i - 1], `No samples for ${dt.toPrecision(4)} s — detected from timestamps.`, preferred.key, 1);
        break;
      }
    }
  }
  return suggestions.sort((a, b) => b.score - a.score).slice(0, 16);
}

export function confirmEvents(events: any[]): any[] {
  return (events ?? []).map((e) => createEvent({ ...e, source: 'user', confirmed: 1 }));
}
