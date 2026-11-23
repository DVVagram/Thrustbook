import React, { useEffect, useRef, useState } from 'react';
import {
  MotionAnalysis,
  MotionObject,
  MotionPoint,
  MotionReferencePoint,
  TrackFrame,
  polygonBounds,
  polygonCentroid,
} from '../../shared/motion';

export type MotionTool =
  | 'select'
  | 'polygon'
  | 'rectangle'
  | 'reference'
  | 'origin'
  | 'xaxis'
  | 'yaxis'
  | 'scale-a'
  | 'scale-b'
  | 'homography';

interface Props {
  analysis: MotionAnalysis;
  mediaUrl: string;
  videoUrl: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  selectedObject: MotionObject | null;
  frame: number;
  tool: MotionTool;
  draftPolygon: MotionPoint[];
  draftReferences: MotionReferencePoint[];
  selectedPoint: number;
  readout: { time: number | null; x: number | null; y: number | null; speed: number | null; calibrated: boolean; unit: string } | null;
  onCanvasPoint: (point: MotionPoint) => void;
  onRectangle: (a: MotionPoint, b: MotionPoint) => void;
  onMovePoint: (index: number, point: MotionPoint) => void;
  onMoveReference: (index: number, point: MotionPoint) => void;
  onInsertPoint: (index: number, point: MotionPoint) => void;
  onBeginPointDrag: () => void;
  onBeginReferenceDrag: () => void;
  onSelectPoint: (index: number) => void;
  onCalibrationPoint: (tool: MotionTool, point: MotionPoint) => void;
  onVideoTime: (time: number) => void;
  onVideoReady: () => void;
  onPlayState: (playing: boolean) => void;
  onFinishPolygon: () => void;
}

function visibleFrame(object: MotionObject, frame: number): TrackFrame | null {
  const exact = object.frames.find((f) => f.frame === frame);
  if (exact) return exact;
  if (object.initialFrame === frame && object.initialPolygon.length >= 3) {
    return {
      frame,
      time: 0,
      polygon: object.initialPolygon,
      references: object.initialReferences,
      bbox: polygonBounds(object.initialPolygon),
      status: 'manual',
      quality: 100,
      qualityNotes: [],
      featureCount: 0,
      inlierRatio: 1,
      fbError: 0,
    };
  }
  return null;
}

