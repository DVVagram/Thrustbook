/** Shared definitions for reusable data-entry templates and their custom fields. */

export type EntryFieldType = 'text' | 'textarea' | 'number' | 'measurement' | 'select' | 'checkbox' | 'date' | 'datetime';

export interface TemplateField {
  key: string;
  label: string;
  type: EntryFieldType;
  unit?: string;
  required?: boolean;
  options?: string[];
  default?: any;
  help?: string;
  full?: boolean;
}

export const TEMPLATE_TARGETS: { value: string; label: string; entity: string }[] = [
  { value: 'test', label: 'Ground / experimental test', entity: 'test' },
  { value: 'flight', label: 'Flight', entity: 'flight' },
  { value: 'run', label: 'Experiment run', entity: 'run' },
];

export const ENTRY_FIELD_TYPES: { value: EntryFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'measurement', label: 'Measurement (value + unit)' },
  { value: 'select', label: 'Selection list' },
  { value: 'checkbox', label: 'Yes / no' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date and time' },
];

export const TEMPLATE_ENTITIES = ['test', 'flight', 'run'];

export function targetForEntity(entity: string): string | null {
  return TEMPLATE_TARGETS.find((t) => t.entity === entity)?.value ?? null;
}

export function targetLabel(target: string): string {
  return TEMPLATE_TARGETS.find((t) => t.value === target)?.label ?? target;
}

export function slugifyKey(label: string, taken: Set<string> = new Set()): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'field';
  let key = base;
  let i = 2;
  while (taken.has(key)) key = `${base}_${i++}`;
  return key;
}

/** Normalises user-edited template fields, dropping empty rows and duplicate keys. */
export function normalizeTemplateFields(input: any): TemplateField[] {
  const rows = Array.isArray(input) ? input : [];
  const taken = new Set<string>();
  const out: TemplateField[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const label = String(raw.label ?? '').trim();
    if (!label) continue;
    let key = String(raw.key ?? '').trim().replace(/[^a-zA-Z0-9_]/g, '_');
    if (!key) key = slugifyKey(label, taken);
    if (taken.has(key)) key = slugifyKey(key, taken);
    taken.add(key);
    const type: EntryFieldType = (ENTRY_FIELD_TYPES.find((t) => t.value === raw.type)?.value ?? 'text') as EntryFieldType;
    const options = Array.isArray(raw.options)
      ? raw.options.map((o: any) => String(o).trim()).filter(Boolean)
      : String(raw.options ?? '')
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean);
    out.push({
      key,
      label,
      type,
      unit: type === 'measurement' ? String(raw.unit ?? '').trim() : '',
      required: !!raw.required,
      options: type === 'select' ? options : [],
      default:
        raw.default === undefined || raw.default === null || raw.default === ''
          ? undefined
          : type === 'checkbox'
            ? !!raw.default && raw.default !== 'false'
            : type === 'number' || type === 'measurement'
              ? Number(raw.default)
              : String(raw.default),
      help: String(raw.help ?? '').trim(),
      full: !!raw.full || type === 'textarea',
    });
  }
  return out;
}

export function isTemplateEntity(entity: string): boolean {
  return TEMPLATE_ENTITIES.includes(entity);
}

/** Initial custom values for a template, preserving values the user already entered. */
export function applyTemplateDefaults(fields: TemplateField[], existing: Record<string, any> = {}): Record<string, any> {
  const values: Record<string, any> = { ...(existing ?? {}) };
  for (const field of fields) {
    if (values[field.key] !== undefined && values[field.key] !== null && values[field.key] !== '') continue;
    if (field.default !== undefined) values[field.key] = field.default;
  }
  return values;
}

export function isFieldEmpty(field: TemplateField, value: any): boolean {
  if (field.type === 'checkbox') return false;
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return !Number.isFinite(value);
  return false;
}

/** Returns human-readable validation errors for template-defined values. */
export function validateTemplateValues(fields: TemplateField[], values: Record<string, any>): string[] {
  const errors: string[] = [];
  for (const field of fields) {
    const value = values?.[field.key];
    if (field.required && isFieldEmpty(field, value)) {
      errors.push(`${field.label} is required`);
      continue;
    }
    if (isFieldEmpty(field, value)) continue;
    if (field.type === 'number' || field.type === 'measurement') {
      if (!Number.isFinite(Number(value))) errors.push(`${field.label} must be a number`);
    }
    if (field.type === 'select' && field.options?.length && !field.options.includes(String(value))) {
      errors.push(`${field.label} must be one of: ${field.options.join(', ')}`);
    }
  }
  return errors;
}

export function displayCustomValue(field: TemplateField, value: any): string {
  if (value === undefined || value === null || value === '') return '—';
  if (field.type === 'checkbox') return value ? 'Yes' : 'No';
  if (field.type === 'measurement') return `${Number(value)}${field.unit ? ` ${field.unit}` : ''}`;
  if (field.type === 'number') return `${Number(value)}${field.unit ? ` ${field.unit}` : ''}`;
  if (field.type === 'datetime') return String(value).replace('T', ' ').slice(0, 16);
  return String(value);
}
