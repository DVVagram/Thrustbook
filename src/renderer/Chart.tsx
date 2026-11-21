import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { boxStats, histogram } from '../shared/analysis';

export type ChartType =
  | 'line'
  | 'timeseries'
  | 'scatter'
  | 'area'
  | 'bar'
  | 'histogram'
  | 'distribution'
  | 'xy'
  | 'difference'
  | 'percentdiff'
  | 'box';

export interface ChartSeries {
  id: string;
  label: string;
  x: number[];
  y: (number | null)[];
  unit: string;
  axis?: 'left' | 'right';
  color?: string;
  dash?: boolean;
  datasetName?: string;
}

export interface ChartMarker {
  t: number;
  label: string;
  category?: string;
}

export interface ChartHandle {
  exportPng: () => string | null;
}

interface Props {
  series: ChartSeries[];
  type?: ChartType;
  title?: string;
  xLabel?: string;
  yLabel?: string;
  height?: number;
  xDomain?: [number, number] | null;
  onXDomainChange?: (domain: [number, number] | null) => void;
  markers?: ChartMarker[];
  onHoverTime?: (t: number | null) => void;
  showLegend?: boolean;
  note?: string;
  emptyMessage?: string;
}

const COLORS = ['#4aa3ff', '#f0a13a', '#4fbf87', '#e06c75', '#a78bfa', '#38bdf8', '#eab308', '#fb7185'];

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const range = max - min;
  const rough = range / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(rough) || 1)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function tickLabel(v: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(1);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return String(Number(v.toFixed(3)));
  return String(Number(v.toFixed(4)));
}

