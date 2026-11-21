import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupsDir, dbFile } from './paths';

export type SqlParam = string | number | null;

/**
 * Ordered schema migrations. Each entry runs once inside a transaction and the
 * database user_version is advanced. Never edit an existing migration: add a new
 * one so that installed copies upgrade safely.
 */
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT DEFAULT '',
  description TEXT DEFAULT '',
  objectives TEXT DEFAULT '',
  status TEXT DEFAULT 'Planning',
  stage TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  archived INTEGER DEFAULT 0,
  color TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rockets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  identifier TEXT DEFAULT '',
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'In development',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  rocket_id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT DEFAULT '',
  design_changes TEXT DEFAULT '',
  component_changes TEXT DEFAULT '',
  config_changes TEXT DEFAULT '',
  observations TEXT DEFAULT '',
  conclusions TEXT DEFAULT '',
  status TEXT DEFAULT 'In design',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  rocket_id TEXT DEFAULT '',
  revision_id TEXT DEFAULT '',
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  status TEXT DEFAULT 'Not started',
  started_at TEXT DEFAULT '',
  completed_at TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT DEFAULT 'Ground',
  description TEXT DEFAULT '',
  objectives TEXT DEFAULT '',
  started_at TEXT DEFAULT '',
  ended_at TEXT DEFAULT '',
  status TEXT DEFAULT 'Planned',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  rocket_id TEXT DEFAULT '',
  revision_id TEXT DEFAULT '',
  campaign_id TEXT DEFAULT '',
  name TEXT NOT NULL,
  test_no TEXT DEFAULT '',
  kind TEXT DEFAULT 'ground',
  category TEXT DEFAULT 'General experimental testing',
  performed_at TEXT DEFAULT '',
  objectives TEXT DEFAULT '',
  description TEXT DEFAULT '',
  equipment TEXT DEFAULT '',
  sensor_config TEXT DEFAULT '',
  electronics_config_id TEXT DEFAULT '',
  config_snapshot_id TEXT DEFAULT '',
  env_conditions TEXT DEFAULT '',
  expected TEXT DEFAULT '',
  actual TEXT DEFAULT '',
  observations TEXT DEFAULT '',
  status TEXT DEFAULT 'Planned',
  conclusions TEXT DEFAULT '',
  custom_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS flights (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  rocket_id TEXT DEFAULT '',
  revision_id TEXT DEFAULT '',
  name TEXT NOT NULL,
  flight_no TEXT DEFAULT '',
  performed_at TEXT DEFAULT '',
  objectives TEXT DEFAULT '',
  description TEXT DEFAULT '',
  env_conditions TEXT DEFAULT '',
  weather TEXT DEFAULT '',
  electronics_config_id TEXT DEFAULT '',
  hardware_config TEXT DEFAULT '',
  firmware_versions TEXT DEFAULT '',
  sensor_config TEXT DEFAULT '',
  daq_config TEXT DEFAULT '',
  observations TEXT DEFAULT '',
  post_inspection TEXT DEFAULT '',
  conclusions TEXT DEFAULT '',
  status TEXT DEFAULT 'Planned',
  custom_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision_id TEXT DEFAULT '',
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  objective TEXT DEFAULT '',
  independent_vars TEXT DEFAULT '',
  measured_vars TEXT DEFAULT '',
  controlled_conditions TEXT DEFAULT '',
  setup TEXT DEFAULT '',
  conclusions TEXT DEFAULT '',
  status TEXT DEFAULT 'Planned',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  performed_at TEXT DEFAULT '',
  configuration TEXT DEFAULT '',
  observations TEXT DEFAULT '',
  results TEXT DEFAULT '',
  status TEXT DEFAULT 'Planned',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT DEFAULT 'imported',
  test_id TEXT DEFAULT '',
  flight_id TEXT DEFAULT '',
  run_id TEXT DEFAULT '',
  source_dataset_id TEXT DEFAULT '',
  recorded_at TEXT DEFAULT '',
  sampling_hz REAL,
  duration REAL,
  points INTEGER DEFAULT 0,
  channels_count INTEGER DEFAULT 0,
  units_note TEXT DEFAULT '',
  original_file TEXT DEFAULT '',
  stored_dir TEXT DEFAULT '',
  checksum TEXT DEFAULT '',
  quality_json TEXT DEFAULT '{}',
  provenance_json TEXT DEFAULT '{}',
  processing_json TEXT DEFAULT '{}',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'custom',
  unit TEXT DEFAULT '',
  axis TEXT DEFAULT '',
  column_index INTEGER DEFAULT -1,
  stats_json TEXT DEFAULT '{}',
  min REAL,
  max REAL,
  points INTEGER DEFAULT 0,
  file TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  derived INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'Custom',
  t REAL DEFAULT 0,
  description TEXT DEFAULT '',
  channel_key TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  source TEXT DEFAULT 'user',
  confirmed INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS components (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  manufacturer TEXT DEFAULT '',
  model TEXT DEFAULT '',
  category TEXT DEFAULT 'Other',
  specs TEXT DEFAULT '',
  serial TEXT DEFAULT '',
  purchase_info TEXT DEFAULT '',
  configuration TEXT DEFAULT '',
  firmware TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS component_usage (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  entity_type TEXT DEFAULT '',
  entity_id TEXT DEFAULT '',
  installed_at TEXT DEFAULT '',
  removed_at TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS electronics_configs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  revision_id TEXT DEFAULT '',
  content_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_items (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  component_id TEXT DEFAULT '',
  role TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sensors (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  manufacturer TEXT DEFAULT '',
  model TEXT DEFAULT '',
  type TEXT DEFAULT 'Other',
  serial TEXT DEFAULT '',
  range_min REAL,
  range_max REAL,
  range_unit TEXT DEFAULT '',
  resolution REAL,
  units TEXT DEFAULT '',
  sampling TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sensor_installations (
  id TEXT PRIMARY KEY,
  sensor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  entity_type TEXT DEFAULT '',
  entity_id TEXT DEFAULT '',
  location TEXT DEFAULT '',
  installed_at TEXT DEFAULT '',
  removed_at TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calibrations (
  id TEXT PRIMARY KEY,
  sensor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  performed_at TEXT DEFAULT '',
  method TEXT DEFAULT '',
  reference_equipment TEXT DEFAULT '',
  values_json TEXT DEFAULT '[]',
  coefficients TEXT DEFAULT '',
  range_min REAL,
  range_max REAL,
  uncertainty TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT DEFAULT 'Electronics configuration',
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  content_json TEXT DEFAULT '{}',
  file_path TEXT DEFAULT '',
  checksum TEXT DEFAULT '',
  version TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_type TEXT DEFAULT '',
  entity_id TEXT DEFAULT '',
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  kind TEXT DEFAULT 'Other',
  tags TEXT DEFAULT '',
  original_name TEXT DEFAULT '',
  stored_path TEXT DEFAULT '',
  mime TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  checksum TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision_id TEXT DEFAULT '',
  test_id TEXT DEFAULT '',
  flight_id TEXT DEFAULT '',
  dataset_id TEXT DEFAULT '',
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT 'Observation',
  severity TEXT DEFAULT 'Medium',
  status TEXT DEFAULT 'Open',
  identified_at TEXT DEFAULT '',
  investigation TEXT DEFAULT '',
  proposed_resolution TEXT DEFAULT '',
  resolution TEXT DEFAULT '',
  verification TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_type TEXT DEFAULT '',
  entity_id TEXT DEFAULT '',
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graphs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  spec_json TEXT DEFAULT '{}',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT DEFAULT '',
  spec_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comparisons (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision_id TEXT DEFAULT '',
  name TEXT NOT NULL,
  spec_json TEXT DEFAULT '{}',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  spec_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  spec_json TEXT DEFAULT '{}',
  html_path TEXT DEFAULT '',
  pdf_path TEXT DEFAULT '',
  entity_type TEXT DEFAULT '',
  entity_id TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_type TEXT DEFAULT '',
  entity_id TEXT DEFAULT '',
  kind TEXT DEFAULT 'update',
  title TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  at TEXT NOT NULL,
  tags TEXT DEFAULT '',
  actor TEXT DEFAULT 'user'
);

CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_rockets_project ON rockets(project_id);
CREATE INDEX IF NOT EXISTS idx_revisions_project ON revisions(project_id, rocket_id);
CREATE INDEX IF NOT EXISTS idx_stages_project ON stages(project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_tests_project ON tests(project_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tests_campaign ON tests(campaign_id);
CREATE INDEX IF NOT EXISTS idx_flights_project ON flights(project_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_experiment ON runs(experiment_id);
CREATE INDEX IF NOT EXISTS idx_datasets_project ON datasets(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_datasets_test ON datasets(test_id);
CREATE INDEX IF NOT EXISTS idx_datasets_flight ON datasets(flight_id);
CREATE INDEX IF NOT EXISTS idx_datasets_run ON datasets(run_id);
CREATE INDEX IF NOT EXISTS idx_channels_dataset ON channels(dataset_id);
CREATE INDEX IF NOT EXISTS idx_events_dataset ON events(dataset_id, t);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, status);
CREATE INDEX IF NOT EXISTS idx_components_project ON components(project_id);
CREATE INDEX IF NOT EXISTS idx_sensors_project ON sensors(project_id);
CREATE INDEX IF NOT EXISTS idx_calibrations_sensor ON calibrations(sensor_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_config_snapshots_project ON config_snapshots(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_reports_project ON reports(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_entity ON notes(entity_type, entity_id);
`,
  },
  {
    version: 2,
    name: 'dataset channel metadata and import provenance',
    sql: `
ALTER TABLE channels ADD COLUMN calibration TEXT DEFAULT '';
ALTER TABLE channels ADD COLUMN source_desc TEXT DEFAULT '';
ALTER TABLE datasets ADD COLUMN import_spec_json TEXT DEFAULT '{}';
ALTER TABLE datasets ADD COLUMN row_count_raw INTEGER DEFAULT 0;
ALTER TABLE datasets ADD COLUMN quality_status TEXT DEFAULT 'ok';
`,
  },
  {
    version: 3,
    name: 'reusable data-entry templates and custom values',
    sql: `
CREATE TABLE IF NOT EXISTS entry_templates (
  id TEXT PRIMARY KEY,
  project_id TEXT DEFAULT '',
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  applies_to TEXT NOT NULL DEFAULT 'test',
  category TEXT DEFAULT '',
  fields_json TEXT DEFAULT '[]',
  archived INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entry_templates_target ON entry_templates(applies_to, project_id);
ALTER TABLE tests ADD COLUMN template_id TEXT DEFAULT '';
ALTER TABLE flights ADD COLUMN template_id TEXT DEFAULT '';
ALTER TABLE runs ADD COLUMN custom_json TEXT DEFAULT '{}';
ALTER TABLE runs ADD COLUMN template_id TEXT DEFAULT '';
`,
  },
];

export interface Db {
  raw: DatabaseSync;
  all<T = any>(sql: string, params?: SqlParam[]): T[];
  get<T = any>(sql: string, params?: SqlParam[]): T | undefined;
  run(sql: string, params?: SqlParam[]): { changes: number; lastInsertRowid: number | bigint };
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  version: number;
}

let db: Db | null = null;

function backupBeforeMigration(fromVersion: number): void {
  try {
    const file = dbFile();
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) return;
    const dest = path.join(backupsDir(), `pre-migration-v${fromVersion}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    fs.copyFileSync(file, dest);
  } catch (err) {
    console.error('Pre-migration backup failed', err);
  }
}

export function openDatabase(): Db {
  if (db) return db;
  const file = dbFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA synchronous = NORMAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA busy_timeout = 5000;');

  const wrapper: Db = {
    raw,
    version: 0,
    all<T = any>(sql: string, params: SqlParam[] = []): T[] {
      return raw.prepare(sql).all(...params) as T[];
    },
    get<T = any>(sql: string, params: SqlParam[] = []): T | undefined {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    run(sql: string, params: SqlParam[] = []) {
      return raw.prepare(sql).run(...params) as { changes: number; lastInsertRowid: number | bigint };
    },
    exec(sql: string) {
      raw.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      raw.exec('BEGIN');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    },
  };

  const current = Number((raw.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
  wrapper.version = current;
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length > 0) {
    if (current > 0) backupBeforeMigration(current);
    for (const migration of pending) {
      try {
        wrapper.transaction(() => {
          raw.exec(migration.sql);
          raw.exec(`PRAGMA user_version = ${migration.version}`);
        });
        wrapper.version = migration.version;
        console.log(`Database migrated to v${migration.version} (${migration.name})`);
      } catch (err) {
        console.error(`Migration v${migration.version} failed`, err);
        throw err;
      }
    }
  }

  seedDefaults(wrapper);
  db = wrapper;
  return wrapper;
}

export function getDb(): Db {
  if (!db) return openDatabase();
  return db;
}

export function closeDatabase(): void {
  if (!db) return;
  try {
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.raw.close();
  } catch (err) {
    console.error('Database close failed', err);
  }
  db = null;
}

export function schemaVersion(): number {
  return getDb().version;
}

const DEFAULT_SETTINGS: Record<string, string> = {
  theme: 'dark',
  density: 'compact',
  dateFormat: 'YYYY-MM-DD',
  timeFormat: '24h',
  lengthUnit: 'm',
  velocityUnit: 'm/s',
  accelerationUnit: 'm/s2',
  pressureUnit: 'hPa',
  temperatureUnit: 'C',
  voltageUnit: 'V',
  currentUnit: 'A',
  backupOnStart: 'true',
  backupRetention: '10',
  autoCheckUpdates: 'true',
  updateRepo: '',
  defaultGraphPoints: '4000',
  defaultChartType: 'line',
  importDefaultSamplingHz: '',
  dashboardWidgets: JSON.stringify([
    'activeProjects',
    'recentActivity',
    'upcomingTests',
    'recentDatasets',
    'openIssues',
    'recentFlights',
    'milestones',
  ]),
  confirmDeletes: 'true',
  lastProjectId: '',
  showWelcome: 'true',
};

function seedDefaults(database: Db): void {
  const insert = database.raw.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  database.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, value);
  });
}

export function getSetting(key: string): string | null {
  const row = getDb().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

export function allSettings(): Record<string, string> {
  const rows = getDb().all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export { DEFAULT_SETTINGS };
