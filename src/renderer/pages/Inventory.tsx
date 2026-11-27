import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { RecordEditor } from '../RecordForm';
import { Badge, Button, DataTable, EmptyState, ErrorBox, Icon, Modal, PageHeader, Panel, SearchInput, Select, Stat, Tabs } from '../ui';
import { fmtDate, money, quantity } from '../format';
import {
  INVENTORY_CATEGORIES,
  inventoryValue,
  isLowStock,
  shoppingLineTotal,
  summarizeInventory,
  summarizeShopping,
} from '../../shared/operations';

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
  component_id: '',
});

const emptyShoppingEntry = (projectId: string) => ({
  project_id: projectId,
  name: '',
  component_id: '',
  quantity: 1,
  unit: 'pcs',
  estimated_unit_cost: 0,
  currency: 'USD',
  supplier: '',
  priority: 'Normal',
  status: 'Needed',
  notes: '',
});

/** Rocket component categories translated into stock categories. */
const COMPONENT_STOCK_CATEGORY: Record<string, string> = {
  Microcontroller: 'Electronics',
  Sensor: 'Sensors',
  Battery: 'Power',
  'Power system': 'Power',
  Communication: 'Electronics',
  'Data acquisition': 'Electronics',
  Structural: 'Structure',
  Mechanical: 'Structure',
  Recovery: 'Structure',
  Propulsion: 'Propulsion',
  Other: 'Other',
};

