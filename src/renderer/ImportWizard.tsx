import React, { useEffect, useMemo, useState } from 'react';
import { api, onImportProgress } from './api';
import { useApp } from './state';
import { Button, Checkbox, Field, Icon, Input, Modal, Select, Textarea } from './ui';
import { QUANTITY_TYPES, UNITS, compatibleUnits } from '../shared/units';
import { TIME_UNITS } from '../shared/constants';

export interface ImportAttach {
  testId?: string | null;
  flightId?: string | null;
  runId?: string | null;
  label?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: string;
  attach?: ImportAttach;
  onImported?: (dataset: any) => void;
}

const QUANTITY_OPTIONS = QUANTITY_TYPES.map((q) => ({ value: q.key, label: q.label }));
const UNIT_OPTIONS = Object.keys(UNITS).map((u) => ({ value: u, label: `${u || '(none)'} — ${UNITS[u].label}` }));

export function ImportWizard({ open, onClose, projectId, attach, onImported }: Props) {
  const { notify, navigate, confirm } = useApp();
  const [filePath, setFilePath] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [delimiter, setDelimiter] = useState(',');
  const [datasetName, setDatasetName] = useState('');
  const [timeColumn, setTimeColumn] = useState<number | null>(null);
  const [timeUnit, setTimeUnit] = useState('s');
  const [samplingHz, setSamplingHz] = useState('');
  const [channels, setChannels] = useState<any[]>([]);
  const [notes, setNotes] = useState('');
  const [recordedAt, setRecordedAt] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [templates, setTemplates] = useState<any[]>([]);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<any>(null);
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError(null);
    setProgress(null);
    api.importTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, [open]);

  useEffect(() => {
    if (!importing) return;
    return onImportProgress((p) => setProgress(p));
  }, [importing]);

  const reset = () => {
    setFilePath('');
    setPreview(null);
    setChannels([]);
    setDatasetName('');
    setNotes('');
    setTemplateName('');
    setResult(null);
    setError(null);
    setRecordedAt('');
    setSamplingHz('');
  };

  const applyPreview = (data: any, path: string) => {
    setPreview(data);
    setDelimiter(data.delimiter ?? ',');
    setHeaderRow(data.headerRow ?? 0);
    setTimeColumn(data.suggestedTimeColumn ?? null);
    setChannels(
      (data.suggestedChannels ?? []).map((c: any) => ({
        ...c,
        enabled: true,
      })),
    );
    setDatasetName((prev) => prev || path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ''));
    if (data.format === 'json' || data.format === 'xlsx') setTimeUnit(data.format === 'xlsx' ? 's' : 's');
  };

  const pickFile = async () => {
    const picked = await api.pickOpen({
      title: 'Select a measurement file',
      filters: [
        { name: 'Measurement data', extensions: ['csv', 'tsv', 'txt', 'json', 'xlsx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (picked.canceled || !picked.paths?.[0]) return;
    await loadPreview(picked.paths[0], 0, undefined);
  };

  const loadPreview = async (path: string, sheet: number, header?: number) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.previewImport(path, sheet, header);
      setFilePath(path);
      setSheetIndex(sheet);
      if (header === undefined) applyPreview(data, path);
      else {
        setPreview(data);
        setHeaderRow(data.headerRow);
        setChannels((prev) => {
          const next = data.suggestedChannels.map((c: any) => {
            const existing = prev.find((p) => p.column === c.column);
            return existing ? { ...c, name: existing.name, type: existing.type, unit: existing.unit, enabled: existing.enabled } : { ...c, enabled: true };
          });
          return next;
        });
      }
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  const changeHeaderRow = async (value: number) => {
    setHeaderRow(value);
    if (filePath) await loadPreview(filePath, sheetIndex, value);
  };

  const enabledChannels = channels.filter((c) => c.enabled && c.name.trim());
  const columnOptions = (preview?.columns ?? []).map((c: string, i: number) => ({ value: String(i), label: `[${i + 1}] ${c}` }));

  const sampleFor = (column: number) => {
    const rows: string[][] = preview?.sampleRows ?? [];
    const values = rows.map((r) => r[column]).filter((v) => v !== undefined && v !== '');
    return values.slice(0, 3).join(' · ') || '—';
  };

  const importData = async () => {
    if (!filePath || !preview) return;
    if (!datasetName.trim()) {
      setError('Give the dataset a name');
      return;
    }
    if (enabledChannels.length === 0) {
      setError('Map at least one measurement channel');
      return;
    }
    if (timeUnit !== 'index' && (timeColumn === null || timeColumn < 0)) {
      setError('Select a timestamp column, or choose row index as the time base');
      return;
    }
    if (timeUnit === 'index' && !samplingHz && !(await confirm({
      title: 'No sampling frequency',
      message: 'The time axis will be a row index. You can set a sampling frequency now to derive elapsed seconds.',
      confirmLabel: 'Import with row index',
    }))) {
      return;
    }
    setImporting(true);
    setError(null);
    setProgress({ phase: 'Starting import', percent: 0, rows: 0 });
    try {
      const spec = {
        filePath,
        projectId,
        datasetName: datasetName.trim(),
        format: preview.format,
        sheetIndex,
        delimiter,
        headerRow,
        skipRows: 0,
        timeColumn,
        timeUnit,
        channels: enabledChannels.map((c) => ({
          column: c.column,
          name: c.name.trim(),
          type: c.type || 'custom',
          unit: c.unit || '',
          axis: c.axis ?? '',
          enabled: true,
        })),
        samplingHz: samplingHz ? Number(samplingHz) : null,
        notes,
        recordedAt,
        attach: {
          testId: attach?.testId ?? null,
          flightId: attach?.flightId ?? null,
          runId: attach?.runId ?? null,
        },
        templateName: templateName.trim() || undefined,
      };
      const dataset = await api.commitImport(spec);
      setResult(dataset);
      notify(`Imported ${dataset.points.toLocaleString()} rows across ${dataset.channels.length} channels`, 'success');
      onImported?.(dataset);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setImporting(false);
    }
  };

  const loadTemplate = (template: any) => {
    if (!template?.spec_json && !template?.spec) return;
    const spec = template.spec_json ?? template.spec;
    setTimeUnit(spec.timeUnit ?? 's');
    setSamplingHz(spec.samplingHz ? String(spec.samplingHz) : '');
    const mapping: Record<number, any> = {};
    for (const c of spec.channels ?? []) mapping[c.column] = c;
    setChannels((prev) =>
      prev.map((c) => (mapping[c.column] ? { ...c, name: mapping[c.column].name, type: mapping[c.column].type, unit: mapping[c.column].unit, enabled: true } : c)),
    );
    notify(`Applied mapping template “${template.name}” to matching columns`, 'info');
  };

  const qualityNote = (channel: any) => {
    if (!channel.unit) return 'No unit';
    if (!compatibleUnits(channel.unit, channel.unit)) return 'Unit not recognised';
    return null;
  };

  return (
    <Modal
      title={result ? 'Import complete' : 'Import measurement data'}
      onClose={() => {
        if (importing) return;
        onClose();
        if (result) reset();
      }}
      size="xl"
    >
      {result ? (
        <div className="stack">
          <div className="success-banner">
            <Icon name="check" size={18} />
            <div>
              <strong>{result.name}</strong> imported: {result.points.toLocaleString()} rows, {result.channels.length} channels,
              {result.duration !== null ? ` ${Number(result.duration).toFixed(2)} s duration` : ' duration unknown'}.
            </div>
          </div>
          {result.quality?.warnings?.length > 0 && (
            <div className="warn-banner">
              <strong>Data quality flags</strong>
              <ul>
                {result.quality.warnings.map((w: string, i: number) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="kv-grid">
            <div className="kv-item">
              <span className="kv-key">Original file</span>
              <span className="kv-value mono">{result.original_file}</span>
            </div>
            <div className="kv-item">
              <span className="kv-key">SHA-256</span>
              <span className="kv-value mono">{result.checksum}</span>
            </div>
          </div>
          <div className="modal-actions-row">
            <Button
              onClick={() => {
                const id = result.id;
                reset();
                onClose();
                navigate(`#/analysis?dataset=${id}`);
              }}
              variant="primary"
              icon="chart"
            >
              Open in analysis workspace
            </Button>
            <Button
              onClick={() => {
                reset();
              }}
              icon="upload"
            >
              Import another file
            </Button>
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : (
        <div className="wizard">
          <div className="wizard-steps">
            <span className={filePath ? 'done' : 'active'}>1 · Select file</span>
            <span className={filePath && preview ? 'active' : ''}>2 · Map columns</span>
            <span className={importing ? 'active' : ''}>3 · Import</span>
          </div>

          {!filePath && (
            <div className="import-start">
              <Icon name="upload" size={28} />
              <h3>Import a recording</h3>
              <p className="muted">
                CSV, TSV, TXT, JSON and XLSX are supported. The original file is copied into the project storage unmodified;
                all processing produces separate derived datasets.
              </p>
              <Button variant="primary" icon="folder" onClick={pickFile} disabled={loading}>
                {loading ? 'Reading file…' : 'Choose file'}
              </Button>
            </div>
          )}

          {filePath && preview && (
            <>
              <div className="import-file-row">
                <div>
                  <div className="mono small">{filePath}</div>
                  <div className="muted small">
                    {preview.format.toUpperCase()} · {preview.estimatedRows ? `~${preview.estimatedRows.toLocaleString()} rows` : 'row count unknown'} ·{' '}
                    {preview.columns.length} columns
                  </div>
                </div>
                <Button size="sm" onClick={pickFile} icon="folder">
                  Change file
                </Button>
              </div>

              {preview.warnings?.length > 0 && (
                <div className="warn-banner">
                  <ul>
                    {preview.warnings.map((w: string, i: number) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="wizard-grid">
                <div className="stack">
                  <h4>Dataset</h4>
                  <Field label="Dataset name" required>
                    <Input value={datasetName} onChange={(e) => setDatasetName(e.target.value)} />
                  </Field>
                  <div className="form-grid">
                    <Field label="Recorded at" hint="Used as the absolute time origin">
                      <Input type="datetime-local" value={recordedAt.slice(0, 16)} onChange={(e) => setRecordedAt(e.target.value ? new Date(e.target.value).toISOString() : '')} />
                    </Field>
                    <Field label="Sampling frequency [Hz]" hint="Leave blank to derive from timestamps">
                      <Input type="number" step="any" value={samplingHz} onChange={(e) => setSamplingHz(e.target.value)} placeholder="auto" />
                    </Field>
                  </div>
                  <div className="form-grid">
                    <Field label="Header row" hint="Row number containing column names">
                      <Input type="number" min={0} value={headerRow} onChange={(e) => void changeHeaderRow(Number(e.target.value))} />
                    </Field>
                    {preview.sheets && preview.sheets.length > 1 ? (
                      <Field label="Worksheet">
                        <Select
                          value={String(sheetIndex)}
                          options={preview.sheets.map((s: string, i: number) => ({ value: String(i), label: s }))}
                          onChange={(v) => void loadPreview(filePath, Number(v))}
                        />
                      </Field>
                    ) : (
                      <Field label="Delimiter">
                        <Select
                          value={delimiter}
                          options={[
                            { value: ',', label: 'Comma ,' },
                            { value: ';', label: 'Semicolon ;' },
                            { value: '\t', label: 'Tab' },
                            { value: '|', label: 'Pipe |' },
                          ]}
                          onChange={setDelimiter}
                        />
                      </Field>
                    )}
                  </div>
                  <div className="form-grid">
                    <Field label="Timestamp column">
                      <Select
                        value={timeColumn === null ? '' : String(timeColumn)}
                        placeholder="Row index (no timestamp)"
                        options={columnOptions}
                        onChange={(v) => setTimeColumn(v === '' ? null : Number(v))}
                      />
                    </Field>
                    <Field label="Time unit">
                      <Select value={timeUnit} options={TIME_UNITS.map((t) => ({ value: t.key, label: t.label }))} onChange={setTimeUnit} />
                    </Field>
                  </div>
                  {templates.length > 0 && (
                    <Field label="Apply mapping template">
                      <Select
                        value=""
                        placeholder="Saved templates…"
                        options={templates.map((t) => ({ value: t.id, label: t.name }))}
                        onChange={(v) => loadTemplate(templates.find((t) => t.id === v))}
                      />
                    </Field>
                  )}
                  <Field label="Notes">
                    <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Test conditions, recording notes…" />
                  </Field>
                  <Field label="Save mapping as template" hint="Optional name for reuse with similar loggers">
                    <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="e.g. Flight computer v2 CSV" />
                  </Field>
                  {attach?.label && <div className="muted small">Attaching to: {attach.label}</div>}
                </div>

                <div className="stack channel-map">
                  <div className="section-row">
                    <h4>Measurement channels</h4>
                    <span className="muted small">{enabledChannels.length} selected</span>
                  </div>
                  <div className="channel-table">
                    <div className="channel-row channel-head">
                      <span />
                      <span>Column</span>
                      <span>Channel name</span>
                      <span>Type</span>
                      <span>Unit</span>
                      <span>Sample values</span>
                    </div>
                    {channels.map((channel, idx) => (
                      <div className={`channel-row ${channel.enabled ? '' : 'disabled'}`} key={`${channel.column}-${idx}`}>
                        <Checkbox
                          checked={channel.enabled}
                          onChange={(v) => setChannels((prev) => prev.map((c, i) => (i === idx ? { ...c, enabled: v } : c)))}
                        />
                        <span className="mono small">[{channel.column + 1}] {preview.columns[channel.column]}</span>
                        <Input
                          value={channel.name}
                          onChange={(e) => setChannels((prev) => prev.map((c, i) => (i === idx ? { ...c, name: e.target.value } : c)))}
                        />
                        <Select
                          value={channel.type}
                          options={QUANTITY_OPTIONS}
                          onChange={(v) => {
                            const qt = QUANTITY_TYPES.find((q) => q.key === v);
                            setChannels((prev) =>
                              prev.map((c, i) => (i === idx ? { ...c, type: v, unit: c.unit || qt?.defaultUnit || '' } : c)),
                            );
                          }}
                        />
                        <Select
                          value={channel.unit}
                          options={UNIT_OPTIONS}
                          onChange={(v) => setChannels((prev) => prev.map((c, i) => (i === idx ? { ...c, unit: v } : c)))}
                        />
                        <span className="mono tiny muted" title={sampleFor(channel.column)}>
                          {sampleFor(channel.column).slice(0, 40)}
                        </span>
                        {qualityNote(channel) && channel.enabled && <span className="tiny warn-text">{qualityNote(channel)}</span>}
                      </div>
                    ))}
                  </div>
                  <div className="muted small">
                    Columns not mapped are not imported. Missing or non-numeric cells become gaps and are reported, never silently replaced.
                  </div>
                </div>
              </div>

              {progress && (
                <div className="progress-wrap">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${Math.max(2, Math.min(100, progress.percent ?? 0))}%` }} />
                  </div>
                  <span className="small muted">
                    {progress.phase} · {Number(progress.rows ?? 0).toLocaleString()} rows
                  </span>
                </div>
              )}

              {error && <div className="error-box">{error}</div>}

              <div className="modal-actions-row">
                <Button onClick={importData} variant="primary" icon="upload" disabled={importing || enabledChannels.length === 0}>
                  {importing ? 'Importing…' : 'Import dataset'}
                </Button>
                <Button onClick={onClose} disabled={importing}>
                  Cancel
                </Button>
              </div>
            </>
          )}

          {loading && !preview && <div className="loading">Reading file…</div>}
          {error && !preview && <div className="error-box">{error}</div>}
        </div>
      )}
    </Modal>
  );
}
