import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { Badge, Button, Checkbox, EmptyState, ErrorBox, Icon, Modal, PageHeader, Panel, Stat } from '../ui';
import { fmtDate, fmtDateTime, relativeTime } from '../format';
import { todayInput } from '../format';

const WIDGETS = [
  { key: 'activeProjects', label: 'Active projects' },
  { key: 'upcomingTests', label: 'Upcoming planned tests' },
  { key: 'recentActivity', label: 'Recent development activity' },
  { key: 'recentDatasets', label: 'Recent datasets' },
  { key: 'openIssues', label: 'Unresolved issues' },
  { key: 'recentFlights', label: 'Completed flights' },
  { key: 'latestRevisions', label: 'Latest design revisions' },
  { key: 'milestones', label: 'Project milestones' },
  { key: 'recentGroundTests', label: 'Completed ground tests' },
  { key: 'recentMeasurements', label: 'Recent measurements' },
];

export default function Dashboard() {
  const { settings, setSetting, navigate, projectId, setProject, projects, notify } = useApp();
  const { data, loading, error, reload } = useAsync(() => api.dashboard(), []);
  const [customizing, setCustomizing] = useState(false);
  const [widgets, setWidgets] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(settings.dashboardWidgets || '[]');
      return Array.isArray(parsed) ? parsed : WIDGETS.map((w) => w.key);
    } catch {
      return WIDGETS.map((w) => w.key);
    }
  });
  const [importOpen, setImportOpen] = useState(false);

  const active = useMemo(() => new Set(widgets), [widgets]);

  const saveWidgets = async (next: string[]) => {
    setWidgets(next);
    await setSetting('dashboardWidgets', JSON.stringify(next));
  };

  if (loading && !data) return <div className="loading">Loading dashboard…</div>;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return null;

  const hasProjects = data.projects.length > 0;

  return (
    <div className="page">
      <PageHeader
        title="Engineering dashboard"
        subtitle={`${data.totals.projects} active project(s) · ${data.totals.tests} ground tests · ${data.totals.flights} flights · ${data.totals.datasets} datasets`}
        actions={
          <>
            <Button icon="gear" onClick={() => setCustomizing(true)}>
              Customize
            </Button>
            <Button icon="refresh" onClick={reload}>
              Refresh
            </Button>
            <Button variant="primary" icon="plus" onClick={() => navigate('#/projects?new=1')}>
              New project
            </Button>
          </>
        }
      />

      {!hasProjects && (
        <div className="onboarding">
          <div className="onboarding-mark">
            <Icon name="rocket" size={30} />
          </div>
          <h2>Start your development programme</h2>
          <p className="muted">
            Create a project, define the first rocket revision, then record ground tests, flights and imported measurement data.
            Everything is stored locally and works offline.
          </p>
          <div className="onboarding-actions">
            <Button variant="primary" icon="plus" onClick={() => navigate('#/projects?new=1')}>
              Create first project
            </Button>
            <Button icon="folder" onClick={() => api.pickOpen({ title: 'Import a project archive', filters: [{ name: 'Thrustbook project', extensions: ['rlproj'] }] })}>
              Import project archive
            </Button>
          </div>
        </div>
      )}

      <div className="quick-actions">
        <button onClick={() => navigate('#/projects?new=1')}>
          <Icon name="folder" size={16} /> New project
        </button>
        <button onClick={() => navigate('#/ground?new=1')}>
          <Icon name="beaker" size={16} /> New ground test
        </button>
        <button onClick={() => navigate('#/flights?new=1')}>
          <Icon name="flight" size={16} /> New flight
        </button>
        <button onClick={() => navigate('#/analysis?import=1')}>
          <Icon name="upload" size={16} /> Import dataset
        </button>
        <button onClick={() => navigate('#/experiments?new=1')}>
          <Icon name="flask" size={16} /> New experiment
        </button>
      </div>

      <div className="stat-row">
        <Stat label="Projects" value={data.totals.projects} sub="active" onClick={() => navigate('#/projects')} />
        <Stat label="Ground tests" value={data.totals.tests} sub="all time" onClick={() => navigate('#/ground')} />
        <Stat label="Flights" value={data.totals.flights} sub="recorded" onClick={() => navigate('#/flights')} />
        <Stat label="Datasets" value={data.totals.datasets} sub={`${data.totals.channels} channels`} onClick={() => navigate('#/analysis')} />
        <Stat label="Open issues" value={data.totals.issues} sub="unresolved" tone={data.totals.issues > 0 ? 'warn' : undefined} onClick={() => navigate('#/issues')} />
      </div>

      <div className="dash-grid">
        {active.has('activeProjects') && (
          <Panel
            title="Active projects"
            subtitle="Most recently updated"
            className="span-2"
            actions={<Button size="sm" icon="chevron" onClick={() => navigate('#/projects')}>All projects</Button>}
          >
            {data.projects.length === 0 ? (
              <EmptyState title="No projects" icon="folder" />
            ) : (
              <div className="project-cards">
                {data.projects.map((p: any) => (
                  <button
                    className={`project-card ${p.id === projectId ? 'current' : ''}`}
                    key={p.id}
                    onClick={() => {
                      setProject(p.id);
                      navigate(`#/project/${p.id}`);
                    }}
                  >
                    <div className="project-card-head">
                      <span className="project-code">{p.code || '—'}</span>
                      <Badge>{p.status}</Badge>
                    </div>
                    <div className="project-name">{p.name}</div>
                    <div className="project-stage">{p.currentStage ?? p.stage ?? 'No active stage'}</div>
                    <div className="project-metrics">
                      <span>{p.counts.revisions} rev</span>
                      <span>{p.counts.tests} tests</span>
                      <span>{p.counts.flights} flights</span>
                      <span>{p.counts.datasets} ds</span>
                      {p.counts.open_issues > 0 && <span className="warn-text">{p.counts.open_issues} open</span>}
                    </div>
                    <div className="project-updated muted small">Updated {relativeTime(p.updated_at)}</div>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        )}

        {active.has('upcomingTests') && (
          <Panel title="Upcoming tests" subtitle="Planned or ready">
            {data.upcomingTests.length === 0 ? (
              <EmptyState title="Nothing scheduled" message="Planned tests appear here." icon="beaker" />
            ) : (
              <div className="list-rows">
                {data.upcomingTests.map((t: any) => (
                  <button key={t.id} className="list-row" onClick={() => navigate(`#/ground/${t.id}`)}>
                    <div>
                      <div className="list-title">{t.name}</div>
                      <div className="muted small">{t.test_no ? `${t.test_no} · ` : ''}{t.category}</div>
                    </div>
                    <div className="right">
                      <Badge>{t.status}</Badge>
                      <div className="muted small">{t.performed_at ? fmtDateTime(t.performed_at) : 'No date'}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        )}

        {active.has('openIssues') && (
          <Panel title="Unresolved issues" subtitle="Highest severity first" actions={<Button size="sm" onClick={() => navigate('#/issues')}>All</Button>}>
            {data.openIssues.length === 0 ? (
              <EmptyState title="No open issues" icon="check" />
            ) : (
              <div className="list-rows">
                {data.openIssues.map((i: any) => (
                  <button key={i.id} className="list-row" onClick={() => navigate(`#/issues?issue=${i.id}`)}>
                    <div>
                      <div className="list-title">{i.title}</div>
                      <div className="muted small">{i.project_name} · {i.category}</div>
                    </div>
                    <div className="right">
                      <Badge>{i.severity}</Badge>
                      <div className="muted small">{i.status}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        )}

        {active.has('recentDatasets') && (
          <Panel title="Recent datasets" actions={<Button size="sm" onClick={() => navigate('#/analysis')}>Workspace</Button>}>
            {data.recentDatasets.length === 0 ? (
              <EmptyState title="No datasets" message="Import a recording to begin analysis." icon="chart" />
            ) : (
              <div className="list-rows">
                {data.recentDatasets.map((d: any) => (
                  <button key={d.id} className="list-row" onClick={() => navigate(`#/analysis?dataset=${d.id}`)}>
                    <div>
                      <div className="list-title">{d.name}</div>
                      <div className="muted small">
                        {Number(d.points).toLocaleString()} rows · {d.channels_count} channels · {d.project_name}
                      </div>
                    </div>
                    <div className="right">
                      <Badge tone={d.quality_status === 'warning' ? 'warn' : 'ok'}>{d.quality_status || 'ok'}</Badge>
                      <div className="muted small">{relativeTime(d.created_at)}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        )}

        {active.has('recentFlights') && (
          <Panel title="Recent flights" actions={<Button size="sm" onClick={() => navigate('#/flights')}>All flights</Button>}>
            {data.recentFlights.length === 0 ? (
              <EmptyState title="No flights recorded" icon="flight" />
            ) : (
              <div className="list-rows">
                {data.recentFlights.map((f: any) => (
                  <button key={f.id} className="list-row" onClick={() => navigate(`#/flights/${f.id}`)}>
                    <div>
                      <div className="list-title">{f.name}</div>
                      <div className="muted small">{f.flight_no} · {f.project_name}</div>
                    </div>
                    <div className="right">
                      <Badge>{f.status}</Badge>
                      <div className="muted small">{fmtDate(f.performed_at)}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        )}

        {active.has('recentActivity') && (
          <Panel title="Recent activity" actions={<Button size="sm" onClick={() => navigate('#/datalog')}>Data log</Button>}>
            {data.recentActivity.length === 0 ? (
              <EmptyState title="No activity yet" icon="log" />
            ) : (
              <div className="timeline compact">
                {data.recentActivity.map((a: any) => (
                  <div className="timeline-item" key={a.id}>
                    <span className="timeline-dot" />
                    <div>
                      <div className="list-title">{a.title}</div>
                      <div className="muted small">
                        {a.detail} · {a.project_name}
                      </div>
                      <div className="muted tiny">{relativeTime(a.at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}

        {active.has('latestRevisions') && (
          <Panel title="Latest design revisions">
            {data.latestRevisions.length === 0 ? (
              <EmptyState title="No revisions" icon="branch" />
            ) : (
              <div className="list-rows">
                {data.latestRevisions.map((r: any) => (
                  <button key={r.id} className="list-row" onClick={() => navigate(`#/revision/${r.id}`)}>
                    <div>
                      <div className="list-title">{r.label}</div>
                      <div className="muted small">{r.project_name}</div>
                    </div>
                    <div className="right">
                      <Badge>{r.status}</Badge>
                      <div className="muted small">{fmtDate(r.created_at)}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        )}

        {active.has('milestones') && (
          <Panel title="Recent milestones">
            {data.milestones.length === 0 ? (
              <EmptyState title="No completed stages" icon="check" />
            ) : (
              <div className="list-rows">
                {data.milestones.map((m: any) => (
                  <div className="list-row static" key={m.id}>
                    <div>
                      <div className="list-title">{m.name}</div>
                      <div className="muted small">{m.project_name}</div>
                    </div>
                    <div className="right muted small">{fmtDate(m.completed_at)}</div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}

        {active.has('recentGroundTests') && (
          <Panel title="Completed ground tests">
            {data.recentGroundTests.length === 0 ? (
              <EmptyState title="No completed tests" icon="beaker" />
            ) : (
              <div className="list-rows">
                {data.recentGroundTests.map((t: any) => (
                  <button key={t.id} className="list-row" onClick={() => navigate(`#/ground/${t.id}`)}>
                    <div>
                      <div className="list-title">{t.name}</div>
                      <div className="muted small">{t.category} · {t.project_name}</div>
                    </div>
                    <div className="right">
                      <Badge>{t.status}</Badge>
                      <div className="muted small">{fmtDate(t.performed_at)}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        )}

        {active.has('recentMeasurements') && (
          <Panel title="Recent measurements" subtitle="Latest recorded channels">
            {data.recentMeasurements.length === 0 ? (
              <EmptyState title="No measurements" icon="sensor" />
            ) : (
              <div className="measurement-list">
                {data.recentMeasurements.slice(0, 10).map((m: any, i: number) => (
                  <button key={i} className="measurement-row" onClick={() => navigate(`#/analysis?dataset=${m.dataset_id}`)}>
                    <span className="measurement-name">{m.name}</span>
                    <span className="muted small">{m.dataset_name}</span>
                    <span className="mono small">{m.unit}</span>
                    <span className="mono small right">
                      {m.min?.toPrecision?.(4) ?? '—'} … {m.max?.toPrecision?.(4) ?? '—'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        )}
      </div>

      {customizing && (
        <Modal
          title="Dashboard widgets"
          onClose={() => setCustomizing(false)}
          footer={<Button variant="primary" onClick={() => setCustomizing(false)}>Done</Button>}
        >
          <div className="stack">
            <p className="muted small">Choose the engineering information shown on the dashboard.</p>
            {WIDGETS.map((w) => (
              <Checkbox
                key={w.key}
                checked={active.has(w.key)}
                label={w.label}
                onChange={(checked) => {
                  const next = checked ? [...widgets, w.key] : widgets.filter((k) => k !== w.key);
                  void saveWidgets(next);
                }}
              />
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
