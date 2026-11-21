import { getDb } from './db';
import { expand, expandOne } from './repo';
import { ENTITY_LABELS } from '../shared/constants';

/* ------------------------------------------------------------------ */
/* Unified data log                                                    */
/* ------------------------------------------------------------------ */

export type LogType =
  | 'project'
  | 'revision'
  | 'stage'
  | 'campaign'
  | 'test'
  | 'flight'
  | 'experiment'
  | 'run'
  | 'dataset'
  | 'event'
  | 'issue'
  | 'calibration'
  | 'document'
  | 'note'
  | 'component'
  | 'sensor'
  | 'config'
  | 'report'
  | 'activity';

export interface LogEntry {
  id: string;
  at: string;
  type: LogType;
  title: string;
  subtitle: string;
  detail: string;
  status: string;
  tags: string;
  project_id: string;
  project_name: string;
  entity_type: string;
  entity_id: string;
  route: string;
  meta: Record<string, any>;
}

export interface LogFilter {
  projectId?: string;
  types?: LogType[];
  from?: string;
  to?: string;
  q?: string;
  tags?: string;
  status?: string;
  testCategory?: string;
  limit?: number;
  offset?: number;
  sort?: 'desc' | 'asc';
}

function matches(entry: LogEntry, f: LogFilter): boolean {
  if (f.projectId && entry.project_id !== f.projectId) return false;
  if (f.types?.length && !f.types.includes(entry.type)) return false;
  if (f.status && entry.status !== f.status) return false;
  if (f.testCategory && entry.meta.category !== f.testCategory) return false;
  if (f.from && entry.at && entry.at < f.from) return false;
  if (f.to && entry.at && entry.at > `${f.to}T23:59:59.999Z` && entry.at > f.to) return false;
  if (f.tags) {
    const want = f.tags.toLowerCase();
    if (!String(entry.tags ?? '').toLowerCase().includes(want)) return false;
  }
  if (f.q) {
    const term = f.q.toLowerCase();
    const haystack = `${entry.title} ${entry.subtitle} ${entry.detail} ${entry.tags} ${entry.project_name} ${entry.status}`.toLowerCase();
    if (!haystack.includes(term)) return false;
  }
  return true;
}

