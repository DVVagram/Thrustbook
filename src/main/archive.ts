import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { closeDatabase, getDb, openDatabase, schemaVersion } from './db';
import { expand, newId, nowIso, tableFor } from './repo';
import {
  backupsDir,
  dataDir,
  datasetsDir,
  dbFile,
  documentsDir,
  ensureStorage,
  isInside,
  reportsDir,
  setDataDir,
  safeFileName,
} from './paths';
import { APP_NAME } from '../shared/constants';

/* ------------------------------------------------------------------ */
/* Tar (ustar) writer / reader                                         */
/* ------------------------------------------------------------------ */

function octal(value: number, width: number): string {
  const s = Math.max(0, Math.floor(value)).toString(8);
  return s.padStart(width - 1, '0') + '\0';
}

function tarHeader(name: string, size: number, mtime: number, isDir: boolean): Buffer {
  const buf = Buffer.alloc(512, 0);
  let prefix = '';
  let shortName = name;
  if (Buffer.byteLength(name) > 100) {
    const parts = name.split('/');
    let base = parts.pop() ?? '';
    let dir = parts.join('/');
    while (Buffer.byteLength(base) > 100 && parts.length > 0) {
      base = `${parts.pop()}/${base}`;
    }
    shortName = base;
    prefix = dir;
    while (Buffer.byteLength(prefix) > 155) {
      const idx = prefix.indexOf('/');
      prefix = idx >= 0 ? prefix.slice(idx + 1) : prefix.slice(-155);
    }
  }
  buf.write(shortName, 0, 100, 'utf8');
  buf.write(octal(isDir ? 0o755 : 0o644, 8), 100, 8, 'ascii');
  buf.write(octal(0, 8), 108, 8, 'ascii');
  buf.write(octal(0, 8), 116, 8, 'ascii');
  buf.write(octal(size, 12), 124, 12, 'ascii');
  buf.write(octal(mtime, 12), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii');
  buf.write(isDir ? '5' : '0', 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write('rocketlab', 265, 32, 'ascii');
  buf.write('rocketlab', 297, 32, 'ascii');
  if (prefix) buf.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

type TarEntrySource = { name: string; filePath: string } | { name: string; data: Buffer };

async function* tarStream(entries: TarEntrySource[]): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    if ('data' in entry) {
      yield tarHeader(entry.name, entry.data.length, Math.floor(Date.now() / 1000), false);
      yield entry.data;
      const pad = (512 - (entry.data.length % 512)) % 512;
      if (pad) yield Buffer.alloc(pad, 0);
      continue;
    }
    // Files can disappear between directory enumeration and archiving (for example an
    // import's temporary folder being renamed). Skip them instead of failing the backup.
    if (!fs.existsSync(entry.filePath)) continue;
    const stat = fs.statSync(entry.filePath);
    if (stat.isDirectory()) {
      yield tarHeader(`${entry.name.replace(/\/$/, '')}/`, 0, Math.floor(stat.mtimeMs / 1000), true);
      continue;
    }
    yield tarHeader(entry.name, stat.size, Math.floor(stat.mtimeMs / 1000), false);
    let written = 0;
    const stream = fs.createReadStream(entry.filePath, { highWaterMark: 1 << 20 });
    for await (const chunk of stream) {
      written += chunk.length;
      yield chunk as Buffer;
    }
    if (written !== stat.size) throw new Error(`File changed while archiving: ${entry.name}`);
    const pad = (512 - (stat.size % 512)) % 512;
    if (pad) yield Buffer.alloc(pad, 0);
  }
  yield Buffer.alloc(1024, 0);
}

export async function writeTarGz(destination: string, entries: TarEntrySource[]): Promise<void> {
  await pipeline(Readable.from(tarStream(entries)), zlib.createGzip({ level: 6 }), fs.createWriteStream(destination));
}

function parseTarHeader(block: Buffer): { name: string; size: number; isDir: boolean } | null {
  if (block.every((b) => b === 0)) return null;
  const rawName = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
  const name = prefix ? `${prefix}/${rawName}` : rawName;
  const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
  const isDir = block[156] === 0x35;
  return { name, size: Number.isFinite(size) ? size : 0, isDir };
}

/** Safely joins an archive path into the destination, rejecting traversal. */
function safeJoin(destDir: string, name: string): string | null {
  const cleaned = name.replace(/^\/+/, '').replace(/\\/g, '/');
  if (!cleaned || cleaned.includes('..')) return null;
  const target = path.join(destDir, cleaned);
  return isInside(destDir, target) ? target : null;
}

export async function extractTarGz(archivePath: string, destDir: string): Promise<string[]> {
  fs.mkdirSync(destDir, { recursive: true });
  const inflated = fs.createReadStream(archivePath).pipe(zlib.createGunzip());
  const extracted: string[] = [];
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let current: { fd: number; remaining: number; pad: number } | null = null;
  let padding = 0;

  const handle = (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (true) {
      if (padding > 0) {
        const skip = Math.min(padding, pending.length);
        pending = pending.subarray(skip);
        padding -= skip;
        if (padding > 0) return;
      }
      if (current) {
        if (pending.length === 0) return;
        const take = Math.min(current.remaining, pending.length);
        if (take > 0) {
          fs.writeSync(current.fd, pending.subarray(0, take));
          current.remaining -= take;
          pending = pending.subarray(take);
        }
        if (current.remaining > 0) return;
        fs.closeSync(current.fd);
        padding = current.pad;
        current = null;
        continue;
      }
      if (pending.length < 512) return;
      const entry = parseTarHeader(pending.subarray(0, 512));
      pending = pending.subarray(512);
      if (!entry) return;
      const target = safeJoin(destDir, entry.name);
      if (!target) continue;
      if (entry.isDir) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(target, 'w');
      extracted.push(target);
      const pad = (512 - (entry.size % 512)) % 512;
      if (entry.size === 0) {
        fs.closeSync(fd);
        padding = pad;
        continue;
      }
      current = { fd, remaining: entry.size, pad };
    }
  };

  for await (const chunk of inflated) handle(chunk as Buffer);
  if (current) {
    fs.closeSync((current as any).fd);
  }
  return extracted;
}

export function dirSize(dir: string): number {
  let total = 0;
  try {
    const walk = (p: string) => {
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          try {
            total += fs.statSync(full).size;
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(dir);
  } catch {
    /* missing dir */
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

export interface BackupInfo {
  file: string;
  name: string;
  createdAt: string;
  sizeBytes: number;
  schemaVersion: number | null;
  appVersion: string | null;
  kind: 'manual' | 'automatic' | 'pre-migration' | 'pre-restore';
  counts?: Record<string, number>;
}

export async function createBackup(label = '', kind: BackupInfo['kind'] = 'manual'): Promise<BackupInfo> {
  ensureStorage();
  const db = getDb();
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    /* checkpoint is best effort */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `thrustbook-${kind}-${stamp}${label ? `-${safeFileName(label)}` : ''}.rlbak`;
  const file = path.join(backupsDir(), name);

  const counts: Record<string, number> = {};
  for (const table of ['projects', 'revisions', 'tests', 'flights', 'datasets', 'channels', 'documents', 'issues', 'components', 'sensors', 'entry_templates']) {
    try {
      counts[table] = Number((db.get<any>(`SELECT COUNT(*) AS c FROM ${table}`) as any)?.c ?? 0);
    } catch {
      counts[table] = 0;
    }
  }

  const manifest = {
    format: 'rocketlab-backup',
    formatVersion: 1,
    appVersion: APP_NAME,
    schemaVersion: schemaVersion(),
    createdAt: nowIso(),
    label,
    kind,
    counts,
  };

  const entries: TarEntrySource[] = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }];
  const root = dataDir();
  entries.push({ name: 'data/rocketlab.db', filePath: dbFile() });
  const includeDirs = ['datasets', 'documents', 'reports'];
  for (const dirName of includeDirs) {
    const dir = path.join(root, dirName);
    if (!fs.existsSync(dir)) continue;
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        const rel = path.relative(root, full).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          entries.push({ name: `data/${rel}/`, filePath: full });
          walk(full);
        } else if (entry.isFile()) {
          entries.push({ name: `data/${rel}`, filePath: full });
        }
      }
    };
    walk(dir);
  }

  await writeTarGz(file, entries);
  const info: BackupInfo = {
    file,
    name,
    createdAt: manifest.createdAt,
    sizeBytes: fs.statSync(file).size,
    schemaVersion: manifest.schemaVersion,
    appVersion: manifest.appVersion,
    kind,
    counts,
  };
  fs.writeFileSync(`${file}.json`, JSON.stringify(info, null, 2), 'utf8');

  // Reject a backup that cannot be read back — never leave a silent bad archive.
  const verify = await inspectBackup(file);
  if (!verify.valid) {
    fs.rmSync(file, { force: true });
    throw new Error(`Backup verification failed: ${verify.error}`);
  }
  pruneBackups();
  return info;
}

