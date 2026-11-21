import {
  COMPONENT_CATEGORIES,
  CONFIG_KINDS,
  DOCUMENT_KINDS,
  FLIGHT_STATUSES,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  PROJECT_STATUSES,
  REVISION_STATUSES,
  SENSOR_TYPES,
  STAGE_STATUSES,
  TEST_CATEGORIES,
  TEST_STATUSES,
} from '../shared/constants';

export type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'datetime' | 'date' | 'checkbox';

export interface FieldDef {
  key: string;
  label: string;
  type?: FieldType;
  options?: (string | { value: string; label: string })[];
  full?: boolean;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  rows?: number;
  step?: string;
  ref?: string;
  refWhere?: Record<string, any>;
  hide?: boolean;
  mono?: boolean;
}

export const opts = (values: string[]) => values.map((v) => ({ value: v, label: v }));

export const FORMS: Record<string, { title: string; singular: string; fields: FieldDef[] }> = {
  project: {
    title: 'Project',
    singular: 'project',
    fields: [
      { key: 'name', label: 'Project name', required: true, placeholder: 'e.g. Kestrel sounding rocket' },
      { key: 'code', label: 'Project identifier', placeholder: 'e.g. KST-01' },
      { key: 'status', label: 'Status', type: 'select', options: opts(PROJECT_STATUSES) },
      { key: 'stage', label: 'Development stage' },
      { key: 'objectives', label: 'Objectives', type: 'textarea', full: true, rows: 3 },
      { key: 'description', label: 'Description', type: 'textarea', full: true, rows: 3 },
      { key: 'tags', label: 'Tags', hint: 'Comma separated' },
    ],
  },
  rocket: {
    title: 'Rocket',
    singular: 'rocket',
    fields: [
      { key: 'name', label: 'Rocket name', required: true },
      { key: 'identifier', label: 'Identifier' },
      { key: 'status', label: 'Status' },
      { key: 'description', label: 'Description', type: 'textarea', full: true, rows: 3 },
    ],
  },
  revision: {
    title: 'Rocket revision',
    singular: 'revision',
    fields: [
      { key: 'label', label: 'Revision identifier', required: true, placeholder: 'e.g. Rev C' },
      { key: 'status', label: 'Status', type: 'select', options: opts(REVISION_STATUSES) },
      { key: 'rocket_id', label: 'Rocket', ref: 'rocket', required: true },
      { key: 'description', label: 'Description', type: 'textarea', full: true, rows: 2 },
      { key: 'design_changes', label: 'Design changes', type: 'textarea', rows: 4 },
      { key: 'component_changes', label: 'Component changes', type: 'textarea', rows: 4 },
      { key: 'config_changes', label: 'Configuration changes', type: 'textarea', rows: 4 },
      { key: 'observations', label: 'Observations', type: 'textarea', rows: 3 },
      { key: 'conclusions', label: 'Conclusions', type: 'textarea', full: true, rows: 3 },
    ],
  },
  stage: {
    title: 'Development stage',
    singular: 'stage',
    fields: [
      { key: 'name', label: 'Stage', required: true },
      { key: 'status', label: 'Status', type: 'select', options: opts(STAGE_STATUSES) },
      { key: 'started_at', label: 'Started', type: 'date' },
      { key: 'completed_at', label: 'Completed', type: 'date' },
      { key: 'description', label: 'Description', type: 'textarea', full: true, rows: 3 },
      { key: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 3 },
    ],
  },
  campaign: {
    title: 'Testing campaign',
    singular: 'campaign',
    fields: [
      { key: 'name', label: 'Campaign name', required: true },
      { key: 'kind', label: 'Kind', type: 'select', options: opts(['Ground', 'Flight', 'Experimental', 'Mixed']) },
      { key: 'status', label: 'Status', type: 'select', options: opts(['Planned', 'Active', 'Complete', 'Archived']) },
      { key: 'started_at', label: 'Starts', type: 'date' },
      { key: 'ended_at', label: 'Ends', type: 'date' },
      { key: 'objectives', label: 'Objectives', type: 'textarea', full: true, rows: 2 },
      { key: 'description', label: 'Description', type: 'textarea', full: true, rows: 3 },
    ],
  },
  test: {
    title: 'Ground test',
    singular: 'ground test',
    fields: [
      { key: 'name', label: 'Test name', required: true, placeholder: 'e.g. IMU static verification' },
      { key: 'test_no', label: 'Test number', placeholder: 'e.g. GT-004' },
      { key: 'category', label: 'Category', type: 'select', options: opts(TEST_CATEGORIES) },
      { key: 'status', label: 'Status', type: 'select', options: opts(TEST_STATUSES) },
      { key: 'performed_at', label: 'Date and time', type: 'datetime' },
      { key: 'campaign_id', label: 'Campaign', ref: 'campaign' },
      { key: 'revision_id', label: 'Rocket revision', ref: 'revision' },
      { key: 'electronics_config_id', label: 'Electronics configuration', ref: 'electronics_config' },
      { key: 'objectives', label: 'Objectives', type: 'textarea', full: true, rows: 2 },
      { key: 'description', label: 'Description / procedure', type: 'textarea', full: true, rows: 3 },
      { key: 'equipment', label: 'Equipment used', type: 'textarea', full: true, rows: 2 },
      { key: 'sensor_config', label: 'Sensor configuration', type: 'textarea', full: true, rows: 2 },
      { key: 'env_conditions', label: 'Environmental conditions', type: 'textarea', full: true, rows: 2 },
      { key: 'expected', label: 'Expected results', type: 'textarea', rows: 3 },
      { key: 'actual', label: 'Actual results', type: 'textarea', rows: 3 },
      { key: 'observations', label: 'Observations', type: 'textarea', full: true, rows: 3 },
      { key: 'conclusions', label: 'Conclusions', type: 'textarea', full: true, rows: 3 },
    ],
  },
  flight: {
    title: 'Flight',
    singular: 'flight',
    fields: [
      { key: 'name', label: 'Flight name', required: true, placeholder: 'e.g. Kestrel flight 3' },
      { key: 'flight_no', label: 'Flight number', placeholder: 'e.g. FL-003' },
      { key: 'status', label: 'Status', type: 'select', options: opts(FLIGHT_STATUSES) },
      { key: 'performed_at', label: 'Flight date and time', type: 'datetime' },
      { key: 'revision_id', label: 'Rocket revision', ref: 'revision' },
      { key: 'electronics_config_id', label: 'Electronics configuration', ref: 'electronics_config' },
      { key: 'objectives', label: 'Objectives', type: 'textarea', full: true, rows: 2 },
      { key: 'description', label: 'Description', type: 'textarea', full: true, rows: 2 },
      { key: 'env_conditions', label: 'Environmental conditions', type: 'textarea', full: true, rows: 2 },
      { key: 'weather', label: 'Weather', type: 'textarea', full: true, rows: 2 },
      { key: 'hardware_config', label: 'Hardware configuration', type: 'textarea', full: true, rows: 2 },
      { key: 'firmware_versions', label: 'Firmware versions', type: 'textarea', full: true, rows: 2 },
      { key: 'sensor_config', label: 'Sensor configuration', type: 'textarea', full: true, rows: 2 },
      { key: 'daq_config', label: 'Data acquisition configuration', type: 'textarea', full: true, rows: 2 },
      { key: 'observations', label: 'Flight observations', type: 'textarea', full: true, rows: 3 },
      { key: 'post_inspection', label: 'Post-flight inspection', type: 'textarea', full: true, rows: 3 },
      { key: 'conclusions', label: 'Conclusions', type: 'textarea', full: true, rows: 3 },
    ],
  },
  experiment: {
    title: 'Experiment',
    singular: 'experiment',
    fields: [
      { key: 'name', label: 'Experiment name', required: true },
      { key: 'status', label: 'Status', type: 'select', options: opts(['Planned', 'Running', 'Complete', 'Archived']) },
      { key: 'revision_id', label: 'Rocket revision', ref: 'revision' },
      { key: 'objective', label: 'Objective', type: 'textarea', full: true, rows: 2 },
      { key: 'independent_vars', label: 'Independent variables', type: 'textarea', full: true, rows: 2 },
      { key: 'measured_vars', label: 'Measured variables', type: 'textarea', full: true, rows: 2 },
      { key: 'controlled_conditions', label: 'Controlled conditions', type: 'textarea', full: true, rows: 2 },
      { key: 'description', label: 'Description', type: 'textarea', full: true, rows: 3 },
      { key: 'setup', label: 'Test configuration / setup', type: 'textarea', full: true, rows: 3 },
      { key: 'conclusions', label: 'Conclusions', type: 'textarea', full: true, rows: 3 },
    ],
  },
  run: {
    title: 'Experiment run',
    singular: 'run',
    fields: [
      { key: 'label', label: 'Run label', required: true, placeholder: 'e.g. Run 4 — 12 V' },
      { key: 'status', label: 'Status', type: 'select', options: opts(['Planned', 'Completed', 'Aborted', 'Failed']) },
      { key: 'performed_at', label: 'Performed', type: 'datetime' },
      { key: 'configuration', label: 'Run configuration', type: 'textarea', full: true, rows: 2 },
      { key: 'observations', label: 'Observations', type: 'textarea', full: true, rows: 3 },
      { key: 'results', label: 'Results', type: 'textarea', full: true, rows: 3 },
    ],
  },
  component: {
    title: 'Component',
    singular: 'component',
    fields: [
      { key: 'name', label: 'Component name', required: true },
      { key: 'category', label: 'Category', type: 'select', options: opts(COMPONENT_CATEGORIES) },
      { key: 'manufacturer', label: 'Manufacturer' },
      { key: 'model', label: 'Model' },
      { key: 'serial', label: 'Serial / identifier' },
      { key: 'firmware', label: 'Firmware version' },
      { key: 'specs', label: 'Technical specifications', type: 'textarea', full: true, rows: 3 },
      { key: 'configuration', label: 'Current configuration', type: 'textarea', full: true, rows: 2 },
      { key: 'purchase_info', label: 'Purchase information', type: 'textarea', full: true, rows: 2 },
      { key: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 3 },
    ],
  },
  electronics_config: {
    title: 'Electronics configuration',
    singular: 'electronics configuration',
    fields: [
      { key: 'name', label: 'Configuration name', required: true },
      { key: 'revision_id', label: 'Rocket revision', ref: 'revision' },
      { key: 'description', label: 'Description', type: 'textarea', full: true, rows: 3 },
    ],
  },
  sensor: {
    title: 'Sensor',
    singular: 'sensor',
    fields: [
      { key: 'name', label: 'Sensor name', required: true },
      { key: 'type', label: 'Sensor type', type: 'select', options: opts(SENSOR_TYPES) },
      { key: 'manufacturer', label: 'Manufacturer' },
      { key: 'model', label: 'Model' },
      { key: 'serial', label: 'Serial / identifier' },
      { key: 'range_min', label: 'Range minimum', type: 'number' },
      { key: 'range_max', label: 'Range maximum', type: 'number' },
      { key: 'range_unit', label: 'Range unit' },
      { key: 'resolution', label: 'Resolution', type: 'number', step: 'any' },
      { key: 'units', label: 'Measurement units' },
      { key: 'sampling', label: 'Sampling characteristics' },
      { key: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 3 },
    ],
  },
  calibration: {
    title: 'Calibration record',
    singular: 'calibration',
    fields: [
      { key: 'performed_at', label: 'Calibration date', type: 'datetime' },
      { key: 'method', label: 'Method' },
      { key: 'reference_equipment', label: 'Reference equipment' },
      { key: 'coefficients', label: 'Calibration coefficients', placeholder: 'e.g. y = 0.998x + 0.4' },
      { key: 'range_min', label: 'Range minimum', type: 'number' },
      { key: 'range_max', label: 'Range maximum', type: 'number' },
      { key: 'uncertainty', label: 'Known uncertainty' },
      { key: 'values_json', label: 'Calibration values (JSON)', type: 'textarea', full: true, rows: 3, mono: true, hint: 'Recorded reference pairs, e.g. [{"reference":0,"measured":0.01}]' },
      { key: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 3 },
    ],
  },
  config_snapshot: {
    title: 'Configuration snapshot',
    singular: 'configuration snapshot',
    fields: [
      { key: 'name', label: 'Snapshot name', required: true },
      { key: 'kind', label: 'Kind', type: 'select', options: opts(CONFIG_KINDS) },
      { key: 'version', label: 'Version / build' },
      { key: 'description', label: 'Description', type: 'textarea', full: true, rows: 2 },
      { key: 'content_json', label: 'Configuration content (JSON)', type: 'textarea', full: true, rows: 5, mono: true },
    ],
  },
  issue: {
    title: 'Issue or observation',
    singular: 'issue',
    fields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'category', label: 'Category', type: 'select', options: opts(['Anomaly', 'Observation', 'Defect', 'Data quality', 'Configuration', 'Procedure', 'Safety note']) },
      { key: 'severity', label: 'Severity', type: 'select', options: opts(ISSUE_SEVERITIES) },
      { key: 'status', label: 'Status', type: 'select', options: opts(ISSUE_STATUSES) },
      { key: 'identified_at', label: 'Identified', type: 'datetime' },
      { key: 'revision_id', label: 'Rocket revision', ref: 'revision' },
      { key: 'description', label: 'Description', type: 'textarea', full: true, rows: 3 },
      { key: 'investigation', label: 'Investigation notes', type: 'textarea', full: true, rows: 3 },
      { key: 'proposed_resolution', label: 'Proposed resolution', type: 'textarea', full: true, rows: 2 },
      { key: 'resolution', label: 'Resolution record', type: 'textarea', full: true, rows: 3 },
      { key: 'verification', label: 'Verification results', type: 'textarea', full: true, rows: 2 },
      { key: 'tags', label: 'Tags' },
    ],
  },
  note: {
    title: 'Engineering note',
    singular: 'note',
    fields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'tags', label: 'Tags' },
      { key: 'body', label: 'Note', type: 'textarea', full: true, rows: 6 },
    ],
  },
  document: {
    title: 'Document metadata',
    singular: 'document',
    fields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'kind', label: 'Kind', type: 'select', options: opts(DOCUMENT_KINDS) },
      { key: 'tags', label: 'Tags' },
      { key: 'description', label: 'Description', type: 'textarea', full: true, rows: 3 },
    ],
  },
};

export function fieldsFor(entity: string): FieldDef[] {
  return FORMS[entity]?.fields ?? [];
}