export function dataLog(filter: LogFilter = {}): { entries: LogEntry[]; total: number; counts: Record<string, number> } {
  const db = getDb();
  const projectWhere = filter.projectId ? 'WHERE project_id = ?' : '';
  const pp = filter.projectId ? [filter.projectId] : [];
  const projects = db.all<any>('SELECT id, name FROM projects');
  const projectNames = new Map(projects.map((p) => [p.id, p.name as string]));

  const entries: LogEntry[] = [];
  const add = (e: Partial<LogEntry> & { id: string; at: string; type: LogType; title: string; project_id: string }) => {
    entries.push({
      subtitle: '',
      detail: '',
      status: '',
      tags: '',
      entity_type: e.type,
      entity_id: e.id,
      route: '',
      meta: {},
      project_name: projectNames.get(e.project_id) ?? '',
      ...e,
    } as LogEntry);
  };

  db.all<any>(`SELECT * FROM tests ${projectWhere} ORDER BY created_at DESC LIMIT 4000`, pp).forEach((t) =>
    add({
      id: t.id,
      at: t.performed_at || t.created_at,
      type: 'test',
      title: t.name,
      subtitle: `${t.test_no ? `${t.test_no} · ` : ''}${t.category}`,
      detail: t.objectives || t.observations,
      status: t.status,
      tags: t.kind === 'experimental' ? 'experimental' : 'ground',
      project_id: t.project_id,
      route: `#/ground/${t.id}`,
      meta: { category: t.category, kind: t.kind, revision_id: t.revision_id },
    }),
  );

  db.all<any>(`SELECT * FROM flights ${projectWhere} ORDER BY created_at DESC LIMIT 2000`, pp).forEach((f) =>
    add({
      id: f.id,
      at: f.performed_at || f.created_at,
      type: 'flight',
      title: f.name,
      subtitle: f.flight_no ? `Flight ${f.flight_no}` : 'Flight',
      detail: f.objectives || f.observations,
      status: f.status,
      tags: 'flight',
      project_id: f.project_id,
      route: `#/flights/${f.id}`,
      meta: { revision_id: f.revision_id },
    }),
  );

  db.all<any>(`SELECT * FROM datasets ${projectWhere} ORDER BY created_at DESC LIMIT 4000`, pp).forEach((d) =>
    add({
      id: d.id,
      at: d.recorded_at || d.created_at,
      type: 'dataset',
      title: d.name,
      subtitle: `${d.kind === 'processed' ? 'Processed dataset' : 'Recorded dataset'} · ${d.points} points · ${d.channels_count} channels`,
      detail: d.notes,
      status: d.quality_status || '',
      tags: `${d.kind} dataset`,
      project_id: d.project_id,
      route: `#/analysis?dataset=${d.id}`,
      meta: { dataset_id: d.id, test_id: d.test_id, flight_id: d.flight_id, run_id: d.run_id },
    }),
  );

  db.all<any>(`SELECT * FROM revisions ${projectWhere} ORDER BY created_at DESC LIMIT 2000`, pp).forEach((r) =>
    add({
      id: r.id,
      at: r.created_at,
      type: 'revision',
      title: r.label,
      subtitle: 'Design revision',
      detail: r.description || r.design_changes,
      status: r.status,
      tags: 'revision',
      project_id: r.project_id,
      route: `#/revision/${r.id}`,
      meta: { rocket_id: r.rocket_id },
    }),
  );

  db.all<any>(`SELECT * FROM issues ${projectWhere} ORDER BY created_at DESC LIMIT 2000`, pp).forEach((i) =>
    add({
      id: i.id,
      at: i.identified_at || i.created_at,
      type: 'issue',
      title: i.title,
      subtitle: `${i.severity} · ${i.status}`,
      detail: i.description || i.investigation,
      status: i.status,
      tags: `${i.category} ${i.severity}`,
      project_id: i.project_id,
      route: `#/issues?issue=${i.id}`,
      meta: { severity: i.severity, revision_id: i.revision_id },
    }),
  );

  db.all<any>(
    `SELECT c.*, s.name AS sensor_name FROM calibrations c LEFT JOIN sensors s ON s.id = c.sensor_id ${projectWhere ? 'WHERE c.project_id = ?' : ''} ORDER BY c.created_at DESC LIMIT 1000`,
    pp,
  ).forEach((c) =>
    add({
      id: c.id,
      at: c.performed_at || c.created_at,
      type: 'calibration',
      title: `Calibration · ${c.sensor_name ?? 'Sensor'}`,
      subtitle: c.method,
      detail: c.notes,
      status: 'Recorded',
      tags: 'calibration',
      project_id: c.project_id,
      route: `#/sensors?sensor=${c.sensor_id}`,
      meta: { sensor_id: c.sensor_id },
    }),
  );

  db.all<any>(`SELECT * FROM documents ${projectWhere} ORDER BY created_at DESC LIMIT 2000`, pp).forEach((d) =>
    add({
      id: d.id,
      at: d.created_at,
      type: 'document',
      title: d.title,
      subtitle: `${d.kind} · ${d.original_name}`,
      detail: d.description,
      status: 'Stored',
      tags: d.tags,
      project_id: d.project_id,
      route: `#/documents?doc=${d.id}`,
      meta: { entity_type: d.entity_type, entity_id: d.entity_id },
    }),
  );

  db.all<any>(`SELECT * FROM notes ${projectWhere} ORDER BY created_at DESC LIMIT 1000`, pp).forEach((n) =>
    add({
      id: n.id,
      at: n.created_at,
      type: 'note',
      title: n.title,
      subtitle: 'Engineering note',
      detail: n.body,
      status: 'Note',
      tags: n.tags,
      project_id: n.project_id,
      route: `#/development?note=${n.id}`,
      meta: {},
    }),
  );

  db.all<any>(`SELECT * FROM stages ${projectWhere} ORDER BY created_at DESC LIMIT 1000`, pp).forEach((s) =>
    add({
      id: s.id,
      at: s.completed_at || s.started_at || s.created_at,
      type: 'stage',
      title: s.name,
      subtitle: `Development stage · ${s.status}`,
      detail: s.description,
      status: s.status,
      tags: 'development',
      project_id: s.project_id,
      route: `#/development?stage=${s.id}`,
      meta: {},
    }),
  );

  db.all<any>(`SELECT * FROM campaigns ${projectWhere} ORDER BY created_at DESC LIMIT 500`, pp).forEach((c) =>
    add({
      id: c.id,
      at: c.started_at || c.created_at,
      type: 'campaign',
      title: c.name,
      subtitle: `${c.kind} testing campaign`,
      detail: c.objectives,
      status: c.status,
      tags: 'campaign',
      project_id: c.project_id,
      route: `#/ground?campaign=${c.id}`,
      meta: {},
    }),
  );

  db.all<any>(`SELECT * FROM experiments ${projectWhere} ORDER BY created_at DESC LIMIT 500`, pp).forEach((e) =>
    add({
      id: e.id,
      at: e.created_at,
      type: 'experiment',
      title: e.name,
      subtitle: 'Experiment',
      detail: e.objective,
      status: e.status,
      tags: 'experiment',
      project_id: e.project_id,
      route: `#/experiments/${e.id}`,
      meta: {},
    }),
  );

  db.all<any>(`SELECT * FROM components ${projectWhere} ORDER BY created_at DESC LIMIT 500`, pp).forEach((c) =>
    add({
      id: c.id,
      at: c.created_at,
      type: 'component',
      title: c.name,
      subtitle: `${c.category}${c.model ? ` · ${c.model}` : ''}`,
      detail: c.notes,
      status: 'In inventory',
      tags: c.category,
      project_id: c.project_id,
      route: `#/components?component=${c.id}`,
      meta: {},
    }),
  );

  db.all<any>(`SELECT * FROM sensors ${projectWhere} ORDER BY created_at DESC LIMIT 500`, pp).forEach((s) =>
    add({
      id: s.id,
      at: s.created_at,
      type: 'sensor',
      title: s.name,
      subtitle: s.type,
      detail: s.notes,
      status: 'Registered',
      tags: s.type,
      project_id: s.project_id,
      route: `#/sensors?sensor=${s.id}`,
      meta: {},
    }),
  );

  db.all<any>(`SELECT * FROM config_snapshots ${projectWhere} ORDER BY created_at DESC LIMIT 500`, pp).forEach((c) =>
    add({
      id: c.id,
      at: c.created_at,
      type: 'config',
      title: c.name,
      subtitle: `${c.kind}${c.version ? ` · ${c.version}` : ''}`,
      detail: c.description,
      status: c.checksum ? 'Checksummed' : 'Recorded',
      tags: c.kind,
      project_id: c.project_id,
      route: `#/components?snapshot=${c.id}`,
      meta: {},
    }),
  );

  db.all<any>(`SELECT * FROM events ${projectWhere} ORDER BY t DESC LIMIT 2000`, pp).forEach((e) =>
    add({
      id: e.id,
      at: e.created_at,
      type: 'event',
      title: e.name,
      subtitle: `${e.category} · t = ${e.t.toFixed(3)} s`,
      detail: e.description,
      status: e.confirmed ? 'Confirmed' : 'Suggested',
      tags: e.tags,
      project_id: e.project_id,
      route: `#/analysis?dataset=${e.dataset_id}`,
      meta: { dataset_id: e.dataset_id, t: e.t, channel_key: e.channel_key },
    }),
  );

  db.all<any>(`SELECT * FROM reports ${projectWhere} ORDER BY created_at DESC LIMIT 500`, pp).forEach((r) =>
    add({
      id: r.id,
      at: r.created_at,
      type: 'report',
      title: r.title,
      subtitle: `${r.kind} report`,
      detail: '',
      status: 'Generated',
      tags: 'report',
      project_id: r.project_id,
      route: `#/reports?report=${r.id}`,
      meta: {},
    }),
  );

  db.all<any>(
    `SELECT * FROM activity ${projectWhere} ORDER BY at DESC LIMIT 3000`,
    pp,
  ).forEach((a) => {
    if (a.kind === 'create') return; // the originating record is already in the log
    add({
      id: a.id,
      at: a.at,
      type: 'activity',
      title: a.title,
      subtitle: ENTITY_LABELS[a.entity_type] ?? a.entity_type,
      detail: a.detail,
      status: a.kind,
      tags: 'change',
      project_id: a.project_id,
      entity_type: a.entity_type,
      entity_id: a.entity_id,
      route: routeForEntity(a.entity_type, a.entity_id),
      meta: { kind: a.kind },
    });
  });

  const filtered = entries.filter((e) => matches(e, filter));
  const sortDir = filter.sort === 'asc' ? 1 : -1;
  filtered.sort((a, b) => sortDir * String(a.at).localeCompare(String(b.at)));
  const counts: Record<string, number> = {};
  for (const e of filtered) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = Math.min(2000, Math.max(1, filter.limit ?? 400));
  return { entries: filtered.slice(offset, offset + limit), total: filtered.length, counts };
}

