/**
 * Unit system for the engineering platform.
 *
 * Every measurement is stored with an explicit unit. Values are converted to a
 * canonical base unit of its dimension only for derived calculations; the
 * recorded value and its original unit are always preserved.
 *
 * Conversion model: base = (value + offset) * factor
 */

export type Dimension =
  | 'length'
  | 'time'
  | 'velocity'
  | 'acceleration'
  | 'mass'
  | 'force'
  | 'pressure'
  | 'temperature'
  | 'voltage'
  | 'current'
  | 'angle'
  | 'angular_velocity'
  | 'frequency'
  | 'percent'
  | 'power'
  | 'energy'
  | 'signal'
  | 'data'
  | 'count'
  | 'dimensionless';

export interface UnitDef {
  symbol: string;
  dimension: Dimension;
  /** Multiplier to the dimension's base unit. */
  factor: number;
  /** Added to the value before the multiplier (used by temperature scales). */
  offset?: number;
  label: string;
}

const U = (symbol: string, dimension: Dimension, factor: number, label: string, offset = 0): UnitDef => ({
  symbol,
  dimension,
  factor,
  offset,
  label,
});

export const UNITS: Record<string, UnitDef> = {
  // length (base: m)
  m: U('m', 'length', 1, 'metre'),
  cm: U('cm', 'length', 0.01, 'centimetre'),
  mm: U('mm', 'length', 0.001, 'millimetre'),
  km: U('km', 'length', 1000, 'kilometre'),
  in: U('in', 'length', 0.0254, 'inch'),
  ft: U('ft', 'length', 0.3048, 'foot'),
  yd: U('yd', 'length', 0.9144, 'yard'),
  mi: U('mi', 'length', 1609.344, 'statute mile'),
  nmi: U('nmi', 'length', 1852, 'nautical mile'),

  // time (base: s)
  s: U('s', 'time', 1, 'second'),
  ms: U('ms', 'time', 0.001, 'millisecond'),
  us: U('us', 'time', 1e-6, 'microsecond'),
  ns: U('ns', 'time', 1e-9, 'nanosecond'),
  min: U('min', 'time', 60, 'minute'),
  h: U('h', 'time', 3600, 'hour'),

  // velocity (base: m/s)
  'm/s': U('m/s', 'velocity', 1, 'metre per second'),
  'km/h': U('km/h', 'velocity', 1 / 3.6, 'kilometre per hour'),
  mph: U('mph', 'velocity', 0.44704, 'mile per hour'),
  'ft/s': U('ft/s', 'velocity', 0.3048, 'foot per second'),
  kn: U('kn', 'velocity', 0.514444444, 'knot'),

  // acceleration (base: m/s^2)
  'm/s2': U('m/s2', 'acceleration', 1, 'metre per second squared'),
  'm/s^2': U('m/s^2', 'acceleration', 1, 'metre per second squared'),
  g: U('g', 'acceleration', 9.80665, 'standard gravity'),
  'ft/s2': U('ft/s2', 'acceleration', 0.3048, 'foot per second squared'),

  // mass (base: kg)
  kg: U('kg', 'mass', 1, 'kilogram'),
  g_mass: U('g_mass', 'mass', 0.001, 'gram'),
  lb: U('lb', 'mass', 0.45359237, 'pound'),
  oz: U('oz', 'mass', 0.028349523125, 'ounce'),

  // force (base: N)
  N: U('N', 'force', 1, 'newton'),
  kN: U('kN', 'force', 1000, 'kilonewton'),
  lbf: U('lbf', 'force', 4.4482216153, 'pound-force'),
  kgf: U('kgf', 'force', 9.80665, 'kilogram-force'),

  // pressure (base: Pa)
  Pa: U('Pa', 'pressure', 1, 'pascal'),
  hPa: U('hPa', 'pressure', 100, 'hectopascal'),
  kPa: U('kPa', 'pressure', 1000, 'kilopascal'),
  MPa: U('MPa', 'pressure', 1e6, 'megapascal'),
  bar: U('bar', 'pressure', 1e5, 'bar'),
  mbar: U('mbar', 'pressure', 100, 'millibar'),
  psi: U('psi', 'pressure', 6894.757293168, 'pound per square inch'),
  atm: U('atm', 'pressure', 101325, 'atmosphere'),
  torr: U('torr', 'pressure', 133.322368421, 'torr'),

  // temperature (base: K)
  C: U('C', 'temperature', 1, 'degree Celsius', 273.15),
  F: U('F', 'temperature', 5 / 9, 'degree Fahrenheit', 459.67),
  K: U('K', 'temperature', 1, 'kelvin'),

  // voltage (base: V)
  V: U('V', 'voltage', 1, 'volt'),
  mV: U('mV', 'voltage', 0.001, 'millivolt'),
  kV: U('kV', 'voltage', 1000, 'kilovolt'),

  // current (base: A)
  A: U('A', 'current', 1, 'ampere'),
  mA: U('mA', 'current', 0.001, 'milliampere'),
  uA: U('uA', 'current', 1e-6, 'microampere'),

  // angle (base: rad)
  rad: U('rad', 'angle', 1, 'radian'),
  deg: U('deg', 'angle', Math.PI / 180, 'degree'),
  rev: U('rev', 'angle', Math.PI * 2, 'revolution'),

  // angular velocity (base: rad/s)
  'rad/s': U('rad/s', 'angular_velocity', 1, 'radian per second'),
  'deg/s': U('deg/s', 'angular_velocity', Math.PI / 180, 'degree per second'),
  rpm: U('rpm', 'angular_velocity', (Math.PI * 2) / 60, 'revolution per minute'),

  // frequency (base: Hz)
  Hz: U('Hz', 'frequency', 1, 'hertz'),
  kHz: U('kHz', 'frequency', 1000, 'kilohertz'),
  MHz: U('MHz', 'frequency', 1e6, 'megahertz'),

  '%': U('%', 'percent', 1, 'percent'),
  'ppm': U('ppm', 'percent', 1e-4, 'parts per million'),

  W: U('W', 'power', 1, 'watt'),
  kW: U('kW', 'power', 1000, 'kilowatt'),
  J: U('J', 'energy', 1, 'joule'),
  Wh: U('Wh', 'energy', 3600, 'watt-hour'),
  mAh: U('mAh', 'energy', 3.6, 'milliampere-hour (at 1 V equivalent)'),

  dBm: U('dBm', 'signal', 1, 'decibel-milliwatt'),
  dB: U('dB', 'signal', 1, 'decibel'),

  B: U('B', 'data', 1, 'byte'),
  kB: U('kB', 'data', 1000, 'kilobyte'),
  MB: U('MB', 'data', 1e6, 'megabyte'),
  GB: U('GB', 'data', 1e9, 'gigabyte'),

  count: U('count', 'count', 1, 'count'),
  '': U('', 'dimensionless', 1, 'dimensionless'),
  '1': U('1', 'dimensionless', 1, 'dimensionless'),
};

