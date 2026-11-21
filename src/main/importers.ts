import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { guessQuantityFromName } from '../shared/units';

export type RawRow = string[];

export interface PreviewResult {
  format: 'csv' | 'tsv' | 'txt' | 'json' | 'xlsx';
  delimiter: string;
  headerRow: number;
  skipRows: number;
  columns: string[];
  sampleRows: RawRow[];
  totalPreviewRows: number;
  sheets?: string[];
  sheet?: string;
  estimatedRows: number | null;
  suggestedTimeColumn: number | null;
  suggestedChannels: { column: number; name: string; type: string; unit: string; axis?: string }[];
  warnings: string[];
}

const DELIMITERS = [',', ';', '\t', '|'];

function readBuffer(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

function decodeBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

/** Parse one delimited record set from text with quote handling. */
export function parseDelimitedText(text: string, delimiter: string, maxRows = Infinity): RawRow[] {
  const rows: RawRow[] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length && rows.length < maxRows) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i++;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 20000).split(/\r?\n/).slice(0, 12).filter((l) => l.trim().length > 0);
  let best = ',';
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = sample.map((line) => parseDelimitedText(line, d, 1)[0]?.length ?? 1);
    if (counts.length === 0) continue;
    const max = Math.max(...counts);
    const consistency = counts.filter((c) => c === max).length / counts.length;
    const score = max > 1 ? max * consistency : 0;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function looksNumeric(value: string): boolean {
  const t = value.trim();
  if (t === '') return false;
  return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(t);
}

/** First row that looks like a header (mostly non-numeric labels). */
export function detectHeaderRow(rows: RawRow[]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i];
    if (!row || row.every((c) => c.trim() === '')) continue;
    const filled = row.filter((c) => c.trim() !== '');
    const nonNumeric = filled.filter((c) => !looksNumeric(c)).length;
    if (filled.length >= 2 && nonNumeric / filled.length >= 0.5) return i;
  }
  return 0;
}

function guessTimeColumn(columns: string[]): number | null {
  for (let i = 0; i < columns.length; i++) {
    if (/^(time|t|timestamp|time_s|time_ms|elapsed|elapsed_s|seconds|sec|time_utc|datetime|date)$/i.test(columns[i].trim().replace(/[\[\]()]/g, ''))) {
      return i;
    }
  }
  for (let i = 0; i < columns.length; i++) {
    if (/time|stamp|elapsed/i.test(columns[i])) return i;
  }
  return null;
}

function classifyTimeColumn(sampleRows: RawRow[], column: number): string {
  const values = sampleRows.map((r) => (r[column] ?? '').trim()).filter(Boolean).slice(0, 20);
  if (values.length === 0) return 'index';
  if (values.every((v) => /\d{4}-\d{2}-\d{2}[T ]/.test(v) || /^\d{2}\/\d{2}\/\d{4}/.test(v))) return 'iso';
  const nums = values.map(Number).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return 'index';
  const max = Math.max(...nums);
  if (max > 1e11) return 'ms';
  if (max > 1e8) return 's';
  return 's';
}

function suggestChannelsFromColumns(columns: string[], timeColumn: number | null) {
  return columns
    .map((name, column) => ({ name, column }))
    .filter((c) => c.column !== timeColumn)
    .filter((c) => c.name.trim() !== '')
    .map((c) => {
      const guess = guessQuantityFromName(c.name);
      return { column: c.column, name: c.name.trim(), type: guess.type, unit: guess.unit, axis: guess.axis };
    });
}

function countLines(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 400 * 1024 * 1024) return null;
    const fd = fs.openSync(filePath, 'r');
    const bufSize = 1024 * 1024;
    const buf = Buffer.alloc(bufSize);
    let lines = 0;
    let bytes = 0;
    let read = 0;
    do {
      read = fs.readSync(fd, buf, 0, bufSize, bytes);
      for (let i = 0; i < read; i++) if (buf[i] === 10) lines++;
      bytes += read;
    } while (read > 0);
    fs.closeSync(fd);
    return lines;
  } catch {
    return null;
  }
}

export function detectFormat(filePath: string): 'csv' | 'tsv' | 'txt' | 'json' | 'xlsx' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
  if (ext === '.tsv' || ext === '.tab') return 'tsv';
  if (ext === '.csv') return 'csv';
  return 'txt';
}

/* ------------------------- delimited ------------------------- */

