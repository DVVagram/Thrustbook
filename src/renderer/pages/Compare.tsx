import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { Chart } from '../Chart';
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  Icon,
  Input,
  Modal,
  PageHeader,
  Panel,
  Select,
  Tabs,
  Textarea,
} from '../ui';
import { fmtDateTime } from '../format';
import { dimensionOf } from '../../shared/units';
import { GRAPH_TYPES } from '../../shared/constants';

interface Item {
  datasetId: string;
  channelId: string;
}

export default function ComparePage() {
  const { projectId, project, notify, confirm, route } = useApp();
  const candidates = useAsync(() => (projectId ? api.comparisonCandidates(projectId) : Promise.resolve([])), [projectId]);
  const saved = useAsync(() => (projectId ? api.comparisons(projectId) : Promise.resolve([])), [projectId]);
  const [items, setItems] = useState<Item[]>([]);
  const [mode, setMode] = useState<'record-start' | 'absolute' | 'event'>('record-start');
  const [normalization, setNormalization] = useState('none');
  const [commonRange, setCommonRange] = useState(true);
  const [gridPoints, setGridPoints] = useState('2000');
  const [offsets, setOffsets] = useState<Record<string, string>>({});
  const [baseIndex, setBaseIndex] = useState('0');
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState('overlay');
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveNotes, setSaveNotes] = useState('');
  const [saveRevision, setSaveRevision] = useState('');
  const [addDatasetId, setAddDatasetId] = useState('');
  const revisions = useAsync(() => api.list('revision', { where: { project_id: projectId }, limit: 200 }), [projectId]);

  const chooseDefaultChannel = (datasetId: string) => {
    const candidate = candidates.data?.find((d: any) => d.id === datasetId);
    if (!candidate?.channels?.length) return '';
    const referenceDim = items.length ? dimensionOf(candidates.data?.find((d: any) => d.id === items[0].datasetId)?.channels?.find((c: any) => c.id === items[0].channelId)?.unit) : null;
    const match = referenceDim ? candidate.channels.find((c: any) => dimensionOf(c.unit) === referenceDim) : null;
    const byName = items.length
      ? candidate.channels.find((c: any) => c.name.toLowerCase() === candidates.data?.find((d: any) => d.id === items[0].datasetId)?.channels?.find((c2: any) => c2.id === items[0].channelId)?.name?.toLowerCase())
      : null;
    return (byName ?? match ?? candidate.channels[0])?.id ?? '';
  };

  const addDataset = (datasetId: string) => {
    if (!datasetId || items.some((i) => i.datasetId === datasetId)) return;
    const channelId = chooseDefaultChannel(datasetId);
    if (!channelId) {
      notify('That dataset has no measurement channels', 'warn');
      return;
    }
    setItems((prev) => [...prev, { datasetId, channelId }]);
    setAddDatasetId('');
  };

  useEffect(() => {
    if (route.query.datasets) {
      const ids = route.query.datasets.split(',');
      const next: Item[] = [];
      for (const id of ids) {
        const candidate = candidates.data?.find((d: any) => d.id === id);
        const channel = candidate?.channels?.[0];
        if (channel) next.push({ datasetId: id, channelId: channel.id });
      }
      if (next.length) setItems(next.slice(0, 6));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.query.datasets, candidates.data]);

  const run = async () => {
    if (items.length < 2) {
      notify('Select at least two datasets to compare', 'warn');
      return;
    }
    setRunning(true);
    try {
      const outcome = await api.runComparison({
        items,
        mode,
        offsets: Object.fromEntries(Object.entries(offsets).map(([k, v]) => [k, Number(v) || 0])),
        gridPoints: Number(gridPoints) || 2000,
        commonRange,
        normalization,
        baseIndex: Number(baseIndex) || 0,
      });
      setResult(outcome);
      if (!outcome.compatible) notify('The selected channels are not directly comparable', 'warn');
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setRunning(false);
    }
  };

  const saveComparison = async () => {
    if (!saveName.trim() || !result) return;
    try {
      await api.saveComparison({
        project_id: projectId,
        revision_id: saveRevision,
        name: saveName,
        notes: saveNotes,
        spec_json: {
          items,
          mode,
          offsets: Object.fromEntries(Object.entries(offsets).map(([k, v]) => [k, Number(v) || 0])),
          gridPoints: Number(gridPoints) || 2000,
          commonRange,
          normalization,
          baseIndex: Number(baseIndex) || 0,
          savedAt: new Date().toISOString(),
        },
      });
      setSaveOpen(false);
      setSaveName('');
      setSaveNotes('');
      saved.reload();
      notify('Comparison saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const loadComparison = (row: any) => {
    const spec = row.spec ?? row.spec_json;
    if (!spec) return;
    setItems(spec.items ?? []);
    setMode(spec.mode ?? 'record-start');
    setOffsets(Object.fromEntries(Object.entries(spec.offsets ?? {}).map(([k, v]) => [k, String(v)])));
    setGridPoints(String(spec.gridPoints ?? 2000));
    setCommonRange(spec.commonRange !== false);
    setNormalization(spec.normalization ?? 'none');
    setBaseIndex(String(spec.baseIndex ?? 0));
    setSaveName(row.name);
    setSaveNotes(row.notes ?? '');
    setSaveRevision(row.revision_id ?? '');
    notify(`Comparison “${row.name}” loaded — run to recompute`, 'info');
  };

  const chartSeries = useMemo(() => {
    if (!result?.series) return [];
    return result.series.map((s: any, i: number) => ({
      id: `${s.datasetId}-${s.channelId}`,
      label: `${s.datasetName} · ${s.channelName}`,
      x: s.x,
      y: s.y,
      unit: s.unit,
    }));
  }, [result]);

  const differenceSeries = useMemo(() => {
    if (!result?.series?.length) return [];
    const base = result.series[0];
    return result.series.slice(1).map((s: any) => ({
      id: `diff-${s.datasetId}`,
      label: `${s.datasetName} − ${base.datasetName}`,
      x: base.x,
      y: s.y.map((v: number | null, i: number) => {
        const b = base.y[i];
        if (v === null || b === null) return null;
        return v - b;
      }),
      unit: s.unit,
    }));
  }, [result]);

  const percentSeries = useMemo(() => {
    if (!result?.series?.length) return [];
    const base = result.series[0];
    return result.series.slice(1).map((s: any) => ({
      id: `pct-${s.datasetId}`,
      label: `${s.datasetName} vs ${base.datasetName} [%]`,
      x: base.x,
      y: s.y.map((v: number | null, i: number) => {
        const b = base.y[i];
        if (v === null || b === null || b === 0) return null;
        return ((v - b) / Math.abs(b)) * 100;
      }),
      unit: '%',
    }));
  }, [result]);

  if (!projectId) return <EmptyState title="Select a project" icon="folder" />;

  return (
    <div className="page compare-page">
      <PageHeader
        title="Dataset Comparison"
        subtitle={`${project?.name ?? ''} · align, overlay and statistically compare recordings from different tests, flights and revisions`}
        actions={
          <>
            <Button icon="refresh" onClick={() => candidates.reload()}>Refresh datasets</Button>
            <Button variant="primary" icon="compare" onClick={run} disabled={running || items.length < 2}>
              {running ? 'Comparing…' : 'Run comparison'}
            </Button>
          </>
        }
      />

      <div className="detail-grid">
        <Panel title="Selected datasets" className="detail-main">
          <div className="stack">
            <div className="toolbar-inline">
              <Select
                value={addDatasetId}
                onChange={setAddDatasetId}
                placeholder="Add a dataset…"
                options={(candidates.data ?? [])
                  .filter((d: any) => !items.some((i) => i.datasetId === d.id))
                  .map((d: any) => ({ value: d.id, label: `${d.name} · ${d.project_name ?? ''}` }))}
              />
              <Button size="sm" icon="plus" disabled={!addDatasetId} onClick={() => addDataset(addDatasetId)}>
                Add
              </Button>
              <span className="status-spacer" />
              {items.length > 0 && (
                <Button size="sm" icon="x" onClick={() => setItems([])}>Clear</Button>
              )}
            </div>
            {items.length === 0 ? (
              <EmptyState title="No datasets selected" message="Select two or more recordings with comparable measurement channels." icon="compare" />
            ) : (
              <div className="compare-items">
                {items.map((item, index) => {
                  const candidate = candidates.data?.find((d: any) => d.id === item.datasetId);
                  return (
                    <div className="compare-item" key={item.datasetId}>
                      <div className="compare-item-head">
                        <span className="compare-index">{String.fromCharCode(65 + index)}</span>
                        <div>
                          <div className="list-title">{candidate?.name ?? item.datasetId}</div>
                          <div className="muted tiny">
                            {candidate?.project_name} · {candidate?.test_name || candidate?.flight_name || candidate?.run_label || 'no linked test'} ·{' '}
                            {Number(candidate?.points ?? 0).toLocaleString()} rows · {candidate?.sampling_hz ? `${Number(candidate.sampling_hz).toFixed(2)} Hz` : 'rate unknown'} ·{' '}
                            {fmtDateTime(candidate?.recorded_at)}
                          </div>
                        </div>
                        <button className="icon-btn danger" title="Remove" onClick={() => setItems((prev) => prev.filter((i) => i.datasetId !== item.datasetId))}>
                          <Icon name="x" size={13} />
                        </button>
                      </div>
                      <Select
                        value={item.channelId}
                        onChange={(v) => setItems((prev) => prev.map((i) => (i.datasetId === item.datasetId ? { ...i, channelId: v } : i)))}
                        options={(candidate?.channels ?? []).map((c: any) => ({ value: c.id, label: `${c.name}${c.unit ? ` [${c.unit}]` : ''} · ${c.type}` }))}
                      />
                      {mode === 'event' && (
                        <Field label="Event offset [s]" hint="Added to this recording's elapsed time">
                          <Input
                            type="number"
                            step="any"
                            value={offsets[candidate?.id ?? item.datasetId] ?? ''}
                            onChange={(e) => setOffsets((prev) => ({ ...prev, [candidate?.id ?? item.datasetId]: e.target.value }))}
                          />
                        </Field>
                      )}
                      <div className="muted tiny">
                        {(candidate?.channels ?? []).length} channels available · recording {candidate?.kind}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Panel>

        <div className="stack">
          <Panel title="Alignment & normalization">
            <div className="stack">
              <Field label="Time alignment">
                <Select
                  value={mode}
                  onChange={(v) => setMode(v as any)}
                  options={[
                    { value: 'record-start', label: 'Start of recording (elapsed time)' },
                    { value: 'absolute', label: 'Absolute timestamp' },
                    { value: 'event', label: 'User-defined event alignment' },
                  ]}
                />
              </Field>
              <Field label="Normalization">
                <Select
                  value={normalization}
                  onChange={setNormalization}
                  options={[
                    { value: 'none', label: 'None — recorded units' },
                    { value: 'minmax', label: 'Min–max (0…1)' },
                    { value: 'zscore', label: 'Z-score (mean 0, σ 1)' },
                    { value: 'peak', label: 'Peak (max |value| = 1)' },
                    { value: 'zero-initial', label: 'Zero at first sample' },
                  ]}
                />
              </Field>
              <Field label="Shared grid points">
                <Input type="number" value={gridPoints} onChange={(e) => setGridPoints(e.target.value)} />
              </Field>
              <Field label="Baseline series">
                <Select
                  value={baseIndex}
                  onChange={setBaseIndex}
                  options={items.map((it, i) => ({
                    value: String(i),
                    label: `${String.fromCharCode(65 + i)} · ${candidates.data?.find((d: any) => d.id === it.datasetId)?.name ?? ''}`,
                  }))}
                />
              </Field>
              <Checkbox checked={commonRange} onChange={setCommonRange} label="Use common time range (intersection)" />
              <div className="muted small">
                Alignment is applied for analysis only. Originals are never modified; interpolated and resampled values are identified in the results.
              </div>
            </div>
          </Panel>

          <Panel title="Saved comparisons" actions={<Button size="sm" icon="save" onClick={() => setSaveOpen(true)} disabled={!result}>Save current</Button>}>
            {(saved.data ?? []).length === 0 ? (
              <div className="muted small">No saved comparisons.</div>
            ) : (
              <div className="list-rows">
                {saved.data!.map((c: any) => (
                  <div className="list-row static" key={c.id}>
                    <button className="link-like" onClick={() => loadComparison(c)}>{c.name}</button>
                    <button
                      className="icon-btn danger"
                      onClick={async () => {
                        const ok = await confirm({ title: 'Delete comparison?', message: c.name, confirmLabel: 'Delete', danger: true });
                        if (!ok) return;
                        await api.removeComparison(c.id);
                        saved.reload();
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>

      {result && (
        <div className="stack">
          {!result.compatible && (
            <div className="error-box">
              <strong>Not directly comparable:</strong> {result.incompatibility}
            </div>
          )}

          <Panel title="Comparison setup">
            <div className="stat-row compact">
              <div className="mini-stat"><span>Alignment</span><strong>{result.alignmentLabel}</strong></div>
              <div className="mini-stat"><span>Grid</span><strong>{result.gridPoints} points</strong></div>
              <div className="mini-stat"><span>Unit</span><strong>{result.targetUnit || '—'}</strong></div>
              <div className="mini-stat"><span>Normalization</span><strong>{result.normalization}</strong></div>
              <div className="mini-stat"><span>Range</span><strong>{Number(result.range.from).toFixed(3)} … {Number(result.range.to).toFixed(3)} s</strong></div>
            </div>
            {result.warnings.length > 0 && (
              <div className="warn-banner">
                <ul>{result.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
            <p className="muted small">{result.method} · {result.normalizationNote}</p>
          </Panel>

          <Tabs
            active={view}
            onChange={setView}
            tabs={[
              { key: 'overlay', label: 'Overlay' },
              { key: 'side', label: 'Side-by-side' },
              { key: 'difference', label: 'Difference' },
              { key: 'percent', label: 'Percentage difference' },
              { key: 'distribution', label: 'Distribution' },
              { key: 'stats', label: 'Statistics' },
            ]}
          />

          {view === 'overlay' && (
            <Panel title="Overlay comparison">
              <Chart series={chartSeries} type="line" title="Aligned comparison" xLabel="aligned time [s]" yLabel={result.targetUnit} height={380} />
            </Panel>
          )}

          {view === 'side' && (
            <div className="chart-grid">
              {result.series.map((s: any) => (
                <div className="chart-panel" key={s.datasetId + s.channelId}>
                  <div className="chart-panel-head">
                    <div className="panel-title">{s.datasetName} · {s.channelName}</div>
                    <Badge>{s.unit || 'unitless'}</Badge>
                  </div>
                  <Chart
                    series={[{ id: s.datasetId, label: `${s.datasetName} · ${s.channelName}`, x: s.x, y: s.y, unit: s.unit }]}
                    type="line"
                    height={250}
                    title={s.channelName}
                    xLabel="aligned time [s]"
                    yLabel={s.unit}
                  />
                </div>
              ))}
            </div>
          )}

          {view === 'difference' && (
            <Panel title="Difference to baseline" subtitle={`Baseline: ${result.series[0]?.datasetName} · ${result.series[0]?.channelName}`}>
              <Chart series={differenceSeries} type="difference" title="Difference" xLabel="aligned time [s]" yLabel={result.targetUnit} height={340} />
            </Panel>
          )}

          {view === 'percent' && (
            <Panel title="Percentage difference" subtitle="Points with a zero or missing baseline are excluded">
              <Chart series={percentSeries} type="percentdiff" title="Percentage difference" xLabel="aligned time [s]" yLabel="%" height={340} />
            </Panel>
          )}

          {view === 'distribution' && (
            <div className="stack">
              <Panel title="Distribution of values">
                <Chart series={chartSeries} type="distribution" title="Frequency distribution" height={320} />
              </Panel>
              <Panel title="Box plot comparison">
                <Chart series={chartSeries} type="box" height={320} title="Box plot (Tukey fences)" />
              </Panel>
            </div>
          )}

          {view === 'stats' && (
            <div className="stack">
              <Panel title="Per-series statistics">
                <DataTable
                  rows={result.series}
                  columns={[
                    { key: 'datasetName', label: 'Dataset' },
                    { key: 'channelName', label: 'Channel' },
                    { key: 'unit', label: 'Unit' },
                    { key: 'stats', label: 'Valid', align: 'right', mono: true, render: (s) => s.stats.valid },
                    { key: 'min', label: 'Min', align: 'right', mono: true, render: (s) => fmt(s.stats.min) },
                    { key: 'max', label: 'Max', align: 'right', mono: true, render: (s) => fmt(s.stats.max) },
                    { key: 'mean', label: 'Mean', align: 'right', mono: true, render: (s) => fmt(s.stats.mean) },
                    { key: 'median', label: 'Median', align: 'right', mono: true, render: (s) => fmt(s.stats.median) },
                    { key: 'stdDev', label: 'Std dev', align: 'right', mono: true, render: (s) => fmt(s.stats.stdDev) },
                    { key: 'rms', label: 'RMS', align: 'right', mono: true, render: (s) => fmt(s.stats.rms) },
                  ]}
                />
              </Panel>
              {result.pairs.length > 0 && (
                <Panel title="Paired comparison against baseline">
                  <DataTable
                    rows={result.pairs}
                    columns={[
                      { key: 'otherName', label: 'Series' },
                      { key: 'stats', label: 'Valid pairs', align: 'right', mono: true, render: (p) => p.stats.valid },
                      { key: 'mean', label: 'Mean Δ', align: 'right', mono: true, render: (p) => fmt(p.stats.mean) },
                      { key: 'meanAbs', label: 'Mean |Δ|', align: 'right', mono: true, render: (p) => fmt(p.stats.meanAbs) },
                      { key: 'rms', label: 'RMS Δ', align: 'right', mono: true, render: (p) => fmt(p.stats.rms) },
                      { key: 'peak', label: 'Peak |Δ|', align: 'right', mono: true, render: (p) => fmt(p.stats.peakAbs) },
                      { key: 'corr', label: 'Pearson r', align: 'right', mono: true, render: (p) => (p.stats.correlation === null ? '—' : p.stats.correlation.toFixed(4)) },
                      { key: 'pct', label: 'Mean %Δ', align: 'right', mono: true, render: (p) => (p.percent.mean === null ? '—' : `${p.percent.mean.toFixed(2)} %`) },
                    ]}
                  />
                  <p className="muted small">{result.pairs[0]?.percent.note}</p>
                </Panel>
              )}
              <Panel title="Selected recording metadata">
                <DataTable
                  rows={result.metadata}
                  columns={[
                    { key: 'datasetName', label: 'Dataset' },
                    { key: 'channelName', label: 'Channel' },
                    { key: 'recordingDate', label: 'Recorded', render: (m) => fmtDateTime(m.recordingDate) },
                    { key: 'samplingHz', label: 'Sampling [Hz]', align: 'right', mono: true, render: (m) => (m.samplingHz ? Number(m.samplingHz).toFixed(2) : '—') },
                    { key: 'sourcePoints', label: 'Points', align: 'right', mono: true, render: (m) => Number(m.sourcePoints).toLocaleString() },
                    { key: 'unit', label: 'Unit' },
                  ]}
                />
              </Panel>
            </div>
          )}

          <Panel title="Limitations">
            <ul className="caveat-list">
              {result.limitations.map((l: string, i: number) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </Panel>
        </div>
      )}

      {!result && items.length > 0 && (
        <div className="muted small">
          Run the comparison to align the recordings and compute statistics. Difference, percentage and distribution views require at least two datasets.
        </div>
      )}

      {saveOpen && (
        <Modal
          title="Save comparison"
          onClose={() => setSaveOpen(false)}
          footer={
            <>
              <Button onClick={() => setSaveOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={saveComparison} disabled={!saveName.trim()}>Save comparison</Button>
            </>
          }
        >
          <div className="stack">
            <Field label="Name" required>
              <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="e.g. Rev B vs Rev C apogee" autoFocus />
            </Field>
            <Field label="Associated revision">
              <Select value={saveRevision} onChange={setSaveRevision} placeholder="None" options={(revisions.data ?? []).map((r: any) => ({ value: r.id, label: r.label }))} />
            </Field>
            <Field label="Notes">
              <Textarea rows={3} value={saveNotes} onChange={(e) => setSaveNotes(e.target.value)} placeholder="What this comparison is investigating" />
            </Field>
            <p className="muted small">
              The saved comparison retains selected datasets, channels, alignment, units, normalization, statistics and notes so it can be reopened and reported.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function fmt(v: any): string {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toPrecision(6);
}
