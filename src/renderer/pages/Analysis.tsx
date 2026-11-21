import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { Chart, ChartHandle, ChartSeries, ChartType } from '../Chart';
import { ImportWizard } from '../ImportWizard';
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
  SearchInput,
  Select,
  Tabs,
  Textarea,
} from '../ui';
import { fmtDateTime } from '../format';
import { convertSeries, QUANTITY_TYPES, UNITS, unitsForDimension, unitDef } from '../../shared/units';
import { EVENT_CATEGORIES, GRAPH_TYPES } from '../../shared/constants';

interface PanelDef {
  id: string;
  title: string;
  type: ChartType;
  keys: string[];
  xKey?: string;
  height: number;
}

const keyOf = (s: any) => `${s.datasetId}:${s.channelId}`;

const uid = () => Math.random().toString(36).slice(2, 10);

export default function AnalysisPage() {
  const { projectId, project, settings, route, navigate, notify, confirm, refresh } = useApp();
  const [selectedDatasets, setSelectedDatasets] = useState<string[]>([]);
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [unitOverrides, setUnitOverrides] = useState<Record<string, string>>({});
  const [panels, setPanels] = useState<PanelDef[]>([]);
  const [xDomain, setXDomain] = useState<[number, number] | null>(null);
  const [linked, setLinked] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [maxPoints, setMaxPoints] = useState(Number(settings.defaultGraphPoints || 4000));
  const [tab, setTab] = useState('graphs');
  const [channelSearch, setChannelSearch] = useState('');
  const [importOpen, setImportOpen] = useState(route.query.import === '1');
  const [deriveOpen, setDeriveOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspacePurpose, setWorkspacePurpose] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [eventDraft, setEventDraft] = useState<any>({ category: 'Custom', t: 0 });
  const chartRefs = useRef<Record<string, ChartHandle | null>>({});

  const datasets = useAsync(() => (projectId ? api.datasets({ projectId, limit: 500 }) : Promise.resolve([])), [projectId]);
  const workspaces = useAsync(() => (projectId ? api.workspaces(projectId) : Promise.resolve([])), [projectId]);
  const presets = useAsync(() => (projectId ? api.graphs(projectId) : Promise.resolve([])), [projectId]);

  useEffect(() => {
    if (route.query.dataset) {
      setSelectedDatasets([route.query.dataset]);
      setSelectedChannels([]);
    }
  }, [route.query.dataset]);

  useEffect(() => {
    if (!datasets.data?.length) return;
    if (selectedDatasets.length === 0) {
      const preferred = datasets.data.find((d: any) => d.id === route.query.dataset) ?? datasets.data[0];
      setSelectedDatasets([preferred.id]);
    }
  }, [datasets.data, route.query.dataset, selectedDatasets.length]);

  const channels = useAsync(async () => {
    const lists = await Promise.all(
      selectedDatasets.map((id) => api.list('channel', { where: { dataset_id: id }, limit: 2000, orderBy: 'created_at', order: 'asc' })),
    );
    return lists.flat().map((c: any) => ({ ...c, datasetName: datasets.data?.find((d: any) => d.id === c.dataset_id)?.name ?? '' }));
  }, [selectedDatasets.join(','), datasets.data?.length]);

  useEffect(() => {
    if (!channels.data?.length) return;
    setSelectedChannels((prev) => {
      const valid = prev.filter((id) => channels.data!.some((c: any) => c.id === id));
      if (valid.length) return valid;
      return channels.data!.slice(0, Math.min(4, channels.data!.length)).map((c: any) => c.id);
    });
  }, [channels.data]);

  const seriesData = useAsync(async () => {
    if (!selectedChannels.length) return { series: [], notes: [], downsampled: false };
    const primaryDataset = selectedChannels
      .map((id) => channels.data?.find((c: any) => c.id === id)?.dataset_id)
      .filter(Boolean) as string[];
    const datasetIds = Array.from(new Set(primaryDataset));
    return api.series({ datasetIds, channelIds: selectedChannels, maxPoints });
  }, [selectedChannels.join(','), maxPoints, channels.data?.length]);

  const displaySeries: any[] = useMemo(() => {
    return (seriesData.data?.series ?? []).map((s: any) => {
      const key = keyOf(s);
      const target = unitOverrides[key] ?? s.unit;
      let y = s.y as (number | null)[];
      if (target && s.unit && target !== s.unit) {
        const converted = convertSeries(y.map((v) => (v === null ? NaN : v)), s.unit, target);
        y = Array.from(converted, (v) => (Number.isFinite(v) ? v : null));
      }
      return { ...s, displayUnit: target || s.unit, y, key };
    });
  }, [seriesData.data, unitOverrides]);

  const seriesByKey = useMemo(() => {
    const map = new Map<string, any>();
    for (const s of displaySeries) map.set(s.key, s);
    return map;
  }, [displaySeries]);

  const eventsData = useAsync(() => (selectedDatasets.length ? api.events(selectedDatasets) : Promise.resolve([])), [selectedDatasets.join(',')]);

  // Build panels for series that are not yet plotted.
  useEffect(() => {
    const keys = displaySeries.map((s) => s.key);
    if (keys.length === 0) {
      setPanels((prev) => (prev.length ? [] : prev));
      return;
    }
    setPanels((prev) => {
      const valid = new Set(keys);
      const next = prev
        .map((p) => ({ ...p, keys: p.keys.filter((k) => valid.has(k)), xKey: p.xKey && valid.has(p.xKey) ? p.xKey : undefined }))
        .filter((p) => p.keys.length > 0);
      const assigned = new Set(next.flatMap((p) => p.keys));
      const missing = displaySeries.filter((s) => !assigned.has(s.key));
      if (missing.length === 0) return next.length === prev.length ? prev : next;
      const byUnit = new Map<string, string[]>();
      for (const s of missing) {
        const unit = s.displayUnit || 'value';
        if (!byUnit.has(unit)) byUnit.set(unit, []);
        byUnit.get(unit)!.push(s.key);
      }
      const added: PanelDef[] = [];
      for (const [unit, group] of byUnit) {
        const existing = next.find((p) => p.title.endsWith(`[${unit}]`) && p.type === 'line');
        if (existing) {
          existing.keys = [...existing.keys, ...group];
        } else {
          added.push({
            id: uid(),
            title: `${group.length === 1 ? seriesByKey.get(group[0])?.channelName : 'Channels'} [${unit}]`,
            type: 'line',
            keys: group,
            height: 260,
          });
        }
      }
      return [...next, ...added];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displaySeries.map((s) => s.key).join('|')]);

  const stats = useAsync(async () => {
    if (!selectedChannels.length || !channels.data) return [];
    const rows = [];
    for (const channelId of selectedChannels) {
      const channel = channels.data.find((c: any) => c.id === channelId);
      if (!channel) continue;
      try {
        const result = await api.stats(channel.dataset_id, channel.id);
        rows.push({ ...result, datasetName: channel.datasetName, channelName: channel.name });
      } catch {
        /* channel may have been removed */
      }
    }
    return rows;
  }, [selectedChannels.join(','), channels.data?.length]);

  if (!projectId) return <EmptyState title="Select a project" icon="folder" />;

  const buildSeries = (panel: PanelDef): ChartSeries[] => {
    const available = panel.keys.map((k) => seriesByKey.get(k)).filter(Boolean);
    if (panel.type === 'difference' || panel.type === 'percentdiff') {
      const [baseKey, otherKey] = panel.keys;
      const base = seriesByKey.get(baseKey);
      const other = seriesByKey.get(otherKey);
      if (!base || !other) return [];
      const y = base.y.map((v: number | null, i: number) => {
        const b = other.y[i];
        if (v === null || b === null || !Number.isFinite(v) || !Number.isFinite(b)) return null;
        if (panel.type === 'percentdiff') return b === 0 ? null : ((b - v) / Math.abs(v)) * 100;
        return b - v;
      });
      return [
        {
          id: `${panel.id}-diff`,
          label: panel.type === 'percentdiff' ? `${other.channelName} vs ${base.channelName} [%]` : `${other.channelName} − ${base.channelName}`,
          x: base.x,
          y,
          unit: panel.type === 'percentdiff' ? '%' : base.displayUnit,
          color: '#f0a13a',
        },
      ];
    }
    if (panel.type === 'xy' && panel.xKey) {
      const xSeries = seriesByKey.get(panel.xKey);
      if (!xSeries) return [];
      return available
        .filter((s) => s.key !== panel.xKey)
        .map((s, i) => ({
          id: s.key,
          label: `${s.channelName} vs ${xSeries.channelName}`,
          x: xSeries.y.map((v: number | null) => (v === null ? NaN : v)),
          y: s.y,
          unit: s.displayUnit,
          axis: s.axis === 'right' ? 'right' : undefined,
          color: undefined,
        }));
    }
    return available.map((s) => ({
      id: s.key,
      label: `${s.datasetName} · ${s.channelName}`,
      x: s.x,
      y: s.y,
      unit: s.displayUnit,
      axis: s.axis === 'right' ? 'right' : undefined,
      color: undefined,
    }));
  };

  const panelMarkers = (panel: PanelDef) => {
    if (!showMarkers) return [];
    const datasetIds = new Set(panel.keys.map((k) => k.split(':')[0]));
    return (eventsData.data ?? [])
      .filter((e: any) => datasetIds.has(e.dataset_id) || datasetIds.size === 0)
      .map((e: any) => ({ t: Number(e.t), label: e.name, category: e.category }));
  };

  const updatePanel = (id: string, patch: Partial<PanelDef>) => setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const saveWorkspace = async () => {
    if (!workspaceName.trim()) return;
    try {
      await api.saveWorkspace({
        project_id: projectId,
        name: workspaceName,
        purpose: workspacePurpose,
        spec_json: {
          selectedDatasets,
          selectedChannels,
          unitOverrides,
          panels,
          linked,
          showMarkers,
          maxPoints,
          savedAt: new Date().toISOString(),
        },
      });
      setSaveOpen(false);
      setWorkspaceName('');
      setWorkspacePurpose('');
      workspaces.reload();
      notify('Analysis workspace saved', 'success');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const loadWorkspace = (ws: any) => {
    const spec = ws.spec ?? ws.spec_json;
    if (!spec) return;
    setSelectedDatasets(spec.selectedDatasets ?? []);
    setSelectedChannels(spec.selectedChannels ?? []);
    setUnitOverrides(spec.unitOverrides ?? {});
    setPanels(spec.panels ?? []);
    setLinked(spec.linked !== false);
    setShowMarkers(spec.showMarkers !== false);
    setMaxPoints(spec.maxPoints ?? 4000);
    setTab('graphs');
    setXDomain(null);
    notify(`Workspace “${ws.name}” loaded`, 'success');
  };

  const savePreset = async (panel: PanelDef) => {
    const name = presetName.trim() || panel.title;
    await api.saveGraph({ project_id: projectId, name, spec_json: { type: panel.type, keys: panel.keys, xKey: panel.xKey, unitOverrides } });
    setPresetName('');
    presets.reload();
    notify('Graph configuration saved', 'success');
  };

  const filteredChannels = (channels.data ?? []).filter((c: any) =>
    !channelSearch || `${c.name} ${c.datasetName} ${c.unit}`.toLowerCase().includes(channelSearch.toLowerCase()),
  );

  const notes = [...(docNotes(seriesData.data?.notes) ?? [])];
  if (seriesData.data?.downsampled) notes.push('Graphs show downsampled previews; the stored recordings are unchanged and full-resolution values remain accessible.');

  return (
    <div className="page analysis-page">
      <PageHeader
        title="Data Analysis"
        subtitle={`${project?.name ?? ''} · ${selectedDatasets.length} dataset(s) selected · ${selectedChannels.length} channel(s) plotted`}
        actions={
          <>
            <Button icon="upload" onClick={() => setImportOpen(true)}>Import dataset</Button>
            <Button icon="save" onClick={() => setSaveOpen(true)}>Save workspace</Button>
            <Button icon="refresh" onClick={() => { seriesData.reload(); stats.reload(); }}>Refresh</Button>
          </>
        }
      />

      <div className="analysis-layout">
        <aside className="analysis-side">
          <Panel title="Datasets" dense>
            {datasets.loading && !datasets.data ? (
              <div className="loading">Loading…</div>
            ) : (datasets.data ?? []).length === 0 ? (
              <EmptyState title="No datasets" message="Import a recording to begin." icon="chart" action={<Button size="sm" icon="upload" onClick={() => setImportOpen(true)}>Import</Button>} />
            ) : (
              <div className="dataset-picker">
                {(datasets.data ?? []).map((d: any) => {
                  const active = selectedDatasets.includes(d.id);
                  return (
                    <label key={d.id} className={`dataset-option ${active ? 'active' : ''}`}>
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedDatasets((prev) => [...prev, d.id]);
                            if (selectedDatasets.length === 0) setSelectedChannels([]);
                          } else {
                            setSelectedDatasets((prev) => prev.filter((id) => id !== d.id));
                            setSelectedChannels((prev) => prev.filter((id) => !channels.data?.find((c: any) => c.id === id && c.dataset_id === d.id)));
                          }
                        }}
                      />
                      <span className="dataset-option-main">
                        <span className="dataset-option-name">{d.name}</span>
                        <span className="muted tiny">
                          {Number(d.points).toLocaleString()} rows · {d.channels_count} ch · {d.kind}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel
            title={`Channels (${selectedChannels.length}/${channels.data?.length ?? 0})`}
            dense
            actions={
              <div className="row-actions">
                <button className="icon-btn" title="Select all" onClick={() => setSelectedChannels((channels.data ?? []).map((c: any) => c.id))}>
                  <Icon name="check" size={13} />
                </button>
                <button className="icon-btn" title="Clear selection" onClick={() => setSelectedChannels([])}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            }
          >
            <SearchInput value={channelSearch} onChange={setChannelSearch} placeholder="Filter channels…" />
            <div className="channel-picker">
              {filteredChannels.length === 0 && <div className="muted small">No channels.</div>}
              {filteredChannels.map((c: any) => {
                const checked = selectedChannels.includes(c.id);
                const key = `${c.dataset_id}:${c.id}`;
                const displayUnit = unitOverrides[key] ?? c.unit;
                return (
                  <div className={`channel-option ${checked ? 'active' : ''}`} key={c.id}>
                    <Checkbox
                      checked={checked}
                      onChange={(v) =>
                        setSelectedChannels((prev) => (v ? [...prev, c.id] : prev.filter((id) => id !== c.id)))
                      }
                      label={
                        <span className="channel-label">
                          <span>{c.name}</span>
                          <span className="muted tiny">{c.datasetName} · {c.type}{c.axis ? ` · ${c.axis}` : ''}</span>
                        </span>
                      }
                    />
                    {checked && (
                      <Select
                        value={displayUnit ?? ''}
                        onChange={(v) => setUnitOverrides((prev) => ({ ...prev, [key]: v }))}
                        options={(unitsForDimension(unitDef(c.unit)?.dimension ?? null).length ? unitsForDimension(unitDef(c.unit)?.dimension ?? null) : Object.values(UNITS).filter((u) => u.dimension === 'dimensionless' || !c.unit)).map((u) => ({ value: u.symbol, label: `${u.symbol || '(none)'}` }))}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel title="Actions" dense>
            <div className="stack">
              <Button size="sm" icon="flask" onClick={() => setDeriveOpen(true)} disabled={!selectedDatasets.length}>Derive dataset…</Button>
              <Button size="sm" icon="chart" onClick={() => setTab('statistics')}>Statistics</Button>
              <Button size="sm" icon="alert" onClick={() => setTab('events')}>Event markers</Button>
            </div>
          </Panel>
        </aside>

        <section className="analysis-main">
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { key: 'graphs', label: 'Graph workspace', count: panels.length },
              { key: 'statistics', label: 'Statistics', count: stats.data?.length ?? 0 },
              { key: 'events', label: 'Events', count: eventsData.data?.length ?? 0 },
              { key: 'workspaces', label: 'Saved workspaces', count: workspaces.data?.length ?? 0 },
            ]}
          />

          {tab === 'graphs' && (
            <div className="stack">
              <ToolbarRow>
                <label className="checkbox">
                  <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
                  <span>Linked time range</span>
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} />
                  <span>Event markers</span>
                </label>
                <span className="muted small">Points per channel</span>
                <Select
                  value={String(maxPoints)}
                  onChange={(v) => setMaxPoints(Number(v))}
                  options={['1000', '2000', '4000', '8000', '16000', '40000'].map((v) => ({ value: v, label: Number(v).toLocaleString() }))}
                />
                {xDomain && (
                  <Button size="sm" icon="x" onClick={() => setXDomain(null)}>
                    Reset zoom {xDomain[0].toFixed(2)}–{xDomain[1].toFixed(2)} s
                  </Button>
                )}
                <span className="status-spacer" />
                <Button
                  size="sm"
                  icon="plus"
                  onClick={() =>
                    setPanels((prev) => [
                      ...prev,
                      { id: uid(), title: 'New graph', type: (settings.defaultChartType as ChartType) || 'line', keys: [], height: 260 },
                    ])
                  }
                >
                  Add panel
                </Button>
              </ToolbarRow>

              {notes.length > 0 && (
                <div className="note-banner">
                  {notes.map((n, i) => (
                    <div key={i}>{n}</div>
                  ))}
                </div>
              )}

              {panels.length === 0 ? (
                <EmptyState
                  title="No measurements selected"
                  message="Select a dataset and its channels to build graphs. Multiple panels can share a linked time range."
                  icon="chart"
                />
              ) : (
                <div className="chart-grid">
                  {panels.map((panel) => {
                    const chartSeries = buildSeries(panel);
                    return (
                      <div className="chart-panel" key={panel.id}>
                        <div className="chart-panel-head">
                          <input
                            className="chart-title-input"
                            value={panel.title}
                            onChange={(e) => updatePanel(panel.id, { title: e.target.value })}
                            aria-label="Graph title"
                          />
                          <div className="chart-controls">
                            <Select
                              value={panel.type}
                              onChange={(v) => updatePanel(panel.id, { type: v as ChartType })}
                              options={GRAPH_TYPES.map((g) => ({ value: g.key, label: g.label }))}
                            />
                            <button className="icon-btn" title="Series in this graph" onClick={() => {
                              const chosen = window.prompt('Channels (comma separated names):', panel.keys.map((k) => seriesByKey.get(k)?.channelName ?? k).join(', '));
                              if (!chosen) return;
                              const names = chosen.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
                              const keys = displaySeries.filter((s: any) => names.includes(s.channelName.toLowerCase())).map((s) => s.key);
                              if (keys.length) updatePanel(panel.id, { keys });
                            }}>
                              <Icon name="filter" size={13} />
                            </button>
                            <button className="icon-btn" title="Export PNG" onClick={async () => {
                              const dataUrl = chartRefs.current[panel.id]?.exportPng();
                              if (!dataUrl) return;
                              try {
                                const r = await api.saveImage(dataUrl, panel.title.replace(/[^\w-]+/g, '_'));
                                if (!r.canceled) notify('Graph image exported', 'success');
                              } catch (err: any) {
                                notify(err.message, 'error');
                              }
                            }}>
                              <Icon name="download" size={13} />
                            </button>
                            <button className="icon-btn" title="Save graph configuration" onClick={() => {
                              setPresetName(panel.title);
                              savePreset(panel);
                            }}>
                              <Icon name="save" size={13} />
                            </button>
                            <button className="icon-btn danger" title="Remove panel" onClick={() => setPanels((prev) => prev.filter((p) => p.id !== panel.id))}>
                              <Icon name="x" size={13} />
                            </button>
                          </div>
                        </div>
                        {panel.keys.length === 0 ? (
                          <div className="chart-empty">
                            <div className="muted small">This panel has no channels. Choose channels from the sidebar, then use the filter control.</div>
                          </div>
                        ) : (
                          <>
                            {(panel.type === 'xy' || panel.type === 'difference' || panel.type === 'percentdiff') && (
                              <div className="chart-axis-pick">
                                <span className="muted tiny">
                                  {panel.type === 'xy' ? 'X-axis channel' : 'Baseline (first) vs compared (second)'}
                                </span>
                                <Select
                                  value={panel.xKey ?? panel.keys[0] ?? ''}
                                  onChange={(v) => updatePanel(panel.id, { xKey: v })}
                                  options={panel.keys.map((k) => ({ value: k, label: seriesByKey.get(k)?.channelName ?? k }))}
                                />
                              </div>
                            )}
                            <Chart
                              ref={(handle) => {
                                chartRefs.current[panel.id] = handle;
                              }}
                              series={chartSeries}
                              type={panel.type}
                              title={panel.title}
                              height={panel.height}
                              markers={panelMarkers(panel)}
                              xDomain={linked ? xDomain : undefined}
                              onXDomainChange={linked ? setXDomain : undefined}
                              note={seriesData.data?.downsampled ? 'downsampled preview' : undefined}
                            />
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'statistics' && (
            <Panel title="Measurement statistics" subtitle="Computed from the full stored recording, not the plotted preview">
              {stats.loading && !stats.data ? (
                <div className="loading">Computing statistics…</div>
              ) : (
                <>
                  <DataTable
                    rows={stats.data ?? []}
                    columns={[
                      { key: 'datasetName', label: 'Dataset' },
                      { key: 'channelName', label: 'Channel' },
                      { key: 'channel', label: 'Unit', render: (r) => r.channel?.unit || '—' },
                      { key: 'valid', label: 'Valid', align: 'right', mono: true, render: (r) => r.stats.valid },
                      { key: 'missing', label: 'Missing', align: 'right', mono: true, render: (r) => r.stats.missing },
                      { key: 'min', label: 'Min', align: 'right', mono: true, render: (r) => fmtNum(r.stats.min) },
                      { key: 'max', label: 'Max', align: 'right', mono: true, render: (r) => fmtNum(r.stats.max) },
                      { key: 'mean', label: 'Mean', align: 'right', mono: true, render: (r) => fmtNum(r.stats.mean) },
                      { key: 'median', label: 'Median', align: 'right', mono: true, render: (r) => fmtNum(r.stats.median) },
                      { key: 'stdDev', label: 'Std dev', align: 'right', mono: true, render: (r) => fmtNum(r.stats.stdDev) },
                      { key: 'rms', label: 'RMS', align: 'right', mono: true, render: (r) => fmtNum(r.stats.rms) },
                    ]}
                    empty={<EmptyState title="No statistics" message="Select channels to compute statistics." icon="chart" />}
                  />
                  <p className="muted small">
                    {stats.data?.[0]?.note ??
                      'Sample statistics over finite values; standard deviation uses n-1. Percentiles use linear interpolation. Missing values are excluded and counted.'}
                  </p>
                </>
              )}
            </Panel>
          )}

          {tab === 'events' && (
            <div className="stack">
              <Panel
                title="Event markers"
                subtitle="Manually confirmed events appear on graphs"
                actions={
                  <>
                    <Button size="sm" icon="warning" onClick={async () => {
                      if (!selectedDatasets.length) return;
                      try {
                        const results = await Promise.all(selectedDatasets.map((id) => api.suggestEvents(id)));
                        setSuggestions(results.flat());
                        setShowSuggestions(true);
                      } catch (err: any) {
                        notify(err.message, 'error');
                      }
                    }}>
                      Suggest events
                    </Button>
                  </>
                }
              >
                <div className="event-composer">
                  <Field label="Dataset">
                    <Select
                      value={eventDraft.dataset_id ?? selectedDatasets[0] ?? ''}
                      onChange={(v) => setEventDraft((d: any) => ({ ...d, dataset_id: v }))}
                      options={selectedDatasets.map((id) => ({ value: id, label: datasets.data?.find((x: any) => x.id === id)?.name ?? id }))}
                    />
                  </Field>
                  <Field label="Event name">
                    <Input value={eventDraft.name ?? ''} onChange={(e) => setEventDraft((d: any) => ({ ...d, name: e.target.value }))} placeholder="e.g. Motor burnout" />
                  </Field>
                  <Field label="Category">
                    <Select value={eventDraft.category ?? 'Custom'} onChange={(v) => setEventDraft((d: any) => ({ ...d, category: v }))} options={EVENT_CATEGORIES.map((c) => ({ value: c, label: c }))} />
                  </Field>
                  <Field label="Time [s]">
                    <Input type="number" step="any" value={eventDraft.t ?? 0} onChange={(e) => setEventDraft((d: any) => ({ ...d, t: Number(e.target.value) }))} />
                  </Field>
                  <Field label="Related channel" hint="Optional">
                    <Select
                      value={eventDraft.channel_key ?? ''}
                      placeholder="Any channel"
                      onChange={(v) => setEventDraft((d: any) => ({ ...d, channel_key: v }))}
                      options={(channels.data ?? []).filter((c: any) => c.dataset_id === (eventDraft.dataset_id ?? selectedDatasets[0])).map((c: any) => ({ value: c.key, label: c.name }))}
                    />
                  </Field>
                  <Field label="Description" full>
                    <Input value={eventDraft.description ?? ''} onChange={(e) => setEventDraft((d: any) => ({ ...d, description: e.target.value }))} />
                  </Field>
                  <div className="field">
                    <span className="field-label">&nbsp;</span>
                    <Button
                      variant="primary"
                      icon="plus"
                      disabled={!eventDraft.name || !(eventDraft.dataset_id ?? selectedDatasets[0])}
                      onClick={async () => {
                        try {
                          await api.createEvent({ ...eventDraft, dataset_id: eventDraft.dataset_id ?? selectedDatasets[0] });
                          setEventDraft({ category: 'Custom', t: 0, dataset_id: eventDraft.dataset_id });
                          eventsData.reload();
                          notify('Event marker added', 'success');
                        } catch (err: any) {
                          notify(err.message, 'error');
                        }
                      }}
                    >
                      Add event
                    </Button>
                  </div>
                </div>
                <DataTable
                  rows={eventsData.data ?? []}
                  columns={[
                    { key: 'name', label: 'Event' },
                    { key: 'category', label: 'Category' },
                    { key: 't', label: 'Time [s]', align: 'right', mono: true, render: (e) => Number(e.t).toFixed(4) },
                    { key: 'dataset_name', label: 'Dataset' },
                    { key: 'description', label: 'Description' },
                    { key: 'source', label: 'Source', render: (e) => <Badge tone={e.source === 'suggested' ? 'warn' : 'neutral'}>{e.source === 'suggested' ? 'suggested' : 'user'}</Badge> },
                    {
                      key: 'actions',
                      label: '',
                      align: 'right',
                      render: (e) => (
                        <button
                          className="icon-btn danger"
                          title="Delete event"
                          onClick={async () => {
                            const ok = await confirm({ title: 'Delete event marker?', message: e.name, confirmLabel: 'Delete', danger: true });
                            if (!ok) return;
                            await api.removeEvent(e.id);
                            eventsData.reload();
                          }}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      ),
                    },
                  ]}
                  empty={<EmptyState title="No events" message="Identify ignition, burnout, apogee, deployment, anomalies and other points of interest." icon="alert" />}
                />
              </Panel>
            </div>
          )}

          {tab === 'workspaces' && (
            <div className="stack">
              <Panel
                title="Saved analysis workspaces"
                actions={<Button size="sm" icon="save" onClick={() => setSaveOpen(true)}>Save current workspace</Button>}
              >
                <DataTable
                  rows={workspaces.data ?? []}
                  columns={[
                    { key: 'name', label: 'Workspace' },
                    { key: 'purpose', label: 'Purpose' },
                    { key: 'updated_at', label: 'Updated', render: (w) => fmtDateTime(w.updated_at) },
                    {
                      key: 'actions',
                      label: '',
                      align: 'right',
                      render: (w) => (
                        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                          <button className="icon-btn" title="Load" onClick={() => loadWorkspace(w)}>
                            <Icon name="chevron" size={14} />
                          </button>
                          <button
                            className="icon-btn"
                            title="Duplicate"
                            onClick={async () => {
                              await api.saveWorkspace({ project_id: projectId, name: `${w.name} (copy)`, purpose: w.purpose, spec_json: w.spec ?? {} });
                              workspaces.reload();
                            }}
                          >
                            <Icon name="doc" size={14} />
                          </button>
                          <button
                            className="icon-btn danger"
                            title="Delete"
                            onClick={async () => {
                              const ok = await confirm({ title: 'Delete workspace?', message: w.name, confirmLabel: 'Delete', danger: true });
                              if (!ok) return;
                              await api.remove('workspace', w.id);
                              workspaces.reload();
                            }}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        </div>
                      ),
                    },
                  ]}
                  onRowClick={loadWorkspace}
                  empty={<EmptyState title="No saved workspaces" message="Save the current datasets, panels, units and layout for reuse." icon="save" />}
                />
              </Panel>
              <Panel title="Saved graph configurations" subtitle="Reusable single-graph presets">
                <DataTable
                  rows={presets.data ?? []}
                  columns={[
                    { key: 'name', label: 'Preset' },
                    { key: 'updated_at', label: 'Saved', render: (p) => fmtDateTime(p.updated_at) },
                    {
                      key: 'actions',
                      label: '',
                      align: 'right',
                      render: (p) => (
                        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="icon-btn"
                            title="Add as panel"
                            onClick={() => {
                              const spec = p.spec ?? {};
                              setPanels((prev) => [
                                ...prev,
                                { id: uid(), title: p.name, type: (spec.type as ChartType) ?? 'line', keys: spec.keys ?? [], xKey: spec.xKey, height: 260 },
                              ]);
                              setTab('graphs');
                            }}
                          >
                            <Icon name="plus" size={14} />
                          </button>
                          <button
                            className="icon-btn danger"
                            title="Delete"
                            onClick={async () => {
                              await api.remove('graph', p.id);
                              presets.reload();
                            }}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        </div>
                      ),
                    },
                  ]}
                  empty={<EmptyState title="No saved graph presets" icon="chart" />}
                />
              </Panel>
            </div>
          )}
        </section>
      </div>

      {importOpen && (
        <ImportWizard
          open={importOpen}
          projectId={projectId}
          onClose={() => setImportOpen(false)}
          onImported={(dataset) => {
            datasets.reload();
            setSelectedDatasets([dataset.id]);
            setSelectedChannels([]);
            setPanels([]);
            navigate(`#/analysis?dataset=${dataset.id}`);
          }}
        />
      )}

      {saveOpen && (
        <Modal
          title="Save analysis workspace"
          onClose={() => setSaveOpen(false)}
          footer={
            <>
              <Button onClick={() => setSaveOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={saveWorkspace} disabled={!workspaceName.trim()}>Save workspace</Button>
            </>
          }
        >
          <div className="stack">
            <Field label="Workspace name" required>
              <Input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="e.g. Flight comparison" autoFocus />
            </Field>
            <Field label="Purpose">
              <Input value={workspacePurpose} onChange={(e) => setWorkspacePurpose(e.target.value)} placeholder="e.g. Sensor calibration review" />
            </Field>
            <p className="muted small">
              The workspace stores the selected datasets, channels, graph layout, axis units, alignment and marker settings. Original data is never copied or modified.
            </p>
          </div>
        </Modal>
      )}

      {deriveOpen && <DeriveDialog projectId={projectId} datasetId={selectedDatasets[0]} onClose={() => setDeriveOpen(false)} onCreated={(dataset) => {
        setDeriveOpen(false);
        datasets.reload();
        setSelectedDatasets([dataset.id]);
        setPanels([]);
        notify('Derived dataset created with recorded provenance', 'success');
        refresh();
      }} notify={notify} />}

      {showSuggestions && (
        <Modal title="Suggested events" onClose={() => setShowSuggestions(false)} size="lg">
          <div className="stack">
            <div className="warn-banner">
              These are algorithmic suggestions derived from the recorded values. They are hypotheses, not confirmed events. Review each one before accepting.
            </div>
            {(suggestions.length ? suggestions : []).map((s, i) => (
              <div className="suggestion" key={i}>
                <div>
                  <div className="list-title">{s.name} <span className="muted tiny">t = {Number(s.t).toFixed(3)} s · {s.category}</span></div>
                  <div className="muted small">{s.description}</div>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  icon="check"
                  onClick={async () => {
                    try {
                      await api.confirmEvents([{ ...s, confirmed: 1, source: 'user' }]);
                      setSuggestions((prev) => prev.filter((_, idx) => idx !== i));
                      eventsData.reload();
                      notify('Event confirmed and recorded', 'success');
                    } catch (err: any) {
                      notify(err.message, 'error');
                    }
                  }}
                >
                  Confirm
                </Button>
              </div>
            ))}
            {suggestions.length === 0 && <div className="muted">No further suggestions.</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function ToolbarRow({ children }: { children: React.ReactNode }) {
  return <div className="toolbar-row">{children}</div>;
}

function docNotes(notes: any): string[] {
  if (!notes) return [];
  return Array.isArray(notes) ? notes : [String(notes)];
}

function fmtNum(v: any): string {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toPrecision(6);
}

function DeriveDialog({
  projectId,
  datasetId,
  onClose,
  onCreated,
  notify,
}: {
  projectId: string;
  datasetId: string;
  onClose: () => void;
  onCreated: (d: any) => void;
  notify: (t: string, tone?: any) => void;
}) {
  const source = useAsync(() => (datasetId ? api.datasetDetail(datasetId) : Promise.resolve(null)), [datasetId]);
  const [operation, setOperation] = useState('convert_unit');
  const [name, setName] = useState('');
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [toUnit, setToUnit] = useState('');
  const [windowSize, setWindowSize] = useState('5');
  const [offset, setOffset] = useState('0');
  const [coefficients, setCoefficients] = useState('0, 1');
  const [t0, setT0] = useState('0');
  const [t1, setT1] = useState('');
  const [factor, setFactor] = useState('2');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (source.data && channelIds.length === 0) setChannelIds(source.data.channels.map((c: any) => c.id));
    if (source.data && !toUnit) setToUnit(source.data.channels[0]?.unit ?? '');
    if (source.data && !name) setName(`${source.data.name} (${operation.replace('_', ' ')})`);
  }, [source.data]);

  const run = async () => {
    if (!datasetId) return;
    setBusy(true);
    try {
      const result = await api.derive({
        sourceDatasetId: datasetId,
        name,
        operation,
        channelIds,
        params: {
          toUnit,
          window: Number(windowSize),
          offset: Number(offset),
          coefficients: coefficients.split(',').map((v) => Number(v.trim())),
          t0: Number(t0),
          t1: t1 === '' ? undefined : Number(t1),
          factor: Number(factor),
        },
        notes,
      });
      onCreated(result);
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Derive a new dataset"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={run} disabled={busy || !channelIds.length || !name.trim()}>
            {busy ? 'Processing…' : 'Create derived dataset'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="warn-banner">
          The source dataset is never modified. A new dataset is written with its own channels and a provenance record describing the operation, parameters and source.
        </div>
        {!datasetId ? (
          <div className="muted">Select a dataset first.</div>
        ) : (
          <>
            <div className="form-grid">
              <Field label="Operation">
                <Select
                  value={operation}
                  onChange={(v) => {
                    setOperation(v);
                    setName(`${source.data?.name ?? 'Dataset'} (${v.replace('_', ' ')})`);
                  }}
                  options={[
                    { value: 'convert_unit', label: 'Convert units' },
                    { value: 'smooth', label: 'Moving average' },
                    { value: 'rate', label: 'Rate of change' },
                    { value: 'offset', label: 'Additive offset' },
                    { value: 'polynomial', label: 'Polynomial calibration' },
                    { value: 'crop', label: 'Crop time window' },
                    { value: 'decimate', label: 'Decimate' },
                  ]}
                />
              </Field>
              <Field label="New dataset name" required>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              {operation === 'convert_unit' && (
                <Field label="Target unit">
                  <Select
                    value={toUnit}
                    onChange={setToUnit}
                    options={(unitsForDimension(unitDef(source.data?.channels[0]?.unit)?.dimension ?? null) || []).map((u) => ({ value: u.symbol, label: u.symbol }))}
                  />
                </Field>
              )}
              {operation === 'smooth' && (
                <Field label="Window (samples)">
                  <Input type="number" value={windowSize} onChange={(e) => setWindowSize(e.target.value)} />
                </Field>
              )}
              {operation === 'offset' && (
                <Field label="Offset">
                  <Input type="number" step="any" value={offset} onChange={(e) => setOffset(e.target.value)} />
                </Field>
              )}
              {operation === 'polynomial' && (
                <Field label="Coefficients" hint="Comma separated, lowest order first: a0, a1, a2 → a0 + a1·x + a2·x²">
                  <Input value={coefficients} onChange={(e) => setCoefficients(e.target.value)} />
                </Field>
              )}
              {operation === 'crop' && (
                <>
                  <Field label="From [s]">
                    <Input type="number" step="any" value={t0} onChange={(e) => setT0(e.target.value)} />
                  </Field>
                  <Field label="To [s]">
                    <Input type="number" step="any" value={t1} onChange={(e) => setT1(e.target.value)} />
                  </Field>
                </>
              )}
              {operation === 'decimate' && (
                <Field label="Decimation factor">
                  <Input type="number" value={factor} onChange={(e) => setFactor(e.target.value)} />
                </Field>
              )}
            </div>
            <Field label="Channels">
              <div className="stack">
                {(source.data?.channels ?? []).map((c: any) => (
                  <Checkbox
                    key={c.id}
                    checked={channelIds.includes(c.id)}
                    label={<span>{c.name} <span className="muted tiny">{c.unit} · {c.type}</span></span>}
                    onChange={(v) => setChannelIds((prev) => (v ? [...prev, c.id] : prev.filter((id) => id !== c.id)))}
                  />
                ))}
              </div>
            </Field>
            <Field label="Notes">
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why this transformation was applied" />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