export function routeForEntity(entityType: string, entityId: string): string {
  switch (entityType) {
    case 'project':
      return `#/project/${entityId}`;
    case 'test':
      return `#/ground/${entityId}`;
    case 'flight':
      return `#/flights/${entityId}`;
    case 'experiment':
      return `#/experiments/${entityId}`;
    case 'revision':
      return `#/revision/${entityId}`;
    case 'dataset':
      return `#/analysis?dataset=${entityId}`;
    case 'issue':
      return `#/issues?issue=${entityId}`;
    case 'document':
      return `#/documents?doc=${entityId}`;
    case 'sensor':
      return `#/sensors?sensor=${entityId}`;
    case 'component':
      return `#/components?component=${entityId}`;
    case 'stage':
      return `#/development?stage=${entityId}`;
    case 'report':
      return `#/reports?report=${entityId}`;
    default:
      return '#/datalog';
  }
}

/** Measurement history: every channel across a project with summary statistics. */
export function measurementHistory(projectId?: string, q?: string): any[] {
  const db = getDb();
  const rows = db.all<any>(
    `SELECT c.*, d.name AS dataset_name, d.recorded_at, d.id AS dataset_id, d.points AS dataset_points,
            d.project_id, p.name AS project_name, t.name AS test_name, f.name AS flight_name
     FROM channels c
     JOIN datasets d ON d.id = c.dataset_id
     LEFT JOIN projects p ON p.id = d.project_id
     LEFT JOIN tests t ON t.id = d.test_id
     LEFT JOIN flights f ON f.id = d.flight_id
     ${projectId ? 'WHERE d.project_id = ?' : ''}
     ORDER BY d.recorded_at DESC`,
    projectId ? [projectId] : [],
  );
  const filtered = q
    ? rows.filter((r) => `${r.name} ${r.type} ${r.unit} ${r.dataset_name}`.toLowerCase().includes(q.toLowerCase()))
    : rows;
  const groups = new Map<string, any>();
  for (const r of filtered) {
    const key = `${r.name.toLowerCase()}|${r.unit}|${r.project_id}`;
    const stat = safeParse(r.stats_json, {});
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name: r.name,
        type: r.type,
        unit: r.unit,
        project_id: r.project_id,
        project_name: r.project_name,
        occurrences: 0,
        min: Infinity,
        max: -Infinity,
        lastRecorded: r.recorded_at,
        samples: [],
      });
    }
    const g = groups.get(key);
    g.occurrences++;
    if (Number.isFinite(stat.min)) g.min = Math.min(g.min, stat.min);
    if (Number.isFinite(stat.max)) g.max = Math.max(g.max, stat.max);
    if (g.samples.length < 12) {
      g.samples.push({
        dataset_id: r.dataset_id,
        dataset_name: r.dataset_name,
        test_name: r.test_name,
        flight_name: r.flight_name,
        recorded_at: r.recorded_at,
        mean: stat.mean,
        min: stat.min,
        max: stat.max,
        points: r.points,
      });
    }
  }
  return Array.from(groups.values()).map((g) => ({
    ...g,
    min: Number.isFinite(g.min) ? g.min : null,
    max: Number.isFinite(g.max) ? g.max : null,
  }));
}

