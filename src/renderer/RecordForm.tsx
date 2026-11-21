import React, { useEffect, useState } from 'react';
import { api } from './api';
import { useApp } from './state';
import { FieldDef, fieldsFor } from './forms';
import { Checkbox, Field, Input, Select, Textarea } from './ui';
import { fromLocalInput, toLocalInput } from './format';
import {
  TemplateField,
  applyTemplateDefaults,
  normalizeTemplateFields,
  targetForEntity,
  validateTemplateValues,
} from '../shared/templates';

function RefSelect({
  field,
  value,
  onChange,
  projectId,
  disabled,
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
  projectId: string;
  disabled?: boolean;
}) {
  const [options, setOptions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const where: any = { ...(field.refWhere ?? {}) };
    if (projectId && field.ref !== 'project') where.project_id = projectId;
    api
      .list(field.ref!, { where, limit: 500, orderBy: field.ref === 'revision' ? 'created_at' : 'name', order: 'asc' })
      .then((rows) => {
        if (!cancelled) setOptions(rows);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [field.ref, field.refWhere, projectId]);

  const labelFor = (row: any) =>
    row[field.ref === 'revision' ? 'label' : 'name'] ?? row.title ?? row.test_no ?? row.flight_no ?? row.id;

  return (
    <Select
      value={value ?? ''}
      onChange={onChange}
      disabled={disabled || loading}
      placeholder={loading ? 'Loading…' : `Select ${field.label.toLowerCase()}`}
      options={options.map((row) => ({
        value: row.id,
        label: `${labelFor(row)}${row.status ? ` · ${row.status}` : ''}`,
      }))}
    />
  );
}

function parseValues(value: any): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value)) ?? {};
  } catch {
    return {};
  }
}

