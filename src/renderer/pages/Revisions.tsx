import React, { useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { Badge, Button, DataTable, EmptyState, ErrorBox, Modal, PageHeader, Panel, Select } from '../ui';
import { fmtDate } from '../format';
import { REVISION_STATUSES } from '../../shared/constants';

export default function RevisionsPage() {
  const { projectId, project, route, navigate, notify } = useApp();
  const revisions = useAsync(() => api.list('revision', { where: { project_id: projectId }, limit: 500, orderBy: 'created_at', order: 'desc' }), [projectId]);
  const [aId, setAId] = useState(route.query.a ?? '');
  const [bId, setBId] = useState(route.query.b ?? '');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  if (!projectId) return <EmptyState title="Select a project" icon="folder" />;

  const runCompare = async () => {
    if (!aId || !bId) return;
    if (aId === bId) {
      notify('Choose two different revisions', 'warn');
      return;
    }
    setBusy(true);
    try {
      setResult(await api.revisionCompare(aId, bId));
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Revision History"
        subtitle={`${project?.name ?? ''} · preserve every design iteration and connect it to the tests that followed`}
        actions={
          <Button icon="report" onClick={() => navigate('#/reports?kind=revision')}>
            Revision report
          </Button>
        }
      />

      <Panel
        title="Compare two revisions"
        actions={
          <Button size="sm" variant="primary" icon="compare" onClick={runCompare} disabled={!aId || !bId || busy}>
            {busy ? 'Comparing…' : 'Compare'}
          </Button>
        }
      >
        <div className="compare-selects">
          <Select value={aId} onChange={(v) => setAId(v)} placeholder="Earlier revision" options={(revisions.data ?? []).map((r: any) => ({ value: r.id, label: `${r.label} · ${r.status}` }))} />
          <span className="muted">→</span>
          <Select value={bId} onChange={(v) => setBId(v)} placeholder="Later revision" options={(revisions.data ?? []).map((r: any) => ({ value: r.id, label: `${r.label} · ${r.status}` }))} />
          <Button size="sm" icon="save" onClick={() => navigate(`#/reports?kind=revision&entity=${aId}&secondary=${bId}`)} disabled={!aId || !bId}>
            Report
          </Button>
        </div>
      </Panel>

      {result && (
        <div className="stack">
          <Panel title={`${result.a.label} → ${result.b.label}`} actions={<Button size="sm" onClick={() => setResult(null)}>Close</Button>}>
            <div className="stat-row compact">
              <div className="mini-stat"><span>Tests</span><strong>{result.records.a.tests.length} → {result.records.b.tests.length}</strong></div>
              <div className="mini-stat"><span>Flights</span><strong>{result.records.a.flights.length} → {result.records.b.flights.length}</strong></div>
              <div className="mini-stat"><span>Datasets</span><strong>{result.records.datasetsA.length} → {result.records.datasetsB.length}</strong></div>
              <div className="mini-stat"><span>Issues</span><strong>{result.records.a.issues.length} → {result.records.b.issues.length}</strong></div>
            </div>
            <DataTable
              rows={result.changedFields}
              columns={[
                { key: 'label', label: 'Field' },
                { key: 'a', label: result.a.label, render: (r) => <span className="wrap-text">{r.a || '—'}</span> },
                { key: 'b', label: result.b.label, render: (r) => <span className="wrap-text">{r.b || '—'}</span> },
                { key: 'changed', label: '', width: '100px', render: (r) => (r.changed ? <Badge tone="warn">Changed</Badge> : <span className="muted tiny">unchanged</span>) },
              ]}
            />
          </Panel>

          {result.metricDeltas.length > 0 && (
            <Panel title="Measured differences" subtitle="Averaged channel statistics per revision">
              <DataTable
                rows={result.metricDeltas}
                columns={[
                  { key: 'name', label: 'Channel' },
                  { key: 'unit', label: 'Unit' },
                  { key: 'a', label: `${result.a.label} mean`, align: 'right', mono: true, render: (r) => r.a.mean?.toPrecision?.(5) ?? '—' },
                  { key: 'b', label: `${result.b.label} mean`, align: 'right', mono: true, render: (r) => r.b.mean?.toPrecision?.(5) ?? '—' },
                  { key: 'deltaMean', label: 'Δ mean', align: 'right', mono: true, render: (r) => (r.deltaMean === null ? '—' : r.deltaMean.toPrecision(5)) },
                  { key: 'a', label: `${result.a.label} peak`, align: 'right', mono: true, render: (r) => r.a.meanPeak?.toPrecision?.(5) ?? '—' },
                  { key: 'b', label: `${result.b.label} peak`, align: 'right', mono: true, render: (r) => r.b.meanPeak?.toPrecision?.(5) ?? '—' },
                  { key: 'deltaPeak', label: 'Δ peak', align: 'right', mono: true, render: (r) => (r.deltaPeak === null ? '—' : r.deltaPeak.toPrecision(5)) },
                ]}
              />
              <ul className="caveat-list">
                {result.caveats.map((c: string, i: number) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}

      <Panel title={`Revisions (${revisions.data?.length ?? 0})`} dense>
        {revisions.error && <ErrorBox message={revisions.error} onRetry={revisions.reload} />}
        <DataTable
          rows={revisions.data ?? []}
          onRowClick={(r) => navigate(`#/revision/${r.id}`)}
          columns={[
            { key: 'label', label: 'Revision', render: (r) => <span className="link-like">{r.label}</span> },
            { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge>, width: '120px' },
            { key: 'description', label: 'Description' },
            { key: 'design_changes', label: 'Design changes' },
            { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at), width: '110px' },
          ]}
          empty={<EmptyState title="No revisions" message="Create revisions in the Rocket Development workspace." icon="branch" />}
        />
      </Panel>
      <div className="muted small">
        Available statuses: {REVISION_STATUSES.join(' · ')}
      </div>
    </div>
  );
}
