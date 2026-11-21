import React, { useEffect, useState } from 'react';
import { api } from './api';
import { useApp } from './state';
import { FieldDef, fieldsFor } from './forms';
import { Field, Input, Select, Textarea, Checkbox } from './ui';
import { fromLocalInput, toLocalInput } from './format';

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