function nearestPoint(point: MotionPoint, points: MotionPoint[], tolerance: number): number {
  let best = -1;
  let bestDistance = tolerance;
  points.forEach((p, i) => {
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return best;
}

function distanceToSegment(p: MotionPoint, a: MotionPoint, b: MotionPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function nearestEdge(point: MotionPoint, polygon: MotionPoint[], tolerance = 8): number {
  let best = -1;
  let bestDistance = tolerance;
  for (let i = 0; i < polygon.length; i++) {
    const d = distanceToSegment(point, polygon[i], polygon[(i + 1) % polygon.length]);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

export function MotionStage(props: Props) {
  const { analysis, mediaUrl, videoUrl, videoRef, selectedObject, frame, tool, draftPolygon, draftReferences, selectedPoint, readout } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragPoint, setDragPoint] = useState(-1);
  const [dragReference, setDragReference] = useState(-1);
  const [rectStart, setRectStart] = useState<MotionPoint | null>(null);
  const [rectPreview, setRectPreview] = useState<MotionPoint | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  zoomRef.current = zoom;
  panRef.current = pan;
  const panDrag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const media = analysis.media;
  const currentFrame = selectedObject ? visibleFrame(selectedObject, frame) : null;
  const polygon = draftPolygon.length ? draftPolygon : currentFrame?.polygon ?? [];
  const references = draftReferences.length ? draftReferences : currentFrame?.references ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        setSpaceDown(e.type === 'keydown');
        if (e.type === 'keydown') e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  useEffect(() => {
    const stage = viewportRef.current;
    if (!stage) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? stage.clientWidth;
      setViewportWidth((previous) => (Math.abs(previous - width) < 0.5 ? previous : width));
    });
    observer.observe(stage);
    setViewportWidth(stage.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stage = viewportRef.current;
    if (!stage) return;
    // React's wheel listener is passive in Chromium; this native listener is
    // required to stop the page from scrolling while zooming the footage.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = stage.getBoundingClientRect();
      const currentZoom = zoomRef.current;
      const currentPan = panRef.current;
      const next = Math.max(0.5, Math.min(8, currentZoom * Math.exp(-event.deltaY * 0.0015)));
      if (Math.abs(next - currentZoom) < 0.0001) return;
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const nextPan = {
        x: x - (x - currentPan.x) * (next / currentZoom),
        y: y - (y - currentPan.y) * (next / currentZoom),
      };
      zoomRef.current = next;
      panRef.current = nextPan;
      setPan(nextPan);
      setZoom(next);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [analysis.media.path, analysis.media.name]);

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

    // The canvas is not CSS-scaled with the media. Draw the overlay at native
    // viewport resolution, mapping media coordinates through pan and zoom.
    const scaleX = (canvas.width / media.width) * zoom;
    const scaleY = (canvas.height / media.height) * zoom;
    ctx.setTransform(scaleX, 0, 0, scaleY, pan.x * dpr, pan.y * dpr);
    const unit = media.width / Math.max(1, cssWidth * zoom);
    const line = 1.7 * unit;
    const dot = 4.25 * unit;
    const font = 11 * unit;

    const drawPoly = (points: MotionPoint[], color: string, dashed = false, selected = false) => {
      if (points.length < 2) return;
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      if (points.length >= 3) ctx.closePath();
      if (selected) {
        ctx.strokeStyle = 'rgba(2, 9, 15, 0.72)';
        ctx.lineWidth = line * 3.2;
        ctx.setLineDash([]);
        ctx.stroke();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = line;
      ctx.setLineDash(dashed ? [6 * unit, 4 * unit] : []);
      ctx.stroke();
      ctx.restore();
    };
    const drawLabel = (p: MotionPoint, label: string, color: string) => {
      ctx.save();
      const labelFont = `600 ${font}px "Segoe UI", sans-serif`;
      ctx.font = labelFont;
      const paddingX = 5 * unit;
      const height = 15 * unit;
      const width = ctx.measureText(label).width + paddingX * 2;
      const x = p.x + 8 * unit;
      const y = p.y - height - 5 * unit;
      const r = 3 * unit;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(3, 10, 16, 0.88)';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.8 * unit;
      ctx.stroke();
      ctx.fillStyle = '#f2f8ff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + paddingX, y + height / 2 + 0.5 * unit);
      ctx.restore();
    };
    const drawPoint = (p: MotionPoint, color: string, label?: string, active = false) => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, dot + 2.4 * unit, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(2, 9, 15, 0.66)';
      ctx.fill();
      if (active) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, dot + 4.5 * unit, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2 * unit;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, dot, 0, Math.PI * 2);
      ctx.fillStyle = '#f7fbff';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * unit;
      ctx.stroke();
      if (label) drawLabel(p, label, color);
      ctx.restore();
    };

    const calibrationTool = ['origin', 'xaxis', 'yaxis', 'scale-a', 'scale-b', 'homography'].includes(tool);
    if (analysis.calibration.mode !== 'none' && (analysis.settings.showAxes || calibrationTool)) {
      const cal = analysis.calibration;
      drawPoint(cal.origin, '#f0b75a', 'origin');
      if (cal.mode === 'rotated') {
        drawPoly([cal.origin, cal.xAxisPoint], '#f0b75a');
        drawPoly([cal.origin, cal.yAxisPoint], '#f0b75a');
        drawPoint(cal.xAxisPoint, '#f0b75a', 'X');
        drawPoint(cal.yAxisPoint, '#f0b75a', 'Y');
      }
      if (cal.mode !== 'homography') {
        drawPoly([cal.scalePointA, cal.scalePointB], '#f0b75a', true);
        drawPoint(cal.scalePointA, '#f0b75a', 'A');
        drawPoint(cal.scalePointB, '#f0b75a', 'B');
      } else if (cal.homographyPoints.length) {
        drawPoly(cal.homographyPoints, '#f0b75a', true);
        cal.homographyPoints.forEach((p, i) => drawPoint(p, '#f0b75a', `H${i + 1}`));
      }
    }

    // `showOutline` is an independent overlay switch. Treat an older project
    // without the field as enabled, matching the settings default.
    const showOutline = analysis.settings.showOutline !== false;
    for (const object of analysis.objects) {
      const isSelected = selectedObject?.id === object.id;
      const track = visibleFrame(object, frame);
      const points = isSelected && polygon.length >= 3 ? polygon : track?.polygon ?? [];
      if (!points.length) continue;
      const color = track?.status === 'uncertain' ? '#e8ad48' : track?.status === 'lost' ? '#df727a' : isSelected ? object.color : 'rgba(135, 161, 181, 0.58)';
      if (showOutline || (isSelected && draftPolygon.length >= 3)) drawPoly(points, color, !track, isSelected);
      if (isSelected && analysis.settings.showBoundingBox && points.length >= 3) {
        const b = polygonBounds(points);
        ctx.save();
        ctx.strokeStyle = 'rgba(217, 234, 247, 0.38)';
        ctx.lineWidth = unit;
        ctx.setLineDash([4 * unit, 3 * unit]);
        ctx.strokeRect(b.x, b.y, b.width, b.height);
        ctx.restore();
      }
      if (isSelected && tool === 'select' && points.length >= 3) {
        points.forEach((point, index) => drawPoint(point, color, undefined, index === selectedPoint));
      }
      if (isSelected && (analysis.settings.showReferences || draftReferences.length)) {
        const visibleRefs = draftReferences.length ? draftReferences : track?.references ?? [];
        for (const ref of visibleRefs) drawPoint(ref.point, '#8fe0b2', ref.name);
      }
      if (isSelected && analysis.settings.showTrajectory) {
        const path = object.frames.filter((f) => f.frame <= frame).map((f) => polygonCentroid(f.polygon));
        if (path.length > 1) {
          ctx.save();
          ctx.strokeStyle = 'rgba(133, 202, 235, 0.58)';
          ctx.lineWidth = 1.4 * unit;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.setLineDash([3.5 * unit, 3.5 * unit]);
          ctx.beginPath();
          ctx.moveTo(path[0].x, path[0].y);
          for (const p of path.slice(1)) ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.restore();
        }
      }
      if (isSelected && points.length >= 3) {
        const center = polygonCentroid(points);
        const path = object.frames.filter((f) => f.frame <= frame).slice(-2);
        if (path.length === 2) {
          const a = polygonCentroid(path[0].polygon);
          const b = polygonCentroid(path[1].polygon);
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          if (len > 1) {
            const nx = (b.x - a.x) / len;
            const ny = (b.y - a.y) / len;
            ctx.save();
            ctx.strokeStyle = 'rgba(240, 161, 91, 0.9)';
            ctx.fillStyle = '#f0a15b';
            ctx.lineWidth = 1.35 * unit;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(center.x, center.y);
            ctx.lineTo(center.x + nx * 34 * unit, center.y + ny * 34 * unit);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(center.x + nx * 34 * unit, center.y + ny * 34 * unit);
            ctx.lineTo(center.x + (nx * 27 - ny * 4.5) * unit, center.y + (ny * 27 + nx * 4.5) * unit);
            ctx.lineTo(center.x + (nx * 27 + ny * 4.5) * unit, center.y + (ny * 27 - nx * 4.5) * unit);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        }
        if (object.referenceLength > 0) {
          const axisRefs = (track?.references ?? []).slice(0, 2);
          if (axisRefs.length === 2) {
            const a = axisRefs[0].point;
            const b = axisRefs[1].point;
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            if (len > 1) {
              const nx = (b.x - a.x) / len;
              const ny = (b.y - a.y) / len;
              ctx.save();
              ctx.strokeStyle = 'rgba(143, 224, 178, 0.95)';
              ctx.lineWidth = 1.35 * unit;
              ctx.lineCap = 'round';
              ctx.beginPath();
              ctx.moveTo(center.x - nx * 18 * unit, center.y - ny * 18 * unit);
              ctx.lineTo(center.x + nx * 18 * unit, center.y + ny * 18 * unit);
              ctx.stroke();
              ctx.restore();
            }
          }
        }
      }
    }

    if (selectedObject && analysis.settings.showReferences) {
      for (const ref of references) {
        if (!polygon.length) drawPoint(ref.point, '#8fe0b2', ref.name);
      }
    }

    if (tool === 'polygon' && polygon.length) {
      drawPoly(polygon, '#67ceff', true, true);
      polygon.forEach((p, i) => drawPoint(p, '#67ceff', String(i + 1), i === selectedPoint));
    }
    if (tool === 'rectangle' && rectStart && rectPreview) {
      const b = {
        x: Math.min(rectStart.x, rectPreview.x),
        y: Math.min(rectStart.y, rectPreview.y),
        width: Math.abs(rectPreview.x - rectStart.x),
        height: Math.abs(rectPreview.y - rectStart.y),
      };
      ctx.save();
      ctx.strokeStyle = '#67ceff';
      ctx.lineWidth = 1.7 * unit;
      ctx.lineJoin = 'round';
      ctx.setLineDash([5 * unit, 3 * unit]);
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      ctx.restore();
    }
    if (readout && analysis.settings.showReadout) {
      // Keep the frame readout pinned to the stage, independent of pan and zoom.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.save();
      ctx.font = '600 12px "Segoe UI", sans-serif';
      const label = `Frame ${frame + 1}${readout.time !== null ? ` · t=${readout.time.toFixed(4)} s` : ' · time unknown'}`;
      const width = ctx.measureText(label).width + 14;
      ctx.fillStyle = 'rgba(4, 11, 17, 0.82)';
      ctx.strokeStyle = 'rgba(133, 160, 181, 0.28)';
      ctx.lineWidth = 1;
      ctx.fillRect(8, 8, width, 23);
      ctx.strokeRect(8, 8, width, 23);
      ctx.fillStyle = '#d8e9f7';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 15, 19.5);
      ctx.restore();
    }
  }, [analysis, draftPolygon, draftReferences, frame, media.height, media.width, pan.x, pan.y, polygon, readout, references, selectedObject, selectedPoint, tool, viewportWidth, zoom, rectStart, rectPreview]);

  const clientToMedia = (clientX: number, clientY: number, canvas: HTMLCanvasElement): MotionPoint => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(media.width, (((clientX - rect.left) - pan.x) / zoom / rect.width) * media.width)),
      y: Math.max(0, Math.min(media.height, (((clientY - rect.top) - pan.y) / zoom / rect.height) * media.height)),
    };
  };

  const toMedia = (e: React.PointerEvent<HTMLCanvasElement>): MotionPoint =>
    clientToMedia(e.clientX, e.clientY, e.currentTarget);

  const zoomBy = (factor: number) => {
    const stage = viewportRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const currentZoom = zoomRef.current;
    const currentPan = panRef.current;
    const next = Math.max(0.5, Math.min(8, currentZoom * factor));
    if (Math.abs(next - currentZoom) < 0.0001) return;
    const x = rect.width / 2;
    const y = rect.height / 2;
    const nextPan = {
      x: x - (x - currentPan.x) * (next / currentZoom),
      y: y - (y - currentPan.y) * (next / currentZoom),
    };
    zoomRef.current = next;
    panRef.current = nextPan;
    setPan(nextPan);
    setZoom(next);
  };

  const resetView = () => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toMedia(e);
    if (e.button === 1 || spaceDown) {
      e.preventDefault();
      panDrag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    if (tool === 'select') {
      const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
      const cssPerMedia = (rect.width * zoom) / Math.max(1, media.width);
      const hitTolerance = 10 / Math.max(0.001, cssPerMedia);
      const index = nearestPoint(point, polygon, hitTolerance);
      if (index >= 0) {
        props.onBeginPointDrag();
        props.onSelectPoint(index);
        setDragPoint(index);
        (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
        return;
      }
      const refIndex = nearestPoint(point, references.map((r) => r.point), hitTolerance);
      if (refIndex >= 0) {
        props.onBeginReferenceDrag();
        setDragReference(refIndex);
        (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
      }
      return;
    }
    if (tool === 'rectangle') {
      setRectStart(point);
      setRectPreview(point);
      (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
      return;
    }
    if (['origin', 'xaxis', 'yaxis', 'scale-a', 'scale-b', 'homography'].includes(tool)) {
      props.onCalibrationPoint(tool, point);
      return;
    }
    props.onCanvasPoint(point);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toMedia(e);
    if (panDrag.current) {
      setPan({
        x: panDrag.current.panX + e.clientX - panDrag.current.x,
        y: panDrag.current.panY + e.clientY - panDrag.current.y,
      });
      return;
    }
    if (dragPoint >= 0 && tool === 'select') {
      props.onMovePoint(dragPoint, point);
      return;
    }
    if (dragReference >= 0 && tool === 'select') {
      props.onMoveReference(dragReference, point);
      return;
    }
    if (rectStart) setRectPreview(point);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (panDrag.current) {
      panDrag.current = null;
      return;
    }
    if (dragPoint >= 0) {
      setDragPoint(-1);
      return;
    }
    if (dragReference >= 0) {
      setDragReference(-1);
      return;
    }
    if (rectStart && rectPreview) {
      props.onRectangle(rectStart, rectPreview);
      setRectStart(null);
      setRectPreview(null);
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool === 'polygon' && polygon.length >= 3) {
      e.preventDefault();
      props.onFinishPolygon();
      return;
    }
    if ((e.altKey || e.ctrlKey) && tool === 'select' && polygon.length >= 2) {
      const canvas = e.currentTarget as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const p = clientToMedia(e.clientX, e.clientY, canvas);
      const edge = nearestEdge(p, polygon, 10 / Math.max(0.001, (rect.width * zoom) / Math.max(1, media.width)));
      if (edge >= 0) {
        e.preventDefault();
        props.onInsertPoint(edge, p);
      }
    }
  };

  return (
    <div
      className={`motion-stage ${spaceDown ? 'panning' : ''}`}
      ref={viewportRef}
      style={{ aspectRatio: media.width && media.height ? `${media.width} / ${media.height}` : '16 / 9' }}
    >
      <div
        className="motion-stage-inner"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
      >
        {media.kind === 'video' ? (
          <video
            crossOrigin="anonymous"
            ref={videoRef}
            src={videoUrl}
            className="motion-media"
            preload="auto"
            playsInline
            onLoadedMetadata={props.onVideoReady}
            onTimeUpdate={(e) => props.onVideoTime(e.currentTarget.currentTime)}
            onPlay={() => props.onPlayState(true)}
            onPause={() => props.onPlayState(false)}
            onEnded={() => props.onPlayState(false)}
          />
        ) : (
          <img crossOrigin="anonymous" src={mediaUrl} className="motion-media" alt={media.name} onLoad={props.onVideoReady} />
        )}
      </div>
      <canvas
        ref={canvasRef}
        className="motion-overlay"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        style={{ cursor: spaceDown ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }}
      />
      <div className="motion-zoom" aria-label="Video zoom controls">
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)} title="Zoom out">−</button>
        <span title="Current zoom">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.2)} title="Zoom in">+</button>
        <button type="button" className="motion-zoom-reset" onClick={resetView} title="Fit video to view">Fit</button>
      </div>
    </div>
  );
}
