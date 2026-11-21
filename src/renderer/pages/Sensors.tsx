import React, { useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { DocumentPanel } from '../EntityPage';
import { RecordEditor, RecordForm } from '../RecordForm';
import { Badge, Button, DataTable, EmptyState, ErrorBox, Icon, KeyValue, Modal, PageHeader, Panel, SearchInput, Select, Tabs } from '../ui';
import { fmtDate, fmtDateTime } from '../format';
import { SENSOR_TYPES } from '../../shared/constants';

export default function SensorsPage() {
  const { projectId, project, notify, confirm, refresh, route, navigate } = useApp();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(route.query.sensor ?? null);
  const [tab, setTab] = useState('record');
  const [editing, setEditing] = useState<any>(null);
  const [calibrating, setCalibrating] = useState<any>(null);
  const [draft, setDraft] = useState<any>({});
  const [dirty, setDirty] = useState(false);

  const sensors = useAsync(() => api.list('sensor', { where: { project_id: projectId, ...(type ? { type } : {}) }, q: search || undefined, limit: 500 }), [projectId, search, type]);
  const history = useAsync(() => (selectedId ? api.sensorHistory(selectedId) : Promise.resolve(null)), [selectedId]);
  const docs = useAsync(() => (selectedId ? api.linked('sensor', selectedId).then((l) => l.documents ?? []) : Promise.resolve([])), [selectedId]);

  if (!projectId) return <EmptyState title="Select a project" icon="folder" />;

  const openSensor = (sensor: any) => {
    setSelectedId(sensor.id);
    setDraft({ ...sensor });
    setDirty(false);
    setTab('record');
  };

  const saveSensor = async () => {
    try {
      await api.update('sensor', selectedId!, draft);
      setDirty(false);
      notify('Sensor saved', 'success');
      sensors.reload();
      history.reload();
      refresh();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const saveCalibration = async () => {
    try {
      const payload = { ...calibrating, sensor_id: selectedId, project_id: projectId };
      if (payload.id) await api.update('calibration', payload.id, payload);
      else await api.create('calibration', payload);
      setCalibrating(null);
      history.reload();
      notify('Calibration record saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const sensor = history.data?.sensor;

  return (
    <div className="page">
      <PageHeader
        title="Sensor Management"
        subtitle={`${project?.name ?? ''} · sensor database, calibration history and installation records`}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setEditing({ __entity: 'sensor', project_id: projectId, type: 'Accelerometer' })}>
            New sensor
          </Button>
        }
      />

      <div className={selectedId ? 'split-pane' : ''}>
        <Panel
          title="Sensor database"
          actions={
            <div className="toolbar-inline">
              <Select value={type} onChange={setType} placeholder="All types" options={SENSOR_TYPES.map((t) => ({ value: t, label: t }))} />
              <SearchInput value={search} onChange={setSearch} placeholder="Search sensors…" />
            </div>
          }
          dense
        >
          {sensors.error && <ErrorBox message={sensors.error} onRetry={sensors.reload} />}
          <DataTable
            rows={sensors.data ?? []}
            selectedKey={selectedId}
            onRowClick={openSensor}
            columns={[
              { key: 'name', label: 'Sensor' },
              { key: 'type', label: 'Type', width: '140px' },
              { key: 'manufacturer', label: 'Manufacturer' },
              { key: 'model', label: 'Model', mono: true },
              { key: 'serial', label: 'Serial', mono: true },
              { key: 'units', label: 'Units' },
              { key: 'range_min', label: 'Range', render: (s) => (s.range_min !== null ? `${s.range_min} … ${s.range_max} ${s.range_unit}` : '—') },
            ]}
            empty={<EmptyState title="No sensors" message="Register accelerometers, barometers, thermometers, GPS and other instruments." icon="sensor" />}
          />
        </Panel>

        {selectedId && sensor && (
          <Panel
            title={sensor.name}
            actions={
              <button className="icon-btn" onClick={() => { setSelectedId(null); navigate('#/sensors'); }} title="Close">
                <Icon name="x" size={14} />
              </button>
            }
          >
            <Tabs
              active={tab}
              onChange={setTab}
              tabs={[
                { key: 'record', label: 'Record' },
                { key: 'calibrations', label: 'Calibrations', count: history.data?.calibrations?.length ?? 0 },
                { key: 'installations', label: 'Installations', count: history.data?.installations?.length ?? 0 },
                { key: 'documents', label: 'Documents', count: docs.data?.length ?? 0 },
              ]}
            />

            {tab === 'record' && (
              <div className="stack">
                <RecordForm
                  entity="sensor"
                  value={draft}
                  projectId={projectId}
                  onChange={(patch) => {
                    setDraft((prev: any) => ({ ...prev, ...patch }));
                    setDirty(true);
                  }}
                />
                <div className="modal-actions-row">
                  <Button variant="primary" icon="save" onClick={saveSensor} disabled={!dirty}>Save sensor</Button>
                  <Button icon="report" onClick={() => navigate(`#/reports?kind=calibration&entity=${selectedId}`)}>Calibration report</Button>
                  <Button
                    variant="danger"
                    icon="trash"
                    onClick={async () => {
                      const ok = await confirm({ title: 'Delete sensor?', message: sensor.name, details: 'Calibration records will also be removed.', confirmLabel: 'Delete', danger: true });
                      if (!ok) return;
                      await api.remove('sensor', selectedId);
                      setSelectedId(null);
                      sensors.reload();
                    }}
                  >
                    Delete
                  </Button>
                </div>
                <KeyValue
                  columns={1}
                  items={[
                    ['Installed on recordings', history.data?.channels?.length ?? 0],
                    ['Registered', fmtDateTime(sensor.created_at)],
                  ]}
                />
                <div className="muted small">
                  Calibration changes are never applied to historical recordings automatically. Applying coefficients produces a new derived dataset with recorded provenance.
                </div>
              </div>
            )}

            {tab === 'calibrations' && (
              <div className="stack">
                <Button size="sm" icon="plus" onClick={() => setCalibrating({ performed_at: new Date().toISOString(), method: '' })}>
                  Record calibration
                </Button>
                {(history.data?.calibrations ?? []).length === 0 ? (
                  <EmptyState title="No calibration records" icon="sensor" />
                ) : (
                  <DataTable
                    rows={history.data!.calibrations}
                    columns={[
                      { key: 'performed_at', label: 'Date', render: (c) => fmtDateTime(c.performed_at) },
                      { key: 'method', label: 'Method' },
                      { key: 'reference_equipment', label: 'Reference' },
                      { key: 'coefficients', label: 'Coefficients', mono: true },
                      { key: 'uncertainty', label: 'Uncertainty' },
                      {
                        key: 'actions',
                        label: '',
                        align: 'right',
                        render: (c) => (
                          <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                            <button className="icon-btn" onClick={() => setCalibrating({ ...c })}>
                              <Icon name="edit" size={14} />
                            </button>
                            <button
                              className="icon-btn danger"
                              onClick={async () => {
                                const ok = await confirm({ title: 'Delete calibration record?', message: c.method, confirmLabel: 'Delete', danger: true });
                                if (!ok) return;
                                await api.remove('calibration', c.id);
                                history.reload();
                              }}
                            >
                              <Icon name="trash" size={14} />
                            </button>
                          </div>
                        ),
                      },
                    ]}
                    onRowClick={(c) => setCalibrating({ ...c })}
                  />
                )}
              </div>
            )}

            {tab === 'installations' && (
              <div className="stack">
                <Button
                  size="sm"
                  icon="plus"
                  onClick={async () => {
                    await api.create('sensor_installation', {
                      sensor_id: selectedId,
                      project_id: projectId,
                      installed_at: new Date().toISOString(),
                      location: '',
                    });
                    history.reload();
                  }}
                >
                  Record installation
                </Button>
                {(history.data?.installations ?? []).length === 0 ? (
                  <EmptyState title="No installation records" icon="sensor" />
                ) : (
                  <DataTable
                    rows={history.data!.installations}
                    columns={[
                      { key: 'entity_type', label: 'Attached to' },
                      { key: 'entity_id', label: 'Record', render: (i) => <span className="mono tiny">{i.entity_id.slice(0, 8)}</span> },
                      { key: 'location', label: 'Location' },
                      { key: 'installed_at', label: 'Installed', render: (i) => fmtDate(i.installed_at) },
                      { key: 'removed_at', label: 'Removed', render: (i) => fmtDate(i.removed_at) },
                    ]}
                  />
                )}
              </div>
            )}

            {tab === 'documents' && (
              <DocumentPanel documents={docs.data ?? []} projectId={projectId} entityType="sensor" entityId={selectedId} onChange={() => docs.reload()} />
            )}
          </Panel>
        )}
      </div>

      {!selectedId && (
        <Panel title="Calibration policy">
          <p className="muted small">
            Each sensor can carry multiple calibration records over time. Historical datasets keep the calibration context they were imported with;
            applying new coefficients creates a separate processed dataset that records the operation, parameters and source.
          </p>
        </Panel>
      )}

      {editing && (
        <Modal
          title="New sensor"
          onClose={() => setEditing(null)}
          size="lg"
          footer={
            <>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    const created = await api.create('sensor', { ...editing, project_id: projectId });
                    setEditing(null);
                    sensors.reload();
                    refresh();
                    openSensor(created);
                    notify('Sensor registered', 'success');
                  } catch (err: any) {
                    notify(err.message, 'error');
                  }
                }}
              >
                Save sensor
              </Button>
            </>
          }
        >
          <RecordEditor entity="sensor" value={editing} onChange={(patch) => setEditing((d: any) => ({ ...d, ...patch }))} projectId={projectId} />
        </Modal>
      )}

      {calibrating && (
        <Modal
          title="Calibration record"
          onClose={() => setCalibrating(null)}
          footer={
            <>
              <Button onClick={() => setCalibrating(null)}>Cancel</Button>
              <Button variant="primary" onClick={saveCalibration}>Save calibration</Button>
            </>
          }
        >
          <RecordEditor entity="calibration" value={calibrating} onChange={(patch) => setCalibrating((d: any) => ({ ...d, ...patch }))} projectId={projectId} />
        </Modal>
      )}
    </div>
  );
}
