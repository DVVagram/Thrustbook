import React, { useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { RecordForm } from '../RecordForm';
import { Badge, Button, DataTable, EmptyState, ErrorBox, PageHeader, Panel, Select, Tabs } from '../ui';
import { fmtDate, fmtDateTime } from '../format';

export default function RevisionDetailPage() {
  const { route, navigate, projectId, notify, confirm, refresh } = useApp();
  const id = route.id ?? '';
  const revision = useAsync(() => api.get('revision', id), [id]);
  const others = useAsync(() => api.list('revision', { where: { project_id: projectId }, limit: 300 }), [projectId]);
  const related = useAsync(async () => {
    if (!id) return null;
    const [tests, flights, issues, stages, datasets] = await Promise.all([
      api.list('test', { where: { revision_id: id }, limit: 300 }),
      api.list('flight', { where: { revision_id: id }, limit: 300 }),
      api.list('issue', { where: { revision_id: id }, limit: 300 }),
      api.list('stage', { where: { revision_id: id }, limit: 300 }),
      api.list('dataset', { where: { project_id: projectId }, limit: 1000 }),
    ]);
    const testIds = new Set(tests.map((t: any) => t.id));
    const flightIds = new Set(flights.map((f: any) => f.id));
    return { tests, flights, issues, stages, datasets: datasets.filter((d: any) => testIds.has(d.test_id) || flightIds.has(d.flight_id)) };
  }, [id, projectId]);

  const [draft, setDraft] = useState<any>({});
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState('record');
  const [compareWith, setCompareWith] = useState('');
  const [comparison, setComparison] = useState<any>(null);

  React.useEffect(() => {
    if (revision.data) {
      setDraft({ ...revision.data });
      setDirty(false);
    }
  }, [revision.data?.id, revision.data?.updated_at]);

  if (revision.loading && !revision.data) return <div className="loading">Loading revision…</div>;
  if (revision.error) return <ErrorBox message={revision.error} onRetry={revision.reload} />;
  if (!revision.data) return <EmptyState title="Revision not found" icon="branch" />;

  const save = async () => {
    try {
      await api.update('revision', id, draft);
      setDirty(false);
      revision.reload();
      refresh();
      notify('Revision saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="page">
      <PageHeader
        breadcrumbs={[{ label: 'Revision History', onClick: () => navigate('#/revisions') }, { label: revision.data.label }]}
        title={
          <span className="title-with-badge">
            {draft.label ?? revision.data.label} <Badge>{draft.status ?? revision.data.status}</Badge>
          </span>
        }
        subtitle={`Design revision · created ${fmtDate(revision.data.created_at)} · ${related.data?.tests.length ?? 0} tests · ${related.data?.flights.length ?? 0} flights`}
        actions={
          <>
            <Button icon="compare" onClick={() => navigate(`#/revisions?a=${id}`)}>Compare revisions</Button>
            <Button icon="report" onClick={() => navigate(`#/reports?kind=revision&entity=${id}`)}>Report</Button>
            <Button variant="primary" icon="save" onClick={save} disabled={!dirty}>Save changes</Button>
          </>
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'record', label: 'Revision record' },
          { key: 'testing', label: 'Associated testing', count: (related.data?.tests.length ?? 0) + (related.data?.flights.length ?? 0) },
          { key: 'data', label: 'Datasets', count: related.data?.datasets.length ?? 0 },
          { key: 'issues', label: 'Issues', count: related.data?.issues.length ?? 0 },
          { key: 'compare', label: 'Compare' },
        ]}
      />

      {tab === 'record' && (
        <div className="detail-grid">
          <Panel title="Revision details" className="detail-main">
            <RecordForm
              entity="revision"
              value={draft}
              projectId={projectId}
              onChange={(patch) => {
                setDraft((d: any) => ({ ...d, ...patch }));
                setDirty(true);
              }}
            />
          </Panel>
          <div className="stack">
            <Panel title="Development stages in this revision">
              {(related.data?.stages ?? []).length === 0 ? (
                <div className="muted small">No stages linked.</div>
              ) : (
                related.data!.stages.map((s: any) => (
                  <div className="list-row static" key={s.id}>
                    <span>{s.name}</span>
                    <Badge>{s.status}</Badge>
                  </div>
                ))
              )}
            </Panel>
            <Panel title="Danger zone">
              <Button
                variant="danger"
                icon="trash"
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Delete revision?',
                    message: 'Stages attached to this revision will also be removed. Tests and flights keep their historical records but lose the revision link.',
                    confirmLabel: 'Delete revision',
                    danger: true,
                  });
                  if (!ok) return;
                  await api.remove('revision', id);
                  refresh();
                  navigate('#/revisions');
                }}
              >
                Delete revision
              </Button>
            </Panel>
          </div>
        </div>
      )}

      {tab === 'testing' && (
        <div className="stack">
          <Panel title="Ground tests" actions={<Button size="sm" icon="plus" onClick={() => navigate('#/ground?new=1')}>New test</Button>}>
            {(related.data?.tests ?? []).length === 0 ? (
              <EmptyState title="No tests on this revision" icon="beaker" />
            ) : (
              <DataTable
                rows={related.data!.tests}
                onRowClick={(t) => navigate(`#/ground/${t.id}`)}
                columns={[
                  { key: 'name', label: 'Test' },
                  { key: 'category', label: 'Category' },
                  { key: 'performed_at', label: 'Date', render: (t) => fmtDate(t.performed_at) },
                  { key: 'status', label: 'Status', render: (t) => <Badge>{t.status}</Badge> },
                ]}
              />
            )}
          </Panel>
          <Panel title="Flights" actions={<Button size="sm" icon="plus" onClick={() => navigate('#/flights?new=1')}>New flight</Button>}>
            {(related.data?.flights ?? []).length === 0 ? (
              <EmptyState title="No flights on this revision" icon="flight" />
            ) : (
              <DataTable
                rows={related.data!.flights}
                onRowClick={(f) => navigate(`#/flights/${f.id}`)}
                columns={[
                  { key: 'name', label: 'Flight' },
                  { key: 'performed_at', label: 'Date', render: (f) => fmtDate(f.performed_at) },
                  { key: 'status', label: 'Status', render: (f) => <Badge>{f.status}</Badge> },
                ]}
              />
            )}
          </Panel>
        </div>
      )}

      {tab === 'data' && (
        <Panel title="Datasets recorded on this revision">
          {(related.data?.datasets ?? []).length === 0 ? (
            <EmptyState title="No datasets" icon="chart" />
          ) : (
            <DataTable
              rows={related.data!.datasets}
              onRowClick={(d) => navigate(`#/analysis?dataset=${d.id}`)}
              columns={[
                { key: 'name', label: 'Dataset' },
                { key: 'kind', label: 'Kind', render: (d) => <Badge>{d.kind}</Badge> },
                { key: 'points', label: 'Rows', align: 'right', mono: true, render: (d) => Number(d.points).toLocaleString() },
                { key: 'recorded_at', label: 'Recorded', render: (d) => fmtDateTime(d.recorded_at) },
              ]}
            />
          )}
        </Panel>
      )}

      {tab === 'issues' && (
        <Panel title="Issues on this revision">
          {(related.data?.issues ?? []).length === 0 ? (
            <EmptyState title="No issues" icon="check" />
          ) : (
            <DataTable
              rows={related.data!.issues}
              onRowClick={(i) => navigate(`#/issues/${i.id}`)}
              columns={[
                { key: 'title', label: 'Issue' },
                { key: 'severity', label: 'Severity', render: (i) => <Badge>{i.severity}</Badge> },
                { key: 'status', label: 'Status', render: (i) => <Badge>{i.status}</Badge> },
                { key: 'identified_at', label: 'Identified', render: (i) => fmtDate(i.identified_at) },
              ]}
            />
          )}
        </Panel>
      )}

      {tab === 'compare' && (
        <Panel
          title="Compare with another revision"
          actions={
            <Button
              size="sm"
              variant="primary"
              icon="compare"
              disabled={!compareWith}
              onClick={async () => {
                try {
                  setComparison(await api.revisionCompare(id, compareWith));
                } catch (err: any) {
                  notify(err.message, 'error');
                }
              }}
            >
              Compare
            </Button>
          }
        >
          <div className="toolbar-inline">
            <Select value={compareWith} onChange={setCompareWith} placeholder="Select revision to compare against" options={(others.data ?? []).filter((r: any) => r.id !== id).map((r: any) => ({ value: r.id, label: r.label }))} />
          </div>
          {comparison && (
            <div className="stack">
              <p className="muted small">
                Comparing <strong>{comparison.a.label}</strong> with <strong>{comparison.b.label}</strong>. Fields that differ:
              </p>
              <DataTable
                rows={comparison.changedFields.filter((f: any) => f.changed)}
                columns={[
                  { key: 'label', label: 'Field' },
                  { key: 'a', label: comparison.a.label },
                  { key: 'b', label: comparison.b.label },
                ]}
                empty={<div className="muted">No documented fields differ.</div>}
              />
              <Button icon="chevron" onClick={() => navigate(`#/revisions?a=${id}&b=${compareWith}`)}>
                Open full comparison
              </Button>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