export function previewDelimited(filePath: string, headerRowOverride?: number): PreviewResult {
  const format = detectFormat(filePath) as 'csv' | 'tsv' | 'txt';
  const text = decodeBuffer(readBuffer(filePath));
  const delimiter = format === 'tsv' ? '\t' : detectDelimiter(text);
  const rows = parseDelimitedText(text.slice(0, 400_000), delimiter, 400);
  const warnings: string[] = [];
  let headerRow = headerRowOverride ?? detectHeaderRow(rows);
  if (headerRow > 0) warnings.push(`Rows 1-${headerRow} before the detected header are treated as metadata and skipped.`);
  const rawHeaders = rows[headerRow] ?? [];
  const columns = rawHeaders.map((h, i) => (h.trim() ? h.trim() : `Column ${i + 1}`));
  const sampleRows = rows.slice(headerRow + 1, headerRow + 26);
  const timeColumn = guessTimeColumn(columns);
  const timeUnitGuess = timeColumn !== null ? classifyTimeColumn(sampleRows, timeColumn) : 'index';
  if (timeColumn === null) warnings.push('No timestamp column was recognised; an index-based time axis will be used unless you select a column.');
  if (columns.length === 0) warnings.push('No columns were detected in this file.');
  return {
    format,
    delimiter,
    headerRow,
    skipRows: 0,
    columns,
    sampleRows,
    totalPreviewRows: rows.length,
    estimatedRows: countLines(filePath),
    suggestedTimeColumn: timeColumn,
    suggestedChannels: suggestChannelsFromColumns(columns, timeColumn),
    warnings: timeUnitGuess === 'index' && timeColumn !== null ? [...warnings, 'Timestamp format could not be determined automatically; confirm the time unit.'] : warnings,
  };
}

/** Async stream of delimited rows (used for imports of large files). */
export async function* streamDelimited(
  filePath: string,
  delimiter: string,
  startRow: number,
): AsyncGenerator<RawRow> {
  const stat = fs.statSync(filePath);
  if (stat.size > 8 * 1024 * 1024 || filePath.toLowerCase().endsWith('.txt')) {
    // Smaller files and UTF-16 text are decoded wholesale for correct encoding.
    const text = decodeBuffer(readBuffer(filePath));
    const rows = parseDelimitedText(text, delimiter);
    for (let i = startRow; i < rows.length; i++) yield rows[i];
    return;
  }
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let pending = '';
  let inQuotes = false;
  let rowIndex = 0;
  for await (const chunk of stream) {
    pending += chunk;
    let lineStart = 0;
    for (let i = 0; i < pending.length; i++) {
      const ch = pending[i];
      if (ch === '"') inQuotes = !inQuotes;
      if (!inQuotes && (ch === '\n' || ch === '\r')) {
        const line = pending.slice(lineStart, i);
        if (ch === '\r' && pending[i + 1] === '\n') i++;
        const fields = parseDelimitedText(line, delimiter, 1)[0] ?? [];
        if (rowIndex >= startRow) yield fields;
        rowIndex++;
        lineStart = i + 1;
      }
    }
    pending = pending.slice(lineStart);
  }
  if (pending.trim() !== '') {
    const fields = parseDelimitedText(pending, delimiter, 1)[0] ?? [];
    if (rowIndex >= startRow) yield fields;
  }
}

/* ------------------------- JSON ------------------------- */

interface JsonTable {
  columns: string[];
  rows: RawRow[];
}

export function readJsonTable(filePath: string): JsonTable {
  const text = decodeBuffer(readBuffer(filePath));
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (err: any) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }
  let rows: any[] = [];
  let columns: string[] = [];
  if (Array.isArray(data)) {
    rows = data;
  } else if (data && typeof data === 'object') {
    const arrayKey = Object.keys(data).find((k) => Array.isArray((data as any)[k]));
    if (arrayKey) {
      rows = (data as any)[arrayKey];
      if (Array.isArray(data.columns)) columns = data.columns.map(String);
    } else {
      rows = [data];
    }
  }
  const columnSet = new Set<string>(columns);
  for (const row of rows.slice(0, 500)) {
    if (Array.isArray(row)) continue;
    if (row && typeof row === 'object') Object.keys(row).forEach((k) => columnSet.add(k));
  }
  const resolvedColumns = columns.length ? columns : Array.from(columnSet);
  const outRows: RawRow[] = rows.map((row) => {
    if (Array.isArray(row)) return row.map((v) => (v === null || v === undefined ? '' : String(v)));
    if (row && typeof row === 'object') return resolvedColumns.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    });
    return [String(row)];
  });
  return { columns: resolvedColumns, rows: outRows };
}

export function previewJson(filePath: string): PreviewResult {
  const table = readJsonTable(filePath);
  const columns = table.columns.map((c, i) => c || `Column ${i + 1}`);
  const timeColumn = guessTimeColumn(columns);
  return {
    format: 'json',
    delimiter: ',',
    headerRow: -1,
    skipRows: 0,
    columns,
    sampleRows: table.rows.slice(0, 25),
    totalPreviewRows: table.rows.length,
    estimatedRows: table.rows.length,
    suggestedTimeColumn: timeColumn,
    suggestedChannels: suggestChannelsFromColumns(columns, timeColumn),
    warnings: table.rows.length === 0 ? ['No records found in this JSON file.'] : [],
  };
}

/* ------------------------- XLSX (minimal reader) ------------------------- */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
}

function readZipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a readable XLSX (zip) file');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
    entries.push({ name, method, compressedSize, uncompressedSize, dataOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipFile(buf: Buffer, entry: ZipEntry): Buffer {
  const data = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported XLSX compression method ${entry.method}`);
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function colIndexFromRef(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function listXlsxSheets(filePath: string): string[] {
  try {
    const buf = readBuffer(filePath);
    const entries = readZipEntries(buf);
    const wb = entries.find((e) => e.name === 'xl/workbook.xml');
    if (!wb) return ['Sheet1'];
    const xml = readZipFile(buf, wb).toString('utf8');
    const names = [...xml.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((m) => decodeXml(m[1]));
    return names.length ? names : ['Sheet1'];
  } catch {
    return ['Sheet1'];
  }
}

export function readXlsxTable(filePath: string, sheetIndex = 0): JsonTable {
  const buf = readBuffer(filePath);
  const entries = readZipEntries(buf);
  const sharedEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  const shared: string[] = [];
  if (sharedEntry) {
    const xml = readZipFile(buf, sharedEntry).toString('utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]));
      shared.push(texts.join(''));
    }
  }
  const sheetEntries = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const entry = sheetEntries[sheetIndex] ?? sheetEntries[0];
  if (!entry) throw new Error('No worksheet found in this workbook');
  const xml = readZipFile(buf, entry).toString('utf8');

  const rows: RawRow[] = [];
  let maxCol = 0;
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const refMatch = /r="([A-Z]+\d+)"/.exec(attrs);
      const idx = refMatch ? colIndexFromRef(refMatch[1]) : cells.length;
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      let value = '';
      if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        value = v !== undefined ? shared[Number(v)] ?? '' : '';
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
      } else if (type === 'str') {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      } else if (type === 'b') {
        value = /<v>1<\/v>/.test(body) ? 'TRUE' : 'FALSE';
      } else {
        value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
      if (idx + 1 > maxCol) maxCol = idx + 1;
    }
    if (cells.length > 0) rows.push(cells);
  }
  const columns = Array.from({ length: maxCol }, (_, i) => `Column ${i + 1}`);
  return { columns, rows };
}

export function previewXlsx(filePath: string, sheetIndex = 0): PreviewResult {
  const sheets = listXlsxSheets(filePath);
  const table = readXlsxTable(filePath, sheetIndex);
  const headerRow = detectHeaderRow(table.rows);
  const rawHeaders = table.rows[headerRow] ?? [];
  const columns = Array.from({ length: Math.max(rawHeaders.length, table.columns.length) }, (_, i) =>
    rawHeaders[i]?.trim() ? rawHeaders[i].trim() : `Column ${i + 1}`,
  );
  const sampleRows = table.rows.slice(headerRow + 1, headerRow + 26);
  const timeColumn = guessTimeColumn(columns);
  return {
    format: 'xlsx',
    delimiter: ',',
    headerRow,
    skipRows: 0,
    columns,
    sampleRows,
    totalPreviewRows: table.rows.length,
    sheets,
    sheet: sheets[sheetIndex] ?? sheets[0],
    estimatedRows: table.rows.length,
    suggestedTimeColumn: timeColumn,
    suggestedChannels: suggestChannelsFromColumns(columns, timeColumn),
    warnings: sheets.length > 1 ? [`Workbook contains ${sheets.length} sheets; importing "${sheets[sheetIndex] ?? sheets[0]}".`] : [],
  };
}

/* ------------------------- unified preview ------------------------- */

export function previewAny(filePath: string, headerRowOverride?: number, sheetIndex = 0): PreviewResult {
  const format = detectFormat(filePath);
  if (format === 'json') return previewJson(filePath);
  if (format === 'xlsx') return previewXlsx(filePath, sheetIndex);
  return previewDelimited(filePath, headerRowOverride);
}

/** Async row iterator for any supported format. */
export async function* iterateRows(
  filePath: string,
  format: 'csv' | 'tsv' | 'txt' | 'json' | 'xlsx',
  delimiter: string,
  startRow: number,
  sheetIndex = 0,
): AsyncGenerator<RawRow> {
  if (format === 'json') {
    const table = readJsonTable(filePath);
    for (let i = startRow; i < table.rows.length; i++) yield table.rows[i];
    return;
  }
  if (format === 'xlsx') {
    const table = readXlsxTable(filePath, sheetIndex);
    for (let i = startRow; i < table.rows.length; i++) yield table.rows[i];
    return;
  }
  yield* streamDelimited(filePath, delimiter, startRow);
}

export function parseTimestamp(value: string, timeUnit: string, fallbackStart?: number): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (timeUnit === 'iso') {
    const normalized = /^\d{4}-\d{2}-\d{2} \d/.test(raw) ? raw.replace(' ', 'T') : raw;
    const ms = Date.parse(normalized);
    if (!Number.isFinite(ms)) return null;
    return ms / 1000;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    if (timeUnit === 'index' && fallbackStart !== undefined) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  switch (timeUnit) {
    case 'ms':
      return num / 1000;
    case 'us':
      return num / 1e6;
    case 'min':
      return num * 60;
    case 'index':
      return num;
    default:
      return num;
  }
}