export default function InventoryPage() {
  const { projectId, project, notify, confirm, refresh, route, navigate } = useApp();
  const [tab, setTab] = useState('stock');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [shoppingEdit, setShoppingEdit] = useState<any>(null);
  const [picker, setPicker] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const [busyComponent, setBusyComponent] = useState('');

  const items = useAsync(
    () => api.list('inventory_item', { where: { project_id: projectId }, limit: 5000, orderBy: 'name', order: 'asc' }),
    [projectId],
  );
  const shopping = useAsync(
    () => api.list('shopping_list_item', { where: { project_id: projectId }, limit: 5000, orderBy: 'created_at', order: 'desc' }),
    [projectId],
  );
  const components = useAsync(() => api.list('component', { where: { project_id: projectId }, limit: 2000, orderBy: 'name', order: 'asc' }), [projectId]);

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
  const shoppingTotal = useMemo(() => summarizeShopping(shopping.data ?? []), [shopping.data]);
  const openShoppingCount = useMemo(
    () => (shopping.data ?? []).filter((entry: any) => !['Received', 'Cancelled'].includes(entry.status)).length,
    [shopping.data],
  );
  const stockedComponentIds = useMemo(
    () => new Set((items.data ?? []).map((item: any) => item.component_id).filter(Boolean)),
    [items.data],
  );

  const pickableComponents = useMemo(() => {
    const term = pickerSearch.trim().toLowerCase();
    return (components.data ?? []).filter((component: any) => {
      if (!term) return true;
      return `${component.name} ${component.category} ${component.model} ${component.manufacturer} ${component.serial}`
        .toLowerCase()
        .includes(term);
    });
  }, [components.data, pickerSearch]);

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
    if (route.query.add === 'components') {
      setPicker(true);
      navigate('#/inventory');
    }
  }, [route.query.new, route.query.item, route.query.add, items.data, projectId, navigate]);

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

  const addComponentToStock = async (component: any) => {
    if (stockedComponentIds.has(component.id)) return;
    setBusyComponent(component.id);
    try {
      await api.create('inventory_item', {
        project_id: projectId,
        component_id: component.id,
        name: component.name,
        category: COMPONENT_STOCK_CATEGORY[component.category] ?? 'Other',
        sku: component.model ?? '',
        quantity: Number(component.quantity ?? 1) || 0,
        unit: component.unit || 'pcs',
        unit_cost: Number(component.unit_price ?? 0) || 0,
        currency: component.currency || 'USD',
        supplier: component.supplier ?? '',
        location: '',
        reorder_level: 0,
        notes: `Added from component${component.serial ? ` · serial ${component.serial}` : ''}`,
      });
      items.reload();
      refresh();
      notify(`${component.name} added to inventory`, 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setBusyComponent('');
    }
  };

  const addComponentToShopping = async (component: any) => {
    setBusyComponent(component.id);
    try {
      const existing = (shopping.data ?? []).find((entry: any) => entry.component_id === component.id && entry.status === 'Needed');
      if (existing) {
        await api.update('shopping_list_item', existing.id, {
          quantity: (Number(existing.quantity) || 0) + (Number(component.quantity) || 1),
        });
      } else {
        await api.create('shopping_list_item', {
          project_id: projectId,
          component_id: component.id,
          name: component.name,
          quantity: Number(component.quantity ?? 1) || 1,
          unit: component.unit || 'pcs',
          estimated_unit_cost: Number(component.unit_price ?? 0) || 0,
          currency: component.currency || 'USD',
          supplier: component.supplier ?? '',
          priority: 'Normal',
          status: 'Needed',
          notes: `From component${component.model ? ` ${component.model}` : ''}`,
        });
      }
      shopping.reload();
      notify(`${component.name} added to the shopping list`, 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setBusyComponent('');
    }
  };

  const saveShopping = async () => {
    if (!shoppingEdit) return;
    try {
      const payload = { ...shoppingEdit, project_id: projectId };
      if (payload.id) await api.update('shopping_list_item', payload.id, payload);
      else await api.create('shopping_list_item', payload);
      setShoppingEdit(null);
      shopping.reload();
      notify('Shopping list entry saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const removeShopping = async (entry: any) => {
    const ok = await confirm({
      title: 'Remove shopping list entry?',
      message: entry.name,
      details: 'Only the planning entry is removed. No stock or finance record is changed.',
      confirmLabel: 'Remove entry',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove('shopping_list_item', entry.id);
      shopping.reload();
      notify('Shopping list entry removed', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const receiveShopping = async (entry: any) => {
    try {
      const source = (components.data ?? []).find((component: any) => component.id === entry.component_id);
      await api.create('inventory_item', {
        project_id: projectId,
        component_id: entry.component_id ?? '',
        name: entry.name,
        category: COMPONENT_STOCK_CATEGORY[source?.category] ?? 'Other',
        sku: '',
        quantity: Number(entry.quantity) || 0,
        unit: entry.unit || 'pcs',
        unit_cost: Number(entry.estimated_unit_cost) || 0,
        currency: entry.currency || 'USD',
        supplier: entry.supplier ?? '',
        location: '',
        reorder_level: 0,
        notes: `Received from shopping list${entry.notes ? ` · ${entry.notes}` : ''}`,
      });
      await api.update('shopping_list_item', entry.id, { status: 'Received' });
      items.reload();
      shopping.reload();
      refresh();
      notify(`${entry.name} added to inventory`, 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Inventory"
        subtitle={`${project?.name ?? ''} · costed stock, rocket piece prices and the shopping list`}
        actions={
          <>
            <Button icon="refresh" onClick={() => (tab === 'stock' ? items.reload() : shopping.reload())}>
              Refresh
            </Button>
            {tab === 'stock' ? (
              <>
                <Button icon="rocket" onClick={() => setPicker(true)}>
                  Add from rocket pieces
                </Button>
                <Button variant="primary" icon="plus" onClick={() => setEditing(emptyItem(projectId))}>
                  New item
                </Button>
              </>
            ) : (
              <Button variant="primary" icon="plus" onClick={() => setShoppingEdit(emptyShoppingEntry(projectId))}>
                New list entry
              </Button>
            )}
          </>
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'stock', label: 'Stock', count: items.data?.length ?? 0 },
          { key: 'shopping', label: 'Shopping list', count: shopping.data?.length ?? 0 },
        ]}
      />

      {tab === 'stock' && (
        <>
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
            subtitle={
              search || category || lowOnly
                ? 'Calculated from the filtered items shown below'
                : 'Calculated from quantity on hand × unit cost; no value is stored or inferred'
            }
            actions={
              <div className="toolbar-inline">
                <label className="checkbox">
                  <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
                  <span>Low stock only</span>
                </label>
                <Select
                  value={category}
                  onChange={setCategory}
                  placeholder="All categories"
                  addNew="inventory_item.category"
                  options={INVENTORY_CATEGORIES.map((c) => ({ value: c, label: c }))}
                />
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
                  message="Record parts, materials and consumables with their quantity and unit cost, or pull them straight from the rocket pieces already entered under Components."
                  icon="box"
                  action={
                    <div className="toolbar-inline">
                      <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing(emptyItem(projectId))}>
                        Add first item
                      </Button>
                      <Button size="sm" icon="rocket" onClick={() => setPicker(true)}>
                        Add from rocket pieces
                      </Button>
                    </div>
                  }
                />
              }
            />
          </Panel>

          <div className="note-banner">
            Stock value is a derived figure: quantity on hand multiplied by the recorded unit cost, shown in that item's own currency. Changing quantity or cost
            updates the calculation immediately; no purchase or expense is posted automatically.
          </div>
        </>
      )}

      {tab === 'shopping' && (
        <>
          <div className="stat-row compact">
            <Stat label="Entries" value={shopping.data?.length ?? 0} sub={`${openShoppingCount} still open`} />
            {shoppingTotal.length === 0 ? (
              <Stat label="Planned spend" value="—" sub="No entries yet" />
            ) : (
              shoppingTotal.map((group) => (
                <Stat
                  key={group.currency}
                  label={`Planned spend · ${group.currency}`}
                  value={money(group.totalValue, group.currency)}
                  sub={`${group.itemCount} open entry(ies) · estimates only`}
                />
              ))
            )}
          </div>

          <Panel
            title="Shopping list"
            subtitle="Parts to buy with planning estimates. Marking an entry received copies it into stock; no finance entry is posted."
            actions={
              <Button size="sm" icon="plus" onClick={() => setShoppingEdit(emptyShoppingEntry(projectId))}>
                Add entry
              </Button>
            }
            dense
          >
            {shopping.error && <ErrorBox message={shopping.error} onRetry={shopping.reload} />}
            <DataTable
              rows={shopping.data ?? []}
              onRowClick={setShoppingEdit}
              columns={[
                {
                  key: 'name',
                  label: 'Part or material',
                  render: (entry) => (
                    <span className="list-title">
                      {entry.name}
                      {entry.priority === 'Critical' && <Badge tone="danger">Critical</Badge>}
                    </span>
                  ),
                },
                {
                  key: 'quantity',
                  label: 'Qty',
                  align: 'right',
                  mono: true,
                  render: (entry) => `${quantity(entry.quantity)} ${entry.unit || 'pcs'}`,
                },
                {
                  key: 'estimated_unit_cost',
                  label: 'Est. unit',
                  align: 'right',
                  mono: true,
                  render: (entry) => money(entry.estimated_unit_cost, entry.currency),
                },
                {
                  key: 'line_total',
                  label: 'Est. total',
                  align: 'right',
                  mono: true,
                  sortValue: (entry) => shoppingLineTotal(entry),
                  render: (entry) => money(shoppingLineTotal(entry), entry.currency),
                },
                { key: 'supplier', label: 'Supplier' },
                { key: 'priority', label: 'Priority', render: (entry) => <Badge>{entry.priority}</Badge> },
                { key: 'status', label: 'Status', render: (entry) => <Badge>{entry.status}</Badge> },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  render: (entry) => (
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      {!['Received', 'Cancelled'].includes(entry.status) && (
                        <button className="icon-btn" title="Receive into inventory" onClick={() => receiveShopping(entry)}>
                          <Icon name="box" size={14} />
                        </button>
                      )}
                      <button className="icon-btn" title="Edit" onClick={() => setShoppingEdit(entry)}>
                        <Icon name="edit" size={14} />
                      </button>
                      <button className="icon-btn danger" title="Remove" onClick={() => removeShopping(entry)}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  ),
                },
              ]}
              empty={
                <EmptyState
                  title="Shopping list is empty"
                  message="Add the parts and materials you still need to buy, with quantities and estimates. Rocket pieces can be sent here in one click."
                  icon="wallet"
                  action={
                    <div className="toolbar-inline">
                      <Button size="sm" variant="primary" icon="plus" onClick={() => setShoppingEdit(emptyShoppingEntry(projectId))}>
                        Add first entry
                      </Button>
                      <Button size="sm" icon="rocket" onClick={() => setPicker(true)}>
                        Pick from rocket pieces
                      </Button>
                    </div>
                  }
                />
              }
            />
          </Panel>
        </>
      )}

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

      {shoppingEdit && (
        <Modal
          title={shoppingEdit.id ? 'Edit shopping list entry' : 'New shopping list entry'}
          onClose={() => setShoppingEdit(null)}
          size="lg"
          footer={
            <>
              <Button onClick={() => setShoppingEdit(null)}>Cancel</Button>
              <Button variant="primary" icon="save" onClick={saveShopping} disabled={!String(shoppingEdit.name ?? '').trim()}>
                Save entry
              </Button>
            </>
          }
        >
          <RecordEditor
            entity="shopping_list_item"
            value={shoppingEdit}
            onChange={(patch) => setShoppingEdit((current: any) => ({ ...current, ...patch }))}
            projectId={projectId}
          />
        </Modal>
      )}

      {picker && (
        <Modal
          title="Add from rocket pieces"
          onClose={() => setPicker(false)}
          size="xl"
          footer={
            <>
              <Button onClick={() => setPicker(false)}>Close</Button>
              <Button variant="primary" icon="box" onClick={() => { setPicker(false); setTab('stock'); }}>
                Go to stock
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="toolbar-inline">
              <SearchInput value={pickerSearch} onChange={setPickerSearch} placeholder="Search components already entered…" />
              <span className="status-spacer" />
              <Button size="sm" icon="chip" onClick={() => { setPicker(false); navigate('#/components'); }}>
                Open components
              </Button>
            </div>
            <div className="muted small">
              These are the components and electronics already recorded for this project. Click the plus to add one to stock using its saved quantity, unit and
              price; the box button sends it to the shopping list instead.
            </div>
            <DataTable
              rows={pickableComponents}
              columns={[
                { key: 'name', label: 'Rocket piece' },
                { key: 'category', label: 'Category', width: '140px' },
                { key: 'model', label: 'Model', mono: true },
                { key: 'quantity', label: 'Qty', align: 'right', mono: true, render: (c) => `${quantity(c.quantity ?? 0)} ${c.unit || 'pcs'}` },
                { key: 'unit_price', label: 'Unit price', align: 'right', mono: true, render: (c) => money(c.unit_price ?? 0, c.currency || 'USD') },
                { key: 'supplier', label: 'Supplier' },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  render: (c) => (
                    <div className="row-actions">
                      {stockedComponentIds.has(c.id) ? (
                        <Badge tone="ok">In stock</Badge>
                      ) : (
                        <button
                          className="icon-btn"
                          title="Add to inventory"
                          disabled={busyComponent === c.id}
                          onClick={() => addComponentToStock(c)}
                        >
                          <Icon name="plus" size={14} />
                        </button>
                      )}
                      <button
                        className="icon-btn"
                        title="Add to shopping list"
                        disabled={busyComponent === c.id}
                        onClick={() => addComponentToShopping(c)}
                      >
                        <Icon name="box" size={14} />
                      </button>
                    </div>
                  ),
                },
              ]}
              empty={
                <EmptyState
                  title="No rocket pieces yet"
                  message="Add components and electronics first; they can then be pulled into stock or the shopping list here."
                  icon="chip"
                  action={
                    <Button size="sm" icon="chip" onClick={() => { setPicker(false); navigate('#/components'); }}>
                      Go to components
                    </Button>
                  }
                />
              }
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
