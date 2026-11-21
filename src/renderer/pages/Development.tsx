import React, { useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { RecordEditor } from '../RecordForm';
import { NotesPanel } from '../EntityPage';
import { Badge, Button, DataTable, EmptyState, ErrorBox, Icon, Modal, PageHeader, Panel, Select, Tabs } from '../ui';
import { fmtDate, fmtDateTime } from '../format';
import { STAGE_STATUSES } from '../../shared/constants';

export default function DevelopmentPage() {
  const { projectId, project, navigate, notify, confirm, refresh } = useApp();
  const [tab, setTab] = useState('stages');
  const [editing, setEditing] = useState<any>(null);
  const [stageFilter, setStageFilter] = useState('');

  const stages = useAsync(() => api.list('stage', { where: { project_id: projectId }, limit: 500, orderBy: 'sort_order', order: 'asc' }), [projectId]);
  const rockets = useAsync(() => api.list('rocket', { where: { project_id: projectId }, limit: 100 }), [projectId]);
  const revisions = useAsync(() => api.list('revision', { where: { project_id: projectId }, limit: 200, orderBy: 'created_at', order: 'desc' }), [projectId]);
  const campaigns = useAsync(() => api.list('campaign', { where: { project_id: projectId }, limit: 100, orderBy: 'created_at', order: 'desc' }), [projectId]);
  const notes = useAsync(() => api.list('note', { where: { project_id: projectId }, limit: 200 }), [projectId]);
  const activity = useAsync(() => api.dataLog({ projectId, limit: 120 }), [projectId]);
  const [noteTick, setNoteTick] = useState(0);

  if (!projectId) return <EmptyState title="Select a project" icon="folder" />;
  if (stages.error) return <ErrorBox message={stages.error} onRetry={stages.reload} />;

  const saveEntity = async (entity: string, data: any) => {
    try {
      if (data.id) await api.update(entity, data.id, data);
      else await api.create(entity, { ...data, project_id: projectId });
      setEditing(null);
      stages.reload();
      rockets.reload();
      revisions.reload();
      campaigns.reload();
      refresh();
      notify('Saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const setStageStatus = async (stage: any, status: string) => {
    await api.update('stage', stage.id, {
      status,
      completed_at: status === 'Complete' ? new Date().toISOString().slice(0, 10) : stage.completed_at,
      started_at: stage.started_at || (status !== 'Not started' ? new Date().toISOString().slice(0, 10) : ''),
    });
    stages.reload();
    refresh();
  };

  const filteredStages = (stages.data ?? []).filter((s: any) => !stageFilter || s.status === stageFilter);
  const completed = (stages.data ?? []).filter((s: any) => s.status === 'Complete').length;
  const progress = stages.data?.length ? Math.round((completed / stages.data.length) * 100) : 0;

  return (
    <div className="page">
      <PageHeader
        title="Rocket Development"
        subtitle={`${project?.name ?? ''} · ${rockets.data?.length ?? 0} rocket(s) · ${revisions.data?.length ?? 0} revision(s) · ${progress}% of stages complete`}
        actions={
          <>
            <Button icon="plus" onClick={() => setEditing({ __entity: 'rocket', project_id: projectId, status: 'In development' })}>
              New rocket
            </Button>
            <Button icon="plus" onClick={() => setEditing({ __entity: 'revision', project_id: projectId, rocket_id: rockets.data?.[0]?.id ?? '', status: 'In design', label: `Rev ${String.fromCharCode(65 + (revisions.data?.length ?? 0))}` })}>
              New revision
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setEditing({ __entity: 'stage', project_id: projectId, status: 'Not started', sort_order: stages.data?.length ?? 0, name: '' })}>
              New stage
            </Button>
          </>
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'stages', label: 'Development stages', count: stages.data?.length ?? 0 },
          { key: 'rockets', label: 'Rockets & revisions', count: revisions.data?.length ?? 0 },
          { key: 'campaigns', label: 'Testing campaigns', count: campaigns.data?.length ?? 0 },
          { key: 'notes', label: 'Engineering notes', count: notes.data?.length ?? 0 },
          { key: 'timeline', label: 'Timeline' },
        ]}
      />

      {tab === 'stages' && (
        <Panel
          title="Development workflow"
          subtitle="Stages are organisational milestones, not safety approvals"
          actions={
            <Select
              value={stageFilter}
              onChange={setStageFilter}
              placeholder="All statuses"
              options={STAGE_STATUSES.map((s) => ({ value: s, label: s }))}
            />
          }
        >
          {filteredStages.length === 0 ? (
            <EmptyState title="No stages" message="Create stages to structure the development programme." icon="branch" />
          ) : (
            <div className="stage-board">
              {filteredStages.map((stage: any) => {
                const revision = revisions.data?.find((r: any) => r.id === stage.revision_id);
                return (
                  <div className={`stage-card stage-status-${stage.status.replace(/\s+/g, '-').toLowerCase()}`} key={stage.id}>
                    <div className="stage-card-head">
                      <span className="stage-index">{String((stage.sort_order ?? 0) + 1).padStart(2, '0')}</span>
                      <button className="stage-card-name" onClick={() => setEditing({ ...stage, __entity: 'stage' })}>
                        {stage.name}
                      </button>
                      <Badge>{stage.status}</Badge>
                    </div>
                    <div className="stage-card-meta">
                      {revision ? <button className="link-btn tiny" onClick={() => navigate(`#/revision/${revision.id}`)}>{revision.label}</button> : <span className="muted tiny">No revision</span>}
                      <span className="muted tiny">{stage.started_at ? `started ${fmtDate(stage.started_at)}` : 'not started'}</span>
                      <span className="muted tiny">{stage.completed_at ? `done ${fmtDate(stage.completed_at)}` : ''}</span>
                    </div>
                    {stage.description && <p className="stage-desc">{stage.description}</p>}
                    <div className="stage-card-actions">
                      <Select
                        value={stage.status}
                        onChange={(v) => void setStageStatus(stage, v)}
                        options={STAGE_STATUSES.map((s) => ({ value: s, label: s }))}
                      />
                      <Button size="sm" icon="log" onClick={() => navigate(`#/datalog?stage=${stage.id}`)}>History</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="progress-line">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="small muted">{completed} of {stages.data?.length ?? 0} stages complete</span>
          </div>
        </Panel>
      )}

      {tab === 'rockets' && (
        <div className="stack">
          <Panel title="Rockets" actions={<Button size="sm" icon="plus" onClick={() => setEditing({ __entity: 'rocket', project_id: projectId })}>New rocket</Button>}>
            <DataTable
              rows={rockets.data ?? []}
              columns={[
                { key: 'name', label: 'Rocket' },
                { key: 'identifier', label: 'Identifier', mono: true },
                { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge> },
                { key: 'description', label: 'Description' },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  render: (r) => (
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" title="Edit" onClick={() => setEditing({ ...r, __entity: 'rocket' })}>
                        <Icon name="edit" size={14} />
                      </button>
                      <button
                        className="icon-btn danger"
                        title="Delete"
                        onClick={async () => {
                          const ok = await confirm({ title: 'Delete rocket?', message: r.name, confirmLabel: 'Delete', danger: true });
                          if (!ok) return;
                          await api.remove('rocket', r.id);
                          rockets.reload();
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  ),
                },
              ]}
              empty={<EmptyState title="No rockets" icon="rocket" />}
            />
          </Panel>
          <Panel
            title="Design revisions"
            actions={
              <>
                <Button size="sm" icon="compare" onClick={() => navigate('#/revisions')}>Compare revisions</Button>
                <Button size="sm" icon="plus" onClick={() => setEditing({ __entity: 'revision', project_id: projectId, rocket_id: rockets.data?.[0]?.id ?? '', status: 'In design' })}>
                  New revision
                </Button>
              </>
            }
          >
            <DataTable
              rows={revisions.data ?? []}
              columns={[
                { key: 'label', label: 'Revision', render: (r) => <span className="link-like">{r.label}</span> },
                { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge> },
                { key: 'description', label: 'Description' },
                { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at) },
              ]}
              onRowClick={(r) => navigate(`#/revision/${r.id}`)}
              empty={<EmptyState title="No revisions" icon="branch" />}
            />
          </Panel>
        </div>
      )}

      {tab === 'campaigns' && (
        <Panel
          title="Testing campaigns"
          actions={<Button size="sm" icon="plus" onClick={() => setEditing({ __entity: 'campaign', project_id: projectId, status: 'Planned', kind: 'Ground', started_at: new Date().toISOString().slice(0, 10) })}>New campaign</Button>}
        >
          <DataTable
            rows={campaigns.data ?? []}
            columns={[
              { key: 'name', label: 'Campaign' },
              { key: 'kind', label: 'Kind' },
              { key: 'status', label: 'Status', render: (c) => <Badge>{c.status}</Badge> },
              { key: 'started_at', label: 'Started', render: (c) => fmtDate(c.started_at) },
              { key: 'ended_at', label: 'Ended', render: (c) => fmtDate(c.ended_at) },
              {
                key: 'actions',
                label: '',
                align: 'right',
                render: (c) => (
                  <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" onClick={() => setEditing({ ...c, __entity: 'campaign' })}>
                      <Icon name="edit" size={14} />
                    </button>
                    <button className="icon-btn" onClick={() => navigate(`#/ground`)}>
                      <Icon name="beaker" size={14} />
                    </button>
                  </div>
                ),
              },
            ]}
            empty={<EmptyState title="No campaigns" icon="beaker" />}
          />
        </Panel>
      )}

      {tab === 'notes' && (
        <Panel title="Engineering notes">
          <NotesPanel notes={notes.data ?? []} projectId={projectId} entityType="project" entityId={projectId} onChange={() => { notes.reload(); setNoteTick(noteTick + 1); }} />
        </Panel>
      )}

      {tab === 'timeline' && (
        <Panel title="Development timeline" subtitle="Chronological project history">
          <div className="timeline">
            {(activity.data?.entries ?? []).map((e: any) => (
              <button className="timeline-item clickable" key={`${e.type}-${e.id}`} onClick={() => navigate(e.route || '#/datalog')}>
                <span className="timeline-dot" />
                <div>
                  <div className="list-title">
                    {e.title} <span className="muted tiny">· {e.type}</span>
                  </div>
                  <div className="muted small">{e.subtitle || e.detail}</div>
                  <div className="muted tiny">{fmtDateTime(e.at)}</div>
                </div>
              </button>
            ))}
            {(activity.data?.entries ?? []).length === 0 && <EmptyState title="No history yet" icon="log" />}
          </div>
        </Panel>
      )}

      {editing && (
        <Modal
          title={
            editing.__entity === 'rocket'
              ? editing.id
                ? 'Edit rocket'
                : 'New rocket'
              : editing.__entity === 'revision'
                ? editing.id
                  ? 'Edit revision'
                  : 'New design revision'
                : editing.__entity === 'campaign'
                  ? editing.id
                    ? 'Edit campaign'
                    : 'New testing campaign'
                  : editing.id
                    ? 'Edit development stage'
                    : 'New development stage'
          }
          onClose={() => setEditing(null)}
          size="lg"
          footer={
            <>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => saveEntity(editing.__entity, editing)}>Save</Button>
            </>
          }
        >
          <RecordEditor
            entity={editing.__entity}
            value={editing}
            onChange={(patch) => setEditing((d: any) => ({ ...d, ...patch }))}
            projectId={projectId}
          />
        </Modal>
      )}
    </div>
  );
}
