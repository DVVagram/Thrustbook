import React, { useEffect, useRef, useState } from 'react';
import { Keyframe, KeyframeAnalysis, KeyframeMedia, KeyframePoint } from '../../shared/keyframes';

export type KeyframeTool = 'mark' | 'calibration';

interface Props {
  media: KeyframeMedia;
  mediaUrl: string;
  videoUrl: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  keyframes: Keyframe[];
  analysis: KeyframeAnalysis;
  frame: number;
  time: number | null;
  tool: KeyframeTool;
  selectedId: string | null;
  scalePointA: KeyframePoint | null;
  scalePointB: KeyframePoint | null;
  onPlace: (point: KeyframePoint) => void;
  onMove: (id: string, point: KeyframePoint) => void;
  onSelect: (id: string | null) => void;
  onCalibrationPoint: (point: KeyframePoint) => void;
  onVideoTime: (time: number) => void;
  onVideoReady: () => void;
  onPlayState: (playing: boolean) => void;
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.abs(value) >= 1000 ? value.toFixed(0) : value.toFixed(digits);
}

export function KeyframeStage({
  media,
  mediaUrl,
  videoUrl,
  videoRef,
  keyframes,
  analysis,
  frame,
  time,
  tool,
  selectedId,
  scalePointA,
  scalePointB,
  onPlace,
  onMove,
  onSelect,
  onCalibrationPoint,
  onVideoTime,
  onVideoReady,
  onPlayState,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  dragRef.current = dragId;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? canvas.clientWidth;
      setViewportWidth((previous) => (Math.abs(previous - width) < 0.5 ? previous : width));
    });
    observer.observe(canvas);
    setViewportWidth(canvas.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !media.width || !media.height) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width || media.width;
    const cssHeight = rect.height || media.height;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const backingWidth = Math.max(1, Math.round(cssWidth * dpr));
    const backingHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scaleX = (canvas.width / media.width) * 1;
    const scaleY = (canvas.height / media.height) * 1;
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

    const unit = media.width / Math.max(1, cssWidth);
    const ordered = [...keyframes].sort((a, b) => a.frame - b.frame);
    const rows = new Map(analysis.rows.map((row) => [row.id, row]));

    const dot = (point: KeyframePoint, color: string, radius: number) => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius + 2 * unit, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(2, 9, 15, 0.7)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#f7fbff';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * unit;
      ctx.stroke();
      ctx.restore();
    };

    const label = (point: KeyframePoint, text: string, color: string, offsetX = 10, offsetY = -10) => {
      ctx.save();
      ctx.font = `600 ${11 * unit}px "Segoe UI", sans-serif`;
      const padding = 4 * unit;
      const height = 15 * unit;
      const width = ctx.measureText(text).width + padding * 2;
      const x = point.x + offsetX * unit;
      const y = point.y + offsetY * unit - height;
      ctx.fillStyle = 'rgba(3, 10, 16, 0.88)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.8 * unit;
      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);
      ctx.fillStyle = '#f2f8ff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + padding, y + height / 2 + 0.5 * unit);
      ctx.restore();
    };

    if (scalePointA && scalePointB) {
      ctx.save();
      ctx.strokeStyle = '#f0b75a';
      ctx.lineWidth = 1.5 * unit;
      ctx.setLineDash([5 * unit, 4 * unit]);
      ctx.beginPath();
      ctx.moveTo(scalePointA.x, scalePointA.y);
      ctx.lineTo(scalePointB.x, scalePointB.y);
      ctx.stroke();
      ctx.restore();
      dot(scalePointA, '#f0b75a', 4 * unit);
      dot(scalePointB, '#f0b75a', 4 * unit);
      label(scalePointB, `${formatNumber(analysis.scale.pixelDistance, 1)} px`, '#f0b75a', -110, 24);
    } else {
      if (scalePointA) dot(scalePointA, '#f0b75a', 4 * unit);
      if (scalePointB) dot(scalePointB, '#f0b75a', 4 * unit);
    }

    if (ordered.length > 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(103, 206, 255, 0.7)';
      ctx.lineWidth = 1.4 * unit;
      ctx.setLineDash([4 * unit, 3 * unit]);
      ctx.beginPath();
      ctx.moveTo(ordered[0].x, ordered[0].y);
      for (const entry of ordered.slice(1)) ctx.lineTo(entry.x, entry.y);
      ctx.stroke();
      ctx.restore();

      for (let index = 1; index < ordered.length; index++) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        const row = rows.get(current.id);
        if (!row || row.speed === null) continue;
        label(
          { x: (previous.x + current.x) / 2, y: (previous.y + current.y) / 2 },
          `${formatNumber(row.speed, 2)} ${analysis.summary.velocityUnit}`,
          'rgba(103, 206, 255, 0.85)',
          -34,
          -8,
        );
      }
    }

    ordered.forEach((entry, index) => {
      const active = entry.frame === frame;
      const selected = entry.id === selectedId;
      const color = active ? '#67ceff' : selected ? '#f0a15b' : 'rgba(150, 185, 208, 0.85)';
      dot(entry, color, active ? 6 * unit : 4.5 * unit);
      if (active || selected) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(entry.x, entry.y, 12 * unit, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2 * unit;
        ctx.stroke();
        ctx.restore();
      }
      label(entry, `#${index + 1}${entry.time !== null ? ` · ${entry.time.toFixed(3)} s` : ''}`, color, 8, active ? -12 : -8);
    });

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.font = '600 12px "Segoe UI", sans-serif';
    const row = rows.get(selectedId ?? '') ?? analysis.rows.find((item) => item.frame === frame);
    const text = `Frame ${frame + 1}${time !== null ? ` · t=${time.toFixed(4)} s` : ' · time unknown'}${
      row ? ` · x=${formatNumber(row.x, 1)} ${analysis.summary.unit}` : ''
    }`;
    const width = ctx.measureText(text).width + 16;
    ctx.fillStyle = 'rgba(4, 11, 17, 0.84)';
    ctx.strokeStyle = 'rgba(133, 160, 181, 0.28)';
    ctx.lineWidth = 1;
    ctx.fillRect(8, 8, width, 23);
    ctx.strokeRect(8, 8, width, 23);
    ctx.fillStyle = '#d8e9f7';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 16, 19.5);
    ctx.restore();
  }, [analysis, frame, keyframes, media.height, media.width, scalePointA, scalePointB, selectedId, time, tool, viewportWidth]);

  const toMediaPoint = (event: React.PointerEvent<HTMLCanvasElement>): KeyframePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(media.width, ((event.clientX - rect.left) / Math.max(1, rect.width)) * media.width)),
      y: Math.max(0, Math.min(media.height, ((event.clientY - rect.top) / Math.max(1, rect.height)) * media.height)),
    };
  };

  const hitTest = (point: KeyframePoint, event: React.PointerEvent<HTMLCanvasElement>): string | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const cssPerMedia = rect.width / Math.max(1, media.width);
    const tolerance = 14 / Math.max(0.001, cssPerMedia);
    let best: string | null = null;
    let bestDistance = tolerance;
    for (const entry of keyframes) {
      const distance = Math.hypot(entry.x - point.x, entry.y - point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = entry.id;
      }
    }
    return best;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const point = toMediaPoint(event);
    const hit = hitTest(point, event);
    if (hit) {
      onSelect(hit);
      if (keyframes.find((entry) => entry.id === hit)?.frame === frame) {
        setDragId(hit);
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (tool === 'calibration') onCalibrationPoint(point);
    else onPlace(point);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    onMove(dragRef.current, toMediaPoint(event));
  };

  const endDrag = () => setDragId(null);

  return (
    <div
      className="keyframe-stage"
      style={{ aspectRatio: media.width && media.height ? `${media.width} / ${media.height}` : '16 / 9' }}
    >
      <div className="keyframe-stage-inner">
        {media.kind === 'video' ? (
          <video
            crossOrigin="anonymous"
            ref={videoRef}
            src={videoUrl}
            className="keyframe-media"
            preload="auto"
            playsInline
            onLoadedMetadata={onVideoReady}
            onTimeUpdate={(event) => onVideoTime(event.currentTarget.currentTime)}
            onPlay={() => onPlayState(true)}
            onPause={() => onPlayState(false)}
            onEnded={() => onPlayState(false)}
          />
        ) : (
          <img crossOrigin="anonymous" src={mediaUrl} className="keyframe-media" alt={media.name} onLoad={onVideoReady} />
        )}
      </div>
      <canvas
        ref={canvasRef}
        className="keyframe-overlay"
        data-testid="keyframe-overlay"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(event) => event.preventDefault()}
        style={{ cursor: tool === 'calibration' ? 'cell' : 'crosshair' }}
      />
      <div className="keyframe-stage-hint">
        {tool === 'calibration'
          ? 'Click the two ends of the known distance'
          : keyframes.some((entry) => entry.frame === frame)
            ? 'Click to move this frame’s keyframe · drag a marker to adjust it'
            : 'Click the rocket to place a keyframe on this frame'}
      </div>
    </div>
  );
}
