import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { RecordEditor } from '../RecordForm';
import { Badge, Button, DataTable, EmptyState, ErrorBox, Icon, Modal, PageHeader, Panel, SearchInput, Select, Stat, Tabs } from '../ui';
import { fmtDate, money, todayInput } from '../format';
import { FINANCE_CATEGORIES, summarizeFinance } from '../../shared/operations';

const emptyEntry = (projectId: string) => ({
  project_id: projectId,
  kind: 'expenditure',
  occurred_on: todayInput().slice(0, 10),
  description: '',
  category: '',
  amount: 0,
  currency: 'USD',
  counterparty: '',
  reference: '',
  payment_method: '',
  notes: '',
});

export default function FinancePage() {
  const { projectId, project, notify, confirm, refresh, route, navigate } = useApp();
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const entries = useAsync(
    () => api.list('finance_entry', { where: { project_id: projectId }, limit: 5000, orderBy: 'occurred_on', order: 'desc' }),
    [projectId],
  );

  const allEntries = entries.data ?? [];
  const summary = useMemo(() => summarizeFinance(allEntries), [allEntries]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allEntries.filter((entry: any) => {
      if (tab !== 'all' && entry.kind !== tab) return false;
      if (category && entry.category !== category) return false;
      if (!term) return true;
      return `${entry.description} ${entry.counterparty} ${entry.reference} ${entry.category} ${entry.payment_method} ${entry.notes}`
        .toLowerCase()
        .includes(term);
    });
  }, [allEntries, tab, category, search]);

  useEffect(() => {
    if (!entries.data) return;
    if (route.query.new) {
      setEditing(emptyEntry(projectId));
      navigate('#/finance');
      return;
    }
    if (route.query.entry) {
      const match = entries.data.find((entry: any) => entry.id === route.query.entry);
      if (match) {
        setEditing(match);
        navigate('#/finance');
      }
    }
  }, [route.query.new, route.query.entry, entries.data, projectId, navigate]);

  if (!projectId) return <EmptyState title="Select a project" icon="folder" />;

  const save = async () => {
    if (!editing) return;
    try {
      const payload = { ...editing, project_id: projectId };
      if (payload.id) await api.update('finance_entry', payload.id, payload);
      else await api.create('finance_entry', payload);
      setEditing(null);
      entries.reload();
      refresh();
      notify('Finance entry saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const remove = async (entry: any) => {
    const ok = await confirm({
      title: 'Delete finance entry?',
      message: entry.description,
      details: 'This removes the recorded amount from the income, expenditure and net totals for this project.',
      confirmLabel: 'Delete entry',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove('finance_entry', entry.id);
      entries.reload();
      refresh();
      notify('Finance entry deleted', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Finance"
        subtitle={`${project?.name ?? ''} · income and expenditure ledger`}
        actions={
          <>
            <Button icon="refresh" onClick={() => entries.reload()}>
              Refresh
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setEditing(emptyEntry(projectId))}>
              New entry
            </Button>
          </>
        }
      />

      <div className="stat-row compact">
        {summary.length === 0 ? (
          <Stat label="Ledger" value="—" sub="No income or expenditure recorded" />
        ) : (
          summary.map((group) => (
            <React.Fragment key={group.currency}>
              <Stat label={`Income · ${group.currency}`} value={money(group.income, group.currency)} sub="recorded income" />
              <Stat label={`Expenditure · ${group.currency}`} value={money(group.expenditure, group.currency)} sub="recorded spending" />
              <Stat
                label={`Net · ${group.currency}`}
                value={money(group.net, group.currency)}
                sub="income − expenditure"
                tone={group.net < 0 ? 'warn' : undefined}
              />
            </React.Fragment>
          ))
        )}
      </div>

      <Panel
        title="Income and expenditure"
        subtitle="Totals above include every entry in this project; the table filters do not change the balance"
        actions={
          <div className="toolbar-inline">
            <Select value={category} onChange={setCategory} placeholder="All categories" options={FINANCE_CATEGORIES.map((c) => ({ value: c, label: c }))} />
            <SearchInput value={search} onChange={setSearch} placeholder="Search ledger…" />
          </div>
        }
        dense
      >
        <div className="ledger-tabs">
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { key: 'all', label: 'All entries', count: allEntries.length },
              { key: 'income', label: 'Income', count: allEntries.filter((entry: any) => entry.kind === 'income').length },
              { key: 'expenditure', label: 'Expenditure', count: allEntries.filter((entry: any) => entry.kind === 'expenditure').length },
            ]}
          />
        </div>
        {entries.error && <ErrorBox message={entries.error} onRetry={entries.reload} />}
        <DataTable
          rows={filtered}
          onRowClick={setEditing}
          columns={[
            {
              key: 'occurred_on',
              label: 'Date',
              width: '110px',
              sortValue: (entry) => entry.occurred_on ?? '',
              render: (entry) => fmtDate(entry.occurred_on),
            },
            {
              key: 'kind',
              label: 'Type',
              width: '110px',
              render: (entry) => <Badge tone={entry.kind === 'income' ? 'ok' : 'neutral'}>{entry.kind === 'income' ? 'Income' : 'Expenditure'}</Badge>,
            },
            { key: 'description', label: 'Description' },
            { key: 'category', label: 'Category', width: '150px' },
            { key: 'counterparty', label: 'Paid to / from' },
            {
              key: 'amount',
              label: 'Amount',
              align: 'right',
              mono: true,
              sortValue: (entry) => Number(entry.amount),
              render: (entry) => (
                <span className={entry.kind === 'income' ? 'amount-income' : 'amount-expense'}>
                  {entry.kind === 'income' ? '+' : '−'}
                  {money(entry.amount, entry.currency)}
                </span>
              ),
            },
            { key: 'reference', label: 'Reference', mono: true },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (entry) => (
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn" title="Edit" onClick={() => setEditing(entry)}>
                    <Icon name="edit" size={14} />
                  </button>
                  <button className="icon-btn danger" title="Delete" onClick={() => remove(entry)}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ),
            },
          ]}
          empty={
            <EmptyState
              title="No finance entries"
              message="Track money received and money spent against this project. Income and expenditure stay separate while the net balance is calculated for you."
              icon="wallet"
              action={
                <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing(emptyEntry(projectId))}>
                  Add first entry
                </Button>
              }
            />
          }
        />
      </Panel>

      <div className="note-banner">
        Amounts are recorded once, in the currency you select. Income adds to the balance and expenditure subtracts from it; totals and net values are derived and shown
        per currency, never converted. Recording a purchase here does not automatically change inventory, and adding stock does not post an expenditure.
      </div>

      {editing && (
        <Modal
          title={editing.id ? 'Edit finance entry' : 'New finance entry'}
          onClose={() => setEditing(null)}
          size="lg"
          footer={
            <>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button
                variant="primary"
                icon="save"
                onClick={save}
                disabled={!String(editing.description ?? '').trim() || !(Number(editing.amount) > 0)}
              >
                Save entry
              </Button>
            </>
          }
        >
          <RecordEditor
            entity="finance_entry"
            value={editing}
            onChange={(patch) => setEditing((current: any) => ({ ...current, ...patch }))}
            projectId={projectId}
          />
        </Modal>
      )}
    </div>
  );
}
