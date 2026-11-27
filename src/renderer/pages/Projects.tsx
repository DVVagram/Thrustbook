import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { Badge, Button, EmptyState, Field, Input, Modal, PageHeader, Panel, SearchInput, Select, Textarea } from '../ui';
import { fmtDate, relativeTime } from '../format';
import { PROJECT_STATUSES } from '../../shared/constants';

export default function ProjectsPage() {
  const { projects, settings, refresh, navigate, notify, setProject, confirm, route } = useApp();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<any>({ status: 'Planning' });
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (route.query.new === '1') {
      setDraft({ status: 'Planning' });
      setCreating(true);
    }
  }, [route.query.new]);

  const stats = useAsync(() => api.dashboard(), [projects.length]);

  const filtered = projects.filter((p) => {
    if (!showArchived && p.archived) return false;
    if (!search.trim()) return true;
    const term = search.toLowerCase();
    return `${p.name} ${p.code} ${p.description} ${p.objectives} ${p.tags}`.toLowerCase().includes(term);
  });

  const create = async () => {
    if (!draft.name?.trim()) {
      notify('Project name is required', 'warn');
      return;
    }
    setBusy(true);
    try {
      const result = await api.bootstrap(draft);
      notify(`Project “${result.project.name}” created with ${result.stages.length} development stages`, 'success');
      setCreating(false);
      setDraft({ status: 'Planning' });
      await refresh();
      setProject(result.project.id);
      navigate(`#/project/${result.project.id}`);
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const importProject = async () => {
    try {
      const result = await api.importProject();
      if (result.canceled) return;
      notify(`Imported ${result.result.projectName}`, 'success');
      await refresh();
      navigate(`#/project/${result.result.projectId}`);
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const archive = async (project: any) => {
    const ok = await confirm({
      title: project.archived ? 'Restore project?' : 'Archive project?',
      message: project.archived
        ? `“${project.name}” will be visible again.`
        : `“${project.name}” will be hidden from active lists. All data is preserved.`,
      confirmLabel: project.archived ? 'Restore' : 'Archive',
    });
    if (!ok) return;
    await api.update('project', project.id, { archived: project.archived ? 0 : 1 });
    await refresh();
  };

  const remove = async (project: any) => {
    const ok = await confirm({
      title: 'Delete project permanently?',
      message: `“${project.name}” and every connected test, flight, dataset, document and issue will be removed from the database.`,
      details: 'Create a backup or export the project first. Stored dataset folders are not deleted by this action.',
      confirmLabel: 'Delete project',
      danger: true,
    });
    if (!ok) return;
    await api.remove('project', project.id);
    notify('Project deleted', 'success');
    await refresh();
  };

  return (
    <div className="page">
      <PageHeader
        title="Projects"
        subtitle="Each project is a container for the complete development and testing history of a rocket programme."
        actions={
          <>
            <Button icon="upload" onClick={importProject}>
              Import project
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New project
            </Button>
          </>
        }
      />

      <Panel
        title={`${filtered.length} project(s)`}
        actions={
          <div className="toolbar-inline">
            <label className="checkbox">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              <span>Show archived</span>
            </label>
            <SearchInput value={search} onChange={setSearch} placeholder="Search projects…" />
          </div>
        }
        dense
      >
        {filtered.length === 0 ? (
          <EmptyState
            title="No projects"
            message="Create a project to start documenting rocket development, tests and measurements."
            icon="folder"
            action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New project</Button>}
          />
        ) : (
          <div className="project-cards grid">
            {filtered.map((project) => {
              const summary = stats.data?.projects?.find((p: any) => p.id === project.id);
              return (
                <div key={project.id} className={`project-card large ${project.archived ? 'archived' : ''}`}>
                  <div className="project-card-head">
                    <span className="project-code">{project.code || 'NO-CODE'}</span>
                    <Badge>{project.archived ? 'Archived' : project.status}</Badge>
                  </div>
                  <button className="project-name link-like" onClick={() => { setProject(project.id); navigate(`#/project/${project.id}`); }}>
                    {project.name}
                  </button>
                  <div className="project-stage">{project.stage || 'No stage set'}</div>
                  <p className="project-desc">{project.objectives || project.description || 'No objectives recorded.'}</p>
                  <div className="project-metrics">
                    <span>{summary?.counts?.revisions ?? 0} revisions</span>
                    <span>{summary?.counts?.tests ?? 0} tests</span>
                    <span>{summary?.counts?.flights ?? 0} flights</span>
                    <span>{summary?.counts?.datasets ?? 0} datasets</span>
                    {(summary?.counts?.open_issues ?? 0) > 0 && <span className="warn-text">{summary.counts.open_issues} open issues</span>}
                  </div>
                  <div className="project-card-foot">
                    <span className="muted small">Created {fmtDate(project.created_at)} · updated {relativeTime(project.updated_at)}</span>
                    <div className="row-actions">
                      <Button size="sm" variant="subtle" icon="download" title="Export project" onClick={() => api.exportProject(project.id).then((r) => !r.canceled && notify(`Exported ${r.counts.datasets ?? 0} datasets`, 'success')).catch((e) => notify(e.message, 'error'))}>
                        Export
                      </Button>
                      <Button size="sm" variant="subtle" icon={project.archived ? 'refresh' : 'box'} title={project.archived ? 'Restore' : 'Archive'} onClick={() => archive(project)}>
                        {project.archived ? 'Restore' : 'Archive'}
                      </Button>
                      <Button size="sm" variant="danger" icon="trash" title="Delete project" onClick={() => remove(project)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {creating && (
        <Modal
          title="New project"
          onClose={() => setCreating(false)}
          size="lg"
          footer={
            <>
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="primary" onClick={create} disabled={busy}>
                {busy ? 'Creating…' : 'Create project'}
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="form-grid">
              <Field label="Project name" required>
                <Input value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Kestrel sounding rocket" autoFocus />
              </Field>
              <Field label="Project identifier">
                <Input value={draft.code ?? ''} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="e.g. KST-01" />
              </Field>
              <Field label="Status">
                <Select
                  value={draft.status ?? 'Planning'}
                  onChange={(v) => setDraft({ ...draft, status: v })}
                  options={PROJECT_STATUSES.map((s) => ({ value: s, label: s }))}
                  addNew="project.status"
                />
              </Field>
              <Field label="Rocket name" hint="Creates the first rocket record">
                <Input value={draft.rocketName ?? ''} onChange={(e) => setDraft({ ...draft, rocketName: e.target.value })} placeholder="e.g. Kestrel K1" />
              </Field>
              <Field label="Rocket identifier">
                <Input value={draft.rocketCode ?? ''} onChange={(e) => setDraft({ ...draft, rocketCode: e.target.value })} placeholder="e.g. K1" />
              </Field>
              <Field label="First revision label">
                <Input value={draft.revisionLabel ?? ''} onChange={(e) => setDraft({ ...draft, revisionLabel: e.target.value })} placeholder="Rev A" />
              </Field>
            </div>
            <Field label="Objectives">
              <Textarea rows={3} value={draft.objectives ?? ''} onChange={(e) => setDraft({ ...draft, objectives: e.target.value })} placeholder="What is this programme trying to establish?" />
            </Field>
            <Field label="Description">
              <Textarea rows={3} value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <div className="muted small">
              Creating a project also creates a rocket, an initial revision and the standard development stage set (concept through design revision).
              Stages are organisational records, not safety approvals.
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