export function unitDef(symbol: string | null | undefined): UnitDef | undefined {
  if (!symbol) return undefined;
  return UNITS[symbol] ?? UNITS[symbol.trim()];
}

export function dimensionOf(symbol: string | null | undefined): Dimension | null {
  return unitDef(symbol)?.dimension ?? null;
}

export function unitsForDimension(dimension: Dimension | null): UnitDef[] {
  if (!dimension) return [];
  return Object.values(UNITS).filter((u) => u.dimension === dimension);
}

export function compatUnitInfo(from: string, to: string): { compatible: boolean; reason: string } {
  const a = unitDef(from);
  const b = unitDef(to);
  if (!a || !b) return { compatible: from === to, reason: 'Unknown unit' };
  if (a.dimension !== b.dimension) return { compatible: false, reason: `${from} (${a.dimension}) is not compatible with ${to} (${b.dimension})` };
  return { compatible: true, reason: 'Same physical dimension' };
}

export function compatibleUnits(from: string, to: string): boolean {
  const a = unitDef(from);
  const b = unitDef(to);
  if (!a || !b) return false;
  return a.dimension === b.dimension;
}

/** Convert a value between units. Returns null when the units are incompatible. */
export function convertUnit(value: number, from: string, to: string): number | null {
  if (!Number.isFinite(value)) return null;
  if (from === to) return value;
  const a = unitDef(from);
  const b = unitDef(to);
  if (!a || !b || a.dimension !== b.dimension) return null;
  const base = (value + (a.offset ?? 0)) * a.factor;
  return base / b.factor - (b.offset ?? 0);
}

/** Convert an array in place-free fashion; incompatible values become NaN. */
export function convertSeries(values: ArrayLike<number>, from: string, to: string): Float64Array {
  const out = new Float64Array(values.length);
  const a = unitDef(from);
  const b = unitDef(to);
  if (!a || !b || a.dimension !== b.dimension) {
    out.fill(NaN);
    return out;
  }
  const scale = a.factor / b.factor;
  const shift = ((a.offset ?? 0) * a.factor - (b.offset ?? 0) * b.factor) / b.factor;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out[i] = Number.isFinite(v) ? v * scale + shift : NaN;
  }
  return out;
}

export interface QuantityType {
  key: string;
  label: string;
  dimension: Dimension | null;
  defaultUnit: string;
  vector?: boolean;
}

