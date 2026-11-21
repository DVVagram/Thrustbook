import React from 'react';
import { EntityPage } from '../EntityPage';
import { Badge } from '../ui';
import { fmtDate } from '../format';
import { ISSUE_SEVERITIES, ISSUE_STATUSES } from '../../shared/constants';

export default function IssuesPage() {
  return (
    <EntityPage
      entity="issue"
      basePath="#/issues"
      title="Issues & Observations"
      singular="issue"
      icon="alert"
      intro="Track anomalies, unexpected results and engineering observations through investigation, resolution and verification."
      filterField={{ key: 'status', label: 'statuses', options: ISSUE_STATUSES }}
      createDefaults={() => ({
        status: 'Open',
        severity: 'Medium',
        category: 'Observation',
        identified_at: new Date().toISOString(),
      })}
      columns={[
        { key: 'title', label: 'Issue', render: (i) => <span className="link-like">{i.title}</span> },
        { key: 'severity', label: 'Severity', width: '100px', render: (i) => <Badge>{i.severity}</Badge> },
        { key: 'status', label: 'Status', width: '120px', render: (i) => <Badge>{i.status}</Badge> },
        { key: 'category', label: 'Category', width: '140px' },
        { key: 'identified_at', label: 'Identified', width: '110px', render: (i) => fmtDate(i.identified_at || i.created_at) },
        { key: 'resolution', label: 'Resolution', render: (i) => <span className="ellipsis">{i.resolution || '—'}</span> },
        { key: 'updated_at', label: 'Updated', width: '110px', render: (i) => fmtDate(i.updated_at) },
      ]}
      detailExtras={(row) => (
        <div className="panel">
          <header className="panel-head">
            <div className="panel-title">Lifecycle</div>
          </header>
          <div className="panel-body">
            <div className="stack">
              <div className="muted small">
                Severity levels: {ISSUE_SEVERITIES.join(' · ')}. Status flow: {ISSUE_STATUSES.join(' → ')}.
              </div>
              <div className="muted small">
                Issues record engineering judgement. The application does not perform safety certification; resolving an issue does not establish flight readiness.
              </div>
            </div>
          </div>
        </div>
      )}
    />
  );
}
