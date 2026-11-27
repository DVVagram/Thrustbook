import crypto from 'node:crypto';
import { getDb, type Db } from './db';
import { ENTITY_LABELS } from '../shared/constants';
import { isTemplateEntity, normalizeTemplateFields, templateScopeKey, usesDefaultTemplate, validateTemplateValues } from '../shared/templates';
import { normalizeCurrency, validateFinanceEntry, validateInventoryItem, validateShoppingItem } from '../shared/operations';

export const TABLES: Record<string, string> = {
  project: 'projects',
  rocket: 'rockets',
  revision: 'revisions',
  stage: 'stages',
  campaign: 'campaigns',
  test: 'tests',
  flight: 'flights',
  experiment: 'experiments',
  run: 'runs',
  dataset: 'datasets',
  channel: 'channels',
  event: 'events',
  component: 'components',
  component_usage: 'component_usage',
  electronics_config: 'electronics_configs',
  config_item: 'config_items',
  sensor: 'sensors',
  sensor_installation: 'sensor_installations',
  calibration: 'calibrations',
  config_snapshot: 'config_snapshots',
  document: 'documents',
  issue: 'issues',
  note: 'notes',
  graph: 'graphs',
  workspace: 'workspaces',
  comparison: 'comparisons',
  import_template: 'import_templates',
  entry_template: 'entry_templates',
  inventory_item: 'inventory_items',
  finance_entry: 'finance_entries',
  shopping_list_item: 'shopping_list_items',
  option_value: 'option_values',
  report: 'reports',
  activity: 'activity',
};

export function tableFor(entity: string): string {
  const t = TABLES[entity];
  if (!t) throw new Error(`Unknown record type: ${entity}`);
  return t;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Columns sanctioned by the live schema (blocks SQL injection through keys). */
const columnCache = new Map<string, Set<string>>();

export function columnsFor(table: string): Set<string> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const cols = new Set(getDb().all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
  columnCache.set(table, cols);
  return cols;
}

function parseJsonFields(row: any): any {
  if (!row) return row;
  for (const key of Object.keys(row)) {
    if (key.endsWith('_json')) {
      const value = row[key];
      if (typeof value === 'string' && value.trim()) {
        try {
          row[key.replace(/_json$/, '')] = JSON.parse(value);
        } catch {
          row[key.replace(/_json$/, '')] = null;
        }
      } else {
        row[key.replace(/_json$/, '')] = null;
      }
    }
  }
  return row;
}

export function expand<T = any>(rows: T[]): T[] {
  return rows.map((r) => parseJsonFields(r)) as T[];
}

export function expandOne<T = any>(row: T | undefined): T | undefined {
  return row ? (parseJsonFields(row) as T) : undefined;
}

function coerceValue(value: any): any {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

const TEMPLATE_FINAL_STATUSES = ['Completed', 'Complete', 'Failed', 'Aborted', 'Verified', 'Closed', 'Archived'];
const OPERATIONAL_ENTITIES = new Set(['inventory_item', 'finance_entry', 'shopping_list_item']);

/** Fields that feed the system-wide dropdown lists whenever a record is saved. */
const OPTION_FIELDS: Record<string, Record<string, string>> = {
  component: { category: 'component.category', manufacturer: 'manufacturer', supplier: 'supplier' },
  sensor: { type: 'sensor.type', manufacturer: 'manufacturer' },
  inventory_item: { category: 'inventory_item.category', unit: 'inventory_item.unit', supplier: 'supplier' },
  shopping_list_item: { supplier: 'supplier', priority: 'shopping_list.priority', status: 'shopping_list.status' },
  finance_entry: { category: 'finance_entry.category', counterparty: 'finance_entry.counterparty', payment_method: 'finance_entry.payment_method' },
  test: { category: 'test.category' },
  issue: { category: 'issue.category' },
  project: { status: 'project.status', stage: 'project.stage' },
  document: { kind: 'document.kind' },
  config_snapshot: { kind: 'config_snapshot.kind' },
  experiment: { status: 'experiment.status' },
};

export function registerOption(scopeKey: string, value: unknown): void {
  const text = String(value ?? '').trim();
  if (!scopeKey || !text) return;
  getDb().run('INSERT OR IGNORE INTO option_values (id, scope_key, value, created_at) VALUES (?, ?, ?, ?)', [newId(), scopeKey, text, nowIso()]);
}

/** Adds every chosen dropdown value (including template selections) to its shared list. */
function registerRecordOptions(entity: string, row: Record<string, any>): void {
  for (const [column, scope] of Object.entries(OPTION_FIELDS[entity] ?? {})) registerOption(scope, row[column]);
  if (!isTemplateEntity(entity)) return;
  const templateId = String(row.template_id ?? '').trim();
  let template: any;
  if (templateId) template = getDb().get<any>('SELECT * FROM entry_templates WHERE id = ?', [templateId]);
  else if (usesDefaultTemplate(entity)) template = defaultTemplateRow(entity, String(row.project_id ?? ''));
  if (!template) return;
  const values = parseCustomValues(row.custom_json);
  for (const field of normalizeTemplateFields(parseCustomValues(template.fields_json))) {
    if (field.type === 'select') registerOption(templateScopeKey(entity, field.key), values[field.key]);
  }
}

function registerTemplateOptions(row: Record<string, any>): void {
  const appliesTo = String(row.applies_to ?? '').trim();
  if (!appliesTo) return;
  for (const field of normalizeTemplateFields(parseCustomValues(row.fields_json))) {
    if (field.type !== 'select') continue;
    const scope = templateScopeKey(appliesTo, field.key);
    for (const option of field.options ?? []) registerOption(scope, option);
    if (field.default !== undefined) registerOption(scope, field.default);
  }
}

/** The most specific default field sheet for a record type (project first, then global). */
function defaultTemplateRow(entity: string, projectId: string): any | undefined {
  if (!usesDefaultTemplate(entity)) return undefined;
  return getDb().get<any>(
    `SELECT * FROM entry_templates
     WHERE applies_to = ? AND archived = 0 AND (project_id = ? OR project_id = '')
     ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END, is_default DESC, updated_at DESC LIMIT 1`,
    [entity, projectId ?? '', projectId ?? ''],
  );
}

/**
 * Parses an entered number, keeps unreadable text so validation can report it, and
 * only substitutes `emptyValue` when the field was left blank (undefined keeps the blank).
 */
function parseNumber(value: any, emptyValue: number | undefined): any {
  if (value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return emptyValue === undefined ? value : emptyValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

/** Coerces the operational numeric/currency fields before validation and storage. */
function normalizeOperationalInput(entity: string, data: Record<string, any>): Record<string, any> {
  const next = { ...data };
  if (entity === 'inventory_item') {
    for (const key of ['quantity', 'unit_cost', 'reorder_level']) {
      if (next[key] !== undefined && next[key] !== null && next[key] !== '') next[key] = Number(next[key]);
    }
    if (next.currency !== undefined) next.currency = normalizeCurrency(next.currency);
    if (next.unit !== undefined) next.unit = String(next.unit ?? '').trim() || 'pcs';
  }
  if (entity === 'component') {
    if (next.quantity !== undefined) next.quantity = parseNumber(next.quantity, 0);
    if (next.unit_price !== undefined) next.unit_price = parseNumber(next.unit_price, 0);
    if (next.currency !== undefined) next.currency = normalizeCurrency(next.currency);
    if (next.unit !== undefined) next.unit = String(next.unit ?? '').trim() || 'pcs';
  }
  if (entity === 'shopping_list_item') {
    if (next.quantity !== undefined) next.quantity = parseNumber(next.quantity, undefined);
    if (next.estimated_unit_cost !== undefined) next.estimated_unit_cost = parseNumber(next.estimated_unit_cost, 0);
    if (next.currency !== undefined) next.currency = normalizeCurrency(next.currency);
    if (next.unit !== undefined) next.unit = String(next.unit ?? '').trim() || 'pcs';
  }
  if (entity === 'finance_entry') {
    if (next.amount !== undefined && next.amount !== null && next.amount !== '') next.amount = Number(next.amount);
    if (next.currency !== undefined) next.currency = normalizeCurrency(next.currency);
    if (next.kind !== undefined) next.kind = String(next.kind ?? '').toLowerCase();
    if (next.occurred_on !== undefined) next.occurred_on = String(next.occurred_on ?? '').slice(0, 10);
  }
  return next;
}

function assertOperationalRecord(entity: string, row: Record<string, any>): void {
  if (!OPERATIONAL_ENTITIES.has(entity)) return;
  const errors =
    entity === 'inventory_item'
      ? validateInventoryItem(row)
      : entity === 'shopping_list_item'
        ? validateShoppingItem(row)
        : validateFinanceEntry(row);
  if (errors.length) throw new Error(errors.join('; '));
}

function parseCustomValues(value: any): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value)) ?? {};
  } catch {
    return {};
  }
}

