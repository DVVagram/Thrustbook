import {
  MotionAnalysis,
  MotionFrameResult,
  MotionObject,
  analyseObject,
  buildPixelCalibration,
  buildCsv,
  unitLabel,
} from '../../shared/motion';

export interface ReportInput {
  analysis: MotionAnalysis;
  projectName: string;
  results: Record<string, ReturnType<typeof analyseObject>>;
  frameImage?: string | null;
  selectedFrame: number;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

function svgChart(rows: MotionFrameResult[], keys: { key: keyof MotionFrameResult; label: string; color: string }[], title: string, unit: string, width = 760, height = 210): string {
  const values: number[] = [];
  for (const row of rows) {
    for (const k of keys) {
      const value = row[k.key];
      if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
    }
  }
  if (!values.length) return `<div class="empty">No data for ${esc(title)}</div>`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const left = 52;
  const top = 22;
  const plotW = width - left - 14;
  const plotH = height - top - 28;
  const x = (i: number) => left + (rows.length <= 1 ? 0 : (i / (rows.length - 1)) * plotW);
  const y = (v: number) => top + plotH - ((v - min) / span) * plotH;
  const lines = keys
    .map((k) => {
      const points = rows
        .map((row, i) => {
          const value = row[k.key];
          return typeof value === 'number' && Number.isFinite(value) ? `${x(i).toFixed(1)},${y(value).toFixed(1)}` : null;
        })
        .filter(Boolean)
        .join(' ');
      return points ? `<polyline fill="none" stroke="${k.color}" stroke-width="1.8" points="${points}" /><text x="${left + 4}" y="${top + 12 + keys.indexOf(k) * 13}" fill="${k.color}" font-size="10">${esc(k.label)}</text>` : '';
    })
    .join('');
  return `<figure class="chart"><figcaption>${esc(title)} <span>(${esc(unit)})</span></figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
    <rect x="${left}" y="${top}" width="${plotW}" height="${plotH}" fill="#f7fafc" stroke="#d8e1e8"/>
    ${lines}
    <text x="${left}" y="${top + plotH + 16}" font-size="10" fill="#51626f">0 s</text>
    <text x="${left + plotW}" y="${top + plotH + 16}" text-anchor="end" font-size="10" fill="#51626f">${num(rows[rows.length - 1]?.time, 3)} s</text>
    <text x="${left - 5}" y="${top + 10}" text-anchor="end" font-size="10" fill="#51626f">${num(max, 2)}</text>
    <text x="${left - 5}" y="${top + plotH}" text-anchor="end" font-size="10" fill="#51626f">${num(min, 2)}</text>
  </svg></figure>`;
}

function trajectorySvg(object: MotionObject, rows: MotionFrameResult[], unit: string): string {
  if (rows.length < 2) return '<div class="empty">Trajectory needs at least two tracked frames.</div>';
  const xs = rows.map((r) => r.x).filter((v) => Number.isFinite(v));
  const ys = rows.map((r) => r.y).filter((v) => Number.isFinite(v));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const points = rows.map((r) => `${(40 + ((r.x - minX) / rangeX) * 300).toFixed(1)},${(150 - ((r.y - minY) / rangeY) * 115).toFixed(1)}`).join(' ');
  return `<figure class="chart"><figcaption>Trajectory · ${esc(object.name)} <span>(${esc(unit)})</span></figcaption><svg viewBox="0 0 360 190" role="img" aria-label="Trajectory">
    <rect x="40" y="25" width="300" height="125" fill="#f7fafc" stroke="#d8e1e8"/>
    <polyline fill="none" stroke="#1f7fbf" stroke-width="2" points="${points}"/>
    <circle cx="${points.split(' ').at(-1)?.split(',')[0] ?? 40}" cy="${points.split(' ').at(-1)?.split(',')[1] ?? 150}" r="3" fill="#d4686f"/>
    <text x="40" y="168" font-size="10" fill="#51626f">start</text>
    <text x="340" y="168" text-anchor="end" font-size="10" fill="#51626f">${esc(unit)}</text>
  </svg></figure>`;
}

function tableFor(object: MotionObject, result: ReturnType<typeof analyseObject>): string {
  const rows = result.frames;
  if (!rows.length) return '<div class="empty">No tracked frames.</div>';
  const sample = rows.length > 80 ? rows.filter((_, i) => i % Math.ceil(rows.length / 80) === 0 || i === rows.length - 1) : rows;
  const u = result.summary.unit;
  const vu = result.summary.velocityUnit;
  return `<table><thead><tr><th>Frame</th><th>t (s)</th><th>X (${esc(u)})</th><th>Y (${esc(u)})</th><th>Speed (${esc(vu)})</th><th>Accel. (${esc(result.summary.accelerationUnit)})</th><th>Direction (°)</th><th>Quality</th><th>Status</th></tr></thead><tbody>
    ${sample
      .map(
        (r) =>
          `<tr><td>${r.frame + 1}</td><td>${num(r.time, 4)}</td><td>${num(r.x, 3)}</td><td>${num(r.y, 3)}</td><td>${num(r.speed, 3)}</td><td>${num(Math.hypot(r.ax, r.ay), 3)}</td><td>${num(r.directionDeg, 1)}</td><td>${num(r.quality, 0)}</td><td>${esc(r.status)}${r.manual ? ' · manual' : ''}</td></tr>`,
      )
      .join('')}
    </tbody></table>${rows.length > sample.length ? `<p class="small">Showing ${sample.length} of ${rows.length} frames. Export CSV for the complete series.</p>` : ''}`;
}

/** Self-contained, print-friendly HTML. All content is escaped; no external assets. */
export function buildMotionReport({ analysis, projectName, results, frameImage, selectedFrame }: ReportInput): string {
  const media = analysis.media;
  const cal = buildPixelCalibration(analysis.calibration);
  const timing = analysis.media.timingSource === 'video-timestamps'
    ? 'Decoded video timestamps'
    : analysis.media.timingSource === 'manual-fps'
      ? 'Manual FPS (estimated intervals)'
      : analysis.media.timingSource === 'image-sequence'
        ? 'Image sequence / supplied FPS'
        : 'Unknown';
  const keyframeRows = analysis.objects
    .flatMap((object) => object.manualFrames.map((frame) => ({ object: object.name, frame, time: object.frames.find((track) => track.frame === frame)?.time ?? media.timestamps[frame] })))
    .sort((a, b) => a.frame - b.frame || a.object.localeCompare(b.object));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(analysis.name)} — motion analysis</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: "Segoe UI", Arial, sans-serif; color: #1a2933; margin: 28px; font-size: 11px; line-height: 1.45; }
    h1 { margin: 0 0 2px; font-size: 22px; letter-spacing: .04em; }
    h2 { font-size: 14px; border-bottom: 1px solid #d8e1e8; padding-bottom: 4px; margin: 22px 0 9px; }
    .sub { color: #51626f; margin-bottom: 16px; }
    .meta { display: grid; grid-template-columns: 140px 1fr 140px 1fr; gap: 3px 10px; margin: 8px 0 14px; }
    .meta b { color: #51626f; font-weight: 600; }
    .badge { display: inline-block; border: 1px solid #9fb3c8; border-radius: 10px; padding: 1px 8px; font-size: 9px; text-transform: uppercase; letter-spacing: .04em; }
    .note { background: #fff8e6; border-left: 3px solid #d99b2b; padding: 8px 10px; margin: 10px 0; }
    .ok { background: #eef8f2; border-left: 3px solid #42936d; padding: 8px 10px; margin: 10px 0; }
    table { border-collapse: collapse; width: 100%; font-size: 9.5px; margin: 6px 0 12px; }
    th, td { border-bottom: 1px solid #e2e9ee; padding: 3px 4px; text-align: right; }
    th:first-child, td:first-child, th:last-child, td:last-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
    th { color: #51626f; font-weight: 600; background: #f4f7f9; }
    .chart { margin: 8px 0; break-inside: avoid; }
    figcaption { font-weight: 600; color: #2b4659; margin-bottom: 3px; }
    figcaption span { font-weight: 400; color: #6b7f8d; }
    svg { width: 100%; height: auto; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .small, .empty { color: #6b7f8d; font-size: 9.5px; }
    img.frame { width: 100%; max-height: 420px; object-fit: contain; background: #0b1218; }
    .foot { margin-top: 20px; color: #6b7f8d; font-size: 9px; }
  </style></head><body>
  <h1>MOTION ANALYSIS REPORT</h1>
  <div class="sub">${esc(analysis.name)} · ${esc(projectName)} · generated locally ${esc(new Date().toLocaleString())}</div>
  <div class="meta">
    <b>Project</b><span>${esc(projectName)}</span><b>Analysis</b><span>${esc(analysis.name)}</span>
    <b>Media</b><span>${esc(media.name)}</span><b>Media type</b><span>${esc(media.kind)}</span>
    <b>Resolution</b><span>${media.width} × ${media.height} px</span><b>Duration</b><span>${media.duration !== null ? `${num(media.duration, 3)} s` : '—'}</span>
    <b>Frames</b><span>${media.frameCount ?? '—'}</span><b>Frame timing</b><span>${esc(timing)}${media.fps ? ` · mean ${num(media.fps, 3)} fps` : ''}${media.variableFrameRate ? ' · variable' : ''}</span>
    <b>Calibration</b><span>${esc(cal.description.label)}</span><b>Measurement basis</b><span>${cal.calibrated ? `calibrated physical units (${esc(analysis.calibration.lengthUnit)})` : 'image-plane pixels (not calibrated)'}</span>
    <b>Selected frame</b><span>${selectedFrame + 1}</span><b>Objects</b><span>${analysis.objects.length}</span>
    <b>Camera compensation</b><span>${analysis.settings.compensateCamera ? 'requested · background translation only' : 'disabled'}</span><b>Keyframes</b><span>${analysis.objects.reduce((sum, object) => sum + object.manualFrames.length, 0)}</span>
  </div>
  ${cal.calibrated ? `<div class="ok"><b>Calibration active.</b> ${esc(cal.description.detail)} ${esc(cal.description.warnings.join(' '))}</div>` : `<div class="note"><b>No physical calibration.</b> Distances, speeds and accelerations in this report are image-plane pixel values and must not be read as physical measurements. ${esc(cal.description.warnings.join(' '))}</div>`}
  ${media.timingSource === 'unknown' ? `<div class="note">Frame timing is unknown. No scientific time-based result is shown for this analysis.</div>` : ''}
  <h2>Object definitions</h2>
  <table><thead><tr><th>Object</th><th>Outline points</th><th>Reference points</th><th>Known dimensions</th><th>Tracked frames</th><th>Keyframes / corrections</th></tr></thead><tbody>
    ${analysis.objects.map((o) => `<tr><td>${esc(o.name)}</td><td>${o.initialPolygon.length}</td><td>${o.initialReferences.map((r) => esc(r.name)).join(', ') || '—'}</td><td>${o.actualLength > 0 ? `L ${num(o.actualLength, 3)}` : ''}${o.actualWidth ? ` · W ${num(o.actualWidth, 3)}` : ''}${o.actualHeight ? ` · H ${num(o.actualHeight, 3)}` : ''}${o.actualLength > 0 || o.actualWidth || o.actualHeight ? ` ${esc(o.lengthUnit)}` : '—'}</td><td>${o.frames.length}</td><td>${o.manualFrames.length}</td></tr>`).join('')}
  </tbody></table>
  ${keyframeRows.length ? `<h2>Keyframes / manual corrections</h2><table><thead><tr><th>Frame</th><th>Time (s)</th><th>Object</th></tr></thead><tbody>${keyframeRows.map((row) => `<tr><td>${row.frame + 1}</td><td>${num(row.time, 4)}</td><td>${esc(row.object)}</td></tr>`).join('')}</tbody></table>` : ''}
  ${frameImage ? `<h2>Reference frame</h2><img class="frame" src="${frameImage}" alt="Analysis frame with tracking overlay">` : ''}
  ${analysis.objects
    .map((object) => {
      const result = results[object.id];
      if (!result) return '';
      const u = result.summary.unit;
      return `<h2>${esc(object.name)}</h2>
      <table><thead><tr><th>Metric</th><th>Value</th><th>Metric</th><th>Value</th></tr></thead><tbody>
        <tr><td>Tracked frames</td><td>${result.summary.frameCount}</td><td>Elapsed time</td><td>${num(result.summary.duration, 3)} s</td></tr>
        <tr><td>Net displacement</td><td>${num(result.summary.displacement, 3)} ${esc(u)}</td><td>Distance travelled</td><td>${num(result.summary.distance, 3)} ${esc(u)}</td></tr>
        <tr><td>Maximum speed</td><td>${num(result.summary.maxSpeed, 3)} ${esc(result.summary.velocityUnit)}</td><td>Average speed</td><td>${num(result.summary.averageSpeed, 3)} ${esc(result.summary.velocityUnit)}</td></tr>
        <tr><td>Minimum measured speed</td><td>${num(result.summary.minSpeed, 3)} ${esc(result.summary.velocityUnit)}</td><td>Maximum acceleration magnitude</td><td>${num(result.summary.maxAcceleration, 3)} ${esc(result.summary.accelerationUnit)}</td></tr>
        <tr><td>Net direction</td><td>${num(result.summary.netDirectionDeg, 1)}°</td><td>Maximum |Vy|</td><td>${num(result.summary.maxAbsoluteVerticalVelocity, 3)} ${esc(result.summary.velocityUnit)}</td></tr>
        <tr><td>Camera compensation</td><td>${result.summary.cameraCompensated ? 'applied (background translation)' : analysis.settings.compensateCamera ? 'unavailable' : 'disabled'}</td><td>Keyframes</td><td>${object.manualFrames.length}</td></tr>
      </tbody></table>
      ${svgChart(result.frames, [{ key: 'x', label: 'X', color: '#1f7fbf' }, { key: 'y', label: 'Y', color: '#d47a23' }], 'Position vs time', u)}
      ${svgChart(result.frames, [{ key: 'speed', label: 'smoothed', color: '#1f7fbf' }, { key: 'speedRaw', label: 'raw', color: '#d47a23' }], 'Speed vs time', result.summary.velocityUnit)}
      ${svgChart(result.frames, [{ key: 'ax', label: 'Ax', color: '#1f7fbf' }, { key: 'ay', label: 'Ay', color: '#d47a23' }], 'Acceleration components', result.summary.accelerationUnit)}
      <div class="grid2">${trajectorySvg(object, result.frames, u)}${svgChart(result.frames, [{ key: 'directionDeg', label: 'direction', color: '#1f7fbf' }, { key: 'orientationDeg', label: 'orientation', color: '#42936d' }], 'Direction & projected orientation', 'degrees', 360, 190)}</div>
      <h2>Frame measurements</h2>${tableFor(object, result)}
      <p class="small">${esc(object.notes || 'No object notes.')}</p>`;
    })
    .join('')}
  ${analysis.notes ? `<h2>Analysis notes</h2><div class="note">${esc(analysis.notes)}</div>` : ''}
  <h2>Assumptions and limitations</h2>
  <div class="note">
    2D image-plane analysis. Apparent motion depends on camera position, camera motion, lens distortion and perspective. A simple pixel scale is not globally valid when depth changes. Homography is valid only for the calibrated plane. Object orientation is a projected image-plane axis unless independent orientation data exist. Foreshortening estimates are orthographic approximations and do not determine camera mounting angle. Camera compensation, when shown as applied, removes an estimated background translation only; it does not compensate camera zoom, rotation, rolling shutter or parallax. Segmentation and tracking use Meta's SAM 2.1 Small ONNX model on this computer: masks are propagated frame to frame and the resulting outline is what the measurements use. Mask confidence is a heuristic indicator, not a calibrated probability. Manual corrections and keyframes are retained and identified; automatic tracking stops rather than inventing a position when segmentation is lost. The model is an optional on-demand component; no cloud service or network access is used during analysis.
  </div>
  <div class="foot">Generated by Thrustbook · local analysis · ${esc(analysis.name)}. CSV export remains the authoritative frame-by-frame dataset.</div>
  </body></html>`;
}

export function reportFileName(analysis: MotionAnalysis): string {
  return `${analysis.name.replace(/[^\w.-]+/g, '-')}-report`;
}

export function csvFor(analysis: MotionAnalysis): string {
  return analysis.objects.map((object) => `# ${object.name}\n${buildCsv(object, analyseObject(object, analysis.calibration, analysis.settings))}`).join('\n');
}

export function unitText(unit: string): string {
  return unitLabel(unit);
}
