import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Application data lives outside the installation directory so that updates and
 * reinstalls never touch user data.
 *
 *   <userData>/storage.json   -> { dataDir: "..." }  (optional pointer)
 *   <dataDir>/rocketlab.db    -> metadata database
 *   <dataDir>/datasets/       -> original + channel files
 *   <dataDir>/documents/      -> uploaded attachments
 *   <dataDir>/backups/        -> versioned backups
 *   <dataDir>/reports/        -> generated reports
 *   <dataDir>/deleted/        -> user-deleted dataset folders (kept for recovery)
 */

export interface StorageConfig {
  dataDir: string;
  configFile: string;
}

let cached: StorageConfig | null = null;

function pointerFile(): string {
  return path.join(app.getPath('userData'), 'storage.json');
}

export function readStorageConfig(): StorageConfig {
  if (cached) return cached;
  const file = pointerFile();
  const fallback = path.join(app.getPath('userData'), 'data');
  let dataDir = fallback;
  // Explicit override for QA/portable deployments; the pointer file remains the
  // normal way the storage location is chosen.
  if (process.env.ROCKETLAB_DATA_DIR) dataDir = path.resolve(process.env.ROCKETLAB_DATA_DIR);
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof parsed?.dataDir === 'string' && parsed.dataDir.trim()) dataDir = parsed.dataDir;
    }
  } catch {
    dataDir = fallback;
  }
  cached = { dataDir, configFile: file };
  return cached;
}

export function setDataDir(newDir: string): void {
  const cfg = readStorageConfig();
  fs.mkdirSync(path.dirname(cfg.configFile), { recursive: true });
  fs.writeFileSync(cfg.configFile, JSON.stringify({ dataDir: newDir }, null, 2));
  cached = null;
}

export function dataDir(): string {
  return readStorageConfig().dataDir;
}

export function subDir(name: string): string {
  const dir = path.join(dataDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbFile(): string {
  return path.join(dataDir(), 'rocketlab.db');
}

export function datasetsDir(): string {
  return subDir('datasets');
}

export function documentsDir(): string {
  return subDir('documents');
}

export function backupsDir(): string {
  return subDir('backups');
}

export function reportsDir(): string {
  return subDir('reports');
}

export function deletedDir(): string {
  return subDir('deleted');
}

export function datasetPath(datasetId: string): string {
  const dir = path.join(datasetsDir(), datasetId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureStorage(): void {
  [dataDir(), datasetsDir(), documentsDir(), backupsDir(), reportsDir(), deletedDir()].forEach((d) =>
    fs.mkdirSync(d, { recursive: true }),
  );
}

/** True when `candidate` resolves inside `parent` (prevents path escapes). */
export function isInside(parent: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180) || 'file';
}

export function uniquePath(dir: string, fileName: string): string {
  const safe = safeFileName(fileName);
  let target = path.join(dir, safe);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  let i = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${base}-${i}${ext}`);
    i++;
  }
  return target;
}