/**
 * Validates values entered through a template. Type and selection constraints always
 * apply; required fields are enforced once the record reaches a final state so that
 * planned records can be created first and completed later.
 */
function assertTemplateValues(templateId: string, values: any, status: string): void {
  if (!templateId) return;
  const row = getDb().get<any>('SELECT id, name, applies_to, fields_json FROM entry_templates WHERE id = ?', [templateId]);
  if (!row) return;
  const fields = normalizeTemplateFields(parseCustomValues(row.fields_json) as any).map((field) => {
    if (field.type !== 'select') return field;
    const scope = templateScopeKey(String(row.applies_to ?? ''), field.key);
    const registered = getDb()
      .all<any>('SELECT value FROM option_values WHERE scope_key = ?', [scope])
      .map((option) => String(option.value ?? ''))
      .filter(Boolean);
    if (registered.length === 0) return field;
    return { ...field, options: [...new Set([...(field.options ?? []), ...registered])] };
  });
  const errors = validateTemplateValues(
    TEMPLATE_FINAL_STATUSES.includes(status) ? fields : fields.map((f) => ({ ...f, required: false })),
    parseCustomValues(values),
  );
  if (errors.length) throw new Error(`Template “${row.name}”: ${errors.join('; ')}`);
}

export interface ListOptions {
  where?: Record<string, any>;
  q?: string;
  searchColumns?: string[];
  orderBy?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function list(entity: string, opts: ListOptions = {}): any[] {
  const table = tableFor(entity);
  const cols = columnsFor(table);
  const clauses: string[] = [];
  const params: any[] = [];

  for (const [key, value] of Object.entries(opts.where ?? {})) {
    if (!cols.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      clauses.push(`${key} IN (${value.map(() => '?').join(',')})`);
      params.push(...value);
      continue;
    }
    clauses.push(`${key} = ?`);
    params.push(value);
  }

  if (opts.q && opts.q.trim()) {
    const term = `%${opts.q.trim()}%`;
    const searchable = (opts.searchColumns ?? ['name', 'title', 'label', 'description', 'notes', 'tags', 'test_no', 'flight_no', 'serial', 'category']).filter(
      (c) => cols.has(c),
    );
    if (searchable.length > 0) {
      clauses.push(`(${searchable.map((c) => `${c} LIKE ?`).join(' OR ')})`);
      params.push(...searchable.map(() => term));
    }
  }

  const orderCol = opts.orderBy && cols.has(opts.orderBy) ? opts.orderBy : cols.has('updated_at') ? 'updated_at' : 'created_at';
  const direction = opts.order === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
  const offset = Math.max(0, opts.offset ?? 0);

  const sql = `SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${orderCol} ${direction} LIMIT ${limit} OFFSET ${offset}`;
  return expand(getDb().all(sql, params));
}

export function getRecord(entity: string, id: string): any | undefined {
  const table = tableFor(entity);
  return expandOne(getDb().get(`SELECT * FROM ${table} WHERE id = ?`, [id]));
}

export function findOne(entity: string, where: Record<string, any>): any | undefined {
  const table = tableFor(entity);
  const cols = columnsFor(table);
  const keys = Object.keys(where).filter((k) => cols.has(k));
  if (keys.length === 0) return undefined;
  const sql = `SELECT * FROM ${table} WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')} LIMIT 1`;
  return expandOne(getDb().get(sql, keys.map((k) => where[k])));
}

const DISPLAY_FIELD = ['name', 'title', 'label', 'description'];

function displayName(entity: string, row: any): string {
  for (const f of DISPLAY_FIELD) if (row?.[f]) return String(row[f]);
  return ENTITY_LABELS[entity] ?? entity;
}

export interface ActivityInput {
  project_id: string;
  entity_type: string;
  entity_id: string;
  kind?: string;
  title: string;
  detail?: string;
  tags?: string;
  at?: string;
}

export function logActivity(input: ActivityInput, database: Db = getDb()): void {
  if (!input.project_id) return;
  database.run(
    `INSERT INTO activity (id, project_id, entity_type, entity_id, kind, title, detail, at, tags, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user')`,
    [
      newId(),
      input.project_id,
      input.entity_type,
      input.entity_id,
      input.kind ?? 'update',
      input.title,
      input.detail ?? '',
      input.at ?? nowIso(),
      input.tags ?? '',
    ],
  );
}

function touchProject(projectId: string, database: Db): void {
  if (!projectId) return;
  database.run('UPDATE projects SET updated_at = ? WHERE id = ?', [nowIso(), projectId]);
}

export function createRecord(entity: string, data: Record<string, any>): any {
  const table = tableFor(entity);
  const cols = columnsFor(table);
  const db = getDb();
  const input = normalizeOperationalInput(entity, data);
  const id = typeof input.id === 'string' && input.id ? input.id : newId();
  const ts = nowIso();
  const row: Record<string, any> = { id };
  for (const [key, value] of Object.entries(input)) {
    if (!cols.has(key)) continue;
    if (key === 'id') continue;
    row[key] = coerceValue(value);
  }
  if (cols.has('created_at')) row.created_at = input.created_at ?? ts;
  if (cols.has('updated_at')) row.updated_at = input.updated_at ?? ts;

  if (entity === 'inventory_item' && !String(row.name ?? '').trim()) throw new Error('Item name is required');
  if (entity === 'inventory_item') {
    if (input.quantity === undefined || input.quantity === null || input.quantity === '') throw new Error('Quantity is required');
    if (input.unit_cost === undefined || input.unit_cost === null || input.unit_cost === '') throw new Error('Unit cost is required');
    if (row.quantity === undefined || row.quantity === null) row.quantity = 0;
    if (!row.unit) row.unit = 'pcs';
    if (row.unit_cost === undefined || row.unit_cost === null) row.unit_cost = 0;
    if (row.reorder_level === undefined || row.reorder_level === null) row.reorder_level = 0;
    if (!row.currency) row.currency = 'USD';
  }
  if (entity === 'finance_entry') {
    if (!row.kind) row.kind = 'expenditure';
    if (!row.occurred_on) row.occurred_on = ts.slice(0, 10);
    if (row.amount === undefined || row.amount === null) row.amount = 0;
    if (!row.currency) row.currency = 'USD';
  }
  if (entity === 'component') {
    if (row.quantity === undefined || row.quantity === null) row.quantity = 1;
    if (row.unit_price === undefined || row.unit_price === null) row.unit_price = 0;
    if (!row.unit) row.unit = 'pcs';
    if (!row.currency) row.currency = 'USD';
  }
  if (entity === 'shopping_list_item') {
    if (row.quantity === undefined || row.quantity === null) row.quantity = 1;
    if (row.estimated_unit_cost === undefined || row.estimated_unit_cost === null) row.estimated_unit_cost = 0;
    if (!row.unit) row.unit = 'pcs';
    if (!row.currency) row.currency = 'USD';
    if (!row.priority) row.priority = 'Normal';
    if (!row.status) row.status = 'Needed';
  }
  assertOperationalRecord(entity, row);

  if (cols.has('name') && !row.name) {
    if (entity === 'project') throw new Error('Project name is required');
    if (entity !== 'setting') row.name = input.title ?? input.label ?? `${ENTITY_LABELS[entity] ?? 'Record'}`;
  }

  if (isTemplateEntity(entity) && row.template_id) {
    assertTemplateValues(String(row.template_id), row.custom_json, String(row.status ?? ''));
  }

  const keys = Object.keys(row);
  db.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => row[k]));
  registerRecordOptions(entity, row);
  if (entity === 'entry_template') registerTemplateOptions(row);

  const projectId = row.project_id ?? (entity === 'project' ? id : '');
  if (entity === 'project') {
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [`project.${id}.opened`, ts]);
  } else if (projectId) {
    touchProject(projectId, db);
  }
  if (entity !== 'activity' && entity !== 'setting' && projectId) {
    logActivity(
      {
        project_id: projectId,
        entity_type: entity,
        entity_id: id,
        kind: 'create',
        title: `${ENTITY_LABELS[entity] ?? entity} created`,
        detail: displayName(entity, row),
        at: row.performed_at || row.recorded_at || ts,
      },
      db,
    );
  }
  return getRecord(entity, id);
}

