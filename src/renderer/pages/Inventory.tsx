import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { RecordEditor } from '../RecordForm';
import { Badge, Button, DataTable, EmptyState, ErrorBox, Icon, Modal, PageHeader, Panel, SearchInput, Select, Stat } from '../ui';
import { fmtDate, money, quantity } from '../format';
import { INVENTORY_CATEGORIES, inventoryValue, isLowStock, summarizeInventory } from '../../shared/operations';

const emptyItem = (projectId: string) => ({
  project_id: projectId,
  name: '',
  category: 'Other',
  sku: '',
  quantity: 0,
  unit: 'pcs',
  unit_cost: 0,
  currency: 'USD',
  supplier: '',
  location: '',
  reorder_level: 0,
  notes: '',
});

export default function InventoryPage() {
  const { projectId, project, notify, confirm, refresh, route, navigate } = useApp();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const items = useAsync(
    () => api.list('inventory_item', { where: { project_id: projectId }, limit: 5000, orderBy: 'name', order: 'asc' }),
    [projectId],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (items.data ?? []).filter((item: any) => {
      if (category && item.category !== category) return false;
      if (lowOnly && !isLowStock(item)) return false;
      if (!term) return true;
      return `${item.name} ${item.sku} ${item.category} ${item.supplier} ${item.location} ${item.notes}`.toLowerCase().includes(term);
    });
  }, [items.data, search, category, lowOnly]);

  const summary = useMemo(() => summarizeInventory(filtered), [filtered]);
  const lowCount = useMemo(() => filtered.filter((item: any) => isLowStock(item)).length, [filtered]);

  useEffect(() => {
    if (!items.data) return;
    if (route.query.new) {
      setEditing(emptyItem(projectId));
      navigate('#/inventory');
      return;
    }
    if (route.query.item) {
      const match = items.data.find((item: any) => item.id === route.query.item);
      if (match) {
        setEditing(match);
        navigate('#/inventory');
      }
    }
  }, [route.query.new, route.query.item, items.data, projectId, navigate]);

  if (!projectId) return <EmptyState title="Select a project" icon="folder" />;

  const save = async () => {
    if (!editing) return;
    try {
      const payload = { ...editing, project_id: projectId };
      if (payload.id) await api.update('inventory_item', payload.id, payload);
      else await api.create('inventory_item', payload);
      setEditing(null);
      items.reload();
      refresh();
      notify('Inventory item saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const remove = async (item: any) => {
    const ok = await confirm({
      title: 'Delete inventory item?',
      message: item.name,
      details: 'This removes the stock record and its cost from inventory totals. It does not create a finance entry.',
      confirmLabel: 'Delete item',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove('inventory_item', item.id);
      items.reload();
      refresh();
      notify('Inventory item deleted', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Inventory"
        subtitle={`${project?.name ?? ''} · costed stock of parts, materials, consumables and tools`}
        actions={
          <>
            <Button icon="refresh" onClick={() => items.reload()}>
              Refresh
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setEditing(emptyItem(projectId))}>
              New item
            </Button>
          </>
        }
      />

      <div className="stat-row compact">
        <Stat label="Items shown" value={filtered.length} sub={`${items.data?.length ?? 0} total`} />
        <Stat label="Low stock" value={lowCount} sub="at or below reorder level" tone={lowCount > 0 ? 'warn' : undefined} />
        {summary.length === 0 ? (
          <Stat label="Stock value" value="—" sub="No items match" />
        ) : (
          summary.map((group) => (
            <Stat
              key={group.currency}
              label={`Stock value · ${group.currency}`}
              value={money(group.totalValue, group.currency)}
              sub={`${group.itemCount} item(s) · quantity × unit cost`}
            />
          ))
        )}
      </div>

      <Panel
        title="Inventory valuation"
        subtitle={search || category || lowOnly ? 'Calculated from the filtered items shown below' : 'Calculated from quantity on hand × unit cost; no value is stored or inferred'}
        actions={
          <div className="toolbar-inline">
            <label className="checkbox">
              <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
              <span>Low stock only</span>
            </label>
            <Select value={category} onChange={setCategory} placeholder="All categories" options={INVENTORY_CATEGORIES.map((c) => ({ value: c, label: c }))} />
            <SearchInput value={search} onChange={setSearch} placeholder="Search inventory…" />
          </div>
        }
        dense
      >
        {items.error && <ErrorBox message={items.error} onRetry={items.reload} />}
        <DataTable
          rows={filtered}
          onRowClick={setEditing}
          columns={[
            {
              key: 'name',
              label: 'Item',
              render: (item) => (
                <span className="list-title">
                  {item.name}
                  {isLowStock(item) && <Badge tone="warn">Low stock</Badge>}
                </span>
              ),
            },
            { key: 'category', label: 'Category', width: '130px' },
            { key: 'sku', label: 'SKU', mono: true },
            {
              key: 'quantity',
              label: 'On hand',
              align: 'right',
              mono: true,
              sortValue: (item) => Number(item.quantity),
              render: (item) => `${quantity(item.quantity)} ${item.unit || 'pcs'}`,
            },
            {
              key: 'unit_cost',
              label: 'Unit cost',
              align: 'right',
              mono: true,
              sortValue: (item) => Number(item.unit_cost),
              render: (item) => money(item.unit_cost, item.currency),
            },
            {
              key: 'value',
              label: 'Stock value',
              align: 'right',
              mono: true,
              sortValue: (item) => inventoryValue(item),
              render: (item) => money(inventoryValue(item), item.currency),
            },
            { key: 'supplier', label: 'Supplier' },
            { key: 'location', label: 'Location' },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (item) => (
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn" title="Edit" onClick={() => setEditing(item)}>
                    <Icon name="edit" size={14} />
                  </button>
                  <button className="icon-btn danger" title="Delete" onClick={() => remove(item)}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ),
            },
          ]}
          empty={
            <EmptyState
              title="No inventory items"
              message="Record parts, materials and consumables with their quantity and unit cost to see what is on hand and what it is worth."
              icon="box"
              action={
                <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing(emptyItem(projectId))}>
                  Add first item
                </Button>
              }
            />
          }
        />
      </Panel>

      <div className="note-banner">
        Stock value is a derived figure: quantity on hand multiplied by the recorded unit cost, shown in that item's own currency. Changing quantity or cost updates the
        calculation immediately; no purchase or expense is posted automatically.
      </div>

      {editing && (
        <Modal
          title={editing.id ? 'Edit inventory item' : 'New inventory item'}
          onClose={() => setEditing(null)}
          size="lg"
          footer={
            <>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" icon="save" onClick={save} disabled={!String(editing.name ?? '').trim()}>
                Save item
              </Button>
            </>
          }
        >
          <RecordEditor
            entity="inventory_item"
            value={editing}
            onChange={(patch) => setEditing((current: any) => ({ ...current, ...patch }))}
            projectId={projectId}
          />
        </Modal>
      )}
    </div>
  );
}
