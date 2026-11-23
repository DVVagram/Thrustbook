import React, { useMemo, useState } from 'react';
import { Chart, ChartHandle, ChartSeries } from '../Chart';
import { Badge, Button, Panel, Select, Stat } from '../ui';
import { MotionAnalysis, MotionObject, MotionFrameResult, analyseObject } from '../../shared/motion';

interface Props {
  analysis: MotionAnalysis;
  selectedObject: MotionObject | null;
  results: Record<string, ReturnType<typeof analyseObject>>;
  frame: number;
  onPickTime: (time: number) => void;
  chartRef?: React.Ref<ChartHandle>;
  onExportGraph?: () => void;
}

const fmt = (v: number | null | undefined, digits = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits));

function seriesFrom(rows: MotionFrameResult[], id: string, label: string, key: keyof MotionFrameResult, unit: string, color?: string): ChartSeries {
  return {
    id,
    label,
    x: rows.map((r) => r.time),
    y: rows.map((r) => {
      const value = r[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }),
    unit,
    color,
  };
}

export function AnalysisPanel({ analysis, selectedObject, results, frame, onPickTime, chartRef, onExportGraph }: Props) {
  const [measure, setMeasure] = useState('position');
  const result = selectedObject ? results[selectedObject.id] : null;
  const rows = result?.frames ?? [];
  const current = rows.find((r) => r.frame === frame) ?? null;
  const unit = result?.summary.unit ?? 'px';
  const velocityUnit = result?.summary.velocityUnit ?? 'px/s';
  const accelerationUnit = result?.summary.accelerationUnit ?? 'px/s²';
  const calibration = result?.calibration;

  const chart = useMemo(() => {
    if (!result || rows.length === 0) return { series: [] as ChartSeries[], height: 300, yLabel: '' };
    if (measure === 'position') {
      return { series: [seriesFrom(rows, 'x', `X position [${unit}]`, 'x', unit), seriesFrom(rows, 'y', `Y position [${unit}]`, 'y', unit)], height: 300, yLabel: unit };
    }
    if (measure === 'displacement') {
      return {
        series: [
          seriesFrom(rows, 'dx', `ΔX [${unit}]`, 'dx', unit),
          seriesFrom(rows, 'dy', `ΔY [${unit}]`, 'dy', unit),
          seriesFrom(rows, 'net', `Net displacement [${unit}]`, 'displacement', unit),
          seriesFrom(rows, 'distance', `Cumulative distance [${unit}]`, 'distance', unit),
        ],
        height: 320,
        yLabel: unit,
      };
    }
    if (measure === 'speed') {
      return {
        series: [
          seriesFrom(rows, 'speed', `Smoothed speed [${velocityUnit}]`, 'speed', velocityUnit),
          { ...seriesFrom(rows, 'raw', `Raw speed [${velocityUnit}]`, 'speedRaw', velocityUnit), dash: true },
        ],
        height: 300,
        yLabel: velocityUnit,
      };
    }
    if (measure === 'velocity') {
      return {
        series: [
          seriesFrom(rows, 'vx', `Vx [${velocityUnit}]`, 'vx', velocityUnit),
          seriesFrom(rows, 'vy', `Vy [${velocityUnit}]`, 'vy', velocityUnit),
          { ...seriesFrom(rows, 'speed', `Magnitude [${velocityUnit}]`, 'speed', velocityUnit), dash: true },
        ],
        height: 300,
        yLabel: velocityUnit,
      };
    }
    if (measure === 'acceleration') {
      return {
        series: [
          seriesFrom(rows, 'ax', `Ax [${accelerationUnit}]`, 'ax', accelerationUnit),
          seriesFrom(rows, 'ay', `Ay [${accelerationUnit}]`, 'ay', accelerationUnit),
        ],
        height: 300,
        yLabel: accelerationUnit,
      };
    }
    return {
      series: [
        seriesFrom(rows, 'direction', 'Direction of travel [deg]', 'directionDeg', 'deg'),
        seriesFrom(rows, 'orientation', 'Projected object orientation [deg]', 'orientationDeg', 'deg'),
      ],
      height: 300,
      yLabel: 'degrees',
    };
  }, [measure, result, rows, unit, velocityUnit, accelerationUnit]);

  const trajectory = useMemo<ChartSeries[]>(() => {
    if (!result) return [];
    return [
      {
        id: 'trajectory',
        label: 'Tracked trajectory',
        x: rows.map((r) => r.x),
        y: rows.map((r) => r.y),
        unit,
      },
    ];
  }, [result, rows, unit]);

  if (!selectedObject) {
    return (
      <Panel title="Motion analysis">
        <div className="muted">Select or create an object to calculate its motion measurements.</div>
      </Panel>
    );
  }

  return (
    <div className="stack">
      <Panel
        title={`Motion summary · ${selectedObject.name}`}
        subtitle={calibration ? calibration.description.label : undefined}
        actions={<Badge tone={calibration?.calibrated ? 'ok' : 'warn'}>{calibration?.calibrated ? `Calibrated · ${unit}` : 'Image-plane only'}</Badge>}
      >
        <div className="stat-grid">
          <Stat label="Tracked frames" value={result?.summary.frameCount ?? 0} sub={`${current?.manual ? 'manual correction at current frame' : `${current?.status ?? 'no data'} at current frame`}`} />
          <Stat label="Elapsed time" value={`${fmt(result?.summary.duration, 3)} s`} />
          <Stat label="Net displacement" value={`${fmt(result?.summary.displacement, 3)} ${unit}`} />
          <Stat label="Distance travelled" value={`${fmt(result?.summary.distance, 3)} ${unit}`} />
          <Stat label="Maximum speed" value={`${fmt(result?.summary.maxSpeed, 3)} ${velocityUnit}`} />
          <Stat label="Average speed" value={`${fmt(result?.summary.averageSpeed, 3)} ${velocityUnit}`} />
          <Stat label="Maximum acceleration" value={`${fmt(result?.summary.maxAcceleration, 3)} ${accelerationUnit}`} />
          <Stat label="Net direction" value={result?.summary.netDirectionDeg !== null ? `${fmt(result?.summary.netDirectionDeg, 1)}°` : '—'} sub="Image-plane angle, +Y downwards" />
        </div>
        {calibration && (
          <div className={`motion-cal-note ${calibration.calibrated ? 'ok' : 'warn'}`}>
            <strong>{calibration.description.label}.</strong> {calibration.description.detail}
            {calibration.description.warnings.length > 0 && <span> {calibration.description.warnings.join(' ')}</span>}
          </div>
        )}
        <div className={`motion-cal-note ${result?.summary.cameraCompensated ? 'ok' : analysis.settings.compensateCamera ? 'warn' : ''}`}>
          <strong>Camera motion:</strong>{' '}
          {result?.summary.cameraCompensated
            ? 'background translation was estimated from features outside the object and subtracted from the image positions.'
            : analysis.settings.compensateCamera
              ? 'compensation was requested but is unavailable for this track. Re-track after enabling it; missing background estimates are never treated as zero motion.'
              : 'not compensated. Positions are relative to the image frame, not the surrounding scene.'}
        </div>
      </Panel>

      <Panel
        title="Synchronised graphs"
        subtitle="Click a graph to jump to the nearest tracked frame. Wheel zooms; drag pans; double-click resets."
        actions={
          <div className="row-actions">
            {onExportGraph && <Button size="sm" icon="download" onClick={onExportGraph}>Graph PNG</Button>}
            <Select
              value={measure}
              onChange={setMeasure}
              options={[
                { value: 'position', label: 'Position vs time' },
                { value: 'displacement', label: 'Displacement & distance' },
                { value: 'speed', label: 'Speed' },
                { value: 'velocity', label: 'Velocity components' },
                { value: 'acceleration', label: 'Acceleration components' },
                { value: 'angles', label: 'Direction & orientation' },
              ]}
            />
          </div>
        }
      >
        {rows.length === 0 ? (
          <div className="muted">No tracking frames yet. Track the object to populate the graphs.</div>
        ) : (
          <Chart
            ref={chartRef}
            series={chart.series}
            type="timeseries"
            height={chart.height}
            xLabel="time [s]"
            yLabel={chart.yLabel}
            markers={current ? [{ t: current.time, label: `frame ${current.frame + 1}` }] : []}
            onPickTime={onPickTime}
            note={calibration?.calibrated ? 'Calibrated user coordinates' : 'Image-plane coordinates (pixels)'}
          />
        )}
      </Panel>

      <div className="motion-two-col">
        <Panel title="Trajectory" subtitle={`${unit} · ${calibration?.calibrated ? 'calibrated' : 'image plane'}`}>
          {rows.length > 1 ? (
            <Chart series={trajectory} type="xy" height={300} xLabel={`X [${unit}]`} yLabel={`Y [${unit}]`} showLegend={false} />
          ) : (
            <div className="muted">At least two tracked frames are needed to draw a trajectory.</div>
          )}
        </Panel>
        <Panel title="Current frame measurements">
          {current ? (
            <div className="kv-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
              {[
                ['Frame', String(current.frame + 1)],
                ['Time', `${fmt(current.time, 4)} s`],
                ['Pixel position', `${fmt(current.pixelX, 1)}, ${fmt(current.pixelY, 1)} px`],
                ['User position', `${fmt(current.x, 3)}, ${fmt(current.y, 3)} ${unit}`],
                ['Displacement', `${fmt(current.displacement, 3)} ${unit}`],
                ['Distance', `${fmt(current.distance, 3)} ${unit}`],
                ['Speed (smoothed)', `${fmt(current.speed, 3)} ${velocityUnit}`],
                ['Speed (raw)', `${fmt(current.speedRaw, 3)} ${velocityUnit}`],
                ['Velocity', `${fmt(current.vx, 3)}, ${fmt(current.vy, 3)} ${velocityUnit}`],
                ['Acceleration', `${fmt(current.ax, 3)}, ${fmt(current.ay, 3)} ${accelerationUnit}`],
                ['Direction', current.directionDeg === null ? '—' : `${fmt(current.directionDeg, 2)}°`],
                ['Orientation', current.orientationDeg === null ? '—' : `${fmt(current.orientationDeg, 2)}°`],
                ['Angular velocity', current.angularVelocityDeg === null ? '—' : `${fmt(current.angularVelocityDeg, 2)} °/s`],
                ['Apparent length', `${fmt(current.apparentLength, 3)} ${unit}`],
                ['Distance / object length', current.relativeDistance === null ? '—' : `${fmt(current.relativeDistance, 2)} ×`],
                ['Camera compensation', current.cameraCompensated ? 'background translation removed' : 'not applied'],
                ['Camera offset', `${fmt(current.cameraDx, 1)}, ${fmt(current.cameraDy, 1)} px`],
                ['Tracking quality', `${fmt(current.quality, 0)} / 100`],
              ].map(([key, value]) => (
                <div className="kv-item" key={key}>
                  <span className="kv-key">{key}</span>
                  <span className="kv-value mono">{value}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted">No tracked frame at frame {frame + 1}. Move to a tracked frame or correct the outline here.</div>
          )}
        </Panel>
      </div>

      {selectedObject.frames.length > 0 && (
        <Panel title="Review tracking quality" subtitle="Frames below the confidence threshold are flagged for manual review.">
          <div className="motion-review-list">
            {selectedObject.frames
              .filter((f) => f.status === 'uncertain' || f.quality < analysis.settings.qualityThreshold || f.status === 'manual')
              .slice(0, 100)
              .map((f) => (
                <button
                  key={f.frame}
                  className={`motion-review-item ${f.frame === frame ? 'active' : ''}`}
                  onClick={() => onPickTime(f.time)}
                >
                  <span className="mono">frame {f.frame + 1}</span>
                  <Badge tone={f.status === 'manual' ? 'neutral' : f.status === 'uncertain' ? 'warn' : 'ok'}>{f.status}</Badge>
                  <span className="mono">{fmt(f.quality, 0)}</span>
                  <span className="muted small">{f.qualityNotes[0] ?? 'below review threshold'}</span>
                </button>
              ))}
            {selectedObject.frames.every((f) => f.status === 'tracked' && f.quality >= analysis.settings.qualityThreshold) && (
              <div className="muted small">No frames are currently flagged.</div>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}

export function allObjectResults(analysis: MotionAnalysis): Record<string, ReturnType<typeof analyseObject>> {
  const map: Record<string, ReturnType<typeof analyseObject>> = {};
  for (const object of analysis.objects) map[object.id] = analyseObject(object, analysis.calibration, analysis.settings);
  return map;
}

