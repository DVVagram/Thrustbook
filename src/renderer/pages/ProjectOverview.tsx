import React, { useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { RecordEditor } from '../RecordForm';
import { Badge, Button, Column, DataTable, EmptyState, ErrorBox, Icon, KeyValue, Modal, PageHeader, Panel, Stat, Tabs } from '../ui';
import { fmtDate, fmtDateTime, relativeTime } from '../format';

export default function ProjectOverviewPage() {
  const { route, navigate, notify, refresh, confirm, setProject } = useApp();
  const projectId = route.id ?? '';
  const overview = useAsync(() => api.overview(projectId), [projectId, route.hash]);
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<any>({});

  if (!projectId) return <EmptyState title="No project selected" icon="folder" />;
  if (overview.loading && !overview.data) return <div className="loading">Loading project…</div>;
  if (overview.error) return <ErrorBox message={overview.error} onRetry={overview.reload} />;
  if (!overview.data) return null;

  const { project, counts, stages, revisions, campaigns, tests, flights, datasets, issues, activity, components, sensors, documents, reports, rockets } = overview.data;
  const completedStages = stages.filter((s: any) => s.status === 'Complete').length;
  const progress = stages.length ? Math.round((completedStages / stages.length) * 100) : 0;

  const save = async () => {
    try {
      await api.update('project', project.id, draft);
      setEditing(false);
      notify('Project updated', 'success');
      overview.reload();
      refresh();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const openTest = (row: any) => navigate(`#/ground/${row.id}`);

  const testColumns: Column[] = [
    { key: 'name', label: 'Test', render: (t) => <span className="link-like">{t.name}</span> },
    { key: 'test_no', label: 'No.', mono: true },
    { key: 'category', label: 'Category' },
    { key: 'performed_at', label: 'Date', render: (t) => fmtDate(t.performed_at) },
    { key: 'status', label: 'Status', render: (t) => <Badge>{t.status}</Badge> },
  ];

  const flightColumns: Column[] = [
    { key: 'name', label: 'Flight', render: (f) => <span className="link-like">{f.name}</span> },
    { key: 'flight_no', label: 'No.', mono: true },
    { key: 'performed_at', label: 'Date', render: (f) => fmtDate(f.performed_at) },
    { key: 'status', label: 'Status', render: (f) => <Badge>{f.status}</Badge> },
  ];

  return (
    <div className="page">
      <PageHeader
        breadcrumbs={[{ label: 'Projects', onClick: () => navigate('#/projects') }, { label: project.name }]}
        title={
          <span className="title-with-badge">
            {project.name} <Badge>{project.status}</Badge>
          </span>
        }
        subtitle={
          <span>
            {project.code || 'No code'} · {project.stage || 'No stage'} · created {fmtDate(project.created_at)} · updated {relativeTime(project.updated_at)}
          </span>
        }
        actions={
          <>
            <Button icon="edit" onClick={() => { setDraft({ ...project }); setEditing(true); }}>
              Edit project
            </Button>
            <Button icon="download" onClick={() => api.exportProject(project.id).then((r) => !r.canceled && notify('Project exported', 'success')).catch((e) => notify(e.message, 'error'))}>
              Export
            </Button>
            <Button icon="upload" variant="primary" onClick={() => navigate('#/analysis?import=1')}>
              Import data
            </Button>
          </>
        }
      />

      <div className="stat-row">
        <Stat label="Development" value={`${progress}%`} sub={`${completedStages}/${stages.length} stages complete`} onClick={() => setTab('development')} />
        <Stat label="Revisions" value={counts.revisions} sub={revisions[0]?.label ?? 'none'} onClick={() => setTab('development')} />
        <Stat label="Tests" value={counts.tests} sub={`${tests.filter((t: any) => t.status === 'Completed').length} complete`} onClick={() => setTab('testing')} />
        <Stat label="Flights" value={counts.flights} sub="recorded" onClick={() => setTab('testing')} />
        <Stat label="Datasets" value={counts.datasets} sub="recordings & derived" onClick={() => setTab('data')} />
        <Stat label="Open issues" value={counts.openIssues} tone={counts.openIssues ? 'warn' : undefined} onClick={() => { setProject(project.id); navigate('#/issues'); }} />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'development', label: 'Development', count: stages.length },
          { key: 'testing', label: 'Testing', count: counts.tests + counts.flights },
          { key: 'data', label: 'Data', count: counts.datasets },
          { key: 'records', label: 'Records', count: counts.documents + counts.openIssues },
          { key: 'activity', label: 'Activity' },
        ]}
      />

      {tab === 'overview' && (
        <div className="detail-grid">
          <div className="stack">
            <Panel title="Objectives">
              <p>{project.objectives || <span className="muted">No objectives recorded.</span>}</p>
            </Panel>
            <Panel title="Description">
              <p>{project.description || <span className="muted">No description recorded.</span>}</p>
            </Panel>
            <Panel title="Development progress">
              <div className="stage-track">
                {stages.map((s: any) => (
                  <div className={`stage-chip stage-${s.status.replace(/\s+/g, '-').toLowerCase()}`} key={s.id} title={`${s.status}${s.completed_at ? ` · ${fmtDate(s.completed_at)}` : ''}`}>
                    <span className="stage-dot" />
                    {s.name}
                  </div>
                ))}
              </div>
              <div className="muted small">
                Development stages are organisational records. Completing a stage does not certify flight readiness.
              </div>
            </Panel>
            <Panel title="Recent activity">
              {activity.length === 0 ? (
                <EmptyState title="No activity yet" icon="log" />
              ) : (
                <div className="timeline compact">
                  {activity.slice(0, 10).map((a: any) => (
                    <div className="timeline-item" key={a.id}>
                      <span className="timeline-dot" />
                      <div>
                        <div className="list-title">{a.title}</div>
                        <div className="muted small">{a.detail}</div>
                        <div className="muted tiny">{fmtDateTime(a.at)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
          <div className="stack">
            <Panel title="Project record">
              <KeyValue
                columns={1}
                items={[
                  ['Identifier', project.code],
                  ['Status', project.status],
                  ['Development stage', project.stage],
                  ['Created', fmtDateTime(project.created_at)],
                  ['Rockets', rockets.map((r: any) => r.name).join(', ')],
                  ['Latest revision', revisions[0]?.label ?? '—'],
                  ['Campaigns', campaigns.length],
                  ['Components', counts.components],
                  ['Sensors', counts.sensors],
                  ['Documents', counts.documents],
                  ['Reports', counts.reports],
                ]}
              />
            </Panel>
            <Panel title="Quick links">
              <div className="quick-links">
                <button onClick={() => navigate('#/development')}><Icon name="rocket" size={14} /> Rocket development</button>
                <button onClick={() => navigate('#/ground?new=1')}><Icon name="beaker" size={14} /> New ground test</button>
                <button onClick={() => navigate('#/flights?new=1')}><Icon name="flight" size={14} /> New flight</button>
                <button onClick={() => navigate('#/compare')}><Icon name="compare" size={14} /> Compare datasets</button>
                <button onClick={() => navigate('#/reports')}><Icon name="report" size={14} /> Generate report</button>
                <button onClick={() => navigate('#/settings?tab=data')}><Icon name="save" size={14} /> Backup / storage</button>
              </div>
            </Panel>
            <Panel title="Danger zone">
              <div className="stack">
                <Button
                  variant="danger"
                  icon="trash"
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Delete this project?',
                      message: 'All project records will be removed from the database.',
                      details: 'Export the project first if you may need it later.',
                      confirmLabel: 'Delete project',
                      danger: true,
                    });
                    if (!ok) return;
                    await api.remove('project', project.id);
                    notify('Project deleted', 'success');
                    refresh();
                    navigate('#/projects');
                  }}
                >
                  Delete project
                </Button>
              </div>
            </Panel>
          </div>
        </div>
      )}

      {tab === 'development' && (
        <div className="stack">
          <Panel title="Development stages" actions={<Button size="sm" icon="chevron" onClick={() => navigate('#/development')}>Open workspace</Button>}>
            <div className="stage-table">
              {stages.map((s: any) => (
                <div className="stage-row" key={s.id}>
                  <div className="stage-name">{s.name}</div>
                  <Badge>{s.status}</Badge>
                  <div className="muted small">{s.started_at ? `Started ${fmtDate(s.started_at)}` : 'Not started'}</div>
                  <div className="muted small">{s.completed_at ? `Completed ${fmtDate(s.completed_at)}` : ''}</div>
                </div>
              ))}
              {stages.length === 0 && <EmptyState title="No stages" icon="branch" />}
            </div>
          </Panel>
          <Panel title="Revisions">
            {revisions.length === 0 ? (
              <EmptyState title="No revisions" icon="branch" />
            ) : (
              <DataTable
                rows={revisions}
                columns={[
                  { key: 'label', label: 'Revision', render: (r) => <span className="link-like">{r.label}</span> },
                  { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge> },
                  { key: 'description', label: 'Description' },
                  { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at) },
                ]}
                onRowClick={(r) => navigate(`#/revision/${r.id}`)}
              />
            )}
          </Panel>
          <Panel title="Testing campaigns">
            {campaigns.length === 0 ? (
              <EmptyState title="No campaigns" icon="beaker" />
            ) : (
              <DataTable
                rows={campaigns}
                columns={[
                  { key: 'name', label: 'Campaign' },
                  { key: 'kind', label: 'Kind' },
                  { key: 'status', label: 'Status', render: (c) => <Badge>{c.status}</Badge> },
                  { key: 'started_at', label: 'Started', render: (c) => fmtDate(c.started_at) },
                  { key: 'objectives', label: 'Objectives' },
                ]}
              />
            )}
          </Panel>
        </div>
      )}

      {tab === 'testing' && (
        <div className="stack">
          <Panel title={`Ground & experimental tests (${tests.length})`} actions={<Button size="sm" icon="plus" onClick={() => navigate('#/ground?new=1')}>New test</Button>}>
            {tests.length === 0 ? <EmptyState title="No tests recorded" icon="beaker" /> : <DataTable rows={tests} columns={testColumns} onRowClick={openTest} />}
          </Panel>
          <Panel title={`Flights (${flights.length})`} actions={<Button size="sm" icon="plus" onClick={() => navigate('#/flights?new=1')}>New flight</Button>}>
            {flights.length === 0 ? <EmptyState title="No flights recorded" icon="flight" /> : <DataTable rows={flights} columns={flightColumns} onRowClick={(f) => navigate(`#/flights/${f.id}`)} />}
          </Panel>
        </div>
      )}

      {tab === 'data' && (
        <Panel title={`Datasets (${datasets.length})`} actions={<Button size="sm" icon="upload" onClick={() => navigate('#/analysis?import=1')}>Import data</Button>}>
          {datasets.length === 0 ? (
            <EmptyState title="No datasets" icon="chart" />
          ) : (
            <DataTable
              rows={datasets}
              columns={[
                { key: 'name', label: 'Dataset', render: (d) => <span className="link-like">{d.name}</span> },
                { key: 'kind', label: 'Kind', render: (d) => <Badge>{d.kind}</Badge> },
                { key: 'points', label: 'Rows', align: 'right', mono: true, render: (d) => Number(d.points).toLocaleString() },
                { key: 'channels_count', label: 'Channels', align: 'right' },
                { key: 'recorded_at', label: 'Recorded', render: (d) => fmtDateTime(d.recorded_at) },
                { key: 'quality_status', label: 'Quality', render: (d) => <Badge>{d.quality_status || 'ok'}</Badge> },
              ]}
              onRowClick={(d) => navigate(`#/analysis?dataset=${d.id}`)}
            />
          )}
        </Panel>
      )}

      {tab === 'records' && (
        <div className="stack">
          <Panel title={`Issues (${issues.length})`} actions={<Button size="sm" icon="plus" onClick={() => navigate('#/issues?new=1')}>New issue</Button>}>
            {issues.length === 0 ? (
              <EmptyState title="No issues" icon="check" />
            ) : (
              <DataTable
                rows={issues}
                columns={[
                  { key: 'title', label: 'Issue', render: (i) => <span className="link-like">{i.title}</span> },
                  { key: 'severity', label: 'Severity', render: (i) => <Badge>{i.severity}</Badge> },
                  { key: 'status', label: 'Status', render: (i) => <Badge>{i.status}</Badge> },
                  { key: 'identified_at', label: 'Identified', render: (i) => fmtDate(i.identified_at || i.created_at) },
                ]}
                onRowClick={(i) => navigate(`#/issues?issue=${i.id}`)}
              />
            )}
          </Panel>
          <Panel title={`Documents (${documents.length})`} actions={<Button size="sm" icon="upload" onClick={() => navigate('#/documents')}>Library</Button>}>
            {documents.length === 0 ? (
              <EmptyState title="No documents" icon="doc" />
            ) : (
              <DataTable
                rows={documents}
                columns={[
                  { key: 'title', label: 'Document' },
                  { key: 'kind', label: 'Kind' },
                  { key: 'original_name', label: 'File', mono: true },
                  { key: 'created_at', label: 'Added', render: (d) => fmtDate(d.created_at) },
                ]}
                onRowClick={() => navigate('#/documents')}
              />
            )}
          </Panel>
          <Panel title={`Reports (${reports.length})`}>
            {reports.length === 0 ? (
              <EmptyState title="No reports generated" icon="report" />
            ) : (
              <DataTable
                rows={reports}
                columns={[
                  { key: 'title', label: 'Report' },
                  { key: 'kind', label: 'Kind' },
                  { key: 'created_at', label: 'Generated', render: (r) => fmtDate(r.created_at) },
                ]}
                onRowClick={() => navigate('#/reports')}
              />
            )}
          </Panel>
          <Panel title={`Components & sensors (${components.length + sensors.length})`}>
            <div className="two-col">
              <div>
                <h4>Components</h4>
                {components.length === 0 ? <EmptyState title="None" icon="chip" /> : components.map((c: any) => (
                  <button className="list-row static" key={c.id} onClick={() => navigate(`#/components?component=${c.id}`)}>
                    <span>{c.name}</span><span className="muted small">{c.category}</span>
                  </button>
                ))}
              </div>
              <div>
                <h4>Sensors</h4>
                {sensors.length === 0 ? <EmptyState title="None" icon="sensor" /> : sensors.map((s: any) => (
                  <button className="list-row static" key={s.id} onClick={() => navigate(`#/sensors?sensor=${s.id}`)}>
                    <span>{s.name}</span><span className="muted small">{s.type}</span>
                  </button>
                ))}
              </div>
            </div>
          </Panel>
        </div>
      )}

      {tab === 'activity' && (
        <Panel title="Complete project activity">
          <div className="timeline">
            {activity.map((a: any) => (
              <div className="timeline-item" key={a.id}>
                <span className="timeline-dot" />
                <div>
                  <div className="list-title">{a.title}</div>
                  <div className="muted small">{a.detail}</div>
                  <div className="muted tiny">{fmtDateTime(a.at)}</div>
                </div>
              </div>
            ))}
            {activity.length === 0 && <EmptyState title="No activity recorded" icon="log" />}
          </div>
        </Panel>
      )}

      {editing && (
        <Modal
          title="Edit project"
          onClose={() => setEditing(false)}
          size="lg"
          footer={
            <>
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button variant="primary" onClick={save}>Save project</Button>
            </>
          }
        >
          <RecordEditor entity="project" value={draft} onChange={(patch) => setDraft((d: any) => ({ ...d, ...patch }))} projectId={project.id} />
        </Modal>
      )}
    </div>
  );
}
