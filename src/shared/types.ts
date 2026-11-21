/** Shared domain types. Database rows are plain objects with these shapes. */

export type ID = string;

export interface Row {
  id: ID;
  created_at?: string;
  updated_at?: string;
  [key: string]: any;
}

export interface Project extends Row {
  name: string;
  code: string;
  description: string;
  objectives: string;
  status: string;
  stage: string;
  tags: string;
  archived: number;
}

export interface Rocket extends Row {
  project_id: ID;
  name: string;
  identifier: string;
  description: string;
  status: string;
}

export interface Revision extends Row {
  project_id: ID;
  rocket_id: ID;
  label: string;
  description: string;
  design_changes: string;
  component_changes: string;
  config_changes: string;
  observations: string;
  conclusions: string;
  status: string;
}

export interface Stage extends Row {
  project_id: ID;
  rocket_id: ID;
  revision_id: ID | null;
  name: string;
  description: string;
  notes: string;
  status: string;
  started_at: string;
  completed_at: string;
  sort_order: number;
}

export interface Campaign extends Row {
  project_id: ID;
  name: string;
  kind: string;
  description: string;
  objectives: string;
  started_at: string;
  ended_at: string;
  status: string;
}

export interface TestRecord extends Row {
  project_id: ID;
  rocket_id: ID | null;
  revision_id: ID | null;
  campaign_id: ID | null;
  name: string;
  test_no: string;
  kind: 'ground' | 'experimental';
  category: string;
  performed_at: string;
  objectives: string;
  description: string;
  equipment: string;
  sensor_config: string;
  electronics_config_id: ID | null;
  config_snapshot_id: ID | null;
  env_conditions: string;
  expected: string;
  actual: string;
  observations: string;
  status: string;
  conclusions: string;
  custom_json: string;
}

export interface Flight extends Row {
  project_id: ID;
  rocket_id: ID | null;
  revision_id: ID | null;
  name: string;
  flight_no: string;
  performed_at: string;
  objectives: string;
  description: string;
  env_conditions: string;
  weather: string;
  electronics_config_id: ID | null;
  hardware_config: string;
  firmware_versions: string;
  sensor_config: string;
  daq_config: string;
  observations: string;
  post_inspection: string;
  conclusions: string;
  status: string;
  custom_json: string;
}

export interface Experiment extends Row {
  project_id: ID;
  revision_id: ID | null;
  name: string;
  description: string;
  objective: string;
  independent_vars: string;
  measured_vars: string;
  controlled_conditions: string;
  setup: string;
  conclusions: string;
  status: string;
}

export interface ExperimentRun extends Row {
  experiment_id: ID;
  project_id: ID;
  label: string;
  performed_at: string;
  configuration: string;
  observations: string;
  results: string;
  status: string;
}

export interface Dataset extends Row {
  project_id: ID;
  name: string;
  kind: 'imported' | 'processed' | 'manual';
  test_id: ID | null;
  flight_id: ID | null;
  run_id: ID | null;
  source_dataset_id: ID | null;
  recorded_at: string;
  sampling_hz: number | null;
  duration: number | null;
  points: number;
  channels_count: number;
  units_note: string;
  original_file: string;
  stored_dir: string;
  checksum: string;
  quality_json: string;
  provenance_json: string;
  processing_json: string;
  notes: string;
}

export interface Channel extends Row {
  dataset_id: ID;
  key: string;
  name: string;
  type: string;
  unit: string;
  axis: string;
  column_index: number;
  stats_json: string;
  min: number | null;
  max: number | null;
  points: number;
  file: string;
  notes: string;
  derived: number;
}

export interface DatasetEvent extends Row {
  dataset_id: ID;
  project_id: ID;
  name: string;
  category: string;
  t: number;
  description: string;
  channel_key: string;
  tags: string;
  source: 'user' | 'suggested';
  confirmed: number;
}

export interface DocumentRecord extends Row {
  project_id: ID;
  entity_type: string;
  entity_id: ID;
  title: string;
  description: string;
  kind: string;
  tags: string;
  original_name: string;
  stored_path: string;
  mime: string;
  size: number;
  checksum: string;
}

export interface Issue extends Row {
  project_id: ID;
  revision_id: ID | null;
  test_id: ID | null;
  flight_id: ID | null;
  dataset_id: ID | null;
  title: string;
  description: string;
  category: string;
  severity: string;
  status: string;
  identified_at: string;
  investigation: string;
  proposed_resolution: string;
  resolution: string;
  verification: string;
  tags: string;
}

export interface ComponentRecord extends Row {
  project_id: ID;
  name: string;
  manufacturer: string;
  model: string;
  category: string;
  specs: string;
  serial: string;
  purchase_info: string;
  configuration: string;
  notes: string;
  firmware: string;
}

export interface Sensor extends Row {
  project_id: ID;
  name: string;
  manufacturer: string;
  model: string;
  type: string;
  serial: string;
  range_min: number | null;
  range_max: number | null;
  range_unit: string;
  resolution: number | null;
  units: string;
  sampling: string;
  notes: string;
}

export interface Calibration extends Row {
  sensor_id: ID;
  project_id: ID;
  performed_at: string;
  method: string;
  reference_equipment: string;
  values_json: string;
  coefficients: string;
  range_min: number | null;
  range_max: number | null;
  uncertainty: string;
  notes: string;
}

export interface ConfigSnapshot extends Row {
  project_id: ID;
  kind: string;
  name: string;
  description: string;
  content_json: string;
  file_path: string;
  checksum: string;
  version: string;
}

export interface Activity extends Row {
  project_id: ID;
  entity_type: string;
  entity_id: ID;
  kind: string;
  title: string;
  detail: string;
  at: string;
  tags: string;
  actor: string;
}

export interface SettingsMap {
  [key: string]: string;
}

export interface SeriesResponse {
  x: number[];
  series: {
    channelId: string;
    key: string;
    name: string;
    unit: string;
    type: string;
    axis: string;
    datasetId: string;
    datasetName: string;
    y: (number | null)[];
  }[];
  points: number;
  downsampled: boolean;
  totalPoints: number;
  xUnit: string;
  notes: string[];
}

export interface ImportChannelSpec {
  column: number;
  name: string;
  type: string;
  unit: string;
  axis?: string;
  enabled: boolean;
}

export interface ImportSpec {
  filePath: string;
  projectId: string;
  datasetName: string;
  format: 'csv' | 'tsv' | 'txt' | 'json' | 'xlsx';
  sheet?: string;
  headerRow: number;
  delimiter?: string;
  skipRows: number;
  timeColumn: number | null;
  timeUnit: string;
  timeFormat: string;
  channels: ImportChannelSpec[];
  samplingHz: number | null;
  notes: string;
  attach: { testId?: string | null; flightId?: string | null; runId?: string | null; campaignId?: string | null };
  templateName?: string;
  recordedAt?: string;
  datasetKind?: 'imported' | 'manual';
}

export interface UpdateStatus {
  currentVersion: string;
  platform: string;
  packaged: boolean;
  feedConfigured: boolean;
  latestVersion?: string | null;
  releaseDate?: string | null;
  releaseNotes?: string | null;
  releaseUrl?: string | null;
  available?: boolean;
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported';
  progress?: number | null;
  message?: string | null;
}
