import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, getDb } from './db';
import { createRecord, logActivity, nowIso } from './repo';
import { commitImport } from './datasets';
import { ensureStorage, examplesRoot, workspaceMode } from './paths';

/**
 * The example programme is a completely separate workspace: its own SQLite database,
 * its own dataset/document folders and its own reports. It is created from a bundled
 * seed on first use and can be reset or deleted without touching user records.
 *
 * The seed is generated through the same import pipeline as user data, so the example
 * datasets carry real checksums, quality reports and provenance.
 */

const SEED_MARKER = 'seed.json';
const SEED_VERSION = 1;

export const EXAMPLE_PROJECT_NAME = 'Kestrel-1 — example programme';

function markerPath(): string {
  return path.join(examplesRoot(), SEED_MARKER);
}

export function examplesExist(): boolean {
  return fs.existsSync(markerPath());
}

export function examplesStatus(): { mode: string; exists: boolean; seedVersion: number | null; dir: string } {
  let seedVersion: number | null = null;
  try {
    seedVersion = Number(JSON.parse(fs.readFileSync(markerPath(), 'utf8'))?.version ?? 0) || null;
  } catch {
    seedVersion = null;
  }
  return { mode: workspaceMode(), exists: fs.existsSync(markerPath()), seedVersion, dir: examplesRoot() };
}

/** Creates the example workspace when the application is running in examples mode. */
export async function ensureExamplesWorkspace(): Promise<void> {
  if (workspaceMode() !== 'examples') return;
  const db = getDb();
  const existing = Number(db.get<any>('SELECT COUNT(*) AS c FROM projects')?.c ?? 0);
  if (fs.existsSync(markerPath()) && existing > 0) return;

  // A partial seed (for example an interrupted first run) is discarded and rebuilt.
  closeDatabase();
  fs.rmSync(examplesRoot(), { recursive: true, force: true });
  ensureStorage();
  const fresh = getDb();
  if (Number(fresh.get<any>('SELECT COUNT(*) AS c FROM projects')?.c ?? 0) > 0) return;

  await seedExampleProgramme();
  fs.mkdirSync(examplesRoot(), { recursive: true });
  fs.writeFileSync(markerPath(), JSON.stringify({ version: SEED_VERSION, seededAt: nowIso() }, null, 2));
  console.log('Example workspace seeded');
}

/** Deletes the example workspace. The caller relaunches when examples were active. */
export function deleteExamplesWorkspace(): void {
  if (workspaceMode() === 'examples') closeDatabase();
  fs.rmSync(examplesRoot(), { recursive: true, force: true });
}