function TemplateEntryFields({
  entity,
  projectId,
  value,
  onChange,
  disabled,
}: {
  entity: string;
  projectId: string;
  value: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
  disabled?: boolean;
}) {
  const [templates, setTemplates] = useState<any[]>([]);
  const [manualChoice, setManualChoice] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const target = targetForEntity(entity);
    if (!target) return;
    api
      .list('entry_template', { where: { applies_to: target, project_id: [projectId, ''] }, limit: 300, orderBy: 'name', order: 'asc' })
      .then((rows) => {
        if (!cancelled) setTemplates(rows.filter((t) => !t.archived));
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [entity, projectId]);

  const active = templates.find((t) => t.id === value.template_id);
  const fields: TemplateField[] = active ? normalizeTemplateFields(active.fields ?? active.fields_json) : [];
  const values = parseValues(value.custom_json);

  const applyTemplate = (id: string) => {
    setManualChoice(true);
    if (!id) {
      onChange({ template_id: '' });
      return;
    }
    const template = templates.find((t) => t.id === id);
    const templateFields = template ? normalizeTemplateFields(template.fields ?? template.fields_json) : [];
    onChange({ template_id: id, custom_json: applyTemplateDefaults(templateFields, values) });
  };

  // A template can nominate a category; selecting that category on a new record
  // applies its fields automatically without overwriting anything already entered.
  useEffect(() => {
    if (manualChoice || !templates.length || value.template_id) return;
    const match = templates.find((t) => t.category && value.category && t.category === value.category);
    if (!match) return;
    onChange({ template_id: match.id, custom_json: applyTemplateDefaults(normalizeTemplateFields(match.fields ?? match.fields_json), values) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates, value.category, value.template_id, manualChoice]);

  const errors = active ? validateTemplateValues(fields, values) : [];

  const setValue = (field: TemplateField, raw: any) => {
    onChange({ custom_json: { ...values, [field.key]: raw } });
  };

  return (
    <div className="template-section">
      <div className="template-picker">
        <Field label="Entry template" hint="Reusable custom fields for this type of record">
          <Select
            value={value.template_id ?? ''}
            onChange={applyTemplate}
            placeholder="No template"
            disabled={disabled}
            options={templates.map((t) => ({
              value: t.id,
              label: `${t.name}${t.project_id ? '' : ' · all projects'}${t.category ? ` · ${t.category}` : ''}`,
            }))}
          />
        </Field>
        {active && (
          <div className="template-note muted small">
            {fields.length} field(s) from “{active.name}”. Values are stored with this record and are reported as user-entered data.
          </div>
        )}
        {!active && templates.length === 0 && (
          <div className="template-note muted small">
            No templates for this record type yet. Create one under <strong>Entry Templates</strong> to capture consistent fields.
          </div>
        )}
      </div>

      {active && fields.length > 0 && (
        <div className="template-fields">
          <div className="template-fields-head">
            <span className="field-label">Template fields</span>
            {errors.length > 0 && <span className="warn-text tiny">{errors.length} field(s) need attention</span>}
          </div>
          <div className="form-grid">
            {fields.map((field) => (
              <Field
                key={field.key}
                label={field.label}
                full={field.full}
                required={field.required}
                hint={field.help || (field.unit ? `Unit: ${field.unit}` : undefined)}
              >
                {renderField(field, values[field.key], (v) => setValue(field, v), disabled)}
              </Field>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function renderField(field: TemplateField, raw: any, onChange: (value: any) => void, disabled?: boolean) {
  const unitSuffix = field.unit ? <span className="unit-suffix">{field.unit}</span> : null;
  switch (field.type) {
    case 'textarea':
      return <Textarea rows={3} value={raw ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
    case 'measurement':
      return (
        <div className="input-with-unit">
          <Input
            type="number"
            step="any"
            className="mono"
            value={raw ?? ''}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
          {unitSuffix}
        </div>
      );
    case 'select':
      return (
        <Select
          value={raw ?? ''}
          onChange={onChange}
          disabled={disabled}
          placeholder="—"
          options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
        />
      );
    case 'checkbox':
      return <Checkbox checked={!!raw} onChange={onChange} label={field.label} disabled={disabled} />;
    case 'date':
      return <Input type="date" value={raw ? String(raw).slice(0, 10) : ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case 'datetime':
      return <Input type="datetime-local" value={toLocalInput(raw)} disabled={disabled} onChange={(e) => onChange(fromLocalInput(e.target.value))} />;
    case 'text':
    default:
      return <Input value={raw ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function RecordForm({
  entity,
  fields,
  value,
  onChange,
  projectId,
  disabled,
  columns = 2,
}: {
  entity?: string;
  fields?: FieldDef[];
  value: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
  projectId: string;
  disabled?: boolean;
  columns?: number;
}) {
  const { projects } = useApp();
  const defs = fields ?? (entity ? fieldsFor(entity) : []);
  return (
    <>
      {entity && targetForEntity(entity) && (
        <TemplateEntryFields entity={entity} projectId={projectId} value={value} onChange={onChange} disabled={disabled} />
      )}
      <div className="form-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {defs.map((field) => {
          if (field.hide) return null;
          const raw = value?.[field.key];
          const common = { label: field.label, full: field.full, required: field.required, hint: field.hint };
          if (field.ref) {
            return (
              <Field key={field.key} {...common}>
                <RefSelect field={field} value={raw ?? ''} onChange={(v) => onChange({ [field.key]: v })} projectId={projectId} disabled={disabled} />
              </Field>
            );
          }
          switch (field.type) {
            case 'textarea':
              return (
                <Field key={field.key} {...common}>
                  <Textarea
                    rows={field.rows ?? 3}
                    className={field.mono ? 'mono' : ''}
                    value={raw ?? ''}
                    placeholder={field.placeholder}
                    disabled={disabled}
                    onChange={(e) => onChange({ [field.key]: e.target.value })}
                  />
                </Field>
              );
            case 'select':
              return (
                <Field key={field.key} {...common}>
                  <Select
                    value={raw ?? ''}
                    onChange={(v) => onChange({ [field.key]: v })}
                    options={(field.options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o))}
                    disabled={disabled}
                    placeholder="—"
                  />
                </Field>
              );
            case 'number':
              return (
                <Field key={field.key} {...common}>
                  <Input
                    type="number"
                    step={field.step ?? 'any'}
                    className="mono"
                    value={raw ?? ''}
                    disabled={disabled}
                    onChange={(e) => onChange({ [field.key]: e.target.value === '' ? null : Number(e.target.value) })}
                  />
                </Field>
              );
            case 'datetime':
              return (
                <Field key={field.key} {...common}>
                  <Input
                    type="datetime-local"
                    value={toLocalInput(raw)}
                    disabled={disabled}
                    onChange={(e) => onChange({ [field.key]: fromLocalInput(e.target.value) })}
                  />
                </Field>
              );
            case 'date':
              return (
                <Field key={field.key} {...common}>
                  <Input
                    type="date"
                    value={raw ? String(raw).slice(0, 10) : ''}
                    disabled={disabled}
                    onChange={(e) => onChange({ [field.key]: e.target.value })}
                  />
                </Field>
              );
            case 'checkbox':
              return (
                <Field key={field.key} {...common}>
                  <Checkbox checked={!!raw} onChange={(v) => onChange({ [field.key]: v })} label={field.label} disabled={disabled} />
                </Field>
              );
            default:
              return (
                <Field key={field.key} {...common}>
                  <Input
                    value={raw ?? ''}
                    placeholder={field.placeholder}
                    className={field.mono ? 'mono' : ''}
                    disabled={disabled}
                    onChange={(e) => onChange({ [field.key]: e.target.value })}
                  />
                </Field>
              );
          }
        })}
        {entity === 'project' && null}
        {defs.length === 0 && <div className="muted">No editable fields defined.</div>}
        {projects.length === 0 && entity === 'project' && null}
      </div>
    </>
  );
}

/** Dialog body wrapper used by create/edit modals. */
export function RecordEditor({
  entity,
  value,
  onChange,
  projectId,
}: {
  entity: string;
  value: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
  projectId: string;
}) {
  return <RecordForm entity={entity} value={value} onChange={onChange} projectId={projectId} />;
}
