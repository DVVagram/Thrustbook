import React, { useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { EntityPage } from '../EntityPage';
import { RecordEditor } from '../RecordForm';
import { ImportWizard } from '../ImportWizard';
import { Badge, Button, DataTable, EmptyState, Icon, Modal, Panel } from '../ui';
import { fmtDate, fmtDateTime } from '../format';

function RunsPanel({ experiment }: { experiment: any }) {
  const { projectId, navigate, notify, confirm } = useApp();
  const runs = useAsync(() => api.list('run', { where: { experiment_id: experiment.id }, limit: 200, orderBy: 'performed_at', order: 'asc' }), [experiment.id]);
  const datasets = useAsync(
    () =>
      api.list('dataset', { where: { project_id: projectId }, limit: 500 }).then((rows) => rows.filter((d: any) => runs.data?.some((r: any) => r.id === d.run_id))),
    [projectId, runs.data],
  );
  const [editing, setEditing] = useState<any>(null);
  const [importFor, setImportFor] = useState<any>(null);

  const save = async () => {
    try {
      if (editing.id) await api.update('run', editing.id, editing);
      else await api.create('run', { ...editing, experiment_id: experiment.id, project_id: projectId });
      setEditing(null);
      runs.reload();
      datasets.reload();
      notify('Run saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="stack">
      <Panel
        title={`Runs (${runs.data?.length ?? 0})`}
        actions={
          <Button size="sm" icon="plus" onClick={() => setEditing({ project_id: projectId, experiment_id: experiment.id, status: 'Planned', performed_at: new Date().toISOString() })}>
            Add run
          </Button>
        }
      >
        {(runs.data ?? []).length === 0 ? (
          <EmptyState title="No runs recorded" message="Add repeated runs to compare experimental conditions." icon="flask" />
        ) : (
          <DataTable
            rows={runs.data ?? []}
            columns={[
              { key: 'label', label: 'Run' },
              { key: 'performed_at', label: 'Performed', render: (r) => fmtDateTime(r.performed_at) },
              { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge> },
              { key: 'configuration', label: 'Configuration' },
              {
                key: 'actions',
                label: '',
                align: 'right',
                render: (r) => (
                  <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title="Import run dataset" onClick={() => setImportFor(r)}>
                      <Icon name="upload" size={14} />
                    </button>
                    <button className="icon-btn" title="Edit run" onClick={() => setEditing({ ...r })}>
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      className="icon-btn danger"
                      title="Delete run"
                      onClick={async () => {
                        const ok = await confirm({ title: 'Delete run?', message: r.label, confirmLabel: 'Delete', danger: true });
                        if (!ok) return;
                        await api.remove('run', r.id);
                        runs.reload();
                        datasets.reload();
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ),
              },
            ]}
            onRowClick={(r) => navigate(`#/analysis?dataset=${datasets.data?.find((d: any) => d.run_id === r.id)?.id ?? ''}`)}
          />
        )}
      </Panel>

      <Panel title="Run datasets" actions={<Button size="sm" icon="compare" onClick={() => navigate('#/compare')}>Compare</Button>}>
        {(datasets.data ?? []).length === 0 ? (
          <div className="muted small">No datasets are attached to runs of this experiment.</div>
        ) : (
          <DataTable
            rows={datasets.data ?? []}
            columns={[
              { key: 'name', label: 'Dataset', render: (d) => <span className="link-like">{d.name}</span> },
              { key: 'run_id', label: 'Run', render: (d) => runs.data?.find((r: any) => r.id === d.run_id)?.label ?? '—' },
              { key: 'points', label: 'Rows', align: 'right', mono: true, render: (d) => Number(d.points).toLocaleString() },
              { key: 'recorded_at', label: 'Recorded', render: (d) => fmtDate(d.recorded_at) },
            ]}
            onRowClick={(d) => navigate(`#/analysis?dataset=${d.id}`)}
          />
        )}
      </Panel>

      {editing && (
        <Modal
          title={editing.id ? 'Edit run' : 'New experiment run'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save}>Save run</Button>
            </>
          }
        >
          <RecordEditor entity="run" value={editing} onChange={(patch) => setEditing((d: any) => ({ ...d, ...patch }))} projectId={projectId} />
        </Modal>
      )}

      {importFor && (
        <ImportWizard
          open={!!importFor}
          projectId={projectId}
          attach={{ runId: importFor.id, label: `run “${importFor.label}”` }}
          onClose={() => setImportFor(null)}
          onImported={() => {
            datasets.reload();
            runs.reload();
          }}
        />
      )}
    </div>
  );
}

export default function ExperimentsPage() {
  return (
    <EntityPage
      entity="experiment"
      basePath="#/experiments"
      title="Experimental Testing"
      singular="experiment"
      icon="flask"
      intro="Define custom experiments with independent and measured variables, then record repeated runs and their datasets."
      createDefaults={() => ({ status: 'Planned' })}
      columns={[
        { key: 'name', label: 'Experiment', render: (e) => <span className="link-like">{e.name}</span> },
        { key: 'status', label: 'Status', render: (e) => <Badge>{e.status}</Badge>, width: '110px' },
        { key: 'objective', label: 'Objective' },
        { key: 'measured_vars', label: 'Measured variables' },
        { key: 'created_at', label: 'Created', render: (e) => fmtDate(e.created_at), width: '110px' },
      ]}
      detailExtras={(row) => <RunsPanel experiment={row} />}
    />
  );
}
