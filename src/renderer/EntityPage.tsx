import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useApp, useAsync } from './state';
import {
  Badge,
  Button,
  Column,
  DataTable,
  EmptyState,
  ErrorBox,
  Icon,
  Input,
  KeyValue,
  Modal,
  PageHeader,
  Panel,
  SearchInput,
  Select,
  Tabs,
  Textarea,
  Toolbar,
} from './ui';
import { FORMS } from './forms';
import { RecordEditor, RecordForm } from './RecordForm';
import { fmtDate, fmtDateTime, relativeTime, bytes } from './format';
import { ImportWizard } from './ImportWizard';
import { ENTITY_LABELS } from '../shared/constants';

export function DocumentPanel({
  documents,
  projectId,
  entityType,
  entityId,
  onChange,
  compact,
}: {
  documents: any[];
  projectId: string;
  entityType: string;
  entityId: string;
  onChange: () => void;
  compact?: boolean;
}) {
  const { notify, confirm } = useApp();
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    const picked = await api.pickOpen({ title: 'Attach files', multi: true });
    if (picked.canceled || !picked.paths?.length) return;
    setBusy(true);
    try {
      await api.uploadDocuments({ projectId, entityType, entityId, paths: picked.paths, kind: 'Other' });
      notify(`${picked.paths.length} file(s) attached`, 'success');
      onChange();
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const openPreview = async (doc: any) => {
    try {
      setPreview(await api.documentPreview(doc.id));
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const removeDoc = async (doc: any) => {
    const ok = await confirm({
      title: 'Remove document?',
      message: `“${doc.title}” will be removed from the engineering library.`,
      details: 'The stored file is retained on disk for recovery unless you also delete the file.',
      confirmLabel: 'Remove record',
      danger: true,
    });
    if (!ok) return;
    await api.removeDocument(doc.id, false);
    onChange();
  };

  return (
    <div className="stack">
      <Toolbar>
        <Button size="sm" icon="upload" onClick={upload} disabled={busy}>
          Attach files
        </Button>
        <span className="muted small">{documents.length} document(s)</span>
      </Toolbar>
      {documents.length === 0 ? (
        <EmptyState title="No documents attached" message="Attach datasheets, procedures, images or measurement records." icon="doc" />
      ) : (
        <DataTable
          columns={[
            { key: 'title', label: 'Title', render: (d) => <span className="link-like">{d.title}</span> },
            { key: 'kind', label: 'Kind' },
            { key: 'original_name', label: 'File', render: (d) => <span className="mono small">{d.original_name}</span> },
            { key: 'size', label: 'Size', align: 'right', render: (d) => bytes(d.size) },
            { key: 'created_at', label: 'Added', render: (d) => fmtDate(d.created_at) },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (d) => (
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn" title="Preview" onClick={() => openPreview(d)}>
                    <Icon name="doc" size={14} />
                  </button>
                  <button className="icon-btn" title="Open with system viewer" onClick={() => api.openPath(d.stored_path).catch((err) => notify(err.message, 'error'))}>
                    <Icon name="link" size={14} />
                  </button>
                  <button className="icon-btn" title="Show in folder" onClick={() => api.reveal(d.stored_path).catch((err) => notify(err.message, 'error'))}>
                    <Icon name="folder" size={14} />
                  </button>
                  <button className="icon-btn danger" title="Remove" onClick={() => removeDoc(d)}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ),
            },
          ]}
          rows={documents}
          dense={compact}
          onRowClick={openPreview}
        />
      )}
      {preview && (
        <Modal title={preview.title} onClose={() => setPreview(null)} size="lg">
          <div className="stack">
            <KeyValue
              columns={2}
              items={[
                ['Kind', preview.kind],
                ['Original file', <span className="mono small">{preview.original_name}</span>],
                ['Size', bytes(preview.size)],
                ['SHA-256', <span className="mono tiny">{preview.checksum}</span>],
                ['Added', fmtDateTime(preview.created_at)],
                ['Stored path', <span className="mono tiny">{preview.stored_path}</span>],
              ]}
            />
            {preview.description && <p>{preview.description}</p>}
            {preview.preview?.kind === 'image' && <img className="doc-image" src={preview.preview.dataUrl} alt={preview.title} />}
            {preview.preview?.kind === 'text' && <pre className="code-block scroll">{preview.preview.text}</pre>}
            {preview.preview?.kind === 'unsupported' && (
              <div className="muted">This file type is not previewed in the application. Use “Open with system viewer”.</div>
            )}
            {preview.missing && <div className="error-box">The stored file is missing from disk.</div>}
            <div className="modal-actions-row">
              <Button icon="link" onClick={() => api.openPath(preview.stored_path)}>
                Open with system viewer
              </Button>
              <Button icon="folder" onClick={() => api.reveal(preview.stored_path)}>
                Show in folder
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function NotesPanel({
  notes,
  projectId,
  entityType,
  entityId,
  onChange,
}: {
  notes: any[];
  projectId: string;
  entityType: string;
  entityId: string;
  onChange: () => void;
}) {
  const { notify } = useApp();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const add = async () => {
    if (!title.trim()) return;
    await api.create('note', { project_id: projectId, entity_type: entityType, entity_id: entityId, title, body });
    setTitle('');
    setBody('');
    onChange();
    notify('Engineering note recorded', 'success');
  };

  return (
    <div className="stack">
      <div className="note-composer">
        <Input placeholder="Note title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea rows={3} placeholder="Observation, decision, rationale…" value={body} onChange={(e) => setBody(e.target.value)} />
        <Button size="sm" icon="plus" onClick={add} disabled={!title.trim()}>
          Add note
        </Button>
      </div>
      {notes.length === 0 && <EmptyState title="No engineering notes" message="Record decisions and observations so the history stays traceable." icon="doc" />}
      {notes.map((n) => (
        <div className="note-item" key={n.id}>
          <div className="note-head">
            <strong>{n.title}</strong>
            <span className="muted small">{fmtDateTime(n.created_at)}</span>
          </div>
          <p>{n.body}</p>
        </div>
      ))}
    </div>
  );
}

export function IssuesPanel({
  issues,
  projectId,
  links,
  onChange,
}: {
  issues: any[];
  projectId: string;
  links: Record<string, string>;
  onChange: () => void;
}) {
  const { navigate, notify } = useApp();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<any>({ severity: 'Medium', status: 'Open', category: 'Observation' });

  const save = async () => {
    if (!draft.title?.trim()) return;
    await api.create('issue', {
      ...draft,
      project_id: projectId,
      ...links,
      identified_at: draft.identified_at || new Date().toISOString(),
    });
    setCreating(false);
    setDraft({ severity: 'Medium', status: 'Open', category: 'Observation' });
    onChange();
    notify('Issue recorded', 'success');
  };

  return (
    <div className="stack">
      <Toolbar>
        <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
          Record issue or observation
        </Button>
      </Toolbar>
      {issues.length === 0 ? (
        <EmptyState title="No issues linked" message="Document anomalies, unexpected results and observations against this record." icon="alert" />
      ) : (
        <DataTable
          rows={issues}
          columns={[
            { key: 'title', label: 'Issue', render: (i) => <span className="link-like">{i.title}</span> },
            { key: 'severity', label: 'Severity', render: (i) => <Badge>{i.severity}</Badge> },
            { key: 'status', label: 'Status', render: (i) => <Badge>{i.status}</Badge> },
            { key: 'identified_at', label: 'Identified', render: (i) => fmtDate(i.identified_at || i.created_at) },
            { key: 'resolution', label: 'Resolution', render: (i) => <span className="ellipsis">{i.resolution || '—'}</span> },
          ]}
          onRowClick={(i) => navigate(`#/issues?issue=${i.id}`)}
        />
      )}
      {creating && (
        <Modal
          title="Record issue"
          onClose={() => setCreating(false)}
          footer={
            <>
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="primary" onClick={save} disabled={!draft.title?.trim()}>
                Save issue
              </Button>
            </>
          }
        >
          <RecordEditor entity="issue" value={draft} onChange={(patch) => setDraft((d: any) => ({ ...d, ...patch }))} projectId={projectId} />
        </Modal>
      )}
    </div>
  );
}

export function DatasetPanel({
  datasets,
  projectId,
  attach,
  onChange,
  supportDatasets,
}: {
  datasets: any[];
  projectId: string;
  attach: { testId?: string; flightId?: string; runId?: string; label?: string };
  onChange: () => void;
  supportDatasets: 'test' | 'flight' | 'run';
}) {
  const { navigate, notify, confirm } = useApp();
  const [importing, setImporting] = useState(false);

  return (
    <div className="stack">
      <Toolbar>
        <Button size="sm" icon="upload" variant="primary" onClick={() => setImporting(true)}>
          Import dataset
        </Button>
        <span className="muted small">{datasets.length} dataset(s) attached</span>
      </Toolbar>
      {datasets.length === 0 ? (
        <EmptyState title="No recorded data" message="Import a recording from a data logger, flight computer or DAQ." icon="chart" />
      ) : (
        <DataTable
          rows={datasets}
          columns={[
            { key: 'name', label: 'Dataset', render: (d) => <span className="link-like">{d.name}</span> },
            { key: 'kind', label: 'Kind', render: (d) => <Badge tone={d.kind === 'processed' ? 'warn' : 'neutral'}>{d.kind}</Badge> },
            { key: 'points', label: 'Rows', align: 'right', mono: true, render: (d) => Number(d.points).toLocaleString() },
            { key: 'channels_count', label: 'Channels', align: 'right', mono: true },
            { key: 'recorded_at', label: 'Recorded', render: (d) => fmtDateTime(d.recorded_at) },
            {
              key: 'quality',
              label: 'Quality',
              render: (d) => <Badge tone={d.quality_status === 'warning' ? 'warn' : d.quality_status === 'error' ? 'danger' : 'ok'}>{d.quality_status || 'ok'}</Badge>,
            },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (d) => (
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn" title="Open in analysis" onClick={() => navigate(`#/analysis?dataset=${d.id}`)}>
                    <Icon name="chart" size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Export CSV"
                    onClick={() => api.exportDatasetCsv(d.id, d.name).then((r) => !r.canceled && notify(`Exported to ${r.path}`, 'success')).catch((e) => notify(e.message, 'error'))}
                  >
                    <Icon name="download" size={14} />
                  </button>
                  <button
                    className="icon-btn danger"
                    title="Remove dataset"
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Remove dataset?',
                        message: `“${d.name}” will be removed from the project.`,
                        details: 'The dataset folder is moved to the archive folder in the data directory before removal. Original recordings are never silently deleted.',
                        confirmLabel: 'Remove dataset',
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await api.removeDataset(d.id);
                        notify('Dataset removed (files archived)', 'success');
                        onChange();
                      } catch (err: any) {
                        notify(err.message, 'error');
                      }
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ),
            },
          ]}
          onRowClick={(d) => navigate(`#/analysis?dataset=${d.id}`)}
        />
      )}
      {importing && (
        <ImportWizard
          open={importing}
          projectId={projectId}
          attach={attach}
          onClose={() => setImporting(false)}
          onImported={() => {
            onChange();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

function EntityDetail({
  entity,
  id,
  basePath,
  title,
  singular,
  supportDatasets,
  detailExtras,
}: {
  entity: string;
  id: string;
  basePath: string;
  title: string;
  singular: string;
  supportDatasets?: 'test' | 'flight' | 'run';
  detailExtras?: (row: any, reload: () => void) => React.ReactNode;
}) {
  const { navigate, notify, projectId, project, confirm, refresh } = useApp();
  const [tab, setTab] = useState('record');
  const detail = useAsync(() => api.get(entity, id), [entity, id]);
  const [draft, setDraft] = useState<any>({});
  const [dirty, setDirty] = useState(false);
  const [linked, setLinked] = useState<any>({ documents: [], notes: [], issues: [], datasets: [], activity: [] });

  const loadLinked = () => {
    api.linked(entity, id).then(setLinked).catch(() => undefined);
  };

  useEffect(() => {
    if (detail.data) {
      setDraft({ ...detail.data });
      setDirty(false);
    }
    loadLinked();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.id, detail.data?.updated_at]);

  const reload = () => {
    detail.reload();
    loadLinked();
    refresh();
  };

  if (detail.loading && !detail.data) return <div className="loading">Loading {singular}…</div>;
  if (detail.error) return <ErrorBox message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return null;

  const record = draft;
  const displayName = record.label || record.name || record.title || record.test_no || singular;

  const save = async () => {
    try {
      const patch: any = {};
      for (const [key, value] of Object.entries(draft)) {
        if (['id', 'created_at', 'updated_at'].includes(key)) continue;
        if (/_(json)$/.test(key)) {
          patch[key] = typeof value === 'string' ? value : JSON.stringify(value ?? {});
        } else patch[key] = value;
      }
      await api.update(entity, id, patch);
      setDirty(false);
      notify(`${ENTITY_LABELS[entity] ?? singular} saved`, 'success');
      reload();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${singular}?`,
      message: `“${displayName}” and its dependent records will be removed.`,
      details: 'This cannot be undone from the application. Create a backup first if the record matters.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove(entity, id);
      notify(`${singular} deleted`, 'success');
      refresh();
      navigate(basePath);
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const datasetAttach =
    entity === 'test'
      ? { testId: id, label: `test “${displayName}”` }
      : entity === 'flight'
        ? { flightId: id, label: `flight “${displayName}”` }
        : entity === 'run'
          ? { runId: id, label: `experiment run “${displayName}”` }
          : null;

  const links: [string, React.ReactNode][] = [['Project', project ? <button className="link-btn" onClick={() => navigate(`#/project/${project.id}`)}>{project.name}</button> : '—']];
  if (record.revision_id) links.push(['Rocket revision', <span className="mono small">{record.revision_id.slice(0, 8)}</span>]);
  if (record.campaign_id) links.push(['Campaign', <span className="mono small">{record.campaign_id.slice(0, 8)}</span>]);
  if (record.rocket_id) links.push(['Rocket', <span className="mono small">{record.rocket_id.slice(0, 8)}</span>]);
  if (record.electronics_config_id) links.push(['Electronics config', <span className="mono small">{record.electronics_config_id.slice(0, 8)}</span>]);
  links.push(['Created', fmtDateTime(record.created_at)]);
  links.push(['Last update', `${fmtDateTime(record.updated_at)} (${relativeTime(record.updated_at)})`]);

  return (
    <div className="detail-page">
      <PageHeader
        breadcrumbs={[
          { label: title, onClick: () => navigate(basePath) },
          { label: displayName },
        ]}
        title={
          <span className="title-with-badge">
            {displayName}
            {record.status && <Badge>{record.status}</Badge>}
            {record.severity && <Badge>{record.severity}</Badge>}
          </span>
        }
        subtitle={
          <span className="muted">
            {ENTITY_LABELS[entity] ?? title} · {record.test_no || record.flight_no || record.category || record.kind || record.type || ''}
          </span>
        }
        actions={
          <>
            <Button onClick={() => navigate(basePath)} icon="chevron">
              Back to list
            </Button>
            {dirty && (
              <Button onClick={() => { setDraft({ ...detail.data }); setDirty(false); }}>Discard</Button>
            )}
            <Button variant="primary" icon="save" onClick={save} disabled={!dirty}>
              Save changes
            </Button>
            <Button variant="danger" icon="trash" onClick={remove}>
              Delete
            </Button>
          </>
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'record', label: 'Record' },
          ...(supportDatasets ? [{ key: 'data', label: 'Datasets', count: linked.datasets?.length ?? 0 }] : []),
          { key: 'documents', label: 'Documents', count: linked.documents?.length ?? 0 },
          { key: 'notes', label: 'Notes', count: linked.notes?.length ?? 0 },
          { key: 'issues', label: 'Issues', count: linked.issues?.length ?? 0 },
          { key: 'activity', label: 'Activity' },
        ]}
      />

      {tab === 'record' && (
        <div className="detail-grid">
          <Panel title={`${ENTITY_LABELS[entity] ?? 'Record'} details`} className="detail-main">
            <RecordForm
              entity={entity}
              value={record}
              projectId={projectId}
              onChange={(patch) => {
                setDraft((prev: any) => ({ ...prev, ...patch }));
                setDirty(true);
              }}
            />
          </Panel>
          <div className="stack">
            <Panel title="Traceability">
              <KeyValue columns={1} items={links} />
            </Panel>
            {detailExtras?.(record, reload)}
          </div>
        </div>
      )}

      {tab === 'data' && datasetAttach && (
        <Panel title="Recorded data">
          <DatasetPanel
            datasets={linked.datasets ?? []}
            projectId={projectId}
            attach={datasetAttach}
            supportDatasets={supportDatasets!}
            onChange={reload}
          />
        </Panel>
      )}

      {tab === 'documents' && (
        <Panel title="Attached documents">
          <DocumentPanel
            documents={linked.documents ?? []}
            projectId={projectId}
            entityType={entity}
            entityId={id}
            onChange={loadLinked}
          />
        </Panel>
      )}

      {tab === 'notes' && (
        <Panel title="Engineering notes">
          <NotesPanel notes={linked.notes ?? []} projectId={projectId} entityType={entity} entityId={id} onChange={loadLinked} />
        </Panel>
      )}

      {tab === 'issues' && (
        <Panel title="Linked issues and observations">
          <IssuesPanel
            issues={linked.issues ?? []}
            projectId={projectId}
            links={
              entity === 'test' ? { test_id: id } : entity === 'flight' ? { flight_id: id } : entity === 'revision' ? { revision_id: id } : {}
            }
            onChange={loadLinked}
          />
        </Panel>
      )}

      {tab === 'activity' && (
        <Panel title="Project activity">
          {(linked.activity ?? []).length === 0 ? (
            <EmptyState title="No activity recorded" icon="log" />
          ) : (
            <div className="timeline">
              {(linked.activity ?? []).map((a: any) => (
                <div className="timeline-item" key={a.id}>
                  <span className="timeline-dot" />
                  <div>
                    <div>
                      <strong>{a.title}</strong> <span className="muted">· {a.detail}</span>
                    </div>
                    <div className="muted small">{fmtDateTime(a.at)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* List page                                                           */
/* ------------------------------------------------------------------ */

export function EntityPage({
  entity,
  basePath,
  title,
  singular,
  icon,
  columns,
  listWhere,
  createDefaults,
  supportDatasets,
  detailExtras,
  intro,
  filterField,
  extraActions,
}: {
  entity: string;
  basePath: string;
  title: string;
  singular: string;
  icon: string;
  columns: Column[];
  listWhere?: (projectId: string) => Record<string, any>;
  createDefaults?: (projectId: string) => Record<string, any>;
  supportDatasets?: 'test' | 'flight' | 'run';
  detailExtras?: (row: any, reload: () => void) => React.ReactNode;
  intro?: string;
  filterField?: { key: string; label: string; options: string[] };
  extraActions?: React.ReactNode;
}) {
  const { projectId, route, navigate, notify, refresh, confirm, projects } = useApp();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<any>({});

  useEffect(() => {
    setSearch('');
    setFilter('');
  }, [projectId]);

  const rows = useAsync(
    () =>
      projectId
        ? api.list(entity, {
            where: { project_id: projectId, ...(filterField && filter ? { [filterField.key]: filter } : {}), ...(listWhere?.(projectId) ?? {}) },
            q: search || undefined,
            limit: 1000,
          })
        : Promise.resolve([]),
    [projectId, entity, search, filter],
  );

  if (!projects.length) {
    return (
      <div className="page">
        <PageHeader title={title} subtitle={intro} />
        <EmptyState
          title="No project yet"
          message="Create a project to start recording development work."
          icon="folder"
          action={<Button variant="primary" icon="plus" onClick={() => navigate('#/projects')}>Go to projects</Button>}
        />
      </div>
    );
  }

  const detailId = route.id || route.query.issue || route.query.id || route.query.component || route.query.sensor || route.query.doc || null;
  if (detailId) {
    return (
      <EntityDetail
        entity={entity}
        id={detailId}
        basePath={basePath}
        title={title}
        singular={singular}
        supportDatasets={supportDatasets}
        detailExtras={detailExtras}
      />
    );
  }

  const startCreate = () => {
    setDraft({ ...(createDefaults?.(projectId) ?? {}), project_id: projectId });
    setCreating(true);
  };

  const saveNew = async () => {
    try {
      const payload: any = { ...draft, project_id: projectId };
      if (entity === 'project') delete payload.project_id;
      const created = await api.create(entity, payload);
      setCreating(false);
      notify(`${singular} created`, 'success');
      refresh();
      rows.reload();
      navigate(`${basePath}/${created.id}`);
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="page">
      <PageHeader
        title={title}
        subtitle={intro}
        actions={
          <>
            {extraActions}
            <Button variant="primary" icon="plus" onClick={startCreate}>
              New {singular}
            </Button>
          </>
        }
      />
      <Panel
        dense
        actions={
          <div className="toolbar-inline">
            {filterField && (
              <Select
                value={filter}
                onChange={setFilter}
                placeholder={`All ${filterField.label.toLowerCase()}`}
                options={filterField.options.map((o) => ({ value: o, label: o }))}
              />
            )}
            <SearchInput value={search} onChange={setSearch} placeholder={`Search ${title.toLowerCase()}…`} />
          </div>
        }
        title={`${rows.data?.length ?? 0} record(s)`}
      >
        {rows.error && <ErrorBox message={rows.error} onRetry={rows.reload} />}
        {rows.loading && !rows.data ? (
          <div className="loading">Loading…</div>
        ) : (
          <DataTable
            columns={columns}
            rows={rows.data ?? []}
            selectedKey={route.query?.id ?? null}
            onRowClick={(row) => navigate(`${basePath}/${row.id}`)}
            empty={
              <EmptyState
                title={`No ${title.toLowerCase()} yet`}
                message={intro}
                icon={icon}
                action={
                  <Button variant="primary" icon="plus" onClick={startCreate}>
                    New {singular}
                  </Button>
                }
              />
            }
          />
        )}
      </Panel>

      {creating && (
        <Modal
          title={`New ${singular}`}
          onClose={() => setCreating(false)}
          size="lg"
          footer={
            <>
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="primary" onClick={saveNew}>
                Create {singular}
              </Button>
            </>
          }
        >
          <RecordEditor entity={entity} value={draft} onChange={(patch) => setDraft((d: any) => ({ ...d, ...patch }))} projectId={projectId} />
        </Modal>
      )}
    </div>
  );
}