/** Canonical measurement types offered by the import and channel editors. */
export const QUANTITY_TYPES: QuantityType[] = [
  { key: 'altitude', label: 'Altitude', dimension: 'length', defaultUnit: 'm' },
  { key: 'acceleration', label: 'Acceleration', dimension: 'acceleration', defaultUnit: 'm/s2', vector: true },
  { key: 'velocity', label: 'Velocity', dimension: 'velocity', defaultUnit: 'm/s', vector: true },
  { key: 'angular_velocity', label: 'Angular velocity', dimension: 'angular_velocity', defaultUnit: 'deg/s', vector: true },
  { key: 'orientation', label: 'Orientation', dimension: 'angle', defaultUnit: 'deg', vector: true },
  { key: 'temperature', label: 'Temperature', dimension: 'temperature', defaultUnit: 'C' },
  { key: 'pressure', label: 'Pressure', dimension: 'pressure', defaultUnit: 'Pa' },
  { key: 'voltage', label: 'Voltage', dimension: 'voltage', defaultUnit: 'V' },
  { key: 'current', label: 'Current', dimension: 'current', defaultUnit: 'A' },
  { key: 'gps_lat', label: 'GPS latitude', dimension: 'angle', defaultUnit: 'deg' },
  { key: 'gps_lon', label: 'GPS longitude', dimension: 'angle', defaultUnit: 'deg' },
  { key: 'gps_alt', label: 'GPS altitude', dimension: 'length', defaultUnit: 'm' },
  { key: 'signal_strength', label: 'Signal strength', dimension: 'signal', defaultUnit: 'dBm' },
  { key: 'force', label: 'Force', dimension: 'force', defaultUnit: 'N' },
  { key: 'mass', label: 'Mass', dimension: 'mass', defaultUnit: 'kg' },
  { key: 'frequency', label: 'Frequency', dimension: 'frequency', defaultUnit: 'Hz' },
  { key: 'power', label: 'Power', dimension: 'power', defaultUnit: 'W' },
  { key: 'energy', label: 'Energy / capacity', dimension: 'energy', defaultUnit: 'Wh' },
  { key: 'humidity', label: 'Humidity', dimension: 'percent', defaultUnit: '%' },
  { key: 'count', label: 'Count / state', dimension: 'count', defaultUnit: 'count' },
  { key: 'custom', label: 'Custom measurement', dimension: null, defaultUnit: '' },
];

export function quantityType(key: string | null | undefined): QuantityType | undefined {
  if (!key) return undefined;
  return QUANTITY_TYPES.find((q) => q.key === key);
}

/** Guess a measurement type from a column header. */
export function guessQuantityFromName(rawName: string): { type: string; unit: string; axis?: string } {
  const n = rawName.toLowerCase();
  const axis = /\b(x|y|z)\b|_(x|y|z)$|\[(x|y|z)\]/.exec(n)?.[1]?.toUpperCase();
  const pick = (type: string): { type: string; unit: string; axis?: string } => {
    const q = quantityType(type)!;
    return { type, unit: q.defaultUnit, axis };
  };
  if (/latitude|^lat\b|gps.?lat/.test(n)) return { type: 'gps_lat', unit: 'deg' };
  if (/longitude|^lon\b|^lng\b|gps.?lon/.test(n)) return { type: 'gps_lon', unit: 'deg' };
  if (/altitude|^alt\b|height|agl|msl/.test(n)) return pick('altitude');
  if (/accel|ax\b|ay\b|az\b|imu.?a/.test(n)) return pick('acceleration');
  if (/gyro|angular/.test(n)) return pick('angular_velocity');
  if (/velocity|speed|vel\b/.test(n)) return pick('velocity');
  if (/pitch|roll|yaw|orient|attitude|heading/.test(n)) return pick('orientation');
  if (/temp/.test(n)) return pick('temperature');
  if (/press|baro/.test(n)) return pick('pressure');
  if (/volt|vbat|vcc|batt.?v/.test(n)) return pick('voltage');
  if (/curr|amp|current/.test(n)) return pick('current');
  if (/rssi|dbm|signal|snr/.test(n)) return pick('signal_strength');
  if (/thrust|force|load/.test(n)) return pick('force');
  if (/mass|weight/.test(n)) return pick('mass');
  if (/freq/.test(n)) return pick('frequency');
  if (/power|watt/.test(n)) return pick('power');
  if (/energy|mah|capacity/.test(n)) return pick('energy');
  if (/humid/.test(n)) return pick('humidity');
  if (/time|timestamp|t\b|elapsed|ms\b|sec/.test(n)) return { type: 'custom', unit: 's' };
  return { type: 'custom', unit: '' };
}

/** Suggest a display unit alternative one order of magnitude closer to the data. */
export function suggestReadableUnit(unit: string, magnitude: number): string {
  const def = unitDef(unit);
  if (!def || !Number.isFinite(magnitude) || magnitude === 0) return unit;
  const finite = Math.abs(magnitude);
  const options = unitsForDimension(def.dimension).filter((u) => u.offset === 0 && u.factor > 0);
  let best = unit;
  let bestScore = Infinity;
  for (const u of options) {
    const converted = (finite * def.factor) / u.factor;
    if (converted >= 0.5 && converted < 50000) {
      const score = Math.abs(Math.log10(converted));
      if (score < bestScore) {
        bestScore = score;
        best = u.symbol;
      }
    }
  }
  return best;
}

export function formatNumber(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e7)) return value.toExponential(2);
  const d = abs >= 1000 ? Math.min(digits, 1) : abs >= 100 ? Math.min(digits, 2) : digits;
  return value.toFixed(d);
}
