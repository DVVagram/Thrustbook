import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* ---------------------------------------------------------------- */
/* Icons                                                             */
/* ---------------------------------------------------------------- */

const ICON_PATHS: Record<string, string> = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  rocket: 'M12 2c3 2 5 6 5 10l-3 3H10l-3-3c0-4 2-8 5-10zM9 15l-3 5 4-2M15 15l3 5-4-2M12 8v4',
  chip: 'M7 7h10v10H7zM4 9h3M4 15h3M17 9h3M17 15h3M9 4v3M15 4v3M9 17v3M15 17v3',
  sensor: 'M12 3v4M12 17v4M5 12H3M21 12h-2M7.5 7.5 6 6M18 18l-1.5-1.5M7.5 16.5 6 18M18 6l-1.5 1.5M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  branch: 'M6 4v10a3 3 0 0 0 3 3h5M6 8h8a3 3 0 0 1 3 3v2M6 4a2 2 0 1 0 0 .1M18 20a2 2 0 1 0 0-.1',
  beaker: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7 15h10',
  flight: 'M2 21l7-7M9 14l-2-4 9-7 3 3-7 9-3-1zM13 9l2 2',
  flask: 'M10 2h4M11 2v6L5 20a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2L13 8V2M7 16h10',
  log: 'M4 4h16M4 9h16M4 14h16M4 19h10',
  chart: 'M3 3v18h18M7 15l3-4 3 2 4-6',
  compare: 'M4 5v14M20 5v14M4 9h6M4 15h6M14 9h6M14 15h6M10 12h4',
  doc: 'M6 2h8l4 4v16H6zM14 2v4h4M9 12h6M9 16h6',
  alert: 'M12 3 2 21h20zM12 9v5M12 17v.5',
  report: 'M6 2h9l4 4v16H6zM14 2v4h4M9 11h6M9 15h6M9 19h4',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.4 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L5 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.6h5l.4-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z',
  search: 'M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-4.5-4.5',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  download: 'M12 3v12M7 11l5 5 5-5M4 21h16',
  upload: 'M12 21V9M7 13l5-5 5 5M4 3h16',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  edit: 'M4 20h4L20 8l-4-4L4 16z',
  save: 'M4 4h13l3 3v13H4zM8 4v6h8V4M8 20v-6h8v6',
  refresh: 'M20 11a8 8 0 1 0-2.3 6M20 4v7h-7',
  play: 'M6 4l14 8-14 8z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  stop: 'M6 6h12v12H6z',
  'step-back': 'M6 5v14M18 5l-9 7 9 7z',
  'step-forward': 'M18 5v14M6 5l9 7-9 7z',
  video: 'M3 5h12v14H3zM15 10l6-3v10l-6-3M7 9l3 3-3 3',
  target: 'M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2',
  warning: 'M12 3 2 21h20zM12 9v5M12 17v.5',
  check: 'M4 12l5 5L20 6',
  filter: 'M3 4h18l-7 8v7l-4 2v-9z',
  timeline: 'M3 12h18M7 12a2 2 0 1 0 0-.1M13 7a2 2 0 1 0 0-.1M17 17a2 2 0 1 0 0-.1',
  print: 'M6 9V3h12v6M6 17H4v-7h16v7h-2M7 14h10v7H7z',
  panel: 'M3 4h18v16H3zM9 4v16M15 4v16',
  link: 'M10 13a4 4 0 0 0 6 .5l2-2a4 4 0 0 0-5.7-5.7L11 7M14 11a4 4 0 0 0-6-.5l-2 2A4 4 0 0 0 11.7 18L13 17',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  wallet: 'M3 7a2 2 0 0 1 2-2h12v4M3 7v10a2 2 0 0 0 2 2h14V9H5a2 2 0 0 1-2-2zM16 13h2',
};