export function updateRecord(entity: string, id: string, patch: Record<string, any>): any {
  const table = tableFor(entity);
  const cols = columnsFor(table);
  const db = getDb();
  const existing = db.get<any>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!existing) throw new Error(`${ENTITY_LABELS[entity] ?? entity} not found`);
  const input = normalizeOperationalInput(entity, patch);
  if (cols.has('name') && input.name !== undefined && !String(input.name ?? '').trim()) {
    throw new Error('Name is required');
  }

  const keys: string[] = [];
  const params: any[] = [];
  const changed: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!cols.has(key) || key === 'id' || key === 'created_at') continue;
    if (key === 'updated_at') continue;
    const next = coerceValue(value);
    if (String(existing[key] ?? '') !== String(next ?? '')) changed.push(key);
    keys.push(key);
    params.push(next);
  }
  if (keys.length === 0) return getRecord(entity, id);
  if (OPERATIONAL_ENTITIES.has(entity)) assertOperationalRecord(entity, { ...existing, ...input });
  if (isTemplateEntity(entity) && (patch.template_id !== undefined || patch.custom_json !== undefined || patch.status !== undefined)) {
    const templateId = String(patch.template_id !== undefined ? patch.template_id || '' : existing.template_id || '');
    const values = patch.custom_json !== undefined ? patch.custom_json : parseCustomValues(existing.custom_json);
    assertTemplateValues(templateId, values, String(patch.status !== undefined ? patch.status : existing.status ?? ''));
  }
  if (cols.has('updated_at')) {
    keys.push('updated_at');
    params.push(nowIso());
  }
  db.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...params, id]);
  registerRecordOptions(entity, { ...existing, ...input });
  if (entity === 'entry_template') registerTemplateOptions({ ...existing, ...input });

  const projectId = existing.project_id ?? (entity === 'project' ? id : '');
  if (projectId) touchProject(projectId, db);
  if (entity !== 'activity' && entity !== 'setting' && projectId) {
    const meaningful = changed.filter((c) => !c.endsWith('_json'));
    logActivity(
      {
        project_id: projectId,
        entity_type: entity,
        entity_id: id,
        kind: 'update',
        title: `${ENTITY_LABELS[entity] ?? entity} updated`,
        detail: changed.length ? `Changed: ${meaningful.slice(0, 12).join(', ')}` : displayName(entity, input),
      },
      db,
    );
  }
  return getRecord(entity, id);
}

