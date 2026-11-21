import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { Badge, Button, Column, DataTable, EmptyState, ErrorBox, Icon, PageHeader, Panel, SearchInput, Select, Tabs, Toolbar } from '../ui';
import { fmtDate, fmtDateTime } from '../format';

const LOG_TYPES = [
  'test',
  'flight',
  'dataset',
  'event',
  'revision',
  'issue',
  'calibration',
  'document',
  'note',
  'stage',
  'campaign',
  'experiment',
  'component',
  'sensor',
  'config',
  'report',
  'activity',
];

export default function DataLogPage() {
  const { projectId, project, navigate } = useApp();
  const [view, setView] = useState('timeline');
  const [q, setQ] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tags, setTags] = useState('');
  const [sort, setSort] = useState<'desc' | 'asc'>('desc');

  const log = useAsync(
    () => api.dataLog({ projectId, q: q || undefined, types, from: from || undefined, to: to || undefined, tags: tags || undefined, limit: 800, sort }),
    [projectId, q, types.join(','), from, to, tags, sort],
  );
  const measurements = useAsync(() => (projectId ? api.measurements(projectId, q || undefined) : Promise.resolve([])), [projectId, q]);
  const revisions = useAsync(() => api.list('revision', { where: { project_id: projectId }, limit: 200 }), [projectId]);

  const entries: any[] = log.data?.entries ?? [];

  const grouped = useMemo(() => {
    const groups = new Map<string, typeof entries>();
    for (const e of entries) {
      const key = e.at ? fmtDate(e.at) : 'Undated';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(e);
    }
    return Array.from(groups.entries());
  }, [entries]);

  if (!projectId) return <EmptyState title="Select a project" icon="folder" />;

  const columns: Column[] = [
    { key: 'at', label: 'Date', width: '150px', render: (e) => fmtDateTime(e.at), sortValue: (e) => e.at },
    { key: 'type', label: 'Type', width: '110px', render: (e) => <Badge>{e.type}</Badge> },
    { key: 'title', label: 'Entry', render: (e) => <span className="link-like">{e.title}</span> },
    { key: 'subtitle', label: 'Detail' },
    { key: 'status', label: 'Status', width: '110px' },
    { key: 'project_name', label: 'Project', width: '150px' },
  ];

  const tests = entries.filter((e) => e.type === 'test');
  const flights = entries.filter((e) => e.type === 'flight');

  return (
    <div className="page">
      <PageHeader
        title="Data Log"
        subtitle={`${project?.name ?? ''} · the unified historical record of ${log.data?.total ?? 0} engineering events`}
        actions={
          <>
            <Select
              value={sort}
              onChange={(v) => setSort(v as 'asc' | 'desc')}
              options={[
                { value: 'desc', label: 'Newest first' },
                { value: 'asc', label: 'Oldest first' },
              ]}
            />
            <Button icon="refresh" onClick={() => { log.reload(); measurements.reload(); }}>Refresh</Button>
          </>
        }
      />

      <Panel dense title="Filters">
        <Toolbar className="filters">
          <SearchInput value={q} onChange={setQ} placeholder="Full-text search notes, descriptions, metadata…" />
          <div className="filter-dates">
            <label>
              From
              <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              To
              <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <label>
              Tag
              <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tag" />
            </label>
          </div>
        </Toolbar>
        <div className="type-chips">
          <button className={`chip ${types.length === 0 ? 'active' : ''}`} onClick={() => setTypes([])}>
            All events
          </button>
          {LOG_TYPES.map((t) => (
            <button
              key={t}
              className={`chip ${types.includes(t) ? 'active' : ''}`}
              onClick={() => setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))}
            >
              {t}
              {log.data?.counts?.[t] ? <span className="chip-count">{log.data.counts[t]}</span> : null}
            </button>
          ))}
        </div>
      </Panel>

      <Tabs
        active={view}
        onChange={setView}
        tabs={[
          { key: 'timeline', label: 'Chronological timeline', count: entries.length },
          { key: 'table', label: 'Table', count: entries.length },
          { key: 'measurements', label: 'Measurement history', count: measurements.data?.length ?? 0 },
          { key: 'revisions', label: 'Revision history', count: revisions.data?.length ?? 0 },
          { key: 'tests', label: 'Test history', count: tests.length },
          { key: 'flights', label: 'Flight history', count: flights.length },
        ]}
      />

      {log.error && <ErrorBox message={log.error} onRetry={log.reload} />}

      {view === 'timeline' && (
        <Panel dense title="Project history" subtitle={`${log.data?.total ?? 0} entries match the current filters`}>
          {entries.length === 0 ? (
            <EmptyState title="No entries" message="Adjust the filters or start recording work." icon="log" />
          ) : (
            <div className="log-timeline">
              {grouped.map(([date, dayEntries]) => (
                <div className="log-day" key={date}>
                  <div className="log-date">{date}</div>
                  <div className="log-items">
                    {dayEntries.map((e) => (
                      <button className="log-item" key={`${e.type}-${e.id}`} onClick={() => e.route && navigate(e.route)}>
                        <span className={`log-type log-type-${e.type}`}>{e.type}</span>
                        <span className="log-title">{e.title}</span>
                        <span className="log-sub">{e.subtitle || e.detail}</span>
                        <span className="log-time">{e.at ? fmtDateTime(e.at).slice(-8) : ''}</span>
                        {e.status && <Badge>{e.status}</Badge>}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {view === 'table' && (
        <Panel dense title="All entries">
          <DataTable rows={entries} columns={columns} onRowClick={(e) => e.route && navigate(e.route)} />
        </Panel>
      )}

      {view === 'measurements' && (
        <Panel dense title="Measurement channels across tests and flights" subtitle="Grouped by channel name, unit and project">
          <DataTable
            rows={measurements.data ?? []}
            columns={[
              { key: 'name', label: 'Channel' },
              { key: 'type', label: 'Type' },
              { key: 'unit', label: 'Unit' },
              { key: 'occurrences', label: 'Recordings', align: 'right', mono: true },
              { key: 'min', label: 'Overall min', align: 'right', mono: true, render: (m) => (m.min === null ? '—' : m.min.toPrecision(5)) },
              { key: 'max', label: 'Overall max', align: 'right', mono: true, render: (m) => (m.max === null ? '—' : m.max.toPrecision(5)) },
              { key: 'lastRecorded', label: 'Last recorded', render: (m) => fmtDate(m.lastRecorded) },
            ]}
            onRowClick={(m) => m.samples?.[0] && navigate(`#/analysis?dataset=${m.samples[0].dataset_id}`)}
            empty={<EmptyState title="No measurements" message="Import datasets to build measurement history." icon="sensor" />}
          />
        </Panel>
      )}

      {view === 'revisions' && (
        <Panel dense title="Revision history">
          <DataTable
            rows={revisions.data ?? []}
            columns={[
              { key: 'label', label: 'Revision' },
              { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge> },
              { key: 'design_changes', label: 'Design changes' },
              { key: 'config_changes', label: 'Configuration changes' },
              { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at) },
            ]}
            onRowClick={(r) => navigate(`#/revision/${r.id}`)}
          />
        </Panel>
      )}

      {view === 'tests' && (
        <Panel dense title="Test history" actions={<Button size="sm" icon="beaker" onClick={() => navigate('#/ground')}>Ground testing</Button>}>
          <DataTable rows={tests} columns={columns} onRowClick={(e) => navigate(e.route)} />
        </Panel>
      )}

      {view === 'flights' && (
        <Panel dense title="Flight history" actions={<Button size="sm" icon="flight" onClick={() => navigate('#/flights')}>Flight testing</Button>}>
          <DataTable rows={flights} columns={columns} onRowClick={(e) => navigate(e.route)} />
        </Panel>
      )}

      <div className="muted small">
        <Icon name="link" size={12} /> Every entry links back to its record; related documents, datasets and issues remain reachable from there.
      </div>
    </div>
  );
}