async function seedExampleProgramme(): Promise<void> {
  const project = createRecord('project', {
    name: EXAMPLE_PROJECT_NAME,
    code: 'EX-K1',
    description:
      'Bundled example data for Rocket Lab. This programme, its tests, flights and recordings are fictional and exist only to demonstrate the workflow. They live in a separate workspace from your own projects.',
    objectives:
      'Demonstrate revision tracking, ground and flight testing, imported recordings, comparison and reporting using realistic but entirely synthetic measurements.',
    status: 'Active',
    stage: 'Flight testing',
    tags: 'example, demonstration',
  });

  const rocket = createRecord('rocket', {
    project_id: project.id,
    name: 'Kestrel-1',
    identifier: 'KST-1',
    description: 'Single-stage experimental sounding rocket used for the example programme.',
    status: 'In development',
  });

  const revA = createRecord('revision', {
    project_id: project.id,
    rocket_id: rocket.id,
    label: 'Rev A',
    status: 'Flown',
    description: 'Baseline airframe with the original fin set and 4-cell power system.',
    design_changes: 'Baseline configuration.',
    component_changes: 'Initial flight computer, barometer and 6-axis IMU.',
    config_changes: 'Firmware 1.0, 100 Hz logging.',
    observations: 'Roll oscillation observed during ascent.',
    conclusions: 'Fin stiffness and power margin need review.',
  });

  const revB = createRecord('revision', {
    project_id: project.id,
    rocket_id: rocket.id,
    label: 'Rev B',
    status: 'In testing',
    description: 'Stiffer fins, revised battery pack and updated telemetry schedule.',
    design_changes: 'Fin thickness increased; nose ballast moved forward.',
    component_changes: 'Battery pack changed to 6-cell; added redundant barometer.',
    config_changes: 'Firmware 1.2, 200 Hz logging, additional accelerometer axis.',
    observations: 'Bench checks nominal.',
    conclusions: 'Ready for the next flight campaign.',
  });

  const stages = [
    ['Initial concept', 'Complete', 'Mission need and envelope study.'],
    ['Preliminary development', 'Complete', 'Sizing, mass budget and recovery concept.'],
    ['Design', 'Complete', 'Airframe and fin layout frozen for Rev A.'],
    ['Ground verification', 'Complete', 'Static fire and avionics checks.'],
    ['Flight testing', 'In progress', 'Rev B flight campaign.'],
    ['Post-flight analysis', 'Not started', 'Compare Rev A and Rev B recordings.'],
  ] as const;
  stages.forEach(([name, status, description], index) =>
    createRecord('stage', {
      project_id: project.id,
      rocket_id: rocket.id,
      revision_id: revB.id,
      name,
      status,
      description,
      sort_order: index,
      started_at: status === 'Not started' ? '' : `2026-0${Math.min(9, index + 1)}-05`,
      completed_at: status === 'Complete' ? `2026-0${Math.min(9, index + 2)}-20` : '',
    }),
  );

  const campaign = createRecord('campaign', {
    project_id: project.id,
    name: 'Rev B verification campaign',
    kind: 'Mixed',
    status: 'Active',
    objectives: 'Validate the Rev B fin and power changes before the next flight.',
    description: 'Combined bench, static fire and flight verification.',
    started_at: '2026-08-01',
  });

  const flightComputer = createRecord('component', {
    project_id: project.id,
    name: 'Flight computer',
    manufacturer: 'Example Avionics',
    model: 'FC-2',
    category: 'Microcontroller',
    serial: 'EX-FC-0007',
    specs: 'Dual-core MCU, 16 MB flash, 200 Hz logging capability.',
    configuration: 'Firmware 1.2 with redundant barometer enabled.',
    firmware: '1.2',
    notes: 'Example inventory record.',
  });
  const imu = createRecord('component', {
    project_id: project.id,
    name: '6-axis IMU',
    manufacturer: 'Example Sensors',
    model: 'IMU-6',
    category: 'Sensor',
    serial: 'EX-IMU-0021',
    specs: '±16 g, ±2000 °/s, SPI interface.',
    notes: 'Example inventory record.',
  });
  const battery = createRecord('component', {
    project_id: project.id,
    name: 'Flight battery pack',
    manufacturer: 'Example Power',
    model: 'BP-6S',
    category: 'Battery',
    serial: 'EX-BAT-0003',
    specs: '6-cell Li-ion pack, 2200 mAh, 30 A continuous.',
    notes: 'Rev B power configuration.',
  });

  const electronics = createRecord('electronics_config', {
    project_id: project.id,
    revision_id: revB.id,
    name: 'Rev B avionics stack',
    description: 'Flight computer, redundant barometer, IMU and telemetry transmitter.',
  });
  for (const [component, role] of [
    [flightComputer, 'Flight computer'],
    [imu, 'Inertial measurement'],
    [battery, 'Power'],
  ] as const) {
    createRecord('config_item', { config_id: electronics.id, component_id: component.id, role });
  }

  const baro = createRecord('sensor', {
    project_id: project.id,
    name: 'Barometric sensor',
    manufacturer: 'Example Sensors',
    model: 'BAR-2',
    type: 'Pressure',
    serial: 'EX-BAR-0042',
    range_min: 100,
    range_max: 1100,
    range_unit: 'hPa',
    resolution: 0.02,
    units: 'hPa',
    sampling: '100 Hz',
    notes: 'Primary altitude source; example record.',
  });
  const accel = createRecord('sensor', {
    project_id: project.id,
    name: 'Axial accelerometer',
    manufacturer: 'Example Sensors',
    model: 'ACC-16',
    type: 'Acceleration',
    serial: 'EX-ACC-0011',
    range_min: -16,
    range_max: 16,
    range_unit: 'g',
    resolution: 0.004,
    units: 'g',
    sampling: '200 Hz',
    notes: 'Example record.',
  });
  createRecord('calibration', {
    project_id: project.id,
    sensor_id: accel.id,
    performed_at: '2026-07-14',
    method: 'Two-point static calibration on a level table (example data).',
    reference_equipment: 'Reference inclinometer (example)',
    values_json: [{ reference: -1, measured: -0.98 }, { reference: 0, measured: 0.01 }, { reference: 1, measured: 1.02 }],
    coefficients: '0.0048 g/LSB, offset 0.01 g',
    range_min: -16,
    range_max: 16,
    uncertainty: '±0.02 g',
    notes: 'Calibration is example data; it has not been applied to historical recordings.',
  });
  createRecord('sensor_installation', {
    project_id: project.id,
    sensor_id: baro.id,
    entity_type: 'test',
    location: 'Avionics bay, static port',
    installed_at: '2026-08-02',
    notes: 'Example installation record.',
  });

  /* ---------------- entry templates ---------------- */

  const staticTemplate = createRecord('entry_template', {
    project_id: project.id,
    name: 'Static fire — instrumentation sheet',
    description: 'Fields captured for every static fire of this programme.',
    applies_to: 'test',
    category: 'Power system characterization',
    fields_json: [
      { key: 'motor', label: 'Motor designation', type: 'text', required: true, default: 'EX-38-120' },
      { key: 'propellant_mass', label: 'Propellant mass', type: 'measurement', unit: 'g', required: true },
      { key: 'burn_duration', label: 'Burn duration', type: 'measurement', unit: 's', required: true },
      { key: 'peak_thrust', label: 'Peak thrust', type: 'measurement', unit: 'N' },
      { key: 'load_cell', label: 'Load cell ID', type: 'text', hint: 'Reference the calibrated load cell used for the run.' },
      { key: 'ignition', label: 'Ignition method', type: 'select', options: ['Pyrogen', 'Electronic', 'Other'] },
      { key: 'inspection', label: 'Post-fire hardware inspection', type: 'textarea' },
    ],
  });

  const flightTemplate = createRecord('entry_template', {
    project_id: project.id,
    name: 'Flight telemetry review',
    description: 'Standard post-flight fields recorded for each flight.',
    applies_to: 'flight',
    fields_json: [
      { key: 'launch_angle', label: 'Launch angle', type: 'measurement', unit: 'deg' },
      { key: 'apogee_baro', label: 'Apogee (barometric)', type: 'measurement', unit: 'm', required: true },
      { key: 'apogee_integrated', label: 'Apogee (integrated acceleration)', type: 'measurement', unit: 'm' },
      { key: 'deployment', label: 'Recovery deployment confirmed', type: 'checkbox', default: true },
      { key: 'firmware', label: 'Firmware build', type: 'text' },
      { key: 'recovery_notes', label: 'Recovery notes', type: 'textarea' },
    ],
  });

  createRecord('entry_template', {
    project_id: project.id,
    name: 'Run sheet — battery discharge',
    description: 'Per-run fields for battery characterisation experiments.',
    applies_to: 'run',
    category: 'Battery',
    fields_json: [
      { key: 'load_current', label: 'Load current', type: 'measurement', unit: 'A', required: true },
      { key: 'cutoff_voltage', label: 'Cut-off voltage', type: 'measurement', unit: 'V', required: true },
      { key: 'capacity', label: 'Capacity delivered', type: 'measurement', unit: 'mAh' },
      { key: 'cell_temp', label: 'Cell temperature', type: 'measurement', unit: '°C' },
      { key: 'notes', label: 'Observations', type: 'textarea' },
    ],
  });

  /* ---------------- testing records ---------------- */

  const staticTest = createRecord('test', {
    project_id: project.id,
    rocket_id: rocket.id,
    revision_id: revA.id,
    campaign_id: campaign.id,
    name: 'Static fire 1 — baseline',
    test_no: 'EX-GT-001',
    kind: 'ground',
    category: 'Power system characterization',
    performed_at: '2026-08-04T10:20:00.000Z',
    objectives: 'Measure thrust and chamber pressure of the baseline motor configuration.',
    description: 'Horizontal test stand, 50 Hz logging, load cell and pressure transducer fitted.',
    equipment: 'Example test stand (EX-TS-01), load cell, pressure transducer, DAQ.',
    sensor_config: 'Load cell 0–500 N; pressure 0–50 bar; battery voltage divider.',
    env_conditions: '18 °C, 62 % RH, light wind.',
    expected: 'Peak thrust about 310 N, burn about 2.8 s.',
    actual: 'Peak thrust 302 N, burn 2.9 s. Within the expected band.',
    observations: 'Slight pressure oscillation in the first 0.3 s; no hardware damage.',
    conclusions: 'Motor and instrumentation behaved nominally. Configuration accepted for flight preparation.',
    status: 'Completed',
    template_id: staticTemplate.id,
    custom_json: {
      motor: 'EX-38-120',
      propellant_mass: 118.4,
      burn_duration: 2.9,
      peak_thrust: 302.1,
      load_cell: 'EX-LC-02 (calibrated 2026-06-30)',
      ignition: 'Electronic',
      inspection: 'No erosion beyond the expected nozzle wear; case and closures reusable.',
    },
  });

  const flight = createRecord('flight', {
    project_id: project.id,
    rocket_id: rocket.id,
    revision_id: revA.id,
    name: 'Flight 1 — Rev A baseline',
    flight_no: 'EX-FL-001',
    performed_at: '2026-08-09T08:45:00.000Z',
    objectives: 'Verify ascent stability, apogee prediction and recovery deployment.',
    description: 'First flight of the baseline configuration on a calm morning.',
    env_conditions: '16 °C, 55 % RH, wind 3 m/s from the west.',
    weather: 'Clear sky, good visibility.',
    electronics_config_id: electronics.id,
    hardware_config: 'Rev A airframe, baseline fins, 4-cell pack.',
    firmware_versions: '1.0',
    sensor_config: 'Barometer 100 Hz; IMU 100 Hz; battery voltage.',
    daq_config: '100 Hz logging, elapsed-time timestamps.',
    observations: 'Stable ascent; roll oscillation near burnout; apogee close to prediction.',
    post_inspection: 'Recovery harness scorched but intact; fins undamaged.',
    conclusions: 'Baseline flight successful; roll oscillation motivates the Rev B fin change.',
    status: 'Completed',
    template_id: flightTemplate.id,
    custom_json: {
      launch_angle: 3,
      apogee_baro: 842,
      apogee_integrated: 861,
      deployment: true,
      firmware: '1.0 (build 2026-07-28)',
      recovery_notes: 'Main deployed at 300 m; descent rate 5.1 m/s; landed 240 m from the pad.',
    },
  });

  const experiment = createRecord('experiment', {
    project_id: project.id,
    revision_id: revB.id,
    name: 'Battery pack discharge characterisation',
    status: 'Complete',
    objective: 'Compare usable capacity of the 4-cell and 6-cell packs at the flight load.',
    independent_vars: 'Pack configuration (4-cell vs 6-cell), load current.',
    measured_vars: 'Terminal voltage, delivered capacity, cell temperature.',
    controlled_conditions: 'Ambient 20 °C, constant-current load, same harness.',
    description: 'Two discharge runs at the flight-representative current.',
    setup: 'Programmable load, calibrated shunt, thermocouple on the centre cell.',
    conclusions: 'The 6-cell pack delivers more usable capacity and holds voltage better under load.',
  });

  const runSheet = createRecord('entry_template', {
    project_id: project.id,
    name: 'Run sheet — discharge (compact)',
    description: 'Minimal per-run sheet used for the example experiment.',
    applies_to: 'run',
    fields_json: [
      { key: 'pack', label: 'Pack configuration', type: 'select', options: ['4-cell', '6-cell'], required: true },
      { key: 'load_current', label: 'Load current', type: 'measurement', unit: 'A', required: true },
      { key: 'capacity', label: 'Delivered capacity', type: 'measurement', unit: 'mAh' },
      { key: 'cell_temp', label: 'Peak cell temperature', type: 'measurement', unit: '°C' },
    ],
  });

  createRecord('run', {
    project_id: project.id,
    experiment_id: experiment.id,
    label: 'Run 1 — 4-cell pack',
    performed_at: '2026-08-12T09:00:00.000Z',
    status: 'Completed',
    configuration: '4-cell pack, 12 A constant current.',
    observations: 'Voltage sag under load; cut-off reached early.',
    results: 'Delivered 1480 mAh before cut-off.',
    template_id: runSheet.id,
    custom_json: { pack: '4-cell', load_current: 12, capacity: 1480, cell_temp: 41.5 },
  });
  createRecord('run', {
    project_id: project.id,
    experiment_id: experiment.id,
    label: 'Run 2 — 6-cell pack',
    performed_at: '2026-08-12T13:30:00.000Z',
    status: 'Completed',
    configuration: '6-cell pack, 12 A constant current.',
    observations: 'Stable voltage; lower temperature rise.',
    results: 'Delivered 2015 mAh before cut-off.',
    template_id: runSheet.id,
    custom_json: { pack: '6-cell', load_current: 12, capacity: 2015, cell_temp: 36.2 },
  });

  createRecord('issue', {
    project_id: project.id,
    revision_id: revA.id,
    test_id: staticTest.id,
    title: 'Pressure oscillation at ignition',
    description: 'A short pressure oscillation is visible in the first 0.3 s of the static fire recording.',
    category: 'Observation',
    severity: 'Low',
    status: 'Resolved',
    identified_at: '2026-08-04T12:00:00.000Z',
    investigation: 'Compared with bench sensor checks; traced to the transducer line length, not the motor.',
    proposed_resolution: 'Shorten the transducer line and add damping.',
    resolution: 'Line shortened before the next run; oscillation no longer present.',
    verification: 'Verified during the following bench test.',
    tags: 'example, instrumentation',
  });
  createRecord('issue', {
    project_id: project.id,
    revision_id: revA.id,
    flight_id: flight.id,
    title: 'Roll oscillation after burnout',
    description: 'Roll rate grows after burnout in the Rev A flight recording.',
    category: 'Anomaly',
    severity: 'Medium',
    status: 'Open',
    identified_at: '2026-08-09T10:30:00.000Z',
    investigation: 'Fin stiffness is the leading hypothesis; Rev B fins are stiffer. Not yet demonstrated by test.',
    proposed_resolution: 'Fly Rev B and compare roll rate; inspect fin attachment after recovery.',
    tags: 'example, roll, rev-b',
  });
  createRecord('note', {
    project_id: project.id,
    entity_type: 'revision',
    entity_id: revB.id,
    title: 'Rev B change rationale',
    body:
      'Fin thickness was increased after the Rev A roll oscillation. The battery pack changed at the same time for power margin, so a measured difference between flights cannot be attributed to one change alone.',
    tags: 'example, reasoning',
  });

  /* ---------------- example recordings ---------------- */

  const seedDir = path.join(examplesRoot(), '_seed');
  fs.mkdirSync(seedDir, { recursive: true });
  const staticCsv = path.join(seedDir, 'static-fire-1.csv');
  const flightCsv = path.join(seedDir, 'flight-1.csv');
  writeCsv(staticCsv, 50, 4, (t) => {
    const burn = t < 2.9 ? 1 : 0;
    const ramp = Math.min(1, t / 0.35);
    return [
      burn ? 302 * ramp * (1 - 0.08 * Math.max(0, t - 2.4)) + 4 * Math.sin(t * 22) * burn : 0,
      burn ? 28 + 11 * ramp : 1.01,
      4.18 - 0.06 * t,
    ];
  }, ['thrust_n', 'chamber_pressure_bar', 'battery_voltage_v']);
  writeCsv(flightCsv, 100, 8, (t) => {
    const apogeeT = 4.2;
    const altitude = t < apogeeT ? 0.5 * 96 * t * t : Math.max(0, 842 - 0.5 * 9.81 * (t - apogeeT) ** 2 * 0.9);
    const velocity = t < apogeeT ? 96 * t : -9.81 * (t - apogeeT) * 0.9;
    const accel = t < apogeeT ? 9.8 : t < 6.5 ? -1 : 0;
    return [altitude, velocity, accel, 4.15 - 0.035 * t];
  }, ['altitude_m', 'velocity_ms', 'accel_z_g', 'battery_voltage_v']);

  const staticDataset = await commitImport({
    filePath: staticCsv,
    projectId: project.id,
    datasetName: 'Static fire 1 — thrust, pressure, voltage',
    format: 'csv',
    headerRow: 0,
    skipRows: 0,
    timeColumn: 0,
    timeUnit: 's',
    timeFormat: 'elapsed',
    channels: [
      { column: 1, name: 'Thrust', type: 'force', unit: 'N', enabled: true },
      { column: 2, name: 'Chamber pressure', type: 'pressure', unit: 'bar', enabled: true },
      { column: 3, name: 'Battery voltage', type: 'voltage', unit: 'V', enabled: true },
    ],
    samplingHz: 50,
    notes: 'Example recording generated for the bundled demonstration programme.',
    attach: { testId: staticTest.id, campaignId: campaign.id },
    recordedAt: '2026-08-04T10:20:00.000Z',
  });

  const flightDataset = await commitImport({
    filePath: flightCsv,
    projectId: project.id,
    datasetName: 'Flight 1 — ascent and recovery',
    format: 'csv',
    headerRow: 0,
    skipRows: 0,
    timeColumn: 0,
    timeUnit: 's',
    timeFormat: 'elapsed',
    channels: [
      { column: 1, name: 'Altitude', type: 'altitude', unit: 'm', enabled: true },
      { column: 2, name: 'Velocity', type: 'velocity', unit: 'm/s', enabled: true },
      { column: 3, name: 'Axial acceleration', type: 'acceleration', unit: 'g', enabled: true },
      { column: 4, name: 'Battery voltage', type: 'voltage', unit: 'V', enabled: true },
    ],
    samplingHz: 100,
    notes: 'Example recording generated for the bundled demonstration programme.',
    attach: { flightId: flight.id },
    recordedAt: '2026-08-09T08:45:00.000Z',
  });
  fs.rmSync(seedDir, { recursive: true, force: true });

  for (const [t, name, category, description] of [
    [0.35, 'Ignition', 'Propulsion', 'Thrust begins to rise.'],
    [2.9, 'Burnout', 'Propulsion', 'Thrust falls to zero.'],
    [4.2, 'Apogee', 'Flight', 'Barometric altitude reaches its maximum.'],
    [6.5, 'Recovery deployment', 'Recovery', 'Descent rate changes after deployment.'],
  ] as const) {
    createRecord('event', {
      dataset_id: flightDataset.id,
      project_id: project.id,
      name,
      category,
      t,
      description,
      tags: 'example',
      source: 'user',
      confirmed: 1,
    });
  }

  logActivity({
    project_id: project.id,
    entity_type: 'project',
    entity_id: project.id,
    kind: 'create',
    title: 'Example programme created',
    detail: `${EXAMPLE_PROJECT_NAME} with ${staticDataset.points + flightDataset.points} recorded rows in the example workspace`,
  });
}

function writeCsv(
  file: string,
  rate: number,
  duration: number,
  values: (t: number) => number[],
  channelNames: string[],
): void {
  const lines = [`time_s,${channelNames.join(',')}`];
  for (let i = 0; i < rate * duration; i++) {
    const t = i / rate;
    lines.push([t.toFixed(4), ...values(t).map((v) => v.toFixed(5))].join(','));
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}
