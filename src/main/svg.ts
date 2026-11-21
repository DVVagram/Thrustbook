/** Minimal dependency-free SVG chart renderer used by generated reports. */

export interface SvgSeries {
  label: string;
  x: number[];
  y: (number | null)[];
  color?: string;
  dash?: boolean;
}

export const PALETTE = ['#2f7fd1', '#d98324', '#2f9e6a', '#c0504d', '#7a5cc4', '#2f8f9e', '#8a8a2f', '#b0407a'];

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const range = max - min;
  const rough = range / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

export function formatTick(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return v.toExponential(1);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

export function lineChartSvg(opts: {
  series: SvgSeries[];
  title?: string;
  xLabel?: string;
  yLabel?: string;
  width?: number;
  height?: number;
  pointLimit?: number;
}): string {
  const width = opts.width ?? 720;
  const height = opts.height ?? 300;
  const margin = { top: opts.title ? 34 : 18, right: 16, bottom: 40, left: 62 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const series = (opts.series ?? []).filter((s) => s.x?.length > 0);

  if (series.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="#ffffff" stroke="#c9d1d9"/>
      <text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#6b7280" font-size="12" font-family="Arial, sans-serif">No data available</text>
    </svg>`;
  }

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of series) {
    for (let i = 0; i < s.x.length; i++) {
      const xv = s.x[i];
      const yv = s.y[i];
      if (Number.isFinite(xv)) {
        if (xv < xMin) xMin = xv;
        if (xv > xMax) xMax = xv;
      }
      if (yv !== null && Number.isFinite(yv)) {
        if (yv < yMin) yMin = yv;
        if (yv > yMax) yMax = yv;
      }
    }
  }
  if (!Number.isFinite(xMin) || xMin === xMax) {
    xMin = 0;
    xMax = 1;
  }
  if (!Number.isFinite(yMin) || yMin === yMax) {
    yMin = yMin - 1;
    yMax = yMax + 1;
  }
  const pad = (yMax - yMin) * 0.06;
  yMin -= pad;
  yMax += pad;

  const sx = (x: number) => margin.left + ((x - xMin) / (xMax - xMin)) * plotW;
  const sy = (y: number) => margin.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, Helvetica, sans-serif">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  if (opts.title) parts.push(`<text x="${margin.left}" y="20" font-size="13" font-weight="bold" fill="#111827">${esc(opts.title)}</text>`);

  const xTicks = niceTicks(xMin, xMax, 7);
  const yTicks = niceTicks(yMin, yMax, 5);

  for (const t of yTicks) {
    const y = sy(t);
    parts.push(`<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${margin.left + plotW}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`);
    parts.push(`<text x="${margin.left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="#4b5563">${esc(formatTick(t))}</text>`);
  }
  for (const t of xTicks) {
    const x = sx(t);
    parts.push(`<line x1="${x.toFixed(1)}" y1="${margin.top}" x2="${x.toFixed(1)}" y2="${margin.top + plotH}" stroke="#f1f3f5" stroke-width="1"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${margin.top + plotH + 16}" text-anchor="middle" font-size="10" fill="#4b5563">${esc(formatTick(t))}</text>`);
  }

  parts.push(`<rect x="${margin.left}" y="${margin.top}" width="${plotW}" height="${plotH}" fill="none" stroke="#9ca3af" stroke-width="1"/>`);

  series.forEach((s, idx) => {
    const color = s.color ?? PALETTE[idx % PALETTE.length];
    let path = '';
    let pen = false;
    const limit = opts.pointLimit ?? 900;
    const step = Math.max(1, Math.ceil(s.x.length / limit));
    for (let i = 0; i < s.x.length; i += step) {
      const xv = s.x[i];
      const yv = s.y[i];
      if (yv === null || !Number.isFinite(yv) || !Number.isFinite(xv)) {
        pen = false;
        continue;
      }
      const px = sx(xv).toFixed(1);
      const py = sy(yv).toFixed(1);
      path += `${pen ? 'L' : 'M'}${px},${py} `;
      pen = true;
    }
    parts.push(`<path d="${path.trim()}" fill="none" stroke="${color}" stroke-width="1.4"${s.dash ? ' stroke-dasharray="5 3"' : ''}/>`);
  });

  if (opts.xLabel) parts.push(`<text x="${margin.left + plotW / 2}" y="${height - 6}" text-anchor="middle" font-size="10" fill="#374151">${esc(opts.xLabel)}</text>`);
  if (opts.yLabel) {
    parts.push(`<text transform="translate(14 ${margin.top + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="10" fill="#374151">${esc(opts.yLabel)}</text>`);
  }

  // Legend
  let lx = margin.left + 8;
  series.slice(0, 8).forEach((s, idx) => {
    const color = s.color ?? PALETTE[idx % PALETTE.length];
    parts.push(`<line x1="${lx}" y1="${margin.top + 12}" x2="${lx + 16}" y2="${margin.top + 12}" stroke="${color}" stroke-width="2"/>`);
    parts.push(`<text x="${lx + 20}" y="${margin.top + 15}" font-size="9" fill="#374151">${esc(s.label.slice(0, 42))}</text>`);
    lx += 22 + Math.min(190, s.label.length * 5.2);
  });

  parts.push('</svg>');
  return parts.join('');
}

export function barChartSvg(opts: {
  labels: string[];
  values: (number | null)[];
  title?: string;
  yLabel?: string;
  width?: number;
  height?: number;
}): string {
  const width = opts.width ?? 720;
  const height = opts.height ?? 260;
  const margin = { top: 30, right: 16, bottom: 42, left: 62 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const values = opts.values.map((v) => (v !== null && Number.isFinite(v) ? v : 0));
  const maxV = Math.max(1e-9, ...values.map(Math.abs));
  const scale = (v: number) => (Math.abs(v) / maxV) * plotH;
  const barW = Math.max(4, plotW / Math.max(1, values.length) - 8);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, Helvetica, sans-serif">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  if (opts.title) parts.push(`<text x="${margin.left}" y="18" font-size="13" font-weight="bold" fill="#111827">${esc(opts.title)}</text>`);
  const baseline = margin.top + plotH;
  values.forEach((v, i) => {
    const h = scale(v);
    const x = margin.left + i * (plotW / Math.max(1, values.length)) + 4;
    parts.push(`<rect x="${x.toFixed(1)}" y="${(baseline - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${PALETTE[i % PALETTE.length]}"/>`);
    const label = opts.labels[i] ?? '';
    parts.push(
      `<text transform="translate(${(x + barW / 2).toFixed(1)} ${baseline + 8}) rotate(35)" font-size="9" fill="#374151">${esc(label.slice(0, 26))}</text>`,
    );
  });
  parts.push(`<line x1="${margin.left}" y1="${baseline}" x2="${margin.left + plotW}" y2="${baseline}" stroke="#9ca3af"/>`);
  if (opts.yLabel) parts.push(`<text transform="translate(14 ${margin.top + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="10" fill="#374151">${esc(opts.yLabel)}</text>`);
  parts.push('</svg>');
  return parts.join('');
}
