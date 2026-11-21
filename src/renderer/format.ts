let prefs = { dateFormat: 'YYYY-MM-DD', timeFormat: '24h' };

export function setDatePrefs(dateFormat: string, timeFormat: string): void {
  prefs = { dateFormat: dateFormat || 'YYYY-MM-DD', timeFormat: timeFormat || '24h' };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  switch (prefs.dateFormat) {
    case 'DD/MM/YYYY':
      return `${day}/${m}/${y}`;
    case 'MM/DD/YYYY':
      return `${m}/${day}/${y}`;
    case 'DD-MMM-YYYY':
      return `${day}-${d.toLocaleString('en-US', { month: 'short' })}-${y}`;
    default:
      return `${y}-${m}-${day}`;
  }
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (prefs.timeFormat === '12h') {
    const h = d.getHours();
    return `${pad(h % 12 === 0 ? 12 : h % 12)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
  }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${fmtDate(iso)} ${fmtTime(iso)}`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [60_000, 'minute'],
    [3_600_000, 'hour'],
    [86_400_000, 'day'],
    [604_800_000, 'week'],
    [2_592_000_000, 'month'],
    [31_536_000_000, 'year'],
  ];
  if (abs < 60_000) return diff >= 0 ? 'just now' : 'in a moment';
  for (let i = 1; i < units.length; i++) {
    if (abs < units[i][0] || i === units.length - 1) {
      const value = Math.round(abs / units[i - 1][0]);
      const label = units[i - 1][1];
      return diff >= 0 ? `${value} ${label}${value === 1 ? '' : 's'} ago` : `in ${value} ${label}${value === 1 ? '' : 's'}`;
    }
  }
  return fmtDateTime(iso);
}

export function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function bytes(size: number | null | undefined): string {
  if (size === null || size === undefined || !Number.isFinite(size)) return '—';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = size;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