function safeParse(text: string, fallback: any): any {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Revision comparison                                                 */
/* ------------------------------------------------------------------ */

const REVISION_FIELDS = ['label', 'status', 'description', 'design_changes', 'component_changes', 'config_changes', 'observations', 'conclusions'];

export function revisionCompare(aId: string, bId: string): any {
  const db = getDb();
  const a = db.get<any>('SELECT * FROM revisions WHERE id = ?', [aId]);
  const b = db.get<any>('SELECT * FROM revisions WHERE id = ?', [bId]);
  if (!a || !b) throw new Error('Both revisions must exist');

  const changedFields = REVISION_FIELDS.map((field) => ({
    field,
    label: field.replace(/_/g, ' '),
    a: a[field] ?? '',
    b: b[field] ?? '',
    changed: String(a[field] ?? '') !== String(b[field] ?? ''),
  }));

  const collect = (revisionId: string) => ({
    tests: db.all<any>('SELECT * FROM tests WHERE revision_id = ? ORDER BY performed_at', [revisionId]),
    flights: db.all<any>('SELECT * FROM flights WHERE revision_id = ? ORDER BY performed_at', [revisionId]),
    issues: db.all<any>('SELECT * FROM issues WHERE revision_id = ? ORDER BY created_at', [revisionId]),
    stages: db.all<any>('SELECT * FROM stages WHERE revision_id = ? ORDER BY sort_order', [revisionId]),
    configs: db.all<any>('SELECT * FROM electronics_configs WHERE revision_id = ?', [revisionId]),
    snapshots: db.all<any>('SELECT * FROM config_snapshots WHERE project_id = ? ORDER BY created_at', [a.project_id]),
  });

  const A = collect(aId);
  const B = collect(bId);

  const datasetIdsFor = (revisionId: string) =>
    db.all<any>(
      `SELECT DISTINCT d.* FROM datasets d
       LEFT JOIN tests t ON t.id = d.test_id
       LEFT JOIN flights f ON f.id = d.flight_id
       WHERE t.revision_id = ? OR f.revision_id = ? ORDER BY d.recorded_at`,
      [revisionId, revisionId],
    );
  const datasetsA = datasetIdsFor(aId);
  const datasetsB = datasetIdsFor(bId);

  // Channel-level deltas where the same measurement exists on both sides.
  const channelRows = (datasetIds: string[]) => {
    if (datasetIds.length === 0) return [];
    return db.all<any>(
      `SELECT c.*, d.name AS dataset_name FROM channels c JOIN datasets d ON d.id = c.dataset_id
       WHERE c.dataset_id IN (${datasetIds.map(() => '?').join(',')})`,
      datasetIds,
    );
  };
  const chA = channelRows(datasetsA.map((d) => d.id));
  const chB = channelRows(datasetsB.map((d) => d.id));

  const metricDeltas: any[] = [];
  const byName = new Map<string, any>();
  for (const c of chA) {
    const key = `${c.name.toLowerCase()}|${c.unit}`;
    if (!byName.has(key)) byName.set(key, { name: c.name, unit: c.unit, type: c.type, a: [], b: [] });
    byName.get(key).a.push(c);
  }
  for (const c of chB) {
    const key = `${c.name.toLowerCase()}|${c.unit}`;
    if (byName.has(key)) byName.get(key).b.push(c);
  }
  for (const entry of byName.values()) {
    if (!entry.a.length || !entry.b.length) continue;
    const statA = entry.a.map((c: any) => safeParse(c.stats_json, {}));
    const statB = entry.b.map((c: any) => safeParse(c.stats_json, {}));
    const mean = (arr: any[], key: string) => {
      const vals = arr.map((s) => s[key]).filter((v) => Number.isFinite(v));
      return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
    };
    metricDeltas.push({
      name: entry.name,
      unit: entry.unit,
      a: { mean: mean(statA, 'mean'), meanPeak: mean(statA, 'max'), datasets: entry.a.length },
      b: { mean: mean(statB, 'mean'), meanPeak: mean(statB, 'max'), datasets: entry.b.length },
      deltaMean: mean(statA, 'mean') !== null && mean(statB, 'mean') !== null ? mean(statB, 'mean')! - mean(statA, 'mean')! : null,
      deltaPeak: mean(statA, 'max') !== null && mean(statB, 'max') !== null ? mean(statB, 'max')! - mean(statA, 'max')! : null,
    });
  }

  return {
    a: expandOne(a),
    b: expandOne(b),
    changedFields,
    records: { a: A, b: B, datasetsA, datasetsB },
    metricDeltas,
    caveats: [
      'Revision differences are assembled from recorded metadata and measurements; a difference is not proof that a specific design change caused an observed effect.',
      'Metric deltas average the stored channel statistics per revision and only compare channels with identical names and units.',
      'Test conditions, hardware configuration and environment must be reviewed before drawing conclusions.',
    ],
  };
}

export function configCompare(aId: string, bId: string): any {
  const db = getDb();
  const a = db.get<any>('SELECT * FROM config_snapshots WHERE id = ?', [aId]) ?? db.get<any>('SELECT * FROM electronics_configs WHERE id = ?', [aId]);
  const b = db.get<any>('SELECT * FROM config_snapshots WHERE id = ?', [bId]) ?? db.get<any>('SELECT * FROM electronics_configs WHERE id = ?', [bId]);
  if (!a || !b) throw new Error('Both configurations must exist');
  const parse = (row: any) => safeParse(row.content_json ?? '{}', {});
  const objA = parse(a);
  const objB = parse(b);
  const keys = new Set([...Object.keys(objA), ...Object.keys(objB)]);
  const rows = Array.from(keys)
    .sort()
    .map((key) => ({
      key,
      a: objA[key] === undefined ? null : typeof objA[key] === 'object' ? JSON.stringify(objA[key]) : String(objA[key]),
      b: objB[key] === undefined ? null : typeof objB[key] === 'object' ? JSON.stringify(objB[key]) : String(objB[key]),
      changed: JSON.stringify(objA[key]) !== JSON.stringify(objB[key]),
    }));

  const items = (config: any) =>
    config.id
      ? db.all<any>(
          `SELECT ci.*, c.name AS component_name, c.category, c.model FROM config_items ci
           LEFT JOIN components c ON c.id = ci.component_id WHERE ci.config_id = ?`,
          [config.id],
        )
      : [];
  const itemsA = items(a);
  const itemsB = items(b);

  return {
    a: { ...a, content: objA },
    b: { ...b, content: objB },
    fields: rows,
    changedCount: rows.filter((r) => r.changed).length,
    itemsA,
    itemsB,
    itemDiff: {
      onlyA: itemsA.filter((x) => !itemsB.some((y) => y.component_id === x.component_id)),
      onlyB: itemsB.filter((x) => !itemsA.some((y) => y.component_id === x.component_id)),
    },
    caveats: ['Configuration comparison reflects recorded snapshot content only. Unrecorded differences may exist.'],
  };
}

export function componentHistory(componentId: string): any {
  const db = getDb();
  const component = db.get<any>('SELECT * FROM components WHERE id = ?', [componentId]);
  if (!component) throw new Error('Component not found');
  const usage = db.all<any>('SELECT * FROM component_usage WHERE component_id = ? ORDER BY installed_at', [componentId]);
  const enriched = usage.map((u) => {
    const table = u.entity_type === 'test' ? 'tests' : u.entity_type === 'flight' ? 'flights' : u.entity_type === 'run' ? 'runs' : null;
    const record = table ? db.get<any>(`SELECT * FROM ${table} WHERE id = ?`, [u.entity_id]) : null;
    return { ...u, record };
  });
  const configs = db.all<any>(
    `SELECT ci.*, ec.name AS config_name FROM config_items ci JOIN electronics_configs ec ON ec.id = ci.config_id WHERE ci.component_id = ?`,
    [componentId],
  );
  return { component: expandOne(component), usage: enriched, configs };
}

export function sensorHistory(sensorId: string): any {
  const db = getDb();
  const sensor = db.get<any>('SELECT * FROM sensors WHERE id = ?', [sensorId]);
  if (!sensor) throw new Error('Sensor not found');
  const calibrations = db.all<any>('SELECT * FROM calibrations WHERE sensor_id = ? ORDER BY performed_at DESC', [sensorId]);
  const installations = db.all<any>('SELECT * FROM sensor_installations WHERE sensor_id = ? ORDER BY installed_at DESC', [sensorId]);
  const documents = db.all<any>(`SELECT * FROM documents WHERE entity_type = 'sensor' AND entity_id = ?`, [sensorId]);
  const channels = db.all<any>(
    `SELECT c.*, d.name AS dataset_name, d.recorded_at FROM channels c JOIN datasets d ON d.id = c.dataset_id
     WHERE c.source_desc LIKE ? ORDER BY d.recorded_at DESC`,
    [`%${sensor.serial || sensor.name}%`],
  );
  return { sensor: expandOne(sensor), calibrations: expand(calibrations), installations, documents, channels };
}
