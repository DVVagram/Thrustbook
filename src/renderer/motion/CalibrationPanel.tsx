import React from 'react';
import { Badge, Button, Checkbox, Field, Input, Panel, Select, Textarea } from '../ui';
import { unitsForDimension, convertUnit } from '../../shared/units';
import {
  CalibrationMode,
  MotionAnalysis,
  MotionCalibration,
  MotionObject,
  MotionSettings,
  buildPixelCalibration,
  distance,
  foreshorteningEstimate,
  analyseObject,
} from '../../shared/motion';
import { MotionTool } from './MotionStage';

interface Props {
  analysis: MotionAnalysis;
  selectedObject: MotionObject | null;
  result: ReturnType<typeof analyseObject> | null;
  frame: number;
  currentTime: number | null;
  tool: MotionTool;
  onTool: (tool: MotionTool) => void;
  onCalibration: (patch: Partial<MotionCalibration>) => void;
  onSettings: (patch: Partial<MotionSettings>) => void;
  onObject: (patch: Partial<MotionObject>) => void;
  onUseObjectReferences: () => void;
  onClearCalibration: () => void;
}

const lengthUnits = unitsForDimension('length').map((u) => ({ value: u.symbol, label: `${u.label} (${u.symbol})` }));

export function CalibrationPanel({
  analysis,
  selectedObject,
  result,
  frame,
  currentTime,
  tool,
  onTool,
  onCalibration,
  onSettings,
  onObject,
  onUseObjectReferences,
  onClearCalibration,
}: Props) {
  const calibration = analysis.calibration;
  const scale = buildPixelCalibration(calibration);
  const current = result?.frames.find((r) => r.frame === frame) ?? null;
  const apparent = current?.apparentLength ?? null;
  const actualInCalibrationUnit =
    selectedObject && calibration.lengthUnit
      ? convertUnit(selectedObject.actualLength, selectedObject.lengthUnit || calibration.lengthUnit, calibration.lengthUnit)
      : null;
  const foreshortening =
    apparent !== null && actualInCalibrationUnit !== null && scale.calibrated
      ? foreshorteningEstimate(apparent, actualInCalibrationUnit)
      : null;
  const referencesAtFrame =
    selectedObject?.frames.find((f) => f.frame === frame)?.references ?? selectedObject?.initialReferences ?? [];
  const referencePairs = referencesAtFrame.slice(0, 4).flatMap((a, index) =>
    referencesAtFrame.slice(index + 1, 4).map((b) => ({
      key: `${a.id}-${b.id}`,
      label: `${a.name} ↔ ${b.name}`,
      value: distance(scale.toMetric(a.point), scale.toMetric(b.point)),
      unit: scale.calibrated ? calibration.lengthUnit : 'px',
    })),
  );
  const referenceAngles = referencesAtFrame.length >= 3
    ? referencesAtFrame.slice(0, 3).map((point, index, all) => {
        if (index === 0) return null;
        const previous = all[index - 1];
        const next = all[index + 1];
        if (!next) return null;
        const ax = previous.point.x - point.point.x;
        const ay = previous.point.y - point.point.y;
        const bx = next.point.x - point.point.x;
        const by = next.point.y - point.point.y;
        const denominator = Math.hypot(ax, ay) * Math.hypot(bx, by);
        if (!denominator) return null;
        const angle = (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / denominator))) * 180) / Math.PI;
        return { key: `${previous.id}-${point.id}-${next.id}`, label: `${previous.name} – ${point.name} – ${next.name}`, angle };
      }).filter((item): item is { key: string; label: string; angle: number } => !!item)
    : [];

  return (
    <div className="stack">
      <Panel
        title="Coordinate system & physical scale"
        subtitle="Calibration applies to all objects in this analysis"
        actions={<Badge tone={scale.calibrated ? 'ok' : scale.description.active ? 'warn' : 'neutral'}>{scale.description.label}</Badge>}
      >
        <div className="form-grid">
          <Field label="Calibration model">
            <Select
              value={calibration.mode}
              onChange={(value) => onCalibration({ mode: value as CalibrationMode })}
              options={[
                { value: 'none', label: 'Image plane only (pixels)' },
                { value: 'scale', label: 'Pixel-to-distance scale (image axes)' },
                { value: 'rotated', label: 'Rotated coordinate system' },
                { value: 'homography', label: 'Planar homography (4 corners, one plane)' },
              ]}
            />
          </Field>
          <Field label="Origin">
            <div className="inline-field">
              <Input
                type="number"
                step="0.1"
                value={calibration.origin.x}
                onChange={(e) => onCalibration({ origin: { ...calibration.origin, x: Number(e.target.value) } })}
              />
              <Input
                type="number"
                step="0.1"
                value={calibration.origin.y}
                onChange={(e) => onCalibration({ origin: { ...calibration.origin, y: Number(e.target.value) } })}
              />
              <Button size="sm" onClick={() => onTool('origin')} variant={tool === 'origin' ? 'primary' : 'default'}>
                Pick on video
              </Button>
            </div>
            <span className="field-hint">Origin in source-image pixels. Positive image Y points down.</span>
          </Field>
        </div>

        {calibration.mode === 'rotated' && (
          <div className="motion-cal-grid">
            <div>
              <div className="field-label">X axis direction</div>
              <div className="muted small mono">
                ({calibration.xAxisPoint.x.toFixed(1)}, {calibration.xAxisPoint.y.toFixed(1)}) px
              </div>
              <Button size="sm" variant={tool === 'xaxis' ? 'primary' : 'default'} onClick={() => onTool('xaxis')}>Draw X direction</Button>
            </div>
            <div>
              <div className="field-label">Y axis direction</div>
              <div className="muted small mono">
                ({calibration.yAxisPoint.x.toFixed(1)}, {calibration.yAxisPoint.y.toFixed(1)}) px
              </div>
              <Button size="sm" variant={tool === 'yaxis' ? 'primary' : 'default'} onClick={() => onTool('yaxis')}>Draw Y direction</Button>
            </div>
          </div>
        )}

        {calibration.mode === 'homography' ? (
          <div className="form-grid">
            <Field label="Reference width" hint="Physical width of the marked quadrilateral">
              <div className="inline-field">
                <Input type="number" min="0" step="0.001" value={calibration.homographyWidth} onChange={(e) => onCalibration({ homographyWidth: Number(e.target.value) })} />
                <Select value={calibration.lengthUnit} onChange={(value) => onCalibration({ lengthUnit: value })} options={lengthUnits} />
              </div>
            </Field>
            <Field label="Reference height">
              <Input type="number" min="0" step="0.001" value={calibration.homographyHeight} onChange={(e) => onCalibration({ homographyHeight: Number(e.target.value) })} />
            </Field>
            <div className="field-full">
              <div className="muted small">
                Mark four corners in order: top-left, top-right, bottom-right, bottom-left. {calibration.homographyPoints.length} of 4 points set.
              </div>
              <div className="row-actions">
                <Button size="sm" variant={tool === 'homography' ? 'primary' : 'default'} onClick={() => onTool('homography')}>
                  {tool === 'homography' ? 'Click four corners…' : 'Set four corners'}
                </Button>
                <Button size="sm" onClick={() => onCalibration({ homographyPoints: [] })}>Clear corners</Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="form-grid">
            <Field label="Known distance" hint="Distance between scale points A and B">
              <div className="inline-field">
                <Input type="number" min="0" step="0.001" value={calibration.knownLength} onChange={(e) => onCalibration({ knownLength: Number(e.target.value) })} />
                <Select value={calibration.lengthUnit} onChange={(value) => onCalibration({ lengthUnit: value })} options={lengthUnits} />
              </div>
            </Field>
            <Field label="Scale reference">
              <div className="inline-field">
                <Button size="sm" variant={tool === 'scale-a' ? 'primary' : 'default'} onClick={() => onTool('scale-a')}>Point A</Button>
                <Button size="sm" variant={tool === 'scale-b' ? 'primary' : 'default'} onClick={() => onTool('scale-b')}>Point B</Button>
                <Button size="sm" onClick={onClearCalibration}>Clear</Button>
              </div>
              <span className="field-hint">
                {Math.hypot(calibration.scalePointB.x - calibration.scalePointA.x, calibration.scalePointB.y - calibration.scalePointA.y).toFixed(1)} px between points
              </span>
            </Field>
            <Field label="Use selected object's nose/tail">
              <Button size="sm" onClick={onUseObjectReferences} disabled={!selectedObject}>
                Use first two reference points
              </Button>
              <span className="field-hint">Requires two named reference points and a known object length below.</span>
            </Field>
          </div>
        )}

        {scale.description.warnings.length > 0 && (
          <div className="motion-cal-note warn">
            {scale.description.warnings.map((warning) => (
              <div key={warning}>• {warning}</div>
            ))}
          </div>
        )}
        {scale.calibrated && (
          <div className="motion-cal-note ok">
            <strong>{scale.description.label}.</strong> {scale.description.detail}
          </div>
        )}
      </Panel>

      <Panel title="Object dimensions">
        {!selectedObject ? (
          <div className="muted">Select an object to enter its physical dimensions.</div>
        ) : (
          <div className="form-grid">
            <Field label="Actual object length" hint="Used only as a relative reference; apparent length still changes with rotation, perspective and depth.">
              <div className="inline-field">
                <Input type="number" min="0" step="0.001" value={selectedObject.actualLength} onChange={(e) => onObject({ actualLength: Number(e.target.value) })} />
                <Select value={selectedObject.lengthUnit} onChange={(value) => onObject({ lengthUnit: value })} options={lengthUnits} />
              </div>
            </Field>
            <Field label="Known width" hint="Optional. Stored as part of the object's physical geometry; it is not inferred from a single view.">
              <Input type="number" min="0" step="0.001" value={selectedObject.actualWidth ?? 0} onChange={(e) => onObject({ actualWidth: Number(e.target.value) })} />
            </Field>
            <Field label="Known height" hint="Optional. Height may not be observable from a single camera view.">
              <Input type="number" min="0" step="0.001" value={selectedObject.actualHeight ?? 0} onChange={(e) => onObject({ actualHeight: Number(e.target.value) })} />
            </Field>
            <Field label="Reference point pair" hint="First two points define orientation and apparent length. Name them Nose/Tail for clarity.">
              <div className="muted small">
                {referencesAtFrame.length} points at/near current frame
              </div>
            </Field>
            {referencePairs.length > 0 && (
              <div className="field-full">
                <div className="field-label">Measured reference-point distances</div>
                <div className="motion-reference-list">
                  {referencePairs.map((pair) => (
                    <div className="motion-reference-item" key={pair.key}>
                      <span>{pair.label}</span>
                      <span className="mono small">{pair.value.toFixed(3)} {pair.unit}</span>
                    </div>
                  ))}
                </div>
                <span className="field-hint">Distances use the active calibration; image-plane values are pixels, not physical lengths.</span>
              </div>
            )}
            {referenceAngles.length > 0 && (
              <div className="field-full">
                <div className="field-label">Reference-point angles (image plane)</div>
                <div className="motion-reference-list">
                  {referenceAngles.map((item) => (
                    <div className="motion-reference-item" key={item.key}>
                      <span>{item.label}</span>
                      <span className="mono small">{item.angle.toFixed(2)}°</span>
                    </div>
                  ))}
                </div>
                <span className="field-hint">Angles are measured between the first three reference points in the image plane.</span>
              </div>
            )}
            <Field label="Notes">
              <Textarea rows={2} value={selectedObject.notes} onChange={(e) => onObject({ notes: e.target.value })} placeholder="Camera setup, measurement assumptions, known uncertainties…" />
            </Field>
          </div>
        )}
      </Panel>

      <Panel title="Perspective & foreshortening" subtitle="Only shown when the assumptions are satisfied">
        {!scale.calibrated ? (
          <div className="muted small">
            A valid physical calibration is required before an apparent length can be compared with a known physical length. Without it, only pixel lengths can be reported.
          </div>
        ) : !foreshortening ? (
          <div className="muted small">
            Track the selected object at this frame and enter its actual length to estimate the orthographic foreshortening angle.
          </div>
        ) : (
          <div className="stack">
            <div className="stat-grid">
              <div className="stat">
                <span className="stat-label">Apparent length</span>
                <span className="stat-value">{apparent?.toFixed(3)} {calibration.lengthUnit}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Apparent / actual</span>
                <span className="stat-value">{foreshortening.ratio?.toFixed(3) ?? '—'}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Orthographic angle to view axis</span>
                <span className="stat-value">{foreshortening.valid ? `${foreshortening.angleDeg?.toFixed(2)}°` : 'not valid'}</span>
              </div>
            </div>
            <div className="motion-cal-note warn">
              {foreshortening.reason} This is not a measurement of the camera's physical mounting angle. A single view cannot separate object rotation, camera viewing direction and depth.
            </div>
          </div>
        )}
        <div className="muted small" style={{ marginTop: 8 }}>
          3D reconstruction from one ordinary video is not provided. Multiple synchronised, calibrated camera views and point correspondences would be required. No depth coordinates are invented.
        </div>
      </Panel>

      <Panel title="Analysis settings" subtitle="Advanced settings stay here so the main workspace remains uncluttered">
        <div className="form-grid">
          <Field label="Smoothing window (frames)" hint="1 = raw values only. Smoothing never replaces the raw series.">
            <Input type="number" min="1" max="31" step="1" value={analysis.settings.smoothingWindow} onChange={(e) => onSettings({ smoothingWindow: Math.max(1, Number(e.target.value)) })} />
          </Field>
          <Field label="Review threshold" hint="Quality below this is marked uncertain, not deleted.">
            <Input type="number" min="0" max="100" step="1" value={analysis.settings.qualityThreshold} onChange={(e) => onSettings({ qualityThreshold: Math.min(100, Math.max(0, Number(e.target.value))) })} />
          </Field>
          <Field label="Camera motion compensation" hint="Estimates background translation and removes it before measurement. Does not handle zoom, rotation or parallax. Re-track to populate background estimates.">
            <Checkbox
              checked={analysis.settings.compensateCamera}
              onChange={(v) => onSettings({ compensateCamera: v })}
              label="Compensate background translation"
            />
          </Field>
          <Field label="Processing width (px)" hint="Lower values are faster. Tracking is mapped back to source pixels.">
            <Input type="number" min="320" max="3840" step="80" value={analysis.settings.processingMaxWidth} onChange={(e) => onSettings({ processingMaxWidth: Math.min(3840, Math.max(320, Number(e.target.value))) })} />
          </Field>
          <Field label="Features per frame" hint="More features can help textured objects but cost time.">
            <Input type="number" min="20" max="500" step="10" value={analysis.settings.maxFeatures} onChange={(e) => onSettings({ maxFeatures: Math.min(500, Math.max(20, Number(e.target.value))) })} />
          </Field>
          <Field label="Analysis start frame">
            <Input type="number" min="0" max={Math.max(0, (analysis.media.frameCount ?? 1) - 1)} value={analysis.settings.startFrame} onChange={(e) => onSettings({ startFrame: Math.max(0, Number(e.target.value)) })} />
          </Field>
          <Field label="Analysis end frame" hint="0 means the last available frame.">
            <Input type="number" min="0" max={Math.max(0, (analysis.media.frameCount ?? 1) - 1)} value={analysis.settings.endFrame} onChange={(e) => onSettings({ endFrame: Math.max(0, Number(e.target.value)) })} />
          </Field>
          <div className="field-full">
            <div className="checkbox-row">
              <Checkbox checked={analysis.settings.showOutline} onChange={(v) => onSettings({ showOutline: v })} label="Outline" />
              <Checkbox checked={analysis.settings.showBoundingBox} onChange={(v) => onSettings({ showBoundingBox: v })} label="Bounding box" />
              <Checkbox checked={analysis.settings.showReferences} onChange={(v) => onSettings({ showReferences: v })} label="Reference points" />
              <Checkbox checked={analysis.settings.showAxes} onChange={(v) => onSettings({ showAxes: v })} label="Axes & origin" />
              <Checkbox checked={analysis.settings.showTrajectory} onChange={(v) => onSettings({ showTrajectory: v })} label="Trajectory" />
              <Checkbox checked={analysis.settings.showReadout} onChange={(v) => onSettings({ showReadout: v })} label="Frame readout" />
            </div>
          </div>
        </div>
        {currentTime !== null && <div className="muted small">Current frame {frame + 1} · t = {currentTime.toFixed(4)} s</div>}
      </Panel>
    </div>
  );
}