function extent(values: (number | null)[], x?: number[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    if (x && !Number.isFinite(x[i])) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  return [min, max];
}

export const Chart = forwardRef<ChartHandle, Props>(function Chart(
  {
    series,
    type = 'line',
    title,
    xLabel,
    yLabel,
    height = 260,
    xDomain: externalDomain,
    onXDomainChange,
    markers,
    onHoverTime,
    showLegend = true,
    note,
    emptyMessage = 'Select measurements to plot',
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<{ px: number; py: number } | null>(null);
  const [internalDomain, setInternalDomain] = useState<[number, number] | null>(null);
  const dragRef = useRef<{ startX: number; domain: [number, number] } | null>(null);
  const frameRef = useRef(0);

  const isCategorical = type === 'histogram' || type === 'distribution' || type === 'box' || type === 'bar';
  const xDomain = isCategorical ? null : (externalDomain ?? internalDomain);

  const setDomain = useCallback(
    (domain: [number, number] | null) => {
      if (onXDomainChange) onXDomainChange(domain);
      else setInternalDomain(domain);
    },
    [onXDomainChange],
  );

  const prepared = useMemo(() => {
    if (isCategorical) return null;
    const xs: number[] = [];
    for (const s of series as ChartSeries[]) {
      for (let i = 0; i < s.x.length; i++) {
        if (Number.isFinite(s.x[i]) && s.y[i] !== null && Number.isFinite(s.y[i] as number)) xs.push(s.x[i]);
      }
    }
    if (xs.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const v of xs) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === max) {
      min -= 1;
      max += 1;
    }
    return { min, max };
  }, [series, isCategorical]);

  const histogramData = useMemo(() => {
    if (type !== 'histogram' && type !== 'distribution') return null;
    return (series as ChartSeries[]).map((s) => ({ id: s.id, label: s.label, data: histogram(s.y as any, 28) }));
  }, [series, type]);

  const boxData = useMemo(() => {
    if (type !== 'box') return null;
    return (series as ChartSeries[]).map((s) => ({ id: s.id, label: s.label, stats: boxStats(s.y as any) }));
  }, [series, type]);

  const barData = useMemo(() => {
    if (type !== 'bar') return null;
    return (series as ChartSeries[]).map((s) => {
      const finite = s.y.filter((v): v is number => v !== null && Number.isFinite(v));
      const mean = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
      return { id: s.id, label: s.label, value: mean };
    });
  }, [series, type]);

  const units = useMemo(() => {
    const u = new Set<string>();
    for (const s of series as ChartSeries[]) if (s.unit) u.add(s.unit);
    return Array.from(u);
  }, [series]);

  const dualAxis = units.length > 1 && !isCategorical;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 600;
      setWidth(Math.max(240, Math.floor(w)));
    });
    observer.observe(el);
    setWidth(Math.max(240, Math.floor(el.clientWidth)));
    return () => observer.disconnect();
  }, []);

  // Reset the internal zoom when the plotted series set changes.
  useEffect(() => {
    if (!onXDomainChange) setInternalDomain(null);
  }, [series.length, onXDomainChange]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = width;
    const h = height;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue('--chart-bg').trim() || '#12181f';
    const grid = styles.getPropertyValue('--chart-grid').trim() || '#24303b';
    const axisColor = styles.getPropertyValue('--chart-axis').trim() || '#485563';
    const text = styles.getPropertyValue('--muted').trim() || '#8a97a5';
    const strong = styles.getPropertyValue('--text').trim() || '#dbe3ea';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    if (!series.length) {
      ctx.fillStyle = text;
      ctx.font = '12px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(emptyMessage, w / 2, h / 2);
      return;
    }

    const margin = { top: 12, right: dualAxis ? 54 : 14, bottom: markers?.length ? 40 : 30, left: 58 };
    const plotW = Math.max(10, w - margin.left - margin.right);
    const plotH = Math.max(10, h - margin.top - margin.bottom);

    ctx.font = '10px "Segoe UI", system-ui, sans-serif';

    /* ---------------- categorical charts ---------------- */
    if (isCategorical) {
      const labels = series.map((s) => s.label);
      const slotW = plotW / Math.max(1, labels.length);
      const drawAxis = (min: number, max: number, color: string) => {
        const ticks = niceTicks(min, max, 5);
        for (const t of ticks) {
          const y = margin.top + plotH - ((t - min) / (max - min || 1)) * plotH;
          ctx.strokeStyle = grid;
          ctx.beginPath();
          ctx.moveTo(margin.left, y);
          ctx.lineTo(margin.left + plotW, y);
          ctx.stroke();
          ctx.fillStyle = text;
          ctx.textAlign = 'right';
          ctx.fillText(tickLabel(t), margin.left - 6, y + 3);
        }
        ctx.strokeStyle = color;
        ctx.strokeRect(margin.left, margin.top, plotW, plotH);
      };

      if (type === 'histogram' || type === 'distribution') {
        const all = (histogramData ?? []).flatMap((d) => d.data?.bins ?? []);
        const min = Math.min(...all.map((b) => b.from), 0);
        const max = Math.max(...all.map((b) => b.to), 1);
        const maxCount = Math.max(1, ...all.map((b) => b.count));
        drawAxis(0, maxCount, axisColor);
        const bins = Math.max(...(histogramData ?? []).map((d) => d.data?.bins.length ?? 0), 1);
        const barW = plotW / bins;
        (histogramData ?? []).forEach((d, sIdx) => {
          ctx.fillStyle = `${COLORS[sIdx % COLORS.length]}aa`;
          d.data?.bins.forEach((bin, i) => {
            const bh = (bin.count / maxCount) * plotH;
            ctx.fillRect(margin.left + i * barW + 0.5, margin.top + plotH - bh, Math.max(1, barW - 1), bh);
          });
        });
        ctx.fillStyle = text;
        ctx.textAlign = 'center';
        for (let i = 0; i <= 5; i++) {
          const v = min + ((max - min) * i) / 5;
          ctx.fillText(tickLabel(v), margin.left + (plotW * i) / 5, margin.top + plotH + 14);
        }
        ctx.textAlign = 'left';
      } else if (type === 'box') {
        const values = (boxData ?? []).flatMap((d) => [d.stats.min ?? 0, d.stats.max ?? 0]).filter((v) => Number.isFinite(v));
        const min = Math.min(...values);
        const max = Math.max(...values);
        const pad = (max - min) * 0.08 || 1;
        drawAxis(min - pad, max + pad, axisColor);
        const sy = (v: number) => margin.top + plotH - ((v - (min - pad)) / (max - min + 2 * pad || 1)) * plotH;
        (boxData ?? []).forEach((d, idx) => {
          if (!d.stats.n) return;
          const cx = margin.left + slotW * (idx + 0.5);
          const bw = Math.min(54, slotW * 0.5);
          const color = COLORS[idx % COLORS.length];
          ctx.strokeStyle = color;
          ctx.fillStyle = `${color}33`;
          ctx.lineWidth = 1.3;
          const q1 = sy(d.stats.q1 ?? 0);
          const q3 = sy(d.stats.q3 ?? 0);
          ctx.fillRect(cx - bw / 2, q3, bw, q1 - q3);
          ctx.strokeRect(cx - bw / 2, q3, bw, q1 - q3);
          const med = sy(d.stats.median ?? 0);
          ctx.beginPath();
          ctx.moveTo(cx - bw / 2, med);
          ctx.lineTo(cx + bw / 2, med);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cx, sy(d.stats.max ?? 0));
          ctx.lineTo(cx, q3);
          ctx.moveTo(cx, q1);
          ctx.lineTo(cx, sy(d.stats.min ?? 0));
          ctx.moveTo(cx - bw / 4, sy(d.stats.max ?? 0));
          ctx.lineTo(cx + bw / 4, sy(d.stats.max ?? 0));
          ctx.moveTo(cx - bw / 4, sy(d.stats.min ?? 0));
          ctx.lineTo(cx + bw / 4, sy(d.stats.min ?? 0));
          ctx.stroke();
          if (d.stats.outliers.length) {
            ctx.fillStyle = color;
            for (const o of d.stats.outliers.slice(0, 80)) {
              ctx.fillRect(cx - 1.5, sy(o) - 1.5, 3, 3);
            }
          }
          ctx.fillStyle = text;
          ctx.textAlign = 'center';
          ctx.fillText(d.label.slice(0, 18), cx, margin.top + plotH + 16);
          ctx.textAlign = 'left';
        });
      } else if (type === 'bar') {
        const values = (barData ?? []).map((d) => d.value ?? 0);
        const maxV = Math.max(1e-9, ...values.map(Math.abs));
        drawAxis(0, maxV, axisColor);
        (barData ?? []).forEach((d, idx) => {
          if (d.value === null) return;
          const bh = (Math.abs(d.value) / maxV) * plotH;
          ctx.fillStyle = COLORS[idx % COLORS.length];
          const bw = Math.min(70, slotW * 0.6);
          ctx.fillRect(margin.left + slotW * (idx + 0.5) - bw / 2, margin.top + plotH - bh, bw, bh);
          ctx.save();
          ctx.translate(margin.left + slotW * (idx + 0.5), margin.top + plotH + 10);
          ctx.rotate(Math.PI / 5);
          ctx.fillStyle = text;
          ctx.textAlign = 'left';
          ctx.fillText(d.label.slice(0, 22), 0, 0);
          ctx.restore();
        });
      }
    } else {
      /* ---------------- continuous charts ---------------- */
      const xMin = xDomain ? xDomain[0] : (prepared?.min ?? 0);
      const xMax = xDomain ? xDomain[1] : (prepared?.max ?? 1);
      const spanX = xMax - xMin || 1;

      const leftSeries = series.filter((s) => s.axis !== 'right');
      const rightSeries = series.filter((s) => s.axis === 'right');
      const [yMinL, yMaxL] = extent(leftSeries.length ? leftSeries.flatMap((s) => s.y as any) : (series.flatMap((s) => s.y) as any));
      const [yMinR, yMaxR] = rightSeries.length ? extent(rightSeries.flatMap((s) => s.y as any)) : [0, 1];
      const padY = (yMaxL - yMinL) * 0.06;
      const yLo = yMinL - padY;
      const yHi = yMaxL + padY;
      const padYR = (yMaxR - yMinR) * 0.06 || 1;

      const sx = (x: number) => margin.left + ((x - xMin) / spanX) * plotW;
      const syL = (y: number) => margin.top + plotH - ((y - yLo) / (yHi - yLo || 1)) * plotH;
      const syR = (y: number) => margin.top + plotH - ((y - (yMinR - padYR)) / (yMaxR - yMinR + 2 * padYR || 1)) * plotH;

      // Grid and axes
      for (const t of niceTicks(yLo, yHi, 5)) {
        const y = syL(t);
        ctx.strokeStyle = grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(margin.left + plotW, y);
        ctx.stroke();
        ctx.fillStyle = text;
        ctx.textAlign = 'right';
        ctx.fillText(tickLabel(t), margin.left - 6, y + 3);
      }
      if (rightSeries.length) {
        for (const t of niceTicks(yMinR - padYR, yMaxR + padYR, 4)) {
          const y = syR(t);
          ctx.fillStyle = text;
          ctx.textAlign = 'left';
          ctx.fillText(tickLabel(t), margin.left + plotW + 6, y + 3);
        }
      }
      for (const t of niceTicks(xMin, xMax, Math.max(3, Math.floor(plotW / 110)))) {
        const x = sx(t);
        ctx.strokeStyle = grid;
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, margin.top + plotH);
        ctx.stroke();
        ctx.fillStyle = text;
        ctx.textAlign = 'center';
        ctx.fillText(tickLabel(t), x, margin.top + plotH + 14);
      }
      ctx.strokeStyle = axisColor;
      ctx.strokeRect(margin.left, margin.top, plotW, plotH);

      ctx.save();
      ctx.beginPath();
      ctx.rect(margin.left, margin.top, plotW, plotH);
      ctx.clip();

      series.forEach((s, idx) => {
        const color = s.color ?? COLORS[idx % COLORS.length];
        const sy = s.axis === 'right' ? syR : syL;
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = type === 'difference' ? 1.6 : 1.4;
        ctx.setLineDash(s.dash ? [5, 3] : []);
        const pointStep = Math.max(1, Math.ceil(s.x.length / (plotW * 2)));

        if (type === 'scatter' || type === 'xy') {
          const r = s.x.length > 4000 ? 0.8 : 1.6;
          for (let i = 0; i < s.x.length; i += pointStep) {
            const xv = s.x[i];
            const yv = s.y[i];
            if (yv === null || !Number.isFinite(xv) || !Number.isFinite(yv)) continue;
            if (xv < xMin || xv > xMax) continue;
            ctx.beginPath();
            ctx.arc(sx(xv), sy(yv), r, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (type === 'area') {
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < s.x.length; i += pointStep) {
            const xv = s.x[i];
            const yv = s.y[i];
            if (yv === null || !Number.isFinite(xv) || !Number.isFinite(yv)) continue;
            const py = sy(yv);
            if (!started) {
              ctx.moveTo(sx(xv), sy(Math.max(yLo, 0)));
              ctx.lineTo(sx(xv), py);
              started = true;
            } else {
              ctx.lineTo(sx(xv), py);
            }
          }
          if (started) {
            const last = s.x[s.x.length - 1];
            ctx.lineTo(sx(last), sy(Math.max(yLo, 0)));
            ctx.closePath();
            ctx.globalAlpha = 0.18;
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          ctx.beginPath();
          let pen = false;
          for (let i = 0; i < s.x.length; i += pointStep) {
            const xv = s.x[i];
            const yv = s.y[i];
            if (yv === null || !Number.isFinite(xv) || !Number.isFinite(yv)) {
              pen = false;
              continue;
            }
            const px = sx(xv);
            const py = sy(yv);
            if (!pen) {
              ctx.moveTo(px, py);
              pen = true;
            } else ctx.lineTo(px, py);
          }
          ctx.stroke();
        } else {
          ctx.beginPath();
          let pen = false;
          for (let i = 0; i < s.x.length; i += pointStep) {
            const xv = s.x[i];
            const yv = s.y[i];
            if (yv === null || !Number.isFinite(xv) || !Number.isFinite(yv)) {
              pen = false;
              continue;
            }
            const px = sx(xv);
            const py = sy(yv);
            if (!pen) {
              ctx.moveTo(px, py);
              pen = true;
            } else ctx.lineTo(px, py);
          }
          ctx.stroke();
          if (s.x.length < 400 && type !== 'difference') {
            for (let i = 0; i < s.x.length; i++) {
              const yv = s.y[i];
              if (yv === null) continue;
              ctx.beginPath();
              ctx.arc(sx(s.x[i]), sy(yv), 1.8, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        ctx.setLineDash([]);
      });

      // Event markers
      (markers ?? []).forEach((m) => {
        if (!Number.isFinite(m.t) || m.t < xMin || m.t > xMax) return;
        const x = sx(m.t);
        ctx.strokeStyle = '#e0a63c';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, margin.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#e0a63c';
        ctx.beginPath();
        ctx.arc(x, margin.top + 4, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.translate(x + 3, margin.top + plotH + 30);
        ctx.rotate(-0.5);
        ctx.fillStyle = text;
        ctx.textAlign = 'left';
        ctx.font = '9px "Segoe UI", system-ui, sans-serif';
        ctx.fillText(m.label.slice(0, 22), 0, 0);
        ctx.restore();
        ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      });

      // Hover crosshair and readout
      if (hover) {
        const px = Math.min(Math.max(hover.px, margin.left), margin.left + plotW);
        const hoverX = xMin + ((px - margin.left) / plotW) * spanX;
        ctx.strokeStyle = '#9fb3c8';
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(px, margin.top);
        ctx.lineTo(px, margin.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);

        const readouts = series.map((s) => {
          let bestIdx = -1;
          let bestDist = Infinity;
          for (let i = 0; i < s.x.length; i++) {
            const d = Math.abs(s.x[i] - hoverX);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = i;
            }
          }
          const v = bestIdx >= 0 ? s.y[bestIdx] : null;
          return { label: s.label, value: v, unit: s.unit, color: s.color ?? COLORS[series.indexOf(s) % COLORS.length] };
        });
        const boxW = Math.min(300, 130 + Math.max(...readouts.map((r) => (r.label.length + 16) * 6)));
        const boxH = 18 + readouts.length * 14;
        const bx = px + 12 + boxW > w ? px - boxW - 12 : px + 12;
        const by = margin.top + 8;
        ctx.fillStyle = 'rgba(10,15,20,0.92)';
        ctx.strokeStyle = axisColor;
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.strokeRect(bx, by, boxW, boxH);
        ctx.fillStyle = strong;
        ctx.textAlign = 'left';
        ctx.fillText(`t = ${tickLabel(hoverX)}${xLabel ? '' : ' s'}`, bx + 8, by + 13);
        readouts.forEach((r, i) => {
          const y = by + 27 + i * 14;
          ctx.fillStyle = r.color;
          ctx.fillRect(bx + 8, y - 6, 6, 6);
          ctx.fillStyle = text;
          ctx.fillText(r.label.slice(0, 28), bx + 20, y);
          ctx.fillStyle = strong;
          ctx.textAlign = 'right';
          ctx.fillText(r.value === null || !Number.isFinite(r.value) ? '—' : `${tickLabel(r.value)} ${r.unit}`, bx + boxW - 8, y);
          ctx.textAlign = 'left';
        });
      }
      ctx.restore();

      // Axis titles
      ctx.fillStyle = text;
      ctx.textAlign = 'center';
      ctx.fillText(xLabel ?? 'elapsed time [s]', margin.left + plotW / 2, h - 3);
      if (yLabel) {
        ctx.save();
        ctx.translate(12, margin.top + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(yLabel, 0, 0);
        ctx.restore();
      }
    }

    // Title and legend
    if (title) {
      ctx.fillStyle = strong;
      ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(title, margin.left, 11);
    }
    if (showLegend && series.length > 1) {
      let lx = margin.left;
      const ly = h - (type === 'box' || type === 'bar' ? 24 : 16);
      ctx.font = '9px "Segoe UI", system-ui, sans-serif';
      series.slice(0, 8).forEach((s, idx) => {
        const label = s.label.length > 26 ? `${s.label.slice(0, 26)}…` : s.label;
        ctx.fillStyle = s.color ?? COLORS[idx % COLORS.length];
        ctx.fillRect(lx, ly - 6, 8, 8);
        ctx.fillStyle = text;
        ctx.textAlign = 'left';
        ctx.fillText(label, lx + 12, ly + 1);
        lx += 24 + label.length * 4.9;
      });
    }
    if (note) {
      ctx.fillStyle = text;
      ctx.font = '9px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(note, w - 10, h - 3);
    }
  }, [series, type, title, xLabel, yLabel, width, height, xDomain, markers, hover, isCategorical, histogramData, boxData, barData, prepared, dualAxis, showLegend, note, emptyMessage]);

  useEffect(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [draw]);

  useImperativeHandle(ref, () => ({
    exportPng: () => canvasRef.current?.toDataURL('image/png') ?? null,
  }));

  const onWheel = (e: React.WheelEvent) => {
    if (isCategorical) return;
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const base = xDomain ?? (prepared ? [prepared.min, prepared.max] : null);
    if (!base) return;
    const marginLeft = 58;
    const plotW = Math.max(10, width - marginLeft - (dualAxis ? 54 : 14));
    const frac = Math.min(1, Math.max(0, (px - marginLeft) / plotW));
    const cursor = base[0] + frac * (base[1] - base[0]);
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    const next: [number, number] = [cursor - (cursor - base[0]) * factor, cursor + (base[1] - cursor) * factor];
    if (next[1] - next[0] < 1e-9) return;
    setDomain(next);
    e.preventDefault();
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (isCategorical) return;
    const base = xDomain ?? (prepared ? [prepared.min, prepared.max] : null);
    if (!base) return;
    dragRef.current = { startX: e.clientX, domain: base };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    setHover({ px: e.clientX - rect.left, py: e.clientY - rect.top });
    if (dragRef.current && xDomain) {
      const delta = e.clientX - dragRef.current.startX;
      const marginLeft = 58;
      const plotW = Math.max(10, width - marginLeft - (dualAxis ? 54 : 14));
      const shift = (-delta / plotW) * (dragRef.current.domain[1] - dragRef.current.domain[0]);
      setDomain([dragRef.current.domain[0] + shift, dragRef.current.domain[1] + shift]);
      return;
    }
    if (onHoverTime && xDomain) {
      const marginLeft = 58;
      const plotW = Math.max(10, width - marginLeft - (dualAxis ? 54 : 14));
      const frac = Math.min(1, Math.max(0, (hover!.px - marginLeft) / plotW));
      onHoverTime(xDomain[0] + frac * (xDomain[1] - xDomain[0]));
    }
  };

  const onMouseUp = () => {
    dragRef.current = null;
  };

  return (
    <div className="chart" ref={containerRef}>
      <canvas
        ref={canvasRef}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          setHover(null);
          dragRef.current = null;
          onHoverTime?.(null);
        }}
        onDoubleClick={() => setDomain(null)}
        style={{ cursor: isCategorical ? 'default' : dragRef.current ? 'grabbing' : 'crosshair' }}
      />
    </div>
  );
});
