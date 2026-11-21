import React from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { EntityPage } from '../EntityPage';
import { Badge, Button, DataTable, Panel } from '../ui';
import { fmtDate, fmtDateTime } from '../format';
import { FLIGHT_STATUSES } from '../../shared/constants';

function FlightContext({ flight }: { flight: any }) {
  const { navigate } = useApp();
  const info = useAsync(async () => {
    const [revision, previous] = await Promise.all([
      flight.revision_id ? api.get('revision', flight.revision_id).catch(() => null) : null,
      api.list('flight', { where: { project_id: flight.project_id }, limit: 50 }),
    ]);
    return { revision, previous: previous.filter((f: any) => f.id !== flight.id) };
  }, [flight.id, flight.revision_id, flight.project_id]);

  return (
    <>
      <Panel title="Flight context">
        <div className="stack">
          <div className="kv-item">
            <span className="kv-key">Rocket revision</span>
            <span className="kv-value">
              {info.data?.revision ? (
                <button className="link-btn" onClick={() => navigate(`#/revision/${info.data?.revision?.id ?? ''}`)}>
                  {info.data.revision.label}
                </button>
              ) : (
                '—'
              )}
            </span>
          </div>
          <div className="kv-item">
            <span className="kv-key">Flown</span>
            <span className="kv-value">{fmtDateTime(flight.performed_at)}</span>
          </div>
          <div className="kv-item">
            <span className="kv-key">Firmware</span>
            <span className="kv-value mono small">{flight.firmware_versions || '—'}</span>
          </div>
          <Button icon="report" onClick={() => navigate(`#/reports?kind=flight-test&entity=${flight.id}`)}>
            Generate flight report
          </Button>
        </div>
      </Panel>
      <Panel title="Other flights">
        {(info.data?.previous ?? []).length === 0 ? (
          <div className="muted small">No other flights in this project.</div>
        ) : (
          <DataTable
            rows={info.data?.previous ?? []}
            columns={[
              { key: 'name', label: 'Flight', render: (f) => <span className="link-like">{f.name}</span> },
              { key: 'performed_at', label: 'Date', render: (f) => fmtDate(f.performed_at) },
              { key: 'status', label: 'Status', render: (f) => <Badge>{f.status}</Badge> },
            ]}
            onRowClick={(f) => navigate(`#/flights/${f.id}`)}
          />
        )}
      </Panel>
    </>
  );
}

export default function FlightsPage() {
  return (
    <EntityPage
      entity="flight"
      basePath="#/flights"
      title="Flight Testing"
      singular="flight"
      icon="flight"
      intro="Each flight is an individual engineering record connected to a project, rocket revision and configuration, with its flight computer recordings."
      supportDatasets="flight"
      filterField={{ key: 'status', label: 'Status', options: FLIGHT_STATUSES }}
      createDefaults={() => ({ status: 'Planned', performed_at: new Date().toISOString() })}
      columns={[
        { key: 'name', label: 'Flight', render: (f) => <span className="link-like">{f.name}</span> },
        { key: 'flight_no', label: 'No.', mono: true, width: '90px' },
        { key: 'performed_at', label: 'Date', render: (f) => (f.performed_at ? fmtDate(f.performed_at) : '—'), width: '110px' },
        { key: 'status', label: 'Status', render: (f) => <Badge>{f.status}</Badge>, width: '130px' },
        { key: 'firmware_versions', label: 'Firmware', render: (f) => <span className="mono small">{f.firmware_versions?.slice(0, 30) || '—'}</span> },
        { key: 'updated_at', label: 'Updated', render: (f) => fmtDate(f.updated_at), width: '110px' },
      ]}
      detailExtras={(row) => <FlightContext flight={row} />}
    />
  );
}
