import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { Badge, Button, Checkbox, DataTable, EmptyState, Field, Icon, Input, Modal, PageHeader, Panel, SearchInput, Select, Tabs, Textarea } from '../ui';
import { fmtDateTime } from '../format';
import {
  ENTRY_FIELD_TYPES,
  EntryFieldType,
  TEMPLATE_TARGETS,
  TemplateField,
  displayCustomValue,
  normalizeTemplateFields,
  targetLabel,
} from '../../shared/templates';
import { TEST_CATEGORIES } from '../../shared/constants';

interface Draft {
  id?: string;
  name: string;
  description: string;
  applies_to: string;
  category: string;
  scope: 'project' | 'global';
  fields: TemplateField[];
}

const emptyDraft = (target = 'test'): Draft => ({
  name: '',
  description: '',
  applies_to: target,
  category: '',
  scope: 'project',
  fields: [],
});

export default function TemplatesPage() {
  const { projectId, project, notify, confirm, route, navigate } = useApp();
  const templates = useAsync(() => api.list('entry_template', { limit: 500, orderBy: 'updated_at' }), [projectId]);
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<any>(null);

  const rows = useMemo(() => {
    return (templates.data ?? []).filter((t: any) => {
      if (tab !== 'all' && t.applies_to !== tab) return false;
      if (!search.trim()) return true;
      const term = search.toLowerCase();
      return `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(term);
    });
  }, [templates.data, tab, search]);

  useEffect(() => {
    if (!route.query.template || !templates.data) return;
    const match = templates.data.find((t: any) => t.id === route.query.template);
    if (match) setSelected(match);
  }, [route.query.template, templates.data]);

  const startCreate = () => {
    setDraft(emptyDraft(tab === 'all' ? 'test' : tab));
  };

  const startEdit = (row: any) => {
    setDraft({
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      applies_to: row.applies_to,
      category: row.category ?? '',
      scope: row.project_id ? 'project' : 'global',
      fields: normalizeTemplateFields(row.fields ?? row.fields_json),
    });
  };

  const duplicate = async (row: any) => {
    const fields = normalizeTemplateFields(row.fields ?? row.fields_json);
    try {
      await api.create('entry_template', {
        project_id: row.project_id ?? '',
        name: `${row.name} (copy)`,
        description: row.description ?? '',
        applies_to: row.applies_to,
        category: row.category ?? '',
        fields_json: fields,
      });
      templates.reload();
      notify('Template duplicated', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    const fields = normalizeTemplateFields(draft.fields);
    setBusy(true);
    try {
      const payload = {
        project_id: draft.scope === 'global' ? '' : projectId,
        name: draft.name.trim(),
        description: draft.description,
        applies_to: draft.applies_to,
        category: draft.category,
        fields_json: fields,
        archived: 0,
      };
      if (draft.id) await api.update('entry_template', draft.id, payload);
      else await api.create('entry_template', payload);
      setDraft(null);
      templates.reload();
      notify('Entry template saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: any) => {
    const ok = await confirm({
      title: 'Delete entry template?',
      message: `“${row.name}” will no longer be offered when creating records.`,
      details: 'Existing records keep the values they already captured. Their template fields will no longer be displayed or included in reports.',
      confirmLabel: 'Delete template',
      danger: true,
    });
    if (!ok) return;
    await api.remove('entry_template', row.id);
    if (selected?.id === row.id) setSelected(null);
    templates.reload();
  };

  const updateField = (index: number, patch: Partial<TemplateField>) => {
    setDraft((prev) => (prev ? { ...prev, fields: prev.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)) } : prev));
  };

  const addField = () => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            fields: [
              ...prev.fields,
              { key: `field_${prev.fields.length + 1}`, label: '', type: 'text', required: false, options: [], help: '' },
            ],
          }
        : prev,
    );
  };

  const moveField = (index: number, delta: number) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = [...prev.fields];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...prev, fields: next };
    });
  };

  if (!projectId) return <EmptyState title="Select a project" icon="folder" />;

  return (
    <div className="page">
      <PageHeader
        title="Entry Templates"
        subtitle={`${project?.name ?? ''} · reusable custom fields for ground tests, flights and experiment runs`}
        actions={
          <>
            <Button icon="refresh" onClick={() => templates.reload()}>
              Refresh
            </Button>
            <Button variant="primary" icon="plus" onClick={startCreate}>
              New template
            </Button>
          </>
        }
      />

      <div className="toolbar-row" style={{ marginBottom: 10 }}>
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'all', label: 'All templates', count: templates.data?.length ?? 0 },
            ...TEMPLATE_TARGETS.map((t) => ({
              key: t.value,
              label: t.label,
              count: (templates.data ?? []).filter((x: any) => x.applies_to === t.value).length,
            })),
          ]}
        />
        <span className="status-spacer" />
        <SearchInput value={search} onChange={setSearch} placeholder="Search templates…" />
      </div>

      <div className="detail-grid">
        <Panel title="Templates" subtitle="Project templates appear only in this project; global templates appear everywhere">
          <DataTable
            rows={rows}
            columns={[
              {
                key: 'name',
                label: 'Template',
                render: (t) => (
                  <span className="list-title">
                    {t.name} {!t.project_id && <Badge tone="warn">global</Badge>}
                  </span>
                ),
              },
              { key: 'applies_to', label: 'Applies to', render: (t) => targetLabel(t.applies_to) },
              { key: 'category', label: 'Auto-apply category', render: (t) => t.category || '—' },
              {
                key: 'fields',
                label: 'Fields',
                align: 'right',
                mono: true,
                render: (t) => normalizeTemplateFields(t.fields ?? t.fields_json).length,
              },
              { key: 'updated_at', label: 'Updated', render: (t) => fmtDateTime(t.updated_at) },
              {
                key: 'actions',
                label: '',
                align: 'right',
                render: (t) => (
                  <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title="Edit" onClick={() => startEdit(t)}>
                      <Icon name="save" size={14} />
                    </button>
                    <button className="icon-btn" title="Duplicate" onClick={() => duplicate(t)}>
                      <Icon name="doc" size={14} />
                    </button>
                    <button className="icon-btn danger" title="Delete" onClick={() => remove(t)}>
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ),
              },
            ]}
            onRowClick={setSelected}
            empty={
              <EmptyState
                title="No entry templates"
                message="Create a template to capture the same custom fields for every test, flight or experimental run of a given type."
                icon="log"
                action={<Button size="sm" variant="primary" icon="plus" onClick={startCreate}>New template</Button>}
              />
            }
          />
        </Panel>

        <div className="stack">
          {selected ? (
            <Panel
              title={selected.name}
              subtitle={targetLabel(selected.applies_to)}
              actions={
                <>
                  <Button size="sm" icon="save" onClick={() => startEdit(selected)}>
                    Edit
                  </Button>
                  <Button size="sm" icon="x" onClick={() => setSelected(null)}>
                    Close
                  </Button>
                </>
              }
            >
              <div className="stack">
                {selected.description && <p>{selected.description}</p>}
                <div className="kv-grid">
                  <div className="kv-item">
                    <span className="kv-key">Scope</span>
                    <span className="kv-value">{selected.project_id ? project?.name ?? 'This project' : 'All projects'}</span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-key">Auto-apply category</span>
                    <span className="kv-value">{selected.category || '—'}</span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-key">Created</span>
                    <span className="kv-value">{fmtDateTime(selected.created_at)}</span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-key">Updated</span>
                    <span className="kv-value">{fmtDateTime(selected.updated_at)}</span>
                  </div>
                </div>
                <div className="field-label">Fields</div>
                <div className="template-preview">
                  {normalizeTemplateFields(selected.fields ?? selected.fields_json).map((field) => (
                    <div className="template-preview-row" key={field.key}>
                      <div>
                        <div className="list-title">
                          {field.label} {field.required && <span className="req">*</span>}
                        </div>
                        <div className="muted tiny">
                          {field.key} · {ENTRY_FIELD_TYPES.find((t) => t.value === field.type)?.label ?? field.type}
                          {field.unit ? ` · ${field.unit}` : ''}
                        </div>
                      </div>
                      <div className="muted small">
                        {field.type === 'select' && field.options?.length
                          ? field.options.join(', ')
                          : field.default !== undefined
                            ? `default: ${displayCustomValue(field, field.default)}`
                            : '—'}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="muted small">
                  Required fields marked * are enforced when the record is saved in a final state (Completed, Failed, Aborted, Verified or Closed).
                  Planned records can be created before every value is known.
                </p>
              </div>
            </Panel>
          ) : (
            <Panel title="How templates work">
              <div className="stack muted small">
                <p>
                  A template defines extra fields for one record type. Apply it to a ground test, flight or experiment run and those fields appear in the record
                  form and are saved with the record.
                </p>
                <p>
                  Choose an <strong>auto-apply category</strong> to attach the template automatically when a new record uses that category (for example a
                  “Power system characterization” test).
                </p>
                <p>
                  Templates are included in project exports and backups. Values recorded with a template are labelled as user-entered in reports and never
                  mixed with calculated results.
                </p>
                <p>
                  Examples are available in the separate example workspace — open it from the sidebar to inspect a working template.
                </p>
              </div>
            </Panel>
          )}
        </div>
      </div>

      {draft && (
        <Modal
          title={draft.id ? 'Edit entry template' : 'New entry template'}
          onClose={() => setDraft(null)}
          size="xl"
          footer={
            <>
              <Button onClick={() => setDraft(null)}>Cancel</Button>
              <Button variant="primary" icon="save" onClick={save} disabled={busy || !draft.name.trim()}>
                {busy ? 'Saving…' : 'Save template'}
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="form-grid">
              <Field label="Template name" required>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Static fire instrumentation sheet" autoFocus />
              </Field>
              <Field label="Applies to" hint="Record type that shows these fields">
                <Select
                  value={draft.applies_to}
                  onChange={(v) => setDraft({ ...draft, applies_to: v })}
                  options={TEMPLATE_TARGETS.map((t) => ({ value: t.value, label: t.label }))}
                />
              </Field>
              <Field label="Scope">
                <Select
                  value={draft.scope}
                  onChange={(v) => setDraft({ ...draft, scope: v as 'project' | 'global' })}
                  options={[
                    { value: 'project', label: `This project${project ? ` — ${project.name}` : ''}` },
                    { value: 'global', label: 'All projects' },
                  ]}
                />
              </Field>
              <Field label="Auto-apply category" hint="Optional. Matches the record's category to apply automatically.">
                <Input
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  placeholder={draft.applies_to === 'test' ? 'e.g. Sensor calibration' : 'Optional'}
                  list="template-categories"
                />
                <datalist id="template-categories">
                  {TEST_CATEGORIES.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>
              <Field label="Description" full>
                <Textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </Field>
            </div>

            <div className="template-editor-head">
              <div>
                <div className="field-label">Custom fields</div>
                <div className="muted small">Fields appear after the standard record fields. Keys stay stable so recorded values are preserved when labels change.</div>
              </div>
              <Button size="sm" icon="plus" onClick={addField}>
                Add field
              </Button>
            </div>

            {draft.fields.length === 0 && <div className="muted small">No custom fields yet. Add at least one to capture template-specific values.</div>}

            <div className="stack">
              {draft.fields.map((field, index) => (
                <div className="template-field-editor" key={index}>
                  <div className="template-field-editor-head">
                    <span className="template-field-index">{index + 1}</span>
                    <span className="muted small">
                      {field.label || 'Untitled field'} {field.required && <span className="req">*</span>}
                    </span>
                    <span className="status-spacer" />
                    <button className="icon-btn" title="Move up" onClick={() => moveField(index, -1)} disabled={index === 0}>
                      <Icon name="chevron" size={13} className="rotate-180" />
                    </button>
                    <button className="icon-btn" title="Move down" onClick={() => moveField(index, 1)} disabled={index === draft.fields.length - 1}>
                      <Icon name="chevron" size={13} />
                    </button>
                    <button
                      className="icon-btn danger"
                      title="Remove field"
                      onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, i) => i !== index) })}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                  <div className="form-grid template-field-grid">
                    <Field label="Label" required>
                      <Input
                        value={field.label}
                        onChange={(e) => updateField(index, { label: e.target.value, key: field.key && !/^field_\d+$/.test(field.key) ? field.key : '' })}
                        placeholder="e.g. Propellant mass"
                      />
                    </Field>
                    <Field label="Key" hint="Stable identifier; generated from the label when left empty">
                      <Input
                        className="mono"
                        value={field.key}
                        onChange={(e) => updateField(index, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') })}
                        placeholder="propellant_mass"
                      />
                    </Field>
                    <Field label="Type">
                      <Select
                        value={field.type}
                        onChange={(v) => updateField(index, { type: v as EntryFieldType })}
                        options={ENTRY_FIELD_TYPES.map((t) => ({ value: t.value, label: t.label }))}
                      />
                    </Field>
                    {(field.type === 'measurement' || field.type === 'number') && (
                      <Field label="Unit" hint="Unit is fixed by the template and recorded with the value">
                        <Input value={field.unit ?? ''} onChange={(e) => updateField(index, { unit: e.target.value })} placeholder="e.g. g, s, N, V" />
                      </Field>
                    )}
                    {field.type === 'select' && (
                      <Field label="Options" hint="Comma separated">
                        <Input
                          value={(field.options ?? []).join(', ')}
                          onChange={(e) => updateField(index, { options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })}
                          placeholder="Pyrogen, Electronic, Other"
                        />
                      </Field>
                    )}
                    <Field label="Default value" hint="Optional">
                      {field.type === 'checkbox' ? (
                        <Checkbox checked={!!field.default} onChange={(v) => updateField(index, { default: v })} label="Checked by default" />
                      ) : (
                        <Input
                          value={field.default ?? ''}
                          onChange={(e) => updateField(index, { default: e.target.value })}
                          placeholder={field.type === 'number' || field.type === 'measurement' ? '0' : 'Optional'}
                        />
                      )}
                    </Field>
                    <Field label="Help text" hint="Shown under the field">
                      <Input value={field.help ?? ''} onChange={(e) => updateField(index, { help: e.target.value })} />
                    </Field>
                    <div className="field template-field-checks">
                      <span className="field-label">Behaviour</span>
                      <Checkbox checked={!!field.required} onChange={(v) => updateField(index, { required: v })} label="Required when the record is final" />
                      <Checkbox checked={!!field.full} onChange={(v) => updateField(index, { full: v })} label="Full width" />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="note-banner">
              Template values are stored in the record's own custom-field set. Changing or deleting a template never rewrites historical values, and exported or
              reported values remain marked as user-entered.
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