export interface RemoveResult {
  removed: boolean;
  cascaded: Record<string, number>;
}

/** Removes a record and its dependent children. Datasets/files are handled by dataset service. */
export function removeRecord(entity: string, id: string): RemoveResult {
  const table = tableFor(entity);
  const db = getDb();
  const existing = db.get<any>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!existing) return { removed: false, cascaded: {} };
  const cascaded: Record<string, number> = {};

  const childDeletes: Record<string, { table: string; column: string }[]> = {
    project: [
      { table: 'rockets', column: 'project_id' },
      { table: 'revisions', column: 'project_id' },
      { table: 'stages', column: 'project_id' },
      { table: 'campaigns', column: 'project_id' },
      { table: 'tests', column: 'project_id' },
      { table: 'flights', column: 'project_id' },
      { table: 'experiments', column: 'project_id' },
      { table: 'runs', column: 'project_id' },
      { table: 'datasets', column: 'project_id' },
      { table: 'channels', column: 'dataset_id IN (SELECT id FROM datasets WHERE project_id = ?)' },
      { table: 'events', column: 'project_id' },
      { table: 'components', column: 'project_id' },
      { table: 'sensors', column: 'project_id' },
      { table: 'calibrations', column: 'project_id' },
      { table: 'config_snapshots', column: 'project_id' },
      { table: 'electronics_configs', column: 'project_id' },
      { table: 'documents', column: 'project_id' },
      { table: 'issues', column: 'project_id' },
      { table: 'notes', column: 'project_id' },
      { table: 'graphs', column: 'project_id' },
      { table: 'workspaces', column: 'project_id' },
      { table: 'comparisons', column: 'project_id' },
      { table: 'entry_templates', column: 'project_id' },
      { table: 'inventory_items', column: 'project_id' },
      { table: 'finance_entries', column: 'project_id' },
      { table: 'shopping_list_items', column: 'project_id' },
      { table: 'reports', column: 'project_id' },
      { table: 'activity', column: 'project_id' },
    ],
    rocket: [{ table: 'revisions', column: 'rocket_id' }],
    revision: [{ table: 'stages', column: 'revision_id' }],
    experiment: [{ table: 'runs', column: 'experiment_id' }],
    dataset: [
      { table: 'channels', column: 'dataset_id' },
      { table: 'events', column: 'dataset_id' },
    ],
    electronics_config: [{ table: 'config_items', column: 'config_id' }],
    sensor: [
      { table: 'calibrations', column: 'sensor_id' },
      { table: 'sensor_installations', column: 'sensor_id' },
    ],
    component: [
      { table: 'component_usage', column: 'component_id' },
      { table: 'config_items', column: 'component_id' },
    ],
    shopping_list_item: [],
  };

  /** References that point at the record without owning it; they are cleared, not deleted. */
  const childNulls: Record<string, { table: string; column: string }[]> = {
    component: [
      { table: 'inventory_items', column: 'component_id' },
      { table: 'shopping_list_items', column: 'component_id' },
    ],
  };

  const children = childDeletes[entity] ?? [];
  db.transaction(() => {
    for (const ref of childNulls[entity] ?? []) {
      if (!columnsFor(ref.table).has(ref.column)) continue;
      db.run(`UPDATE ${ref.table} SET ${ref.column} = '' WHERE ${ref.column} = ?`, [id]);
    }
    for (const child of children) {
      if (child.column.includes('IN (SELECT')) {
        const res = db.run(`DELETE FROM ${child.table} WHERE ${child.column.replace('dataset_id IN', 'dataset_id IN')}`, [id]);
        cascaded[child.table] = Number(res.changes);
      } else {
        const res = db.run(`DELETE FROM ${child.table} WHERE ${child.column} = ?`, [id]);
        cascaded[child.table] = Number(res.changes);
      }
    }
    db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    if (existing.project_id) {
      logActivity(
        {
          project_id: existing.project_id,
          entity_type: entity,
          entity_id: id,
          kind: 'delete',
          title: `${ENTITY_LABELS[entity] ?? entity} deleted`,
          detail: displayName(entity, existing),
        },
        db,
      );
    }
  });
  return { removed: true, cascaded };
}

