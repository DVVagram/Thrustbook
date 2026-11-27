import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { getDb, schemaVersion } from './db';
import { createRecord, expandOne, getRecord, nowIso } from './repo';
import { datasetDetail, seriesBundle } from './datasets';
import { compareDatasets } from './comparison';
import { dataLog, revisionCompare } from './engineering';
import { lineChartSvg, barChartSvg, PALETTE } from './svg';
import { reportsDir } from './paths';
import { APP_NAME, APP_TAGLINE } from '../shared/constants';
import { displayCustomValue, normalizeTemplateFields } from '../shared/templates';
import { formatNumber, convertUnit, unitDef } from '../shared/units';
import type { Stats } from '../shared/analysis';

export const REPORT_KINDS: { key: string; label: string; entity: string }[] = [
  { key: 'ground-test', label: 'Ground test report', entity: 'test' },
  { key: 'flight-test', label: 'Flight test report', entity: 'flight' },
  { key: 'experimental', label: 'Experimental test report', entity: 'experiment' },
  { key: 'analysis', label: 'Dataset analysis report', entity: 'dataset' },
  { key: 'comparison', label: 'Dataset comparison report', entity: 'comparison' },
  { key: 'calibration', label: 'Sensor calibration report', entity: 'sensor' },
  { key: 'revision', label: 'Revision comparison report', entity: 'revision' },
  { key: 'components', label: 'Component history report', entity: 'project' },
  { key: 'project', label: 'Project development report', entity: 'project' },
  { key: 'history', label: 'Project history report', entity: 'project' },
];

export interface ReportSpec {
  projectId: string;
  kind: string;
  entityId?: string;
  secondaryId?: string;
  title?: string;
  sections?: string[];
  comparison?: any;
  notes?: string;
  includeCharts?: boolean;
  preparedBy?: string;
}

function esc(value: any): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(value: any): string {
  if (value === null || value === undefined || value === '') return '—';
  return esc(value);
}

function num(value: number | null | undefined, digits = 4): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : esc(formatNumber(value, digits));
}

