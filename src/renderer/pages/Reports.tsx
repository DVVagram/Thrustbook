import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { Badge, Button, DataTable, EmptyState, Field, Icon, Input, Modal, PageHeader, Panel, Select, Textarea } from '../ui';
import { fmtDateTime } from '../format';

export default function ReportsPage() {
  const { projectId, project, notify, confirm, setBusy, refresh, route, navigate } = useApp();
  const kinds = useAsync(() => api.reportKinds(), []);
  const reports = useAsync(() => api.reports(projectId), [projectId]);
  const [kind, setKind] = useState(route.query.kind ?? 'project');
  const [entityId, setEntityId] = useState(route.query.entity ?? '');
  const [secondary, setSecondary] = useState(route.query.secondary ?? '');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [includeCharts, setIncludeCharts] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [compareChoices, setCompareChoices] = useState<any[]>([]);
  const [entityChoices, setEntityChoices] = useState<any[]>([]);
  const [lastResult, setLastResult] = useState<any>(null);

  useEffect(() => {
    setKind(route.query.kind ?? 'project');
    setEntityId(route.query.entity ?? '');
    setSecondary(route.query.secondary ?? '');
  }, [route.query.kind, route.query.entity, route.query.secondary]);

  const needsEntity = ['ground-test', 'experimental', 'flight-test', 'analysis', 'comparison', 'calibration', 'revision'].includes(kind);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!projectId) return;
      if (kind === 'comparison') {
        const rows = await api.comparisons(projectId);
        if (!cancelled) {
          setCompareChoices(rows);
          setEntityChoices(rows);
        }
        return;
      }
      const entity =
        kind === 'ground-test' || kind === 'experimental'
          ? 'test'
          : kind === 'flight-test'
            ? 'flight'
            : kind === 'analysis'
              ? 'dataset'
              : kind === 'calibration'
                ? 'sensor'
                : kind === 'revision'
                  ? 'revision'
                  : null;
      if (!entity) {
        setEntityChoices([]);
        return;
      }
      const rows = await api.list(entity, { where: { project_id: projectId }, limit: 500, orderBy: entity === 'dataset' ? 'created_at' : 'name' });
      if (!cancelled) setEntityChoices(rows);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [kind, projectId]);

  const kindDef = useMemo(() => kinds.data?.find((k: any) => k.key === kind), [kinds.data, kind]);
  const compareEntity = kindDef?.entity;

  const labelFor = (row: any) =>
    row.label ?? row.name ?? row.title ?? row.test_no ?? row.flight_no ?? row.id;

  const generate = async (openAfter = true) => {
    if (!projectId) return;
    if (needsEntity && !entityId) {
      notify('Select a record to report on', 'warn');
      return;
    }
    setGenerating(true);
    setBusy('Generating report and PDF…');
    try {
      let comparison: any = undefined;
      if (kind === 'comparison') {
        const saved = compareChoices.find((c: any) => c.id === entityId);
        if (!saved) throw new Error('Select a saved comparison');
        comparison = saved.spec ?? saved.spec_json;
        if (typeof comparison === 'string') comparison = JSON.parse(comparison);
      }
      const result = await api.generateReport({
        projectId,
        kind,
        entityId: needsEntity ? entityId : undefined,
        secondaryId: kind === 'revision' && secondary ? secondary : undefined,
        title: title.trim() || undefined,
        notes,
        includeCharts,
        comparison,
      });
      setLastResult(result);
      reports.reload();
      refresh();
      notify(result.pdfPath ? 'Report generated with PDF export' : `Report generated (PDF failed: ${result.pdfError ?? 'unknown error'})`, result.pdfPath ? 'success' : 'warn');
      if (openAfter && result.report?.id) {
        await api.openReport(result.report.id, 'pdf').catch((err) => notify(err.message, 'error'));
      }
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setGenerating(false);
      setBusy(null);
    }
  };

  if (!projectId) return <EmptyState title="Select a project" icon="folder" />;

  return (
    <div className="page">
      <PageHeader
        title="Reports"
        subtitle={`${project?.name ?? ''} · professional engineering reports with PDF export`}
        actions={<Button icon="refresh" onClick={() => reports.reload()}>Refresh</Button>}
      />

      <div className="detail-grid">
        <Panel title="Generate report" className="detail-main">
          <div className="stack">
            <div className="form-grid">
              <Field label="Report type">
                <Select
                  value={kind}
                  onChange={(v) => {
                    setKind(v);
                    setEntityId('');
                    setSecondary('');
                  }}
                  options={(kinds.data ?? []).map((k: any) => ({ value: k.key, label: k.label }))}
                />
              </Field>
              {needsEntity && (
                <Field label={kind === 'comparison' ? 'Saved comparison' : (compareEntity ? `${compareEntity} record` : 'Record')}>
                  <Select
                    value={entityId}
                    onChange={setEntityId}
                    placeholder={`Select ${kind === 'comparison' ? 'comparison' : 'record'}`}
                    options={entityChoices.map((row) => ({
                      value: row.id,
                      label:
                        kind === 'analysis'
                          ? `${labelFor(row)} · ${Number(row.points).toLocaleString()} rows`
                          : kind === 'comparison'
                            ? labelFor(row)
                            : labelFor(row),
                    }))}
                  />
                </Field>
              )}
              {kind === 'revision' && (
                <Field label="Compare against (optional)">
                  <Select
                    value={secondary}
                    onChange={setSecondary}
                    placeholder="Single revision report"
                    options={entityChoices.filter((r) => r.id !== entityId).map((r) => ({ value: r.id, label: labelFor(r) }))}
                  />
                </Field>
              )}
              <Field label="Report title (optional)" full>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Auto-generated from the record" />
              </Field>
            </div>
            <Field label="Report notes">
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Context that should appear in the report…" />
            </Field>
            <label className="checkbox">
              <input type="checkbox" checked={includeCharts} onChange={(e) => setIncludeCharts(e.target.checked)} />
              <span>Include rendered graphs for recorded channels</span>
            </label>
            {kind === 'comparison' && compareChoices.length === 0 && (
              <div className="warn-banner">
                No saved comparisons yet. Create and save one in <button className="link-btn" onClick={() => navigate('#/compare')}>Dataset Comparison</button>.
              </div>
            )}
            <div className="modal-actions-row">
              <Button variant="primary" icon="report" onClick={() => generate(true)} disabled={generating}>
                {generating ? 'Generating…' : 'Generate PDF report'}
              </Button>
              <Button icon="save" onClick={() => generate(false)} disabled={generating}>
                Generate without opening
              </Button>
            </div>
            <p className="muted small">
              Reports distinguish recorded measurements, user-entered information, derived calculations and conclusions. They are engineering records,
              not safety certifications.
            </p>
          </div>
        </Panel>

        <div className="stack">
          <Panel title="Report contents">
            <ul className="plain-list">
              <li>Project and record metadata</li>
              <li>Configuration and test conditions</li>
              <li>Channel statistics with units</li>
              <li>Rendered graphs (optional)</li>
              <li>Event markers and observations</li>
              <li>Linked issues and documents</li>
              <li>Provenance, checksums and methodology</li>
              <li>Limitations and record classification</li>
            </ul>
          </Panel>
          {lastResult && (
            <Panel title="Last generated">
              <div className="stack">
                <div className="list-title">{lastResult.report?.title}</div>
                <div className="muted small">{fmtDateTime(lastResult.report?.created_at)}</div>
                {!lastResult.pdfPath && <div className="warn-banner">PDF export failed: {lastResult.pdfError}</div>}
                <Button size="sm" icon="doc" onClick={() => api.revealReport(lastResult.report.id)}>Show PDF in folder</Button>
              </div>
            </Panel>
          )}
        </div>
      </div>

      <Panel title={`Generated reports (${reports.data?.length ?? 0})`} dense>
        <DataTable
          rows={reports.data ?? []}
          columns={[
            { key: 'title', label: 'Report' },
            { key: 'kind', label: 'Type', width: '160px' },
            { key: 'created_at', label: 'Generated', render: (r) => fmtDateTime(r.created_at), width: '160px' },
            { key: 'pdf_path', label: 'PDF', width: '90px', render: (r) => (r.pdf_path ? <Badge tone="ok">available</Badge> : <Badge tone="warn">missing</Badge>) },
            {
              key: 'actions',
              label: '',
              align: 'right',
              width: '210px',
              render: (r) => (
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn" title="Open PDF" disabled={!r.pdf_path} onClick={() => api.openReport(r.id, 'pdf').catch((e) => notify(e.message, 'error'))}>
                    <Icon name="doc" size={14} />
                  </button>
                  <button className="icon-btn" title="Save PDF as…" disabled={!r.pdf_path} onClick={() => api.exportReportPdf(r.id).then((x) => !x.canceled && notify('PDF saved', 'success')).catch((e) => notify(e.message, 'error'))}>
                    <Icon name="download" size={14} />
                  </button>
                  <button className="icon-btn" title="Show in folder" onClick={() => api.revealReport(r.id)}>
                    <Icon name="folder" size={14} />
                  </button>
                  <button className="icon-btn" title="Open HTML" disabled={!r.html_path} onClick={() => api.openReport(r.id, 'html').catch((e) => notify(e.message, 'error'))}>
                    <Icon name="link" size={14} />
                  </button>
                  <button
                    className="icon-btn danger"
                    title="Delete report"
                    onClick={async () => {
                      const ok = await confirm({ title: 'Delete report?', message: r.title, details: 'Generated PDF and HTML files remain on disk.', confirmLabel: 'Delete record', danger: true });
                      if (!ok) return;
                      await api.remove('report', r.id);
                      reports.reload();
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ),
            },
          ]}
          onRowClick={(r) => r.pdf_path && api.openReport(r.id, 'pdf').catch((e) => notify(e.message, 'error'))}
          empty={<EmptyState title="No reports generated" message="Choose a report type and generate the first engineering report." icon="report" />}
        />
      </Panel>
    </div>
  );
}