export function countRows(table: string, where: Record<string, any> = {}): number {
  const cols = columnsFor(table);
  const keys = Object.keys(where).filter((k) => cols.has(k));
  const sql = `SELECT COUNT(*) AS c FROM ${table}${keys.length ? ` WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}` : ''}`;
  return Number(getDb().get<any>(sql, keys.map((k) => where[k]))?.c ?? 0);
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export function dashboard(): any {
  const db = getDb();
  const projects = db.all<any>(`SELECT * FROM projects WHERE archived = 0 ORDER BY updated_at DESC LIMIT 12`);
  const projectIds = projects.map((p) => p.id);

  const projectSummary = projects.map((p) => {
    const counts = db.get<any>(
      `SELECT
        (SELECT COUNT(*) FROM tests WHERE project_id = ?) AS tests,
        (SELECT COUNT(*) FROM flights WHERE project_id = ?) AS flights,
        (SELECT COUNT(*) FROM datasets WHERE project_id = ?) AS datasets,
        (SELECT COUNT(*) FROM issues WHERE project_id = ? AND status NOT IN ('Resolved','Verified','Closed')) AS open_issues,
        (SELECT COUNT(*) FROM revisions WHERE project_id = ?) AS revisions,
        (SELECT COUNT(*) FROM experiments WHERE project_id = ?) AS experiments`,
      [p.id, p.id, p.id, p.id, p.id, p.id],
    );
    const stage = db.get<any>(
      `SELECT name, status FROM stages WHERE project_id = ? AND status != 'Complete' ORDER BY sort_order ASC LIMIT 1`,
      [p.id],
    );
    return { ...p, counts, currentStage: stage?.name ?? null };
  });

  const today = new Date().toISOString().slice(0, 10);
  const upcomingTests = db.all<any>(
    `SELECT t.*, p.name AS project_name FROM tests t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.status IN ('Planned','Ready') ORDER BY COALESCE(NULLIF(t.performed_at,''),'9999') ASC LIMIT 8`,
  );
  const recentGroundTests = db.all<any>(
    `SELECT t.*, p.name AS project_name FROM tests t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.status IN ('Completed','Failed','Aborted') ORDER BY t.performed_at DESC LIMIT 6`,
  );
  const recentFlights = db.all<any>(
    `SELECT f.*, p.name AS project_name FROM flights f LEFT JOIN projects p ON p.id = f.project_id
     ORDER BY NULLIF(f.performed_at,'') DESC, f.created_at DESC LIMIT 6`,
  );
  const recentDatasets = db.all<any>(
    `SELECT d.*, p.name AS project_name FROM datasets d LEFT JOIN projects p ON p.id = d.project_id
     ORDER BY d.created_at DESC LIMIT 8`,
  );
  const openIssues = db.all<any>(
    `SELECT i.*, p.name AS project_name FROM issues i LEFT JOIN projects p ON p.id = i.project_id
     WHERE i.status NOT IN ('Resolved','Verified','Closed','Won''t fix') ORDER BY
       CASE i.severity WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END,
       i.created_at DESC LIMIT 8`,
  );
  const recentActivity = db.all<any>(
    `SELECT a.*, p.name AS project_name FROM activity a LEFT JOIN projects p ON p.id = a.project_id
     ORDER BY a.at DESC LIMIT 14`,
  );
  const latestRevisions = db.all<any>(
    `SELECT r.*, p.name AS project_name FROM revisions r LEFT JOIN projects p ON p.id = r.project_id
     ORDER BY r.created_at DESC LIMIT 6`,
  );
  const milestones = db.all<any>(
    `SELECT s.*, p.name AS project_name FROM stages s LEFT JOIN projects p ON p.id = s.project_id
     WHERE s.completed_at != '' ORDER BY s.completed_at DESC LIMIT 6`,
  );
  const recentMeasurements = db.all<any>(
    `SELECT c.name, c.type, c.unit, c.min, c.max, c.points, d.name AS dataset_name, d.created_at, d.id AS dataset_id
     FROM channels c JOIN datasets d ON d.id = c.dataset_id
     ORDER BY d.created_at DESC LIMIT 30`,
  );

  const totals = db.get<any>(
    `SELECT (SELECT COUNT(*) FROM projects WHERE archived = 0) AS projects,
            (SELECT COUNT(*) FROM tests) AS tests,
            (SELECT COUNT(*) FROM flights) AS flights,
            (SELECT COUNT(*) FROM datasets) AS datasets,
            (SELECT COUNT(*) FROM channels) AS channels,
            (SELECT COUNT(*) FROM issues WHERE status NOT IN ('Resolved','Verified','Closed')) AS issues`,
  );

  return {
    projects: projectSummary,
    totals,
    upcomingTests,
    recentGroundTests,
    recentFlights,
    recentDatasets,
    openIssues,
    recentActivity,
    latestRevisions,
    milestones,
    recentMeasurements,
    today,
    projectIds,
  };
}