function table(headers: string[], rows: (string | number | null)[][], options: { compact?: boolean } = {}): string {
  return `<table class="data${options.compact ? ' compact' : ''}"><thead><tr>${headers
    .map((h) => `<th>${esc(h)}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c === null || c === undefined || c === '' ? '—' : esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function kv(rows: [string, any][]): string {
  return `<table class="kv">${rows
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v === null || v === '' ? '—' : esc(v)}</td></tr>`)
    .join('')}</table>`;
}

function paragraph(text: string | null | undefined, empty = 'Not recorded.'): string {
  if (!text || !String(text).trim()) return `<p class="muted">${empty}</p>`;
  return String(text)
    .split(/\r?\n/)
    .map((line) => `<p>${esc(line)}</p>`)
    .join('');
}

function datasetCharts(datasetId: string): string {
  const bundle = seriesBundle({ datasetIds: [datasetId], maxPoints: 900, downsample: 'minmax' });
  if (bundle.series.length === 0) return '<p class="muted">No channels available for plotting.</p>';
  const groups = new Map<string, any[]>();
  for (const s of bundle.series) {
    const key = s.unit || 'unitless';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const parts: string[] = [];
  let idx = 0;
  for (const [unit, series] of groups) {
    const chunks: string[] = [];
    for (let i = 0; i < series.length; i += 6) {
      chunks.push(
        lineChartSvg({
          series: series.slice(i, i + 6).map((s, j) => ({ label: s.channelName, x: s.x, y: s.y, color: PALETTE[j % PALETTE.length] })),
          title: `${series.length > 6 ? `Channels ${i + 1}-${Math.min(i + 6, series.length)}` : 'Recorded channels'}${unit !== 'unitless' ? ` [${unit}]` : ''}`,
          xLabel: 'elapsed time [s]',
          yLabel: unit,
          width: 720,
          height: 280,
        }),
      );
    }
    parts.push(chunks.join(''));
    idx++;
  }
  if (bundle.downsampled) parts.push('<p class="muted">Charts use peak-preserving downsampling of the stored recording.</p>');
  return parts.join('');
}

function datasetStatsTable(datasets: any[], includeStats = true): string {
  const rows: (string | number | null)[][] = [];
  for (const d of datasets) {
    for (const c of d.channels ?? []) {
      const stats: Stats = c.stats ?? {};
      rows.push([
        d.name,
        c.name,
        c.type,
        c.unit,
        stats.valid ?? '',
        stats.missing ?? '',
        num(stats.min),
        num(stats.max),
        num(stats.mean),
        num(stats.median),
        num(stats.stdDev),
        num(stats.rms),
      ]);
    }
  }
  if (rows.length === 0) return '<p class="muted">No measurement channels are attached.</p>';
  return table(
    ['Dataset', 'Channel', 'Type', 'Unit', 'Valid', 'Missing', 'Min', 'Max', 'Mean', 'Median', 'Std dev', 'RMS'],
    rows,
    { compact: true },
  );
}

function datasetBlock(datasetId: string, options: { charts: boolean; heading?: string }): string {
  const detail = datasetDetail(datasetId);
  const quality = detail.quality ?? {};
  const provenance = detail.provenance ?? {};
  const parts: string[] = [];
  parts.push(`<h3>${esc(options.heading ?? detail.name)}</h3>`);
  parts.push(
    kv([
      ['Dataset ID', detail.id],
      ['Kind', detail.kind],
      ['Project', detail.project_name],
      ['Attached test', detail.test_name ? `${detail.test_no ?? ''} ${detail.test_name}`.trim() : null],
      ['Attached flight', detail.flight_name ? `${detail.flight_no ?? ''} ${detail.flight_name}`.trim() : null],
      ['Experiment run', detail.run_label ? `${detail.experiment_name ?? ''} · ${detail.run_label}`.trim() : null],
      ['Recorded at', detail.recorded_at],
      ['Samples', detail.points],
      ['Channels', detail.channels_count],
      ['Sampling rate', detail.sampling_hz ? `${Number(detail.sampling_hz).toFixed(3)} Hz` : 'not established'],
      ['Duration', detail.duration !== null && detail.duration !== undefined ? `${Number(detail.duration).toFixed(3)} s` : '—'],
      ['Source file', provenance.source_file_name ?? (detail.original_file ? path.basename(detail.original_file) : null)],
      ['SHA-256', detail.checksum],
      ['Derived from', detail.source?.name ?? null],
    ]),
  );
  if (detail.notes) parts.push(`<h4>Notes</h4>${paragraph(detail.notes)}`);
  parts.push('<h4>Channels</h4>');
  parts.push(datasetStatsTable([detail]));
  if (options.charts) parts.push(`<h4>Graphs</h4>${datasetCharts(datasetId)}`);
  if (quality.warnings?.length) {
    parts.push(`<h4>Data quality</h4><ul>${quality.warnings.map((w: string) => `<li>${esc(w)}</li>`).join('')}</ul>`);
  } else {
    parts.push('<h4>Data quality</h4><p>No import warnings were recorded.</p>');
  }
  if (detail.events?.length) {
    parts.push('<h4>Event markers</h4>');
    parts.push(
      table(
        ['Event', 'Category', 'Time [s]', 'Description', 'Source'],
        detail.events.map((e: any) => [e.name, e.category, Number(e.t).toFixed(4), e.description, e.source === 'suggested' ? 'Suggested' : 'User']),
      ),
    );
  }
  if (detail.processing) {
    parts.push(`<h4>Processing provenance</h4>${kv([
      ['Operation', detail.processing.label ?? detail.processing.operation],
      ['Applied at', detail.processing.applied_at],
      ['Source dataset', detail.processing.source_dataset_name],
      ['Software', detail.processing.software],
      ['Parameters', JSON.stringify(detail.processing.params ?? {})],
    ])}${paragraph(detail.processing.notes, '')}`);
  }
  parts.push(`<p class="muted">Statistics: ${esc(detail.channels?.[0]?.stats?.method ?? 'sample statistics over finite values')}. Derived and calculated values are labelled; recorded values are not modified.</p>`);
  return parts.join('');
}

function templateValuesBlock(record: any): string {
  if (!record?.template_id) return '';
  const row = getDb().get<any>('SELECT * FROM entry_templates WHERE id = ?', [record.template_id]);
  if (!row) return '';
  let fields: any[] = [];
  try {
    fields = normalizeTemplateFields(JSON.parse(row.fields_json || '[]'));
  } catch {
    fields = [];
  }
  let values: Record<string, any> = {};
  try {
    values = JSON.parse(record.custom_json || '{}') ?? {};
  } catch {
    values = {};
  }
  const rows = fields.map((f) => [f.label + (f.unit ? ` [${f.unit}]` : ''), displayCustomValue(f, values[f.key])]);
  if (!rows.length) return '';
  return `<p class="muted">User-entered values from the “${esc(row.name)}” entry template. These are recorded entries, not calculated results.</p>${table(['Field', 'Value'], rows)}`;
}

function issuesTable(issues: any[]): string {
  if (!issues?.length) return '<p class="muted">No linked issues.</p>';
  return table(
    ['Issue', 'Severity', 'Status', 'Identified', 'Resolution'],
    issues.map((i) => [i.title, i.severity, i.status, i.identified_at || i.created_at, i.resolution]),
  );
}

function documentsTable(documents: any[]): string {
  if (!documents?.length) return '<p class="muted">No attached documents.</p>';
  return table(
    ['Document', 'Kind', 'Original file', 'Size', 'SHA-256', 'Added'],
    documents.map((d) => [d.title, d.kind, d.original_name, `${Math.round((d.size ?? 0) / 1024)} kB`, d.checksum, d.created_at]),
  );
}

export function buildReportHtml(spec: ReportSpec): { html: string; title: string; model: any } {
  const db = getDb();
  const project = getRecord('project', spec.projectId);
  if (!project) throw new Error('Project not found');
  const includeCharts = spec.includeCharts !== false;
  const sections: string[] = [];
  const kindDef = REPORT_KINDS.find((k) => k.key === spec.kind) ?? REPORT_KINDS[0];
  let title = spec.title || `${kindDef.label} — ${project.name}`;
  const model: any = { kind: spec.kind, entityId: spec.entityId ?? null };

  const section = (heading: string, body: string) =>
    sections.push(`<section><h2>${esc(heading)}</h2>${body}</section>`);
  const sub = (heading: string, body: string) => `<h3>${esc(heading)}</h3>${body}`;

  switch (spec.kind) {
    case 'ground-test':
    case 'experimental': {
      if (!spec.entityId) throw new Error('Select a test to report');
      const test = db.get<any>('SELECT * FROM tests WHERE id = ?', [spec.entityId]);
      if (!test) throw new Error('Test not found');
      title = spec.title || `${test.kind === 'experimental' ? 'Experimental test' : 'Ground test'} report — ${test.name}`;
      const revision = test.revision_id ? db.get<any>('SELECT * FROM revisions WHERE id = ?', [test.revision_id]) : null;
      const campaign = test.campaign_id ? db.get<any>('SELECT * FROM campaigns WHERE id = ?', [test.campaign_id]) : null;
      const config = test.electronics_config_id
        ? db.get<any>('SELECT id, name, content_json FROM electronics_configs WHERE id = ?', [test.electronics_config_id])
        : null;
      const datasets = db.all<any>('SELECT id FROM datasets WHERE test_id = ? ORDER BY created_at', [test.id]);
      const issues = db.all<any>('SELECT * FROM issues WHERE test_id = ?', [test.id]);
      const documents = db.all<any>(`SELECT * FROM documents WHERE entity_type = 'test' AND entity_id = ?`, [test.id]);
      const sensorInstallations = db.all<any>(
        `SELECT si.*, s.name AS sensor_name, s.model, s.serial FROM sensor_installations si
         LEFT JOIN sensors s ON s.id = si.sensor_id WHERE si.entity_type = 'test' AND si.entity_id = ?`,
        [test.id],
      );
      const components = db.all<any>(
        `SELECT cu.*, c.name AS component_name, c.model, c.category FROM component_usage cu
         LEFT JOIN components c ON c.id = cu.component_id WHERE cu.entity_type = 'test' AND cu.entity_id = ?`,
        [test.id],
      );
      model.test = test;
      section(
        'Test identification',
        kv([
          ['Test name', test.name],
          ['Test number', test.test_no],
          ['Category', test.category],
          ['Status', test.status],
          ['Performed', test.performed_at],
          ['Project', project.name],
          ['Project code', project.code],
          ['Revision', revision?.label],
          ['Campaign', campaign?.name],
        ]),
      );
      section('Objectives and description', `${paragraph(test.objectives)}${paragraph(test.description)}`);
      if (templateValuesBlock(test)) section('Template fields', templateValuesBlock(test));
      section(
        'Test conditions and configuration',
        `${kv([
          ['Environment', test.env_conditions],
          ['Equipment', test.equipment],
          ['Sensor configuration', test.sensor_config],
          ['Electronics configuration', config?.name ?? null],
          ['Expected results', test.expected],
          ['Actual results', test.actual],
        ])}${components.length ? sub('Components present', table(['Component', 'Category', 'Model', 'Notes'], components.map((c) => [c.component_name, c.category, c.model, c.notes]))) : ''}${
          sensorInstallations.length ? sub('Sensors installed', table(['Sensor', 'Model', 'Serial', 'Location', 'Notes'], sensorInstallations.map((s) => [s.sensor_name, s.model, s.serial, s.location, s.notes]))) : ''
        }`,
      );
      if (datasets.length) {
        section(
          'Recorded data',
          datasets.map((d) => `<div class="block">${datasetBlock(d.id, { charts: includeCharts })}</div>`).join(''),
        );
        const all = datasets.map((d) => datasetDetail(d.id));
        const combined = all.reduce((acc: number, d: any) => acc + (d.points ?? 0), 0);
        section('Measurement summary', `${datasetStatsTable(all)}<p class="muted">${all.length} dataset(s) containing ${combined} recorded rows in total.</p>`);
      } else {
        section('Recorded data', '<p class="muted">No datasets are attached to this test. Manual observations only.</p>');
      }
      section('Observations and conclusions', `${sub('Observations', paragraph(test.observations))}${sub('Conclusions', paragraph(test.conclusions))}`);
      section('Linked issues and documents', `${issuesTable(issues)}${documentsTable(documents)}`);
      break;
    }
    case 'flight-test': {
      if (!spec.entityId) throw new Error('Select a flight to report');
      const flight = db.get<any>('SELECT * FROM flights WHERE id = ?', [spec.entityId]);
      if (!flight) throw new Error('Flight not found');
      title = spec.title || `Flight test report — ${flight.name}`;
      const revision = flight.revision_id ? db.get<any>('SELECT * FROM revisions WHERE id = ?', [flight.revision_id]) : null;
      const datasets = db.all<any>('SELECT id FROM datasets WHERE flight_id = ?', [flight.id]);
      const issues = db.all<any>('SELECT * FROM issues WHERE flight_id = ?', [flight.id]);
      const documents = db.all<any>(`SELECT * FROM documents WHERE entity_type = 'flight' AND entity_id = ?`, [flight.id]);
      const previous = db.all<any>(
        `SELECT * FROM flights WHERE project_id = ? AND id != ? AND performed_at != '' AND performed_at < ? ORDER BY performed_at DESC LIMIT 3`,
        [flight.project_id, flight.id, flight.performed_at || '9999'],
      );
      model.flight = flight;
      section(
        'Flight identification',
        kv([
          ['Flight', flight.name],
          ['Flight number', flight.flight_no],
          ['Status', flight.status],
          ['Flown', flight.performed_at],
          ['Revision', revision?.label],
          ['Project', project.name],
        ]),
      );
      section('Objectives and description', `${paragraph(flight.objectives)}${paragraph(flight.description)}`);
      if (templateValuesBlock(flight)) section('Template fields', templateValuesBlock(flight));
      section(
        'Environment and configuration',
        kv([
          ['Environmental conditions', flight.env_conditions],
          ['Weather', flight.weather],
          ['Hardware configuration', flight.hardware_config],
          ['Firmware versions', flight.firmware_versions],
          ['Sensor configuration', flight.sensor_config],
          ['Data acquisition', flight.daq_config],
        ]),
      );
      if (datasets.length) {
        section('Flight data', datasets.map((d) => `<div class="block">${datasetBlock(d.id, { charts: includeCharts })}</div>`).join(''));
      } else {
        section('Flight data', '<p class="muted">No flight recordings are attached.</p>');
      }
      section(
        'Post-flight assessment',
        `${sub('Observations', paragraph(flight.observations))}${sub('Post-flight inspection', paragraph(flight.post_inspection))}${sub('Conclusions', paragraph(flight.conclusions))}`,
      );
      if (previous.length) {
        section(
          'Previous flights',
          table(['Flight', 'Date', 'Status'], previous.map((f) => [f.name, f.performed_at, f.status])),
        );
      }
      section('Linked issues and documents', `${issuesTable(issues)}${documentsTable(documents)}`);
      break;
    }
    case 'experiment': {
      if (!spec.entityId) throw new Error('Select an experiment to report');
      const experiment = db.get<any>('SELECT * FROM experiments WHERE id = ?', [spec.entityId]);
      if (!experiment) throw new Error('Experiment not found');
      title = spec.title || `Experimental report — ${experiment.name}`;
      const runs = db.all<any>('SELECT * FROM runs WHERE experiment_id = ? ORDER BY performed_at, created_at', [experiment.id]);
      const datasets = db.all<any>(
        `SELECT d.id, d.name, r.label AS run_label FROM datasets d LEFT JOIN runs r ON r.id = d.run_id WHERE r.experiment_id = ?`,
        [experiment.id],
      );
      model.experiment = experiment;
      section(
        'Experiment definition',
        kv([
          ['Experiment', experiment.name],
          ['Status', experiment.status],
          ['Objective', experiment.objective],
          ['Independent variables', experiment.independent_vars],
          ['Measured variables', experiment.measured_vars],
          ['Controlled conditions', experiment.controlled_conditions],
        ]),
      );
      section('Setup and description', `${paragraph(experiment.description)}${paragraph(experiment.setup)}`);
      section(
        'Runs',
        runs.length
          ? table(
              ['Run', 'Performed', 'Configuration', 'Observations', 'Results', 'Status'],
              runs.map((r) => [r.label, r.performed_at, r.configuration, r.observations, r.results, r.status]),
            )
          : '<p class="muted">No runs recorded.</p>',
      );
      if (datasets.length) {
        section('Run data', datasets.map((d) => `<div class="block">${datasetBlock(d.id, { charts: includeCharts, heading: `${d.run_label ?? 'Run'} · ${d.name}` })}</div>`).join(''));
      }
      section('Conclusions', paragraph(experiment.conclusions));
      break;
    }
    case 'analysis': {
      if (!spec.entityId) throw new Error('Select a dataset to analyse');
      const dataset = datasetDetail(spec.entityId);
      title = spec.title || `Dataset analysis report — ${dataset.name}`;
      model.dataset = dataset;
      section('Dataset', datasetBlock(dataset.id, { charts: includeCharts }));
      const source = dataset.source ? db.get<any>('SELECT * FROM datasets WHERE id = ?', [dataset.source.id]) : null;
      section(
        'Source and processing',
        `${kv([
          ['Source dataset', source?.name],
          ['Source recording date', source?.recorded_at],
          ['Original file', dataset.original_file],
          ['Import format', dataset.provenance?.format],
          ['Imported at', dataset.provenance?.imported_at],
          ['Checksum', dataset.checksum],
        ])}<p class="muted">The original recording is retained unmodified; all transformations produce separate derived datasets.</p>`,
      );
      section('Limitations', limitationsBlock());
      break;
    }
    case 'comparison': {
      if (!spec.comparison) throw new Error('No comparison configuration was provided');
      const result = compareDatasets(spec.comparison);
      title = spec.title || `Dataset comparison report — ${project.name}`;
      model.comparison = result;
      if (!result.compatible) {
        section('Compatibility', `<p class="warning">${esc(result.incompatibility ?? 'The selected datasets are not directly comparable.')}</p>`);
      } else {
        section(
          'Comparison setup',
          kv([
            ['Datasets compared', result.series.length],
            ['Alignment', result.alignmentLabel],
            ['Normalization', result.normalizationNote],
            ['Shared grid', `${result.gridPoints} points`],
            ['Common target unit', result.targetUnit],
            ['Method', result.method],
          ]),
        );
        section(
          'Selected recordings',
          table(
            ['Dataset', 'Channel', 'Recorded', 'Sampling [Hz]', 'Points', 'Unit'],
            result.metadata.map((m: any) => [m.datasetName, m.channelName, m.recordingDate, m.samplingHz ? Number(m.samplingHz).toFixed(2) : '—', m.sourcePoints, m.unit]),
          ),
        );
        const chart = lineChartSvg({
          series: result.series.map((s: any, i: number) => ({ label: `${s.datasetName} · ${s.channelName}`, x: s.x, y: s.y, color: PALETTE[i % PALETTE.length] })),
          title: 'Aligned comparison',
          xLabel: `aligned time [s]`,
          yLabel: result.targetUnit,
          width: 720,
          height: 320,
        });
        section('Overlay comparison', chart);
        if (result.pairs.length) {
          const diffChart = lineChartSvg({
            series: result.pairs.map((p: any, i: number) => {
              const s = result.series[p.otherIndex];
              const base = result.series[0];
              const y = s.aligned.map((v: number, j: number) => {
                const b = base.aligned[j];
                return Number.isFinite(v) && Number.isFinite(b) ? v - b : null;
              });
              return { label: `${s.channelName} − ${base.channelName}`, x: s.x, y, color: PALETTE[i % PALETTE.length], dash: true };
            }),
            title: 'Difference to baseline',
            xLabel: 'aligned time [s]',
            yLabel: result.targetUnit,
            width: 720,
            height: 280,
          });
          section('Difference', diffChart);
          section(
            'Comparison statistics',
            table(
              ['Series', 'Baseline', 'Valid pairs', 'Mean difference', 'Mean |difference|', 'RMS difference', 'Peak |difference|', 'Correlation r', 'Mean % difference'],
              result.pairs.map((p: any) => [
                p.otherName,
                p.baselineName,
                p.stats.valid,
                num(p.stats.mean),
                num(p.stats.meanAbs),
                num(p.stats.rms),
                num(p.stats.peakAbs),
                p.stats.correlation === null ? '—' : Number(p.stats.correlation).toFixed(4),
                num(p.percent.mean, 2),
              ]),
            ),
          );
          section(
            'Distribution comparison',
            barChartSvg({
              labels: result.series.map((s: any) => `${s.datasetName}\n${s.channelName}`),
              values: result.series.map((s: any) => s.stats.stdDev),
              title: 'Standard deviation by series',
              yLabel: result.targetUnit,
            }),
          );
        }
        section(
          'Per-series statistics',
          table(
            ['Dataset', 'Channel', 'Valid', 'Missing', 'Min', 'Max', 'Mean', 'Median', 'Std dev', 'RMS'],
            result.series.map((s: any) => [
              s.datasetName,
              s.channelName,
              s.stats.valid,
              s.stats.missing,
              num(s.stats.min),
              num(s.stats.max),
              num(s.stats.mean),
              num(s.stats.median),
              num(s.stats.stdDev),
              num(s.stats.rms),
            ]),
          ),
        );
      }
      if (result.warnings.length) section('Alignment warnings', `<ul>${result.warnings.map((w: string) => `<li>${esc(w)}</li>`).join('')}</ul>`);
      section('Limitations', `<ul>${result.limitations.map((l: string) => `<li>${esc(l)}</li>`).join('')}</ul>`);
      break;
    }
    case 'calibration': {
      if (!spec.entityId) throw new Error('Select a sensor to report');
      const sensor = db.get<any>('SELECT * FROM sensors WHERE id = ?', [spec.entityId]);
      if (!sensor) throw new Error('Sensor not found');
      title = spec.title || `Sensor calibration report — ${sensor.name}`;
      const calibrations = db.all<any>('SELECT * FROM calibrations WHERE sensor_id = ? ORDER BY performed_at DESC', [sensor.id]);
      const documents = db.all<any>(`SELECT * FROM documents WHERE entity_type = 'sensor' AND entity_id = ?`, [sensor.id]);
      const datasets = db.all<any>(
        `SELECT DISTINCT d.id, d.name FROM channels c JOIN datasets d ON d.id = c.dataset_id WHERE c.source_desc LIKE ? LIMIT 6`,
        [`%${sensor.serial || sensor.name}%`],
      );
      model.sensor = sensor;
      section(
        'Sensor',
        kv([
          ['Sensor', sensor.name],
          ['Manufacturer', sensor.manufacturer],
          ['Model', sensor.model],
          ['Type', sensor.type],
          ['Serial', sensor.serial],
          ['Range', sensor.range_min !== null ? `${sensor.range_min} … ${sensor.range_max} ${sensor.range_unit}` : null],
          ['Resolution', sensor.resolution],
          ['Units', sensor.units],
          ['Sampling', sensor.sampling],
        ]),
      );
      section(
        'Calibration history',
        calibrations.length
          ? table(
              ['Date', 'Method', 'Reference equipment', 'Coefficients', 'Range', 'Uncertainty', 'Notes'],
              calibrations.map((c) => [
                c.performed_at,
                c.method,
                c.reference_equipment,
                c.coefficients,
                c.range_min !== null ? `${c.range_min} … ${c.range_max}` : '',
                c.uncertainty,
                c.notes,
              ]),
            )
          : '<p class="muted">No calibration records.</p>',
      );
      section(
        'Processing policy',
        '<p>Calibration coefficients are never applied to historical recordings automatically. Applying a calibration produces a new derived dataset with its own provenance record, preserving the original values.</p>',
      );
      section('Documents', documentsTable(documents));
      if (datasets.length) section('Datasets referencing this sensor', table(['Dataset', 'Attached'], datasets.map((d) => [d.name, ''])));
      break;
    }
    case 'revision': {
      if (!spec.entityId) throw new Error('Select a revision');
      const revision = db.get<any>('SELECT * FROM revisions WHERE id = ?', [spec.entityId]);
      if (!revision) throw new Error('Revision not found');
      const other = spec.secondaryId ? db.get<any>('SELECT * FROM revisions WHERE id = ?', [spec.secondaryId]) : null;
      title = spec.title || `Revision report — ${revision.label}`;
      model.revision = revision;
      if (other) {
        const diff = revisionCompare(revision.id, other.id);
        section('Revisions compared', kv([['Earlier', diff.a.label], ['Later', diff.b.label], ['Created', `${diff.a.created_at} → ${diff.b.created_at}`]]));
        section(
          'Documented changes',
          table(
            ['Field', diff.a.label, diff.b.label, 'Changed'],
            diff.changedFields.map((f: any) => [f.label, f.a, f.b, f.changed ? 'Yes' : 'No']),
          ),
        );
        section(
          'Measurement deltas',
          diff.metricDeltas.length
            ? `${table(
                ['Channel', 'Unit', 'Earlier mean', 'Later mean', 'Δ mean', 'Earlier peak', 'Later peak', 'Δ peak'],
                diff.metricDeltas.map((m: any) => [m.name, m.unit, num(m.a.mean), num(m.b.mean), num(m.deltaMean), num(m.a.meanPeak), num(m.b.meanPeak), num(m.deltaPeak)]),
              )}<ul>${diff.caveats.map((c: string) => `<li>${esc(c)}</li>`).join('')}</ul>`
            : '<p class="muted">No matching measurement channels were recorded on both revisions.</p>',
        );
        section(
          'Records per revision',
          table(
            ['Record type', diff.a.label, diff.b.label],
            [
              ['Tests', diff.records.a.tests.length, diff.records.b.tests.length],
              ['Flights', diff.records.a.flights.length, diff.records.b.flights.length],
              ['Datasets', diff.records.datasetsA.length, diff.records.datasetsB.length],
              ['Issues', diff.records.a.issues.length, diff.records.b.issues.length],
            ],
          ),
        );
      } else {
        section(
          'Revision',
          kv([
            ['Label', revision.label],
            ['Status', revision.status],
            ['Created', revision.created_at],
            ['Description', revision.description],
          ]),
        );
        section('Design changes', paragraph(revision.design_changes));
        section('Component changes', paragraph(revision.component_changes));
        section('Configuration changes', paragraph(revision.config_changes));
        section('Observations', paragraph(revision.observations));
        section('Conclusions', paragraph(revision.conclusions));
      }
      break;
    }
    case 'components': {
      const components = db.all<any>('SELECT * FROM components WHERE project_id = ? ORDER BY category, name', [project.id]);
      const configs = db.all<any>('SELECT * FROM electronics_configs WHERE project_id = ?', [project.id]);
      const snapshots = db.all<any>('SELECT * FROM config_snapshots WHERE project_id = ? ORDER BY created_at DESC', [project.id]);
      const usage = db.all<any>(
        `SELECT cu.*, c.name AS component_name FROM component_usage cu LEFT JOIN components c ON c.id = cu.component_id WHERE cu.project_id = ? ORDER BY cu.installed_at`,
        [project.id],
      );
      model.components = components;
      section(
        'Inventory',
        components.length
          ? table(
              ['Component', 'Category', 'Manufacturer', 'Model', 'Serial', 'Quantity', 'Unit price', 'Currency', 'Firmware', 'Notes'],
              components.map((c) => [c.name, c.category, c.manufacturer, c.model, c.serial, c.quantity, c.unit_price, c.currency, c.firmware, c.notes]),
            )
          : '<p class="muted">No components recorded.</p>',
      );
      section(
        'Electronics configurations',
        configs.length
          ? table(
              ['Configuration', 'Revision', 'Description', 'Created'],
              configs.map((c) => [c.name, c.revision_id, c.description, c.created_at]),
            )
          : '<p class="muted">No electronics configurations recorded.</p>',
      );
      section(
        'Installation history',
        usage.length
          ? table(
              ['Component', 'Attached to', 'Installed', 'Removed', 'Notes'],
              usage.map((u) => [u.component_name, `${u.entity_type} ${u.entity_id}`, u.installed_at, u.removed_at, u.notes]),
            )
          : '<p class="muted">No installation records.</p>',
      );
      section(
        'Configuration snapshots',
        snapshots.length
          ? table(
              ['Snapshot', 'Kind', 'Version', 'Checksum', 'Created'],
              snapshots.map((s) => [s.name, s.kind, s.version, s.checksum, s.created_at]),
            )
          : '<p class="muted">No snapshots recorded.</p>',
      );
      break;
    }
    case 'history': {
      const log = dataLog({ projectId: project.id, limit: 500 });
      title = spec.title || `Project history report — ${project.name}`;
      model.entries = log.total;
      section(
        'Recorded history',
        table(
          ['Date', 'Type', 'Entry', 'Detail', 'Status'],
          log.entries.map((e) => [e.at, e.type, e.title, e.subtitle, e.status]),
          { compact: true },
        ),
      );
      break;
    }
    case 'project':
    default: {
      const overview = db.get<any>(
        `SELECT (SELECT COUNT(*) FROM tests WHERE project_id = ?) AS tests,
                (SELECT COUNT(*) FROM flights WHERE project_id = ?) AS flights,
                (SELECT COUNT(*) FROM datasets WHERE project_id = ?) AS datasets,
                (SELECT COUNT(*) FROM revisions WHERE project_id = ?) AS revisions,
                (SELECT COUNT(*) FROM components WHERE project_id = ?) AS components,
                (SELECT COUNT(*) FROM sensors WHERE project_id = ?) AS sensors`,
        Array(6).fill(project.id),
      );
      const revisions = db.all<any>('SELECT * FROM revisions WHERE project_id = ? ORDER BY created_at', [project.id]);
      const tests = db.all<any>('SELECT * FROM tests WHERE project_id = ? ORDER BY performed_at', [project.id]);
      const flights = db.all<any>('SELECT * FROM flights WHERE project_id = ? ORDER BY performed_at', [project.id]);
      const datasets = db.all<any>('SELECT id, name, kind FROM datasets WHERE project_id = ? ORDER BY recorded_at', [project.id]);
      const issues = db.all<any>('SELECT * FROM issues WHERE project_id = ?', [project.id]);
      const stages = db.all<any>('SELECT * FROM stages WHERE project_id = ? ORDER BY sort_order', [project.id]);
      const components = db.all<any>('SELECT * FROM components WHERE project_id = ?', [project.id]);
      const sensors = db.all<any>('SELECT * FROM sensors WHERE project_id = ?', [project.id]);
      const campaigns = db.all<any>('SELECT * FROM campaigns WHERE project_id = ?', [project.id]);
      title = spec.title || `Project development report — ${project.name}`;
      section(
        'Project',
        kv([
          ['Project', project.name],
          ['Code', project.code],
          ['Status', project.status],
          ['Development stage', project.stage],
          ['Created', project.created_at],
          ['Objectives', project.objectives],
        ]) + paragraph(project.description),
      );
      section(
        'Programme summary',
        table(
          ['Revisions', 'Tests', 'Flights', 'Datasets', 'Components', 'Sensors'],
          [[overview.revisions, overview.tests, overview.flights, overview.datasets, overview.components, overview.sensors]],
        ),
      );
      section(
        'Development stages',
        stages.length
          ? table(
              ['Stage', 'Status', 'Started', 'Completed', 'Notes'],
              stages.map((s) => [s.name, s.status, s.started_at, s.completed_at, s.notes]),
            )
          : '<p class="muted">No development stages recorded.</p>',
      );
      section(
        'Revisions',
        revisions.length
          ? table(
              ['Revision', 'Status', 'Created', 'Design changes', 'Conclusions'],
              revisions.map((r) => [r.label, r.status, r.created_at, r.design_changes, r.conclusions]),
            )
          : '<p class="muted">No revisions recorded.</p>',
      );
      section(
        'Testing campaigns',
        campaigns.length ? table(['Campaign', 'Kind', 'Status', 'Objectives'], campaigns.map((c) => [c.name, c.kind, c.status, c.objectives])) : '<p class="muted">No campaigns.</p>',
      );
      section(
        'Ground and experimental tests',
        tests.length
          ? table(
              ['Test', 'No.', 'Category', 'Date', 'Status', 'Objectives'],
              tests.map((t) => [t.name, t.test_no, t.category, t.performed_at, t.status, t.objectives]),
            )
          : '<p class="muted">No tests recorded.</p>',
      );
      section(
        'Flights',
        flights.length
          ? table(
              ['Flight', 'No.', 'Date', 'Status', 'Objectives'],
              flights.map((f) => [f.name, f.flight_no, f.performed_at, f.status, f.objectives]),
            )
          : '<p class="muted">No flights recorded.</p>',
      );
      section(
        'Datasets',
        datasets.length
          ? table(
              ['Dataset', 'Kind', 'Points'],
              datasets.map((d) => [d.name, d.kind, '']),
            )
          : '<p class="muted">No datasets recorded.</p>',
      );
      section('Issues', issuesTable(issues));
      section(
        'Components and sensors',
        table(['Item', 'Type', 'Model', 'Serial'], [
          ...components.map((c) => [c.name, c.category, c.model, c.serial]),
          ...sensors.map((s) => [s.name, s.type, s.model, s.serial]),
        ]),
      );
      section('Limitations', limitationsBlock());
      break;
    }
  }

  if (spec.notes) section('Report notes', paragraph(spec.notes));

  const generated = nowIso();
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; font-size: 9.6pt; color: #111827; margin: 0; line-height: 1.45; }
  header.cover { border-bottom: 2px solid #1f3a5f; padding-bottom: 10px; margin-bottom: 18px; }
  header.cover .brand { font-size: 8.5pt; letter-spacing: 2px; text-transform: uppercase; color: #1f3a5f; font-weight: 600; }
  header.cover h1 { font-size: 20pt; margin: 6px 0 4px; color: #0f172a; }
  header.cover .meta { font-size: 8.6pt; color: #4b5563; }
  section { margin-bottom: 16px; page-break-inside: auto; }
  h2 { font-size: 11.5pt; color: #1f3a5f; border-bottom: 1px solid #cbd5e1; padding-bottom: 3px; margin: 18px 0 8px; text-transform: uppercase; letter-spacing: 0.6px; }
  h3 { font-size: 10pt; margin: 12px 0 6px; color: #0f172a; }
  h4 { font-size: 9.4pt; margin: 10px 0 4px; color: #334155; }
  p { margin: 3px 0 6px; white-space: pre-wrap; }
  .muted { color: #6b7280; font-size: 8.6pt; }
  .warning { color: #92400e; background: #fef3c7; padding: 8px; border-left: 3px solid #d97706; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; page-break-inside: avoid; }
  table.kv th { text-align: left; width: 28%; background: #f3f4f6; font-weight: 600; }
  table.kv th, table.kv td, table.data th, table.data td { border: 1px solid #d1d5db; padding: 3.5px 5px; vertical-align: top; font-size: 8.5pt; }
  table.data th { background: #e8edf3; text-align: left; font-weight: 600; }
  table.data.compact th, table.data.compact td { font-size: 7.8pt; padding: 2.5px 4px; }
  table tbody tr:nth-child(even) { background: #fafbfc; }
  svg { max-width: 100%; page-break-inside: avoid; margin: 6px 0; border: 1px solid #e5e7eb; }
  ul { margin: 4px 0 8px 18px; padding: 0; }
  li { margin: 2px 0; }
  .block { page-break-inside: auto; }
  footer { margin-top: 22px; border-top: 1px solid #cbd5e1; padding-top: 8px; font-size: 8pt; color: #6b7280; }
  .classification { display: inline-block; border: 1px solid #9ca3af; padding: 2px 6px; font-size: 7.5pt; letter-spacing: 1px; color: #4b5563; }
</style></head>
<body>
<header class="cover">
  <div class="brand">${esc(APP_NAME)} · Engineering Record</div>
  <h1>${esc(title)}</h1>
  <div class="meta">${esc(project.name)}${project.code ? ` · ${esc(project.code)}` : ''} · Generated ${esc(generated)}</div>
  <div class="meta">${esc(APP_TAGLINE)} · Report type: ${esc(kindDef.label)} · Software ${esc(APP_NAME)} 1.0.0 · Schema v${schemaVersion()}</div>
</header>
${sections.join('\n')}
<footer>
  <div>This report contains engineering records and calculations produced from recorded data. It distinguishes recorded measurements, user-entered information, derived calculations and user conclusions. It is not a certification or proof of flight safety.</div>
  <div style="margin-top:6px"><span class="classification">ENGINEERING RECORD</span></div>
</footer>
</body></html>`;

  return { html, title, model };
}

