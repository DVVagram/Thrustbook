import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { DocumentPanel } from '../EntityPage';
import { RecordEditor, RecordForm } from '../RecordForm';
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorBox,
  Field,
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
} from '../ui';
import { fmtDate, fmtDateTime, money, quantity, relativeTime } from '../format';
import { COMPONENT_CATEGORIES, CONFIG_KINDS } from '../../shared/constants';
import { componentValue } from '../../shared/operations';

export default function ComponentsPage() {
  const { projectId, project, notify, confirm, refresh, route, navigate } = useApp();
  const [tab, setTab] = useState('inventory');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(route.query.component ?? null);
  const [editing, setEditing] = useState<any>(null);
  const [configEditing, setConfigEditing] = useState<any>(null);
  const [snapshotEditing, setSnapshotEditing] = useState<any>(null);
  const [compare, setCompare] = useState<{ a: string; b: string; result?: any } | null>(null);

  const components = useAsync(() => api.list('component', { where: { project_id: projectId, ...(category ? { category } : {}) }, q: search || undefined, limit: 500 }), [projectId, search, category]);
  const configs = useAsync(() => api.list('electronics_config', { where: { project_id: projectId }, limit: 200 }), [projectId]);
  const snapshots = useAsync(() => api.list('config_snapshot', { where: { project_id: projectId }, limit: 200 }), [projectId]);
  const selected = useAsync(() => (selectedId ? api.componentHistory(selectedId) : Promise.resolve(null)), [selectedId]);
  const configItems = useAsync(() => (configEditing?.id ? api.list('config_item', { where: { config_id: configEditing.id }, limit: 500 }) : Promise.resolve([])), [configEditing?.id]);
  const docs = useAsync(
    () => (selectedId ? api.linked('component', selectedId).then((l) => l.documents ?? []) : Promise.resolve([])),
    [selectedId],
  );

  useEffect(() => {
    if (configEditing?.id && configItems.data) {
      setConfigEditing((prev: any) => (prev && prev.id === configEditing.id && prev.items?.length === 0 ? { ...prev, items: (configItems.data ?? []).map((i: any) => ({ component_id: i.component_id, role: i.role })) } : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configItems.data]);

  if (!projectId) return <EmptyState title="Select a project" icon="folder" />;

  const saveComponent = async (entity: string, data: any) => {
    try {
      if (data.id) await api.update(entity, data.id, data);
      else await api.create(entity, { ...data, project_id: projectId });
      setEditing(null);
      components.reload();
      configs.reload();
      snapshots.reload();
      refresh();
      notify('Saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const removeComponent = async (component: any) => {
    if (!component?.id) return;
    const ok = await confirm({
      title: 'Delete component?',
      message: component.name,
      details:
        'The component, its installation history and its place in electronics configurations are removed. Inventory stock and shopping list entries created from it stay as their own records.',
      confirmLabel: 'Delete component',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove('component', component.id);
      if (selectedId === component.id) setSelectedId(null);
      components.reload();
      configs.reload();
      refresh();
      notify('Component deleted', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const saveConfig = async () => {
    try {
      let config = configEditing;
      if (!config.id) {
        config = await api.create('electronics_config', {
          project_id: projectId,
          name: config.name,
          description: config.description,
          revision_id: config.revision_id ?? '',
          content_json: {},
        });
      } else {
        await api.update('electronics_config', config.id, { name: config.name, description: config.description, revision_id: config.revision_id ?? '' });
      }
      const existing = config.id ? await api.list('config_item', { where: { config_id: config.id }, limit: 500 }) : [];
      const wanted = (config.items ?? []).filter((i: any) => i.component_id);
      for (const item of existing) {
        if (!wanted.some((w: any) => w.component_id === item.component_id)) await api.remove('config_item', item.id);
      }
      for (const item of wanted) {
        const current = existing.find((e: any) => e.component_id === item.component_id);
        if (current) {
          if (current.role !== (item.role ?? '')) await api.update('config_item', current.id, { role: item.role ?? '' });
        } else {
          await api.create('config_item', { config_id: config.id, component_id: item.component_id, role: item.role ?? '' });
        }
      }
      setConfigEditing(null);
      configs.reload();
      notify('Electronics configuration saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const runConfigCompare = async () => {
    if (!compare?.a || !compare?.b) return;
    try {
      const result = await api.configCompare(compare.a, compare.b);
      setCompare({ ...compare, result });
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const saveSnapshot = async () => {
    try {
      const data = { ...snapshotEditing, project_id: projectId };
      if (data.id) await api.update('config_snapshot', data.id, data);
      else await api.create('config_snapshot', data);
      setSnapshotEditing(null);
      snapshots.reload();
      notify('Configuration snapshot saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const importSnapshot = async () => {
    const picked = await api.pickOpen({ title: 'Import configuration or firmware file' });
    if (picked.canceled || !picked.paths?.[0]) return;
    try {
      await api.importConfigFile({ projectId, filePath: picked.paths[0], kind: 'Firmware', name: picked.paths[0].split(/[\\/]/).pop(), version: '' });
      snapshots.reload();
      notify('Configuration file imported with checksum', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Components & Electronics"
        subtitle={`${project?.name ?? ''} · inventory, electronics configurations and firmware snapshots`}
        actions={
          <>
            <Button icon="upload" onClick={importSnapshot}>
              Import config file
            </Button>
            <Button icon="log" onClick={() => navigate('#/templates?entity=component&new=1')} title="Add fields shown on every component">
              Component fields
            </Button>
            <Button
              variant="primary"
              icon="plus"
              onClick={() =>
                setEditing({
                  __entity: 'component',
                  project_id: projectId,
                  category: 'Microcontroller',
                  quantity: 1,
                  unit: 'pcs',
                  unit_price: 0,
                  currency: 'USD',
                  supplier: '',
                })
              }
            >
              New component
            </Button>
          </>
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'inventory', label: 'Inventory', count: components.data?.length ?? 0 },
          { key: 'configurations', label: 'Electronics configurations', count: configs.data?.length ?? 0 },
          { key: 'snapshots', label: 'Configuration & firmware', count: snapshots.data?.length ?? 0 },
        ]}
      />

      {tab === 'inventory' && (
        <div className={selectedId ? 'split-pane' : ''}>
          <Panel
            title="Component inventory"
            actions={
              <div className="toolbar-inline">
                <Select
                  value={category}
                  onChange={setCategory}
                  placeholder="All categories"
                  addNew="component.category"
                  options={COMPONENT_CATEGORIES.map((c) => ({ value: c, label: c }))}
                />
                <SearchInput value={search} onChange={setSearch} placeholder="Search components…" />
              </div>
            }
            dense
          >
            {components.error && <ErrorBox message={components.error} onRetry={components.reload} />}
            <DataTable
              rows={components.data ?? []}
              selectedKey={selectedId}
              onRowClick={(c) => setSelectedId(c.id)}
              columns={[
                { key: 'name', label: 'Component' },
                { key: 'category', label: 'Category', width: '140px' },
                { key: 'manufacturer', label: 'Manufacturer' },
                { key: 'model', label: 'Model', mono: true },
                { key: 'serial', label: 'Serial', mono: true },
                { key: 'quantity', label: 'Qty', align: 'right', mono: true, sortValue: (c) => Number(c.quantity), render: (c) => `${quantity(c.quantity ?? 0)} ${c.unit || 'pcs'}` },
                {
                  key: 'unit_price',
                  label: 'Unit price',
                  align: 'right',
                  mono: true,
                  sortValue: (c) => Number(c.unit_price),
                  render: (c) => money(c.unit_price ?? 0, c.currency || 'USD'),
                },
                {
                  key: 'value',
                  label: 'Piece value',
                  align: 'right',
                  mono: true,
                  sortValue: (c) => componentValue(c),
                  render: (c) => money(componentValue(c), c.currency || 'USD'),
                },
                { key: 'firmware', label: 'Firmware', mono: true },
                { key: 'updated_at', label: 'Updated', render: (c) => fmtDate(c.updated_at), width: '110px' },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  render: (c) => (
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" title="Edit" onClick={() => setEditing({ ...c, __entity: 'component' })}>
                        <Icon name="edit" size={14} />
                      </button>
                      <button className="icon-btn danger" title="Delete component" onClick={() => removeComponent(c)}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  ),
                },
              ]}
              empty={<EmptyState title="No components" message="Record microcontrollers, sensors, batteries, power and structural hardware." icon="chip" />}
            />
          </Panel>

          {selectedId && (
            <Panel
              title="Component record"
              actions={
                <button className="icon-btn" onClick={() => setSelectedId(null)} title="Close">
                  <Icon name="x" size={14} />
                </button>
              }
            >
              {selected.data ? (
                <div className="stack">
                  <div className="detail-subhead">
                    <div>
                      <div className="panel-title">{selected.data.component.name}</div>
                      <Badge>{selected.data.component.category}</Badge>
                    </div>
                    <div className="toolbar-inline">
                      <Button size="sm" icon="edit" onClick={() => setEditing({ ...selected.data.component, __entity: 'component' })}>
                        Edit
                      </Button>
                      <Button size="sm" variant="danger" icon="trash" onClick={() => removeComponent(selected.data.component)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                  <KeyValue
                    columns={1}
                    items={[
                      ['Manufacturer', selected.data.component.manufacturer],
                      ['Model', selected.data.component.model],
                      ['Serial', selected.data.component.serial],
                      ['Quantity', `${quantity(selected.data.component.quantity ?? 0)} ${selected.data.component.unit || 'pcs'}`],
                      ['Unit price', money(selected.data.component.unit_price ?? 0, selected.data.component.currency || 'USD')],
                      ['Piece value', money(componentValue(selected.data.component), selected.data.component.currency || 'USD')],
                      ['Supplier', selected.data.component.supplier],
                      ['Firmware', selected.data.component.firmware],
                      ['Installed in configurations', selected.data.configs.length],
                      ['Usage records', selected.data.usage.length],
                      ['Added', fmtDateTime(selected.data.component.created_at)],
                    ]}
                  />
                  <h4>Installation / usage history</h4>
                  {selected.data.usage.length === 0 ? (
                    <div className="muted small">No installation records.</div>
                  ) : (
                    <div className="timeline compact">
                      {selected.data.usage.map((u: any) => (
                        <div className="timeline-item" key={u.id}>
                          <span className="timeline-dot" />
                          <div>
                            <div className="list-title">{u.entity_type} · {u.record?.name ?? u.entity_id.slice(0, 8)}</div>
                            <div className="muted small">
                              {u.installed_at ? `Installed ${fmtDate(u.installed_at)}` : ''} {u.removed_at ? `· removed ${fmtDate(u.removed_at)}` : ''}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <h4>Used in configurations</h4>
                  {selected.data.configs.length === 0 ? (
                    <div className="muted small">Not part of any electronics configuration.</div>
                  ) : (
                    selected.data.configs.map((c: any) => (
                      <div className="list-row static" key={c.id}>
                        <span>{c.config_name}</span>
                        <span className="muted small">{c.role || '—'}</span>
                      </div>
                    ))
                  )}
                  <h4>Documents</h4>
                  <DocumentPanel
                    documents={docs.data ?? []}
                    projectId={projectId}
                    entityType="component"
                    entityId={selectedId}
                    onChange={() => docs.reload()}
                    compact
                  />
                </div>
              ) : (
                <div className="loading">Loading…</div>
              )}
            </Panel>
          )}
        </div>
      )}

      {tab === 'configurations' && (
        <div className="stack">
          <Panel
            title="Electronics configurations"
            actions={
              <>
                <Select
                  value=""
                  placeholder="Compare with…"
                  options={(configs.data ?? []).map((c: any) => ({ value: c.id, label: c.name }))}
                  onChange={(b) => setCompare({ a: compare?.a ?? '', b })}
                />
                <Button size="sm" icon="plus" onClick={() => setConfigEditing({ project_id: projectId, name: '', description: '', items: [] })}>
                  New configuration
                </Button>
              </>
            }
          >
            <DataTable
              rows={configs.data ?? []}
              columns={[
                { key: 'name', label: 'Configuration' },
                { key: 'description', label: 'Description' },
                { key: 'revision_id', label: 'Revision', render: (c) => <span className="mono small">{c.revision_id?.slice(0, 8) || '—'}</span> },
                { key: 'created_at', label: 'Created', render: (c) => fmtDate(c.created_at) },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  render: (c) => (
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" title="Edit" onClick={() => setConfigEditing({ ...c, items: [] })}>
                        <Icon name="edit" size={14} />
                      </button>
                      <button className="icon-btn" title="Compare" onClick={() => setCompare({ a: c.id, b: compare?.b ?? '' })}>
                        <Icon name="compare" size={14} />
                      </button>
                      <button
                        className="icon-btn danger"
                        title="Delete"
                        onClick={async () => {
                          const ok = await confirm({ title: 'Delete configuration?', message: c.name, confirmLabel: 'Delete', danger: true });
                          if (!ok) return;
                          await api.remove('electronics_config', c.id);
                          configs.reload();
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  ),
                },
              ]}
              empty={<EmptyState title="No electronics configurations" message="Record which components were present in each configuration." icon="chip" />}
            />
          </Panel>
          {compare && (
            <Panel title="Configuration comparison" actions={<Button size="sm" onClick={() => setCompare(null)}>Close</Button>}>
              <div className="toolbar-inline">
                <Select value={compare.a} onChange={(a) => setCompare({ ...compare, a, result: undefined })} placeholder="Configuration A" options={(configs.data ?? []).map((c: any) => ({ value: c.id, label: c.name }))} />
                <Select value={compare.b} onChange={(b) => setCompare({ ...compare, b, result: undefined })} placeholder="Configuration B" options={(configs.data ?? []).map((c: any) => ({ value: c.id, label: c.name }))} />
                <Button size="sm" variant="primary" icon="compare" onClick={runConfigCompare} disabled={!compare.a || !compare.b}>
                  Compare
                </Button>
              </div>
              {compare.result && (
                <div className="stack">
                  <DataTable
                    rows={compare.result.fields}
                    columns={[
                      { key: 'key', label: 'Field', mono: true },
                      { key: 'a', label: compare.result.a.name },
                      { key: 'b', label: compare.result.b.name },
                      { key: 'changed', label: 'Changed', render: (r) => (r.changed ? <Badge tone="warn">Changed</Badge> : <span className="muted">same</span>) },
                    ]}
                  />
                  <div className="two-col">
                    <div>
                      <h4>Components only in {compare.result.a.name}</h4>
                      {compare.result.itemDiff.onlyA.length === 0 ? <div className="muted small">None</div> : compare.result.itemDiff.onlyA.map((i: any) => <div key={i.id}>{i.component_name}</div>)}
                    </div>
                    <div>
                      <h4>Components only in {compare.result.b.name}</h4>
                      {compare.result.itemDiff.onlyB.length === 0 ? <div className="muted small">None</div> : compare.result.itemDiff.onlyB.map((i: any) => <div key={i.id}>{i.component_name}</div>)}
                    </div>
                  </div>
                  <p className="muted small">{compare.result.caveats.join(' ')}</p>
                </div>
              )}
            </Panel>
          )}
        </div>
      )}

      {tab === 'snapshots' && (
        <div className="stack">
          <Panel
            title="Configuration and firmware snapshots"
            actions={
              <>
                <Select
                  value={snapshotEditing?.compareId ?? ''}
                  onChange={(v) => setSnapshotEditing({ compareId: v, ...(snapshots.data ?? []).find((s: any) => s.id === v) })}
                  placeholder="Load snapshot…"
                  options={(snapshots.data ?? []).map((s: any) => ({ value: s.id, label: s.name }))}
                />
                <Button size="sm" icon="plus" onClick={() => setSnapshotEditing({ project_id: projectId, kind: 'Firmware', name: '', version: '', content_json: '{}' })}>
                  New snapshot
                </Button>
              </>
            }
          >
            <DataTable
              rows={snapshots.data ?? []}
              columns={[
                { key: 'name', label: 'Snapshot' },
                { key: 'kind', label: 'Kind' },
                { key: 'version', label: 'Version', mono: true },
                { key: 'checksum', label: 'SHA-256', render: (s) => <span className="mono tiny">{s.checksum ? `${s.checksum.slice(0, 16)}…` : '—'}</span> },
                { key: 'created_at', label: 'Created', render: (s) => fmtDate(s.created_at) },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  render: (s) => (
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" title="View" onClick={() => setSnapshotEditing(s)}>
                        <Icon name="doc" size={14} />
                      </button>
                      {s.file_path && (
                        <button className="icon-btn" title="Open configuration file" onClick={() => api.openPath(s.file_path).catch((e) => notify(e.message, 'error'))}>
                          <Icon name="link" size={14} />
                        </button>
                      )}
                      <button
                        className="icon-btn danger"
                        title="Delete"
                        onClick={async () => {
                          const ok = await confirm({ title: 'Delete snapshot?', message: s.name, confirmLabel: 'Delete', danger: true });
                          if (!ok) return;
                          await api.remove('config_snapshot', s.id);
                          snapshots.reload();
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  ),
                },
              ]}
              empty={<EmptyState title="No configuration snapshots" message="Record firmware versions, DAQ settings and hardware revisions with checksums." icon="chip" />}
            />
          </Panel>
          {snapshotEditing && (
            <Panel title={snapshotEditing.id ? `Snapshot: ${snapshotEditing.name}` : 'New configuration snapshot'}>
              <div className="stack">
                <RecordForm entity="config_snapshot" value={snapshotEditing} onChange={(patch) => setSnapshotEditing((d: any) => ({ ...d, ...patch }))} projectId={projectId} />
                {snapshotEditing.checksum && <div className="mono tiny muted">SHA-256 {snapshotEditing.checksum}</div>}
                <div className="modal-actions-row">
                  <Button variant="primary" onClick={saveSnapshot} icon="save">Save snapshot</Button>
                  <Button onClick={() => setSnapshotEditing(null)}>Close</Button>
                </div>
              </div>
            </Panel>
          )}
        </div>
      )}

      {editing && (
        <Modal
          title={editing.id ? 'Edit component' : 'New component'}
          onClose={() => setEditing(null)}
          size="lg"
          footer={
            <>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => saveComponent('component', editing)}>Save component</Button>
            </>
          }
        >
          <RecordEditor entity="component" value={editing} onChange={(patch) => setEditing((d: any) => ({ ...d, ...patch }))} projectId={projectId} />
        </Modal>
      )}

      {configEditing && (
        <Modal
          title={configEditing.id ? 'Edit electronics configuration' : 'New electronics configuration'}
          onClose={() => setConfigEditing(null)}
          size="lg"
          footer={
            <>
              <Button onClick={() => setConfigEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={saveConfig} disabled={!configEditing.name?.trim()}>
                Save configuration
              </Button>
            </>
          }
        >
          <div className="stack">
            <RecordEditor entity="electronics_config" value={configEditing} onChange={(patch) => setConfigEditing((d: any) => ({ ...d, ...patch }))} projectId={projectId} />
            <h4>Components in this configuration</h4>
            <div className="stack">
              {(components.data ?? []).map((c: any) => {
                const item = (configEditing.items ?? []).find((i: any) => i.component_id === c.id);
                return (
                  <div className="component-pick" key={c.id}>
                    <Checkbox
                      checked={!!item}
                      label={
                        <span>
                          {c.name} <span className="muted small">{c.category} · {c.model}</span>
                        </span>
                      }
                      onChange={(checked) => {
                        setConfigEditing((prev: any) => ({
                          ...prev,
                          items: checked ? [...(prev.items ?? []), { component_id: c.id, role: '' }] : (prev.items ?? []).filter((i: any) => i.component_id !== c.id),
                        }));
                      }}
                    />
                    {item && (
                      <Input
                        placeholder="Role in configuration (e.g. primary flight computer)"
                        value={item.role ?? ''}
                        onChange={(e) =>
                          setConfigEditing((prev: any) => ({
                            ...prev,
                            items: prev.items.map((i: any) => (i.component_id === c.id ? { ...i, role: e.target.value } : i)),
                          }))
                        }
                      />
                    )}
                  </div>
                );
              })}
              {(components.data ?? []).length === 0 && <div className="muted small">Add components first.</div>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