/* ------------------------------------------------------------------ */
/* Global search                                                       */
/* ------------------------------------------------------------------ */

export interface SearchHit {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  project_id: string;
  project_name: string;
  at: string;
  route: string;
}

export function searchGlobal(term: string, projectId?: string): SearchHit[] {
  const db = getDb();
  const q = (term ?? '').trim();
  if (q.length < 1) return [];
  const like = `%${q}%`;
  const hits: SearchHit[] = [];

  const scoped = (projectId ? ' AND project_id = ?' : '');
  const scopedRevisions = (projectId ? ' AND r.project_id = ?' : '');
  const p = projectId ? [projectId] : [];

  const push = (type: string, row: any, title: string, subtitle: string, route: string, projectName = '') => {
    hits.push({
      type,
      id: row.id,
      title,
      subtitle,
      project_id: row.project_id ?? (type === 'project' ? row.id : ''),
      project_name: projectName || row.project_name || '',
      at: row.performed_at || row.recorded_at || row.occurred_on || row.updated_at || row.created_at || '',
      route,
    });
  };

  db.all<any>(`SELECT * FROM projects WHERE (name LIKE ? OR code LIKE ? OR description LIKE ? OR objectives LIKE ? OR tags LIKE ?) ORDER BY updated_at DESC LIMIT 40`, [
    like, like, like, like, like,
  ]).forEach((r) => push('project', r, r.name, r.code || 'Project', `#/project/${r.id}`, r.name));

  db.all<any>(`SELECT r.*, p.name AS project_name FROM rockets r LEFT JOIN projects p ON p.id = r.project_id WHERE (r.name LIKE ? OR r.identifier LIKE ? OR r.description LIKE ?)${projectId ? ' AND r.project_id = ?' : ''} LIMIT 30`, [like, like, like, ...p]).forEach(
    (r) => push('rocket', r, r.name, r.identifier || 'Rocket', `#/development?rocket=${r.id}`, r.project_name),
  );

  db.all<any>(`SELECT r.*, p.name AS project_name FROM revisions r LEFT JOIN projects p ON p.id = r.project_id WHERE (r.label LIKE ? OR r.description LIKE ?)${scopedRevisions} LIMIT 30`, [like, like, ...p]).forEach(
    (r) => push('revision', r, r.label, 'Revision', `#/revision/${r.id}`, r.project_name),
  );

  db.all<any>(`SELECT t.*, p.name AS project_name FROM tests t LEFT JOIN projects p ON p.id = t.project_id WHERE (t.name LIKE ? OR t.test_no LIKE ? OR t.objectives LIKE ? OR t.observations LIKE ? OR t.custom_json LIKE ?)${scoped.replace('project_id', 't.project_id')} LIMIT 40`, [like, like, like, like, like, ...p]).forEach(
    (r) => push('test', r, r.name, r.test_no || r.category || 'Ground test', `#/ground/${r.id}`, r.project_name),
  );

  db.all<any>(`SELECT f.*, p.name AS project_name FROM flights f LEFT JOIN projects p ON p.id = f.project_id WHERE (f.name LIKE ? OR f.flight_no LIKE ? OR f.objectives LIKE ? OR f.observations LIKE ? OR f.custom_json LIKE ?)${scoped.replace('project_id', 'f.project_id')} LIMIT 40`, [like, like, like, like, like, ...p]).forEach(
    (r) => push('flight', r, r.name, r.flight_no || 'Flight', `#/flights/${r.id}`, r.project_name),
  );

  db.all<any>(`SELECT e.*, p.name AS project_name FROM experiments e LEFT JOIN projects p ON p.id = e.project_id WHERE (e.name LIKE ? OR e.objective LIKE ?)${scoped.replace('project_id', 'e.project_id')} LIMIT 30`, [like, like, ...p]).forEach(
    (r) => push('experiment', r, r.name, 'Experiment', `#/experiments/${r.id}`, r.project_name),
  );

  db.all<any>(`SELECT d.*, p.name AS project_name FROM datasets d LEFT JOIN projects p ON p.id = d.project_id WHERE (d.name LIKE ? OR d.notes LIKE ?)${scoped.replace('project_id', 'd.project_id')} LIMIT 40`, [like, like, ...p]).forEach(
    (r) => push('dataset', r, r.name, `${r.points} pts`, `#/analysis?dataset=${r.id}`, r.project_name),
  );

  db.all<any>(
    `SELECT c.*, d.name AS dataset_name, d.project_id, p.name AS project_name FROM channels c
     JOIN datasets d ON d.id = c.dataset_id LEFT JOIN projects p ON p.id = d.project_id
     WHERE (c.name LIKE ? OR c.type LIKE ?)${projectId ? ' AND d.project_id = ?' : ''} LIMIT 30`,
    [like, like, ...p],
  ).forEach((r) => push('channel', r, r.name, `Channel in ${r.dataset_name}`, `#/analysis?dataset=${r.dataset_id}`, r.project_name));

  db.all<any>(`SELECT c.*, p.name AS project_name FROM components c LEFT JOIN projects p ON p.id = c.project_id WHERE (c.name LIKE ? OR c.model LIKE ? OR c.serial LIKE ?)${scoped.replace('project_id', 'c.project_id')} LIMIT 30`, [like, like, like, ...p]).forEach(
    (r) => push('component', r, r.name, r.model || r.category, `#/components?component=${r.id}`, r.project_name),
  );

  db.all<any>(`SELECT s.*, p.name AS project_name FROM sensors s LEFT JOIN projects p ON p.id = s.project_id WHERE (s.name LIKE ? OR s.model LIKE ? OR s.serial LIKE ?)${scoped.replace('project_id', 's.project_id')} LIMIT 30`, [like, like, like, ...p]).forEach(
    (r) => push('sensor', r, r.name, r.type, `#/sensors?sensor=${r.id}`, r.project_name),
  );

  db.all<any>(`SELECT d.*, p.name AS project_name FROM documents d LEFT JOIN projects p ON p.id = d.project_id WHERE (d.title LIKE ? OR d.description LIKE ? OR d.tags LIKE ? OR d.original_name LIKE ?)${scoped.replace('project_id', 'd.project_id')} LIMIT 30`, [like, like, like, like, ...p]).forEach(
    (r) => push('document', r, r.title, r.kind, `#/documents?doc=${r.id}`, r.project_name),
  );

  db.all<any>(`SELECT i.*, p.name AS project_name FROM issues i LEFT JOIN projects p ON p.id = i.project_id WHERE (i.title LIKE ? OR i.description LIKE ? OR i.investigation LIKE ?)${scoped.replace('project_id', 'i.project_id')} LIMIT 30`, [like, like, like, ...p]).forEach(
    (r) => push('issue', r, r.title, `${r.severity} · ${r.status}`, `#/issues?issue=${r.id}`, r.project_name),
  );

  db.all<any>(`SELECT n.*, p.name AS project_name FROM notes n LEFT JOIN projects p ON p.id = n.project_id WHERE (n.title LIKE ? OR n.body LIKE ?)${scoped.replace('project_id', 'n.project_id')} LIMIT 30`, [like, like, ...p]).forEach(
    (r) => push('note', r, r.title, 'Engineering note', `#/development?note=${r.id}`, r.project_name),
  );

  db.all<any>(`SELECT r.*, p.name AS project_name FROM reports r LEFT JOIN projects p ON p.id = r.project_id WHERE r.title LIKE ?${scoped.replace('project_id', 'r.project_id')} LIMIT 20`, [like, ...p]).forEach(
    (r) => push('report', r, r.title, 'Report', `#/reports?report=${r.id}`, r.project_name),
  );

  db.all<any>(`SELECT * FROM entry_templates WHERE (name LIKE ? OR description LIKE ? OR category LIKE ?) ORDER BY updated_at DESC LIMIT 20`, [like, like, like]).forEach(
    (r) => push('entry_template', r, r.name, `Entry template · ${r.applies_to}`, `#/templates?template=${r.id}`, ''),
  );

  db.all<any>(
    `SELECT i.*, p.name AS project_name FROM inventory_items i LEFT JOIN projects p ON p.id = i.project_id
     WHERE (i.name LIKE ? OR i.sku LIKE ? OR i.supplier LIKE ? OR i.location LIKE ? OR i.notes LIKE ?)${projectId ? ' AND i.project_id = ?' : ''}
     ORDER BY i.updated_at DESC LIMIT 30`,
    [like, like, like, like, like, ...p],
  ).forEach((r) =>
    push('inventory_item', r, r.name, `${r.quantity} ${r.unit || 'pcs'} · inventory`, `#/inventory?item=${r.id}`, r.project_name),
  );

  db.all<any>(
    `SELECT f.*, p.name AS project_name FROM finance_entries f LEFT JOIN projects p ON p.id = f.project_id
     WHERE (f.description LIKE ? OR f.counterparty LIKE ? OR f.reference LIKE ? OR f.category LIKE ? OR f.notes LIKE ?)${projectId ? ' AND f.project_id = ?' : ''}
     ORDER BY f.occurred_on DESC LIMIT 30`,
    [like, like, like, like, like, ...p],
  ).forEach((r) =>
    push(
      'finance_entry',
      r,
      r.description,
      `${r.kind === 'income' ? 'Income' : 'Expenditure'} · ${r.currency} ${Number(r.amount).toFixed(2)}`,
      `#/finance?entry=${r.id}`,
      r.project_name,
    ),
  );

  const seen = new Set<string>();
  return hits
    .filter((h) => {
      const key = `${h.type}:${h.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/* ------------------------------------------------------------------ */
/* Project overview and relationship graph                             */
/* ------------------------------------------------------------------ */

export function projectOverview(projectId: string): any {
  const db = getDb();
  const project = db.get<any>('SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!project) throw new Error('Project not found');

  const rockets = db.all<any>('SELECT * FROM rockets WHERE project_id = ? ORDER BY created_at', [projectId]);
  const revisions = db.all<any>('SELECT * FROM revisions WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
  const stages = db.all<any>('SELECT * FROM stages WHERE project_id = ? ORDER BY sort_order', [projectId]);
  const campaigns = db.all<any>('SELECT * FROM campaigns WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
  const tests = db.all<any>('SELECT * FROM tests WHERE project_id = ? ORDER BY COALESCE(NULLIF(performed_at,\'\'),\'0\') DESC LIMIT 100', [projectId]);
  const flights = db.all<any>('SELECT * FROM flights WHERE project_id = ? ORDER BY COALESCE(NULLIF(performed_at,\'\'),\'0\') DESC LIMIT 100', [projectId]);
  const experiments = db.all<any>('SELECT * FROM experiments WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
  const datasets = db.all<any>('SELECT * FROM datasets WHERE project_id = ? ORDER BY created_at DESC LIMIT 100', [projectId]);
  const issues = db.all<any>('SELECT * FROM issues WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
  const activity = db.all<any>('SELECT * FROM activity WHERE project_id = ? ORDER BY at DESC LIMIT 40', [projectId]);
  const documents = db.all<any>('SELECT * FROM documents WHERE project_id = ? ORDER BY created_at DESC LIMIT 50', [projectId]);
  const notes = db.all<any>('SELECT * FROM notes WHERE project_id = ? ORDER BY created_at DESC LIMIT 50', [projectId]);
  const components = db.all<any>('SELECT * FROM components WHERE project_id = ? ORDER BY category, name', [projectId]);
  const sensors = db.all<any>('SELECT * FROM sensors WHERE project_id = ? ORDER BY name', [projectId]);
  const reports = db.all<any>('SELECT * FROM reports WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
  const configs = db.all<any>('SELECT * FROM electronics_configs WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
  const inventory = db.all<any>('SELECT * FROM inventory_items WHERE project_id = ? ORDER BY category, name', [projectId]);
  const finance = db.all<any>('SELECT * FROM finance_entries WHERE project_id = ? ORDER BY occurred_on DESC, created_at DESC', [projectId]);

  return {
    project: expandOne(project),
    rockets,
    revisions,
    stages,
    campaigns,
    tests,
    flights,
    experiments,
    datasets,
    issues,
    activity,
    documents,
    notes,
    components,
    sensors,
    reports,
    configs,
    inventory,
    finance,
    counts: {
      rockets: rockets.length,
      revisions: revisions.length,
      tests: tests.length,
      flights: flights.length,
      experiments: experiments.length,
      datasets: datasets.length,
      openIssues: issues.filter((i) => !['Resolved', 'Verified', 'Closed', "Won't fix"].includes(i.status)).length,
      components: components.length,
      sensors: sensors.length,
      documents: documents.length,
      reports: reports.length,
      inventoryItems: inventory.length,
      financeEntries: finance.length,
    },
  };
}

/** Everything directly attached to a record — powers linked-record navigation. */
export function linkedRecords(entityType: string, entityId: string): any {
  const db = getDb();
  const out: any = { documents: [], notes: [], issues: [], datasets: [], events: [], activity: [] };
  const id = entityId;
  const projectId =
    entityType === 'project'
      ? id
      : db.get<any>(`SELECT project_id FROM ${tableFor(entityType)} WHERE id = ?`, [id])?.project_id ?? '';

  out.documents = db.all<any>('SELECT * FROM documents WHERE entity_type = ? AND entity_id = ?', [entityType, id]);
  out.notes = db.all<any>('SELECT * FROM notes WHERE entity_type = ? AND entity_id = ?', [entityType, id]);
  const issueClauses: string[] = [];
  const issueParams: any[] = [];
  const issueField: Record<string, string> = { revision: 'revision_id', test: 'test_id', flight: 'flight_id', dataset: 'dataset_id' };
  if (issueField[entityType]) {
    issueClauses.push(`${issueField[entityType]} = ?`);
    issueParams.push(id);
  }
  if (entityType === 'project') {
    issueClauses.push('project_id = ?');
    issueParams.push(id);
  }
  if (issueClauses.length) out.issues = db.all<any>(`SELECT * FROM issues WHERE ${issueClauses.join(' OR ')}`, issueParams);

  if (entityType === 'test') out.datasets = db.all<any>('SELECT * FROM datasets WHERE test_id = ?', [id]);
  if (entityType === 'flight') out.datasets = db.all<any>('SELECT * FROM datasets WHERE flight_id = ?', [id]);
  if (entityType === 'run') out.datasets = db.all<any>('SELECT * FROM datasets WHERE run_id = ?', [id]);
  if (entityType === 'project') out.datasets = db.all<any>('SELECT * FROM datasets WHERE project_id = ? ORDER BY created_at DESC', [id]);
  if (out.datasets.length) {
    out.events = db.all<any>(
      `SELECT * FROM events WHERE dataset_id IN (${out.datasets.map(() => '?').join(',')}) ORDER BY t`,
      out.datasets.map((d: any) => d.id),
    );
  }
  out.activity = projectId
    ? db.all<any>('SELECT * FROM activity WHERE project_id = ? ORDER BY at DESC LIMIT 50', [projectId])
    : [];

  if (entityType === 'dataset') {
    const dataset = db.get<any>('SELECT * FROM datasets WHERE id = ?', [id]);
    out.dataset = expandOne(dataset);
    if (dataset?.source_dataset_id) out.sourceDataset = expandOne(db.get<any>('SELECT * FROM datasets WHERE id = ?', [dataset.source_dataset_id]));
    out.derived = db.all<any>('SELECT * FROM datasets WHERE source_dataset_id = ?', [id]);
    out.channels = db.all<any>('SELECT * FROM channels WHERE dataset_id = ?', [id]);
  }
  return out;
}
