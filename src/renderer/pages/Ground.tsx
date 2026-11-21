import React from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { EntityPage } from '../EntityPage';
import { Badge, Button, KeyValue, Panel } from '../ui';
import { fmtDate, fmtDateTime } from '../format';
import { TEST_CATEGORIES } from '../../shared/constants';

function TestContext({ test }: { test: any }) {
  const { navigate } = useApp();
  const refs = useAsync(async () => {
    const [revision, campaign, config, linkedIssues] = await Promise.all([
      test.revision_id ? api.get('revision', test.revision_id).catch(() => null) : null,
      test.campaign_id ? api.get('campaign', test.campaign_id).catch(() => null) : null,
      test.electronics_config_id ? api.get('electronics_config', test.electronics_config_id).catch(() => null) : null,
      api.list('issue', { where: { test_id: test.id }, limit: 50 }),
    ]);
    return { revision, campaign, config, linkedIssues };
  }, [test.id, test.revision_id, test.campaign_id, test.electronics_config_id]);

  const data = refs.data;
  return (
    <>
      <Panel title="Test context">
        <KeyValue
          columns={1}
          items={[
            [
              'Rocket revision',
              data?.revision ? (
                <button className="link-btn" onClick={() => navigate(`#/revision/${data.revision.id}`)}>
                  {data.revision.label}
                </button>
              ) : (
                '—'
              ),
            ],
            ['Campaign', data?.campaign ? `${data.campaign.name} (${data.campaign.kind})` : '—'],
            ['Electronics configuration', data?.config?.name ?? '—'],
            ['Test type', test.kind === 'experimental' ? 'Experimental' : 'Ground'],
            ['Performed', fmtDateTime(test.performed_at)],
            ['Expected', test.expected || '—'],
            ['Actual', test.actual || '—'],
          ]}
        />
      </Panel>
      <Panel title="Test record status">
        <div className="stack">
          <div className="muted small">
            Test records are engineering documentation. Completing a test does not certify the hardware as safe or flight-ready.
          </div>
          <Button icon="report" onClick={() => navigate(`#/reports?kind=ground-test&entity=${test.id}`)}>
            Generate test report
          </Button>
          <Button icon="compare" onClick={() => navigate(`#/compare`)}>
            Compare test datasets
          </Button>
        </div>
      </Panel>
    </>
  );
}

export default function GroundPage() {
  return (
    <EntityPage
      entity="test"
      basePath="#/ground"
      title="Ground Testing"
      singular="ground test"
      icon="beaker"
      intro="Document electronics verification, calibration, telemetry, power, structural and experimental ground tests with their measurement data."
      supportDatasets="test"
      filterField={{ key: 'category', label: 'Categories', options: TEST_CATEGORIES }}
      createDefaults={() => ({
        kind: 'ground',
        status: 'Planned',
        category: 'General experimental testing',
        performed_at: new Date().toISOString(),
      })}
      columns={[
        { key: 'name', label: 'Test', render: (t) => <span className="link-like">{t.name}</span> },
        { key: 'test_no', label: 'No.', mono: true, width: '90px' },
        { key: 'category', label: 'Category' },
        { key: 'performed_at', label: 'Date', render: (t) => (t.performed_at ? fmtDate(t.performed_at) : '—'), width: '110px' },
        { key: 'status', label: 'Status', render: (t) => <Badge>{t.status}</Badge>, width: '110px' },
        { key: 'updated_at', label: 'Updated', render: (t) => fmtDate(t.updated_at), width: '110px' },
      ]}
      detailExtras={(row) => <TestContext test={row} />}
    />
  );
}