export async function inspectBackup(file: string): Promise<{ valid: boolean; manifest?: any; error?: string }> {
  const tempDir = path.join(backupsDir(), `inspect-${crypto.randomUUID()}`);
  try {
    await extractTarGz(file, tempDir);
    const manifestPath = path.join(tempDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return { valid: false, error: 'Archive has no manifest' };
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.format !== 'rocketlab-backup') return { valid: false, error: 'Not a Thrustbook backup' };
    const dbPath = path.join(tempDir, 'data', 'rocketlab.db');
    if (!fs.existsSync(dbPath)) return { valid: false, error: 'Archive has no database' };
    return { valid: true, manifest };
  } catch (err: any) {
    return { valid: false, error: err?.message ?? String(err) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function listBackups(): BackupInfo[] {
  ensureStorage();
  const out: BackupInfo[] = [];
  for (const name of fs.readdirSync(backupsDir())) {
    if (!name.endsWith('.rlbak')) continue;
    const file = path.join(backupsDir(), name);
    const sidecar = `${file}.json`;
    let info: BackupInfo | null = null;
    if (fs.existsSync(sidecar)) {
      try {
        info = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      } catch {
        info = null;
      }
    }
    if (!info) {
      info = {
        file,
        name,
        createdAt: fs.statSync(file).mtime.toISOString(),
        sizeBytes: fs.statSync(file).size,
        schemaVersion: null,
        appVersion: null,
        kind: 'manual',
      };
    }
    out.push(info);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneBackups(): void {
  let keep = 10;
  try {
    const raw = Number(JSON.parse(fs.readFileSync(path.join(dataDir(), 'settings-cache.json'), 'utf8')).backupRetention);
    if (Number.isFinite(raw) && raw > 0) keep = raw;
  } catch {
    /* default */
  }
  const automatic = listBackups().filter((b) => b.kind === 'automatic');
  for (const old of automatic.slice(keep)) {
    try {
      fs.rmSync(old.file, { force: true });
      fs.rmSync(`${old.file}.json`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Restores a backup over the live data directory.
 * The current database is closed first, a safety copy is taken, and the schema is
 * checked after reopening. Returns a warning when the backup predates the current
 * schema so migrations can run on next open.
 */
export async function restoreBackup(file: string): Promise<any> {
  const check = await inspectBackup(file);
  if (!check.valid) throw new Error(`Backup cannot be restored: ${check.error}`);
  const tempDir = path.join(backupsDir(), `restore-${crypto.randomUUID()}`);
  try {
    await extractTarGz(file, tempDir);
    const restoredDb = path.join(tempDir, 'data', 'rocketlab.db');
    const verifyDbCheck = verifySqlite(restoredDb);
    if (!verifyDbCheck.ok) throw new Error(`Backup database failed its integrity check: ${verifyDbCheck.error}`);

    await createBackup('pre-restore', 'pre-restore');

    closeDatabase();
    const root = dataDir();
    for (const dirName of ['datasets', 'documents', 'reports']) {
      const live = path.join(root, dirName);
      if (fs.existsSync(live)) fs.rmSync(live, { recursive: true, force: true });
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${dbFile()}${suffix}`;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
    fs.copyFileSync(restoredDb, dbFile());
    for (const dirName of ['datasets', 'documents', 'reports']) {
      const source = path.join(tempDir, 'data', dirName);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(root, dirName), { recursive: true });
    }
    const reopened = openDatabase();
    return {
      ok: true,
      manifest: check.manifest,
      schemaVersion: reopened.version,
      migrated: (check.manifest?.schemaVersion ?? 0) < schemaVersion(),
      safetyBackup: true,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function verifySqlite(file: string): { ok: boolean; error?: string } {
  try {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const probe = new DatabaseSync(file, { readOnly: true });
    const rows = probe.prepare('PRAGMA integrity_check').all() as any[];
    probe.close();
    const text = String(rows?.[0]?.integrity_check ?? '');
    return text === 'ok' ? { ok: true } : { ok: false, error: text || 'integrity check failed' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/* ------------------------------------------------------------------ */
/* Project export / import                                             */
/* ------------------------------------------------------------------ */

const CHILD_TABLES = ['channels', 'config_items'];

const REFERENCE_COLUMNS = [
  'project_id',
  'rocket_id',
  'revision_id',
  'test_id',
  'flight_id',
  'dataset_id',
  'run_id',
  'experiment_id',
  'campaign_id',
  'sensor_id',
  'component_id',
  'config_id',
  'source_dataset_id',
  'entity_id',
  'electronics_config_id',
  'config_snapshot_id',
  'template_id',
];

function projectTableRows(projectId: string): Record<string, any[]> {
  const db = getDb();
  const tables = [
    'projects',
    'rockets',
    'revisions',
    'stages',
    'campaigns',
    'tests',
    'flights',
    'experiments',
    'runs',
    'datasets',
    'events',
    'components',
    'component_usage',
    'electronics_configs',
    'sensors',
    'sensor_installations',
    'calibrations',
    'config_snapshots',
    'documents',
    'issues',
    'notes',
    'graphs',
    'workspaces',
    'comparisons',
    'entry_templates',
    'reports',
    'activity',
  ];
  const out: Record<string, any[]> = {};
  const datasetIds = new Set(db.all<any>('SELECT id FROM datasets WHERE project_id = ?', [projectId]).map((d) => d.id));
  const configIds = new Set(db.all<any>('SELECT id FROM electronics_configs WHERE project_id = ?', [projectId]).map((d) => d.id));
  for (const table of tables) {
    const cols = new Set(db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
    if (cols.has('project_id')) {
      out[table] = db.all<any>(`SELECT * FROM ${table} WHERE project_id = ?`, [projectId]);
    } else out[table] = [];
  }
  out.channels = db.all<any>(
    `SELECT * FROM channels WHERE dataset_id IN (SELECT id FROM datasets WHERE project_id = ?)`,
    [projectId],
  );
  out.config_items = db.all<any>(
    `SELECT * FROM config_items WHERE config_id IN (SELECT id FROM electronics_configs WHERE project_id = ?)`,
    [projectId],
  );
  // Keep only channels/config items that belong to this project.
  out.channels = out.channels.filter((c) => datasetIds.has(c.dataset_id));
  out.config_items = out.config_items.filter((c) => configIds.has(c.config_id));
  return out;
}

export async function exportProject(projectId: string, destination?: string): Promise<{ file: string; counts: Record<string, number> }> {
  const db = getDb();
  const project = db.get<any>('SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!project) throw new Error('Project not found');
  const tables = projectTableRows(projectId);
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(tables)) counts[table] = rows.length;

  const file = destination ?? path.join(backupsDir(), `project-${safeFileName(project.code || project.name)}-${new Date().toISOString().slice(0, 10)}.rlproj`);
  const manifest = {
    format: 'rocketlab-project',
    formatVersion: 1,
    exportedAt: nowIso(),
    appVersion: APP_NAME,
    schemaVersion: schemaVersion(),
    projectName: project.name,
    projectCode: project.code,
    counts,
    tables,
    files: [] as { archive: string; source: string; datasetId?: string; documentId?: string }[],
    checksums: {} as Record<string, string>,
  };

  const entries: TarEntrySource[] = [];
  const addFile = (source: string, archiveName: string, meta: any) => {
    if (!fs.existsSync(source)) return;
    manifest.files.push({ archive: archiveName, source, ...meta });
    entries.push({ name: archiveName, filePath: source });
  };

  for (const dataset of tables.datasets ?? []) {
    const dir = dataset.stored_dir;
    if (!dir || !fs.existsSync(dir)) continue;
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const rel = path.relative(dir, full).replace(/\\/g, '/');
          addFile(full, `files/datasets/${dataset.id}/${rel}`, { datasetId: dataset.id });
        }
      }
    };
    walk(dir);
    try {
      const buf = fs.readFileSync(path.join(dir, 'time.f64'));
      manifest.checksums[`dataset:${dataset.id}`] = crypto.createHash('sha256').update(buf).digest('hex');
    } catch {
      /* no time file */
    }
  }

  for (const doc of tables.documents ?? []) {
    if (doc.stored_path && fs.existsSync(doc.stored_path)) {
      addFile(doc.stored_path, `files/documents/${doc.id}-${safeFileName(doc.original_name || 'file')}`, { documentId: doc.id });
    }
  }

  entries.unshift({ name: 'project.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  await writeTarGz(file, entries);
  return { file, counts };
}

export async function importProject(archivePath: string, options: { rename?: string } = {}): Promise<any> {
  const tempDir = path.join(backupsDir(), `import-${crypto.randomUUID()}`);
  try {
    await extractTarGz(archivePath, tempDir);
    const manifestPath = path.join(tempDir, 'project.json');
    if (!fs.existsSync(manifestPath)) throw new Error('Archive does not contain a project export manifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.format !== 'rocketlab-project') throw new Error('Archive is not a Thrustbook project export');

    const tables: Record<string, any[]> = manifest.tables ?? {};
    const idMap = new Map<string, string>();
    const remap = (value: any) => {
      if (typeof value !== 'string' || !value) return value;
      return idMap.get(value) ?? value;
    };

    // Assign new identifiers up front so references can be rewritten consistently.
    for (const rows of Object.values(tables)) {
      for (const row of rows) {
        if (typeof row.id === 'string') idMap.set(row.id, newId());
      }
    }

    const db = getDb();
    const projectRows = tables.projects ?? [];
    if (projectRows.length === 0) throw new Error('Export contains no project record');
    const oldProjectId = projectRows[0].id;
    const newProjectId = idMap.get(oldProjectId)!;
    const importedAt = nowIso();

    const insertRows = (table: string, rows: any[]) => {
      if (!rows?.length) return 0;
      const cols = new Set(db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
      let inserted = 0;
      for (const row of rows) {
        const next: Record<string, any> = {};
        for (const [key, value] of Object.entries(row)) {
          if (!cols.has(key)) continue;
          next[key] = REFERENCE_COLUMNS.includes(key) ? remap(value) : value;
        }
        if (next.id) next.id = remap(next.id);
        if (table === 'projects') {
          next.name = options.rename || `${next.name} (imported)`;
          next.archived = 0;
          next.created_at = next.created_at || importedAt;
        }
        if (next.updated_at) next.updated_at = importedAt;
        const keys = Object.keys(next);
        db.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => next[k]));
        inserted++;
      }
      return inserted;
    };

    // Files are copied into the live storage before rows reference them.
    const fileMap = new Map<string, string>();
    for (const entry of manifest.files ?? []) {
      const source = path.join(tempDir, entry.archive);
      if (!fs.existsSync(source)) continue;
      let target: string;
      if (entry.datasetId) {
        const newDatasetId = remap(entry.datasetId);
        const rel = entry.archive.split(`files/datasets/${entry.datasetId}/`)[1] ?? path.basename(source);
        target = path.join(datasetsDir(), newDatasetId, rel);
      } else {
        const newDocId = remap(entry.documentId);
        const originalName = entry.archive.split('/').pop() ?? path.basename(source);
        target = path.join(documentsDir(), `${newDocId}-${safeFileName(originalName.replace(/^[0-9a-f-]{36}-/, ''))}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      fileMap.set(entry.archive, target);
    }

    // Rewrite stored paths for datasets and documents.
    for (const dataset of tables.datasets ?? []) {
      const newIdValue = remap(dataset.id);
      const dir = path.join(datasetsDir(), newIdValue);
      if (fs.existsSync(dir)) {
        dataset.stored_dir = dir;
        const originalName = dataset.original_file ? path.basename(dataset.original_file) : '';
        if (originalName && fs.existsSync(path.join(dir, originalName))) dataset.original_file = path.join(dir, originalName);
      }
    }
    for (const doc of tables.documents ?? []) {
      const archiveEntry = (manifest.files ?? []).find((f: any) => f.documentId === doc.id);
      if (archiveEntry && fileMap.has(archiveEntry.archive)) doc.stored_path = fileMap.get(archiveEntry.archive);
    }

    db.transaction(() => {
      insertRows('projects', tables.projects ?? []);
      insertRows('rockets', tables.rockets ?? []);
      insertRows('revisions', tables.revisions ?? []);
      insertRows('stages', tables.stages ?? []);
      insertRows('campaigns', tables.campaigns ?? []);
      insertRows('tests', tables.tests ?? []);
      insertRows('flights', tables.flights ?? []);
      insertRows('experiments', tables.experiments ?? []);
      insertRows('runs', tables.runs ?? []);
      insertRows('datasets', tables.datasets ?? []);
      insertRows('channels', tables.channels ?? []);
      insertRows('events', tables.events ?? []);
      insertRows('components', tables.components ?? []);
      insertRows('component_usage', tables.component_usage ?? []);
      insertRows('electronics_configs', tables.electronics_configs ?? []);
      insertRows('config_items', tables.config_items ?? []);
      insertRows('sensors', tables.sensors ?? []);
      insertRows('sensor_installations', tables.sensor_installations ?? []);
      insertRows('calibrations', tables.calibrations ?? []);
      insertRows('config_snapshots', tables.config_snapshots ?? []);
      insertRows('documents', tables.documents ?? []);
      insertRows('issues', tables.issues ?? []);
      insertRows('notes', tables.notes ?? []);
      insertRows('graphs', tables.graphs ?? []);
      insertRows('workspaces', tables.workspaces ?? []);
      insertRows('comparisons', tables.comparisons ?? []);
      insertRows('entry_templates', tables.entry_templates ?? []);
      insertRows('reports', tables.reports ?? []);
      insertRows('activity', tables.activity ?? []);
      db.run(
        `INSERT INTO activity (id, project_id, entity_type, entity_id, kind, title, detail, at, tags, actor)
         VALUES (?, ?, 'project', ?, 'import', 'Project imported', ?, ?, 'import')`,
        [newId(), newProjectId, newProjectId, `Imported from ${path.basename(archivePath)} (exported ${manifest.exportedAt})`, importedAt],
      );
    });

    return {
      ok: true,
      projectId: newProjectId,
      projectName: (tables.projects ?? [])[0]?.name,
      counts: manifest.counts ?? {},
      files: fileMap.size,
      exportedAt: manifest.exportedAt,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Storage management                                                 */
/* ------------------------------------------------------------------ */

export function storageInfo(): any {
  ensureStorage();
  const root = dataDir();
  const dbCandidates = [dbFile(), `${dbFile()}-wal`];
  const dbBytes = dbCandidates.reduce((sum, f) => sum + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
  const db = getDb();
  let freeBytes: number | null = null;
  try {
    const stat: any = (fs as any).statfsSync ? (fs as any).statfsSync(root) : null;
    if (stat) freeBytes = stat.bavail * stat.bsize;
  } catch {
    freeBytes = null;
  }
  return {
    dataDir: root,
    dbFile: dbFile(),
    dbBytes,
    datasetsBytes: dirSize(datasetsDir()),
    documentsBytes: dirSize(documentsDir()),
    reportsBytes: dirSize(reportsDir()),
    backupsBytes: dirSize(backupsDir()),
    freeBytes,
    schemaVersion: schemaVersion(),
    counts: {
      projects: Number(db.get<any>('SELECT COUNT(*) c FROM projects')?.c ?? 0),
      datasets: Number(db.get<any>('SELECT COUNT(*) c FROM datasets')?.c ?? 0),
      channels: Number(db.get<any>('SELECT COUNT(*) c FROM channels')?.c ?? 0),
      documents: Number(db.get<any>('SELECT COUNT(*) c FROM documents')?.c ?? 0),
      reports: Number(db.get<any>('SELECT COUNT(*) c FROM reports')?.c ?? 0),
    },
  };
}

/** Copies all data to a new folder and points the application at it. */
export async function moveStorage(newDir: string): Promise<{ ok: boolean; requiresRestart: boolean }> {
  const current = dataDir();
  if (path.resolve(newDir) === path.resolve(current)) return { ok: true, requiresRestart: false };
  if (isInside(current, newDir) || isInside(newDir, current)) {
    throw new Error('The new storage folder must not be inside the current data folder (or vice versa)');
  }
  getDb().exec('PRAGMA wal_checkpoint(TRUNCATE);');
  closeDatabase();
  try {
    fs.mkdirSync(newDir, { recursive: true });
    fs.cpSync(current, newDir, { recursive: true });
    setDataDir(newDir);
    openDatabase();
    return { ok: true, requiresRestart: true };
  } catch (err) {
    openDatabase();
    throw err;
  }
}

export function integrityCheck(): any {
  const db = getDb();
  const sqlite = db.all<any>('PRAGMA integrity_check');
  const issues: string[] = [];
  const orphanChecks: [string, string][] = [
    ['datasets', 'project_id NOT IN (SELECT id FROM projects)'],
    ['channels', 'dataset_id NOT IN (SELECT id FROM datasets)'],
    ['tests', 'project_id NOT IN (SELECT id FROM projects)'],
    ['flights', 'project_id NOT IN (SELECT id FROM projects)'],
    ['documents', 'project_id NOT IN (SELECT id FROM projects)'],
    ['events', 'dataset_id NOT IN (SELECT id FROM datasets)'],
  ];
  for (const [table, condition] of orphanChecks) {
    const count = Number(db.get<any>(`SELECT COUNT(*) c FROM ${table} WHERE ${condition}`)?.c ?? 0);
    if (count > 0) issues.push(`${table}: ${count} orphaned row(s)`);
  }
  const datasets = db.all<any>('SELECT id, name, stored_dir, points, channels_count FROM datasets');
  const missingFiles: string[] = [];
  for (const d of datasets) {
    if (!d.stored_dir || !fs.existsSync(d.stored_dir)) {
      missingFiles.push(`${d.name}: dataset folder missing`);
      continue;
    }
    if (!fs.existsSync(path.join(d.stored_dir, 'time.f64'))) missingFiles.push(`${d.name}: time axis file missing`);
  }
  return {
    sqliteOk: String(sqlite?.[0]?.integrity_check ?? '') === 'ok',
    sqliteMessages: sqlite.map((r) => r.integrity_check),
    orphanIssues: issues,
    missingDatasets: missingFiles,
    checkedAt: nowIso(),
    ok: String(sqlite?.[0]?.integrity_check ?? '') === 'ok' && issues.length === 0 && missingFiles.length === 0,
  };
}

export function removeBackup(file: string): { ok: boolean } {
  if (!isInside(backupsDir(), file)) throw new Error('Backup path is outside the application data folder');
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.json`, { force: true });
  return { ok: true };
}

export function exportTableCsv(table: string, destination: string): string {
  const db = getDb();
  const allowed = new Set(['projects', 'tests', 'flights', 'datasets', 'channels', 'components', 'sensors', 'calibrations', 'issues', 'documents', 'reports', 'activity']);
  if (!allowed.has(table)) throw new Error('Table export is not available for this record type');
  const rows = db.all<any>(`SELECT * FROM ${table} LIMIT 200000`);
  if (rows.length === 0) {
    fs.writeFileSync(destination, '', 'utf8');
    return destination;
  }
  const headers = Object.keys(rows[0]);
  const escapeCsv = (v: any) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => escapeCsv(row[h])).join(','));
  fs.writeFileSync(destination, lines.join('\n'), 'utf8');
  return destination;
}