function limitationsBlock(): string {
  return `<ul>
    <li>Recorded values originate from the imported file and are retained unmodified in the original recording.</li>
    <li>Derived values, statistics and interpolations are calculations and are labelled as such.</li>
    <li>Statistics assume valid numeric samples; missing values are excluded and counted.</li>
    <li>No result in this report certifies that hardware is safe or flight-ready.</li>
  </ul>`;
}

export async function generateReport(spec: ReportSpec): Promise<any> {
  const { html, title } = buildReportHtml(spec);
  const dir = reportsDir();
  const reportId = cryptoRandomId();
  const htmlPath = path.join(dir, `${reportId}.html`);
  const pdfPath = path.join(dir, `${reportId}.pdf`);
  fs.writeFileSync(htmlPath, html, 'utf8');

  let pdfOk = false;
  let pdfError: string | null = null;
  try {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.5, right: 0.5 },
      preferCSSPageSize: true,
    });
    fs.writeFileSync(pdfPath, pdf);
    pdfOk = true;
    win.destroy();
  } catch (err: any) {
    pdfError = err?.message ?? String(err);
    console.error('PDF generation failed', err);
  }

  const report = createRecord('report', {
    id: reportId,
    project_id: spec.projectId,
    kind: spec.kind,
    title,
    spec_json: spec,
    html_path: htmlPath,
    pdf_path: pdfOk ? pdfPath : '',
    entity_type: (REPORT_KINDS.find((k) => k.key === spec.kind) ?? {}).entity ?? '',
    entity_id: spec.entityId ?? '',
  });
  return { report, pdfPath: pdfOk ? pdfPath : null, htmlPath, pdfError };
}

function cryptoRandomId(): string {
  // Local import to keep the module surface compact.
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  return randomUUID();
}
