export const APP_NAME = 'Thrustbook';
export const APP_TAGLINE = 'Rocket Development, Testing & Engineering Analysis Platform';
export const DEFAULT_UPDATE_REPO = 'DVVagram/Thrustbook';

export const PROJECT_STATUSES = ['Planning', 'In development', 'Testing', 'Flight campaign', 'On hold', 'Complete', 'Archived'];
export const REVISION_STATUSES = ['Concept', 'In design', 'Built', 'Tested', 'Flown', 'Superseded', 'Archived'];
export const STAGE_STATUSES = ['Not started', 'In progress', 'Blocked', 'Complete', 'Skipped'];
export const TEST_STATUSES = ['Planned', 'Ready', 'In progress', 'Completed', 'Aborted', 'Failed', 'Archived'];
export const FLIGHT_STATUSES = ['Planned', 'Flown', 'Partially recovered', 'Lost', 'Aborted', 'Under analysis', 'Archived'];
export const ISSUE_STATUSES = ['Open', 'Investigating', 'Mitigated', 'Resolved', 'Verified', 'Closed', 'Won\'t fix'];
export const ISSUE_SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Observation'];
export const EVENT_CATEGORIES = ['Ignition', 'Burnout', 'Apogee', 'Deployment', 'Landing', 'Peak acceleration', 'Anomaly', 'Power event', 'Data gap', 'Calibration', 'Custom'];

export const DEFAULT_STAGES = [
  'Initial concept',
  'Requirements',
  'Preliminary development',
  'Design',
  'Component selection',
  'Electronics development',
  'Assembly',
  'Integration',
  'Ground verification',
  'Flight preparation',
  'Flight testing',
  'Post-flight analysis',
  'Design revision',
];

export const TEST_CATEGORIES = [
  'Electronics verification',
  'Sensor calibration',
  'Telemetry verification',
  'Data acquisition verification',
  'Power system characterization',
  'Communication testing',
  'Structural inspection',
  'Environmental testing',
  'Component acceptance testing',
  'Software verification',
  'General experimental testing',
];

export const COMPONENT_CATEGORIES = [
  'Microcontroller',
  'Sensor',
  'Battery',
  'Power system',
  'Communication',
  'Data acquisition',
  'Structural',
  'Mechanical',
  'Recovery',
  'Propulsion',
  'Other',
];

export const SENSOR_TYPES = [
  'Accelerometer',
  'Gyroscope',
  'IMU',
  'Barometer',
  'Thermometer',
  'Magnetometer',
  'GPS',
  'Voltage sensor',
  'Current sensor',
  'Load cell',
  'Strain gauge',
  'Radio receiver',
  'Other',
];

export const CONFIG_KINDS = ['Electronics configuration', 'Sensor configuration', 'Firmware', 'Software build', 'Data acquisition', 'Hardware revision', 'Other'];

export const DOCUMENT_KINDS = ['Datasheet', 'Test procedure', 'Measurement record', 'Project note', 'Report', 'Image', 'Data file', 'Other'];

export const GRAPH_TYPES = [
  { key: 'line', label: 'Line' },
  { key: 'timeseries', label: 'Time series' },
  { key: 'scatter', label: 'Scatter' },
  { key: 'area', label: 'Area' },
  { key: 'bar', label: 'Bar' },
  { key: 'histogram', label: 'Histogram' },
  { key: 'distribution', label: 'Frequency distribution' },
  { key: 'xy', label: 'XY plot' },
  { key: 'difference', label: 'Difference' },
  { key: 'percentdiff', label: 'Percentage difference' },
  { key: 'box', label: 'Box plot' },
];

export const ENTITY_LABELS: Record<string, string> = {
  project: 'Project',
  rocket: 'Rocket',
  revision: 'Revision',
  stage: 'Development stage',
  campaign: 'Campaign',
  test: 'Ground test',
  flight: 'Flight',
  experiment: 'Experiment',
  run: 'Experiment run',
  dataset: 'Dataset',
  channel: 'Measurement channel',
  component: 'Component',
  electronics_config: 'Electronics configuration',
  sensor: 'Sensor',
  calibration: 'Calibration',
  config_snapshot: 'Configuration snapshot',
  document: 'Document',
  issue: 'Issue',
  note: 'Engineering note',
  graph: 'Graph',
  workspace: 'Analysis workspace',
  comparison: 'Comparison',
  report: 'Report',
  event: 'Event marker',
  entry_template: 'Entry template',
  inventory_item: 'Inventory item',
  finance_entry: 'Finance entry',
  keyframe_set: 'Rocket video analysis',
};

export const NAV_ITEMS: { key: string; label: string; group: string; icon: string }[] = [
  { key: 'dashboard', label: 'Dashboard', group: 'Overview', icon: 'grid' },
  { key: 'projects', label: 'Projects', group: 'Overview', icon: 'folder' },
  { key: 'development', label: 'Rocket Development', group: 'Development', icon: 'rocket' },
  { key: 'components', label: 'Components & Electronics', group: 'Development', icon: 'chip' },
  { key: 'sensors', label: 'Sensors', group: 'Development', icon: 'sensor' },
  { key: 'revisions', label: 'Revision History', group: 'Development', icon: 'branch' },
  { key: 'inventory', label: 'Inventory', group: 'Operations', icon: 'box' },
  { key: 'finance', label: 'Finance', group: 'Operations', icon: 'wallet' },
  { key: 'ground', label: 'Ground Testing', group: 'Testing', icon: 'beaker' },
  { key: 'flights', label: 'Flight Testing', group: 'Testing', icon: 'flight' },
  { key: 'experiments', label: 'Experimental Testing', group: 'Testing', icon: 'flask' },
  { key: 'datalog', label: 'Data Log', group: 'Data', icon: 'log' },
  { key: 'analysis', label: 'Data Analysis', group: 'Data', icon: 'chart' },
  { key: 'compare', label: 'Dataset Comparison', group: 'Data', icon: 'compare' },
  { key: 'keyframes', label: 'Rocket Video Analyser', group: 'Data', icon: 'video' },
  { key: 'documents', label: 'Engineering Documentation', group: 'Records', icon: 'doc' },
  { key: 'issues', label: 'Issues & Observations', group: 'Records', icon: 'alert' },
  { key: 'reports', label: 'Reports', group: 'Records', icon: 'report' },
  { key: 'templates', label: 'Entry Templates', group: 'System', icon: 'log' },
  { key: 'settings', label: 'Settings', group: 'System', icon: 'gear' },
];

export const TIME_UNITS = [
  { key: 's', label: 'seconds (s)' },
  { key: 'ms', label: 'milliseconds (ms)' },
  { key: 'us', label: 'microseconds (us)' },
  { key: 'min', label: 'minutes (min)' },
  { key: 'iso', label: 'absolute timestamp (ISO/date)' },
  { key: 'index', label: 'row index (no time column)' },
];