export function Icon({ name, size = 16, className = '' }: { name: string; size?: number; className?: string }) {
  const path = ICON_PATHS[name] ?? ICON_PATHS.grid;
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

/* ---------------------------------------------------------------- */
/* Buttons and inputs                                                */
/* ---------------------------------------------------------------- */

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  icon,
  disabled,
  title,
  type = 'button',
  className = '',
}: {
  children?: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'subtle';
  size?: 'sm' | 'md';
  icon?: string;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  className?: string;
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 13 : 15} />}
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
  full,
  required,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  full?: boolean;
  required?: boolean;
}) {
  return (
    <label className={`field ${full ? 'field-full' : ''}`}>
      <span className="field-label">
        {label}
        {required && <span className="req">*</span>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  const { mono, className = '', ...rest } = props;
  return <input className={`input ${mono ? 'mono' : ''} ${className}`} {...rest} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return <textarea className={`input textarea ${className}`} {...rest} />;
}

export function Select({
  options,
  value,
  onChange,
  placeholder,
  className = '',
  disabled,
  children,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <select className={`input select ${className}`} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {children}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`checkbox ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)} aria-pressed={checked}>
      <span className="toggle-knob" />
      {label && <span className="toggle-label">{label}</span>}
    </button>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  autoFocus,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="search-input">
      <Icon name="search" size={14} />
      <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} />
      {value && (
        <button type="button" className="search-clear" onClick={() => onChange('')} title="Clear">
          ×
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Layout                                                            */
/* ---------------------------------------------------------------- */

export function Panel({
  title,
  subtitle,
  actions,
  children,
  dense,
  className = '',
  scroll,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  dense?: boolean;
  className?: string;
  scroll?: boolean;
}) {
  return (
    <section className={`panel ${dense ? 'panel-dense' : ''} ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div className="panel-title">
            {title}
            {subtitle && <span className="panel-subtitle">{subtitle}</span>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className={`panel-body ${scroll ? 'scroll' : ''}`}>{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumbs,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: { label: string; onClick?: () => void }[];
}) {
  return (
    <header className="page-head">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="breadcrumbs">
          {breadcrumbs.map((b, i) => (
            <span key={`${b.label}-${i}`}>
              {i > 0 && <span className="crumb-sep">/</span>}
              {b.onClick ? (
                <button className="crumb-link" onClick={b.onClick}>
                  {b.label}
                </button>
              ) : (
                <span className="crumb-current">{b.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="page-head-row">
        <div>
          <h1>{title}</h1>
          {subtitle && <div className="page-sub">{subtitle}</div>}
        </div>
        <div className="page-actions">{actions}</div>
      </div>
    </header>
  );
}

export function Toolbar({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`toolbar ${className}`}>{children}</div>;
}

export function EmptyState({
  title,
  message,
  action,
  icon = 'grid',
}: {
  title: string;
  message?: string;
  action?: React.ReactNode;
  icon?: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      <div className="empty-title">{title}</div>
      {message && <div className="empty-message">{message}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Badge({ children, tone }: { children: React.ReactNode; tone?: string }) {
  const derived =
    tone ??
    (() => {
      const text = String(children).toLowerCase();
      if (/complete|verified|resolved|closed|flown|ok|passed/.test(text)) return 'ok';
      if (/fail|critical|error|lost|blocked/.test(text)) return 'danger';
      if (/progress|investigating|ready|planned|warning|suggest/.test(text)) return 'warn';
      if (/high|open/.test(text)) return 'warn';
      return 'neutral';
    })();
  return <span className={`badge badge-${derived}`}>{children}</span>;
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string; count?: number }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={active === t.key}
          className={`tab ${active === t.key ? 'active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  wide,
  size,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''} ${size ? `modal-${size}` : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="loading">
      <div className="spinner" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box">
      <Icon name="warning" size={16} />
      <div>
        <div>{message}</div>
        {onRetry && (
          <button className="link-btn" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, onClick, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; onClick?: () => void; tone?: string }) {
  return (
    <button type="button" className={`stat ${onClick ? 'clickable' : ''} ${tone ? `stat-${tone}` : ''}`} onClick={onClick} disabled={!onClick}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </button>
  );
}

export function KeyValue({ items, columns = 2 }: { items: [string, React.ReactNode][]; columns?: number }) {
  return (
    <div className="kv-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {items.map(([k, v], i) => (
        <div className="kv-item" key={`${k}-${i}`}>
          <span className="kv-key">{k}</span>
          <span className="kv-value">{v === null || v === undefined || v === '' ? '—' : v}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Table                                                             */
/* ---------------------------------------------------------------- */

export interface Column<T = any> {
  key: string;
  label: string;
  width?: string;
  align?: 'left' | 'right' | 'center';
  render?: (row: T) => React.ReactNode;
  sortValue?: (row: T) => string | number;
  mono?: boolean;
}

export function DataTable<T extends Record<string, any>>({
  columns,
  rows,
  rowKey = (r) => r.id,
  onRowClick,
  selectedKey,
  empty,
  dense,
  maxHeight,
  sortable = true,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey?: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  empty?: React.ReactNode;
  dense?: boolean;
  maxHeight?: string;
  sortable?: boolean;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    const get = (row: T) => (column?.sortValue ? column.sortValue(row) : (row[sort.key] ?? ''));
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sort.dir;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * sort.dir;
    });
  }, [rows, sort, columns]);

  if (rows.length === 0 && empty) {
    return <div className="table-empty">{empty}</div>;
  }

  return (
    <div className={`table-wrap ${dense ? 'dense' : ''}`} style={maxHeight ? { maxHeight, overflow: 'auto' } : undefined}>
      <table className="tbl">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{ width: col.width, textAlign: col.align ?? 'left' }}
                onClick={() => {
                  if (!sortable) return;
                  setSort((prev) => (prev?.key === col.key ? { key: col.key, dir: prev.dir === 1 ? -1 : 1 } : { key: col.key, dir: 1 }));
                }}
                className={sortable ? 'sortable' : ''}
              >
                {col.label}
                {sort?.key === col.key && <span className="sort-mark">{sort.dir === 1 ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                className={`${onRowClick ? 'clickable' : ''} ${selectedKey === key ? 'selected' : ''}`}
                onClick={() => onRowClick?.(row)}
              >
                {columns.map((col) => (
                  <td key={col.key} className={col.mono ? 'mono' : ''} style={{ textAlign: col.align ?? 'left' }}>
                    {col.render ? col.render(row) : (row[col.key] ?? '—')}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
