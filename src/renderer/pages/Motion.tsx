import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, onSam2Progress } from '../api';
import { useApp, useAsync } from '../state';
import { Badge, Button, Checkbox, DataTable, EmptyState, Field, Icon, Input, Modal, PageHeader, Panel, Select, Spinner, Tabs, Toolbar } from '../ui';
import { fmtDateTime } from '../format';
import {
  DEFAULT_CALIBRATION,
  DEFAULT_MOTION_SETTINGS,
  EMPTY_MEDIA,
  MotionAnalysis,
  MotionCalibration,
  MotionHistoryEntry,
  MotionMedia,
  MotionObject,
  MotionPoint,
  MotionReferencePoint,
  MotionSettings,
  TrackFrame,
  analyseObject,
  mergeTrackedFrames,
  normaliseTimestamps,
  planTrackingSegments,
  polygonBounds,
  polygonCentroid,
  rectanglePolygon,
} from '../../shared/motion';
import { MotionStage, MotionTool } from '../motion/MotionStage';
import { CalibrationPanel } from '../motion/CalibrationPanel';
import { AnalysisPanel, allObjectResults } from '../motion/AnalysisPanel';
import { ChartHandle } from '../Chart';
import { buildMotionReport, csvFor } from '../motion/report';
import { createFrameSource, manualVideoTiming, probeImage, probeVideo, scanVideoTiming, seekVideo, timingLabel, videoTimingFromScan } from '../motion/media';
import { EngineState, Sam2Client } from '../motion/sam2Client';
import { FlowClient } from '../motion/flowClient';
import { FLOW_MAX_GAP, buildFlowTrack, flowAxisPoints, polygonIou, samplePolygon, shouldRunSam } from '../../shared/flow';
import type { FlowReply } from '../../shared/flow';
import type { Sam2FrameReply } from '../../shared/sam2';
import { SAM2_COMPONENT, Sam2Progress, Sam2Status, formatBytes } from '../../shared/sam2';

const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi'];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];
const MEDIA_FILTER = [
  { name: 'Images and videos', extensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS] },
  { name: 'Videos', extensions: VIDEO_EXTENSIONS },
  { name: 'Images', extensions: IMAGE_EXTENSIONS },
];

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function baseTitle(filePath: string): string {
  return baseName(filePath).replace(/\.[^.]+$/, '');
}

function emptyObject(frame: number, index = 0): MotionObject {
  return {
    id: uid(),
    name: `Object ${index + 1}`,
    color: ['#5cc8ff', '#f0a13a', '#4fbf87', '#a78bfa'][index % 4],
    initialFrame: frame,
    initialPolygon: [],
    initialReferences: [],
    referenceLength: 0,
    actualLength: 0,
    actualWidth: 0,
    actualHeight: 0,
    lengthUnit: 'm',
    frames: [],
    manualFrames: [],
    history: [],
    notes: '',
  };
}

function normaliseAnalysis(input: any): MotionAnalysis {
  const rawMedia = input?.media ?? {};
  const paths = Array.isArray(rawMedia.paths) ? rawMedia.paths.filter((value: unknown): value is string => typeof value === 'string' && Boolean(value)) : undefined;
  const kind: MotionMedia['kind'] =
    rawMedia.kind === 'video'
      ? 'video'
      : paths && paths.length > 1
        ? 'sequence'
        : rawMedia.kind === 'sequence'
          ? 'sequence'
          : 'image';
  const media: MotionMedia = {
    ...EMPTY_MEDIA,
    ...rawMedia,
    kind,
    path: typeof rawMedia.path === 'string' && rawMedia.path ? rawMedia.path : paths?.[0] ?? '',
    name: typeof rawMedia.name === 'string' && rawMedia.name ? rawMedia.name : paths?.[0]?.split(/[\\/]/).pop() ?? '',
    width: Number(rawMedia.width) || 0,
    height: Number(rawMedia.height) || 0,
    duration:
      rawMedia.duration !== null && rawMedia.duration !== undefined && rawMedia.duration !== '' && Number.isFinite(Number(rawMedia.duration))
        ? Number(rawMedia.duration)
        : null,
    frameCount:
      rawMedia.frameCount !== null && rawMedia.frameCount !== undefined && rawMedia.frameCount !== '' && Number.isFinite(Number(rawMedia.frameCount))
        ? Number(rawMedia.frameCount)
        : paths?.length ?? null,
    fps: rawMedia.fps !== null && rawMedia.fps !== undefined && rawMedia.fps !== '' && Number.isFinite(Number(rawMedia.fps)) ? Number(rawMedia.fps) : null,
    timestamps: normaliseTimestamps(Array.isArray(rawMedia.timestamps) ? rawMedia.timestamps : []),
    paths,
  };
  const objects: MotionObject[] = Array.isArray(input?.objects)
    ? input.objects.map((object: any, index: number) => ({
        ...emptyObject(0, index),
        ...object,
        initialPolygon: Array.isArray(object.initialPolygon) ? object.initialPolygon : [],
        initialReferences: Array.isArray(object.initialReferences) ? object.initialReferences : [],
        actualLength: Number(object.actualLength) || 0,
        referenceLength: Number(object.referenceLength) || 0,
        actualWidth: Number(object.actualWidth) || 0,
        actualHeight: Number(object.actualHeight) || 0,
        lengthUnit: typeof object.lengthUnit === 'string' && object.lengthUnit ? object.lengthUnit : 'm',
        frames: Array.isArray(object.frames) ? object.frames : [],
        manualFrames: Array.isArray(object.manualFrames) ? object.manualFrames.filter((value: unknown) => Number.isInteger(value)) : [],
        history: Array.isArray(object.history)
          ? object.history
              .filter((entry: any) => entry && Number.isInteger(entry.frame) && Array.isArray(entry.polygon) && Array.isArray(entry.references))
              .slice(-50)
          : [],
      }))
    : [];
  return {
    version: 1,
    name: String(input?.name ?? 'Motion analysis'),
    media,
    objects,
    calibration: { ...DEFAULT_CALIBRATION, ...(input?.calibration ?? {}) },
    settings: { ...DEFAULT_MOTION_SETTINGS, ...(input?.settings ?? {}) },
    selectedObjectId: input?.selectedObjectId || objects[0]?.id || '',
    importantFrames: Array.isArray(input?.importantFrames) ? input.importantFrames : [],
    notes: String(input?.notes ?? ''),
    createdAt: input?.createdAt,
    updatedAt: input?.updatedAt,
  };
}

function geometryAt(object: MotionObject, frame: number): { polygon: MotionPoint[]; references: MotionReferencePoint[] } | null {
  const exact = object.frames.find((f) => f.frame === frame);
  if (exact) return { polygon: exact.polygon, references: exact.references };
  if (object.initialFrame === frame && object.initialPolygon.length >= 3) {
    return { polygon: object.initialPolygon, references: object.initialReferences };
  }
  return null;
}

function nearestFrame(times: number[], time: number): number {
  if (!times.length) return 0;
  let best = 0;
  let d = Infinity;
  for (let i = 0; i < times.length; i++) {
    const delta = Math.abs(times[i] - time);
    if (delta < d) {
      d = delta;
      best = i;
    }
  }
  return best;
}

function guessKind(path: string): 'image' | 'video' {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTENSIONS.includes(ext) ? 'video' : 'image';
}

function frameCountOf(analysis: MotionAnalysis): number {
  return analysis.media.frameCount ?? analysis.media.timestamps.length ?? 0;
}

function maxFrameOf(analysis: MotionAnalysis): number {
  return Math.max(0, frameCountOf(analysis) - 1);
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

function makeTrackFrame(object: MotionObject, frame: number, time: number, polygon: MotionPoint[], references: MotionReferencePoint[]): TrackFrame {
  const existing = object.frames.find((f) => f.frame === frame);
  return {
    frame,
    time,
    polygon,
    references,
    bbox: polygonBounds(polygon),
    status: 'manual',
    quality: 100,
    qualityNotes: ['Manual correction by the user'],
    featureCount: 0,
    inlierRatio: 1,
    fbError: 0,
    engine: 'manual',
    // A correction keeps any background-motion estimate already measured for
    // this frame. A brand-new keyframe has no estimate and must not pretend it does.
    cameraDx: existing?.cameraDx,
    cameraDy: existing?.cameraDy,
    cameraValid: existing?.cameraValid,
  };
}

function archiveKeyframe(object: MotionObject, frame: number, time: number, action: string): void {
  const current = object.frames.find((track) => track.frame === frame);
  // An initial outline can exist without a TrackFrame at its frame. Keep that
  // geometry in history too, otherwise deleting the first keyframe loses it.
  const polygon = current?.polygon ?? (object.initialFrame === frame ? object.initialPolygon : []);
  const references = current?.references ?? (object.initialFrame === frame ? object.initialReferences : []);
  object.history = [
    ...(object.history ?? []),
    {
      id: uid(),
      at: new Date().toISOString(),
      frame,
      time: current?.time ?? time,
      polygon: polygon.map((point) => ({ ...point })),
      references: references.map((reference) => ({ ...reference, point: { ...reference.point } })),
      action,
    },
  ].slice(-50);
}

export default function MotionPage() {
  const { projectId, project, route, navigate, notify, confirm } = useApp();
  const analyses = useAsync(() => api.list('motion_analysis', { where: { project_id: projectId }, limit: 300, orderBy: 'updated_at', order: 'desc' }), [projectId]);

  const [analysis, setAnalysis] = useState<MotionAnalysis | null>(null);
  const analysisRef = useRef<MotionAnalysis | null>(null);
  const [recordId, setRecordId] = useState<string | null>(null);
  const loadedIdRef = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const confirmRef = useRef(confirm);
  const [saving, setSaving] = useState(false);

  const [videoUrl, setVideoUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [mediaMissing, setMediaMissing] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [frame, setFrame] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [jumpTime, setJumpTime] = useState('');
  const [fpsInput, setFpsInput] = useState('30');
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ progress: 0, frames: 0 });
  const scanCancelRef = useRef(false);
  const scanningRef = useRef(false);
  const trackingRef = useRef(false);

  const [tab, setTab] = useState('objects');
  const [tool, setTool] = useState<MotionTool>('select');
  const [draftPolygon, setDraftPolygon] = useState<MotionPoint[]>([]);
  const [draftReferences, setDraftReferences] = useState<MotionReferencePoint[]>([]);
  const [selectedPoint, setSelectedPoint] = useState(-1);
  const [referenceName, setReferenceName] = useState('Nose');
  const [undoStack, setUndoStack] = useState<{ polygon: MotionPoint[]; references: MotionReferencePoint[] }[]>([]);
  const [redoStack, setRedoStack] = useState<{ polygon: MotionPoint[]; references: MotionReferencePoint[] }[]>([]);

  const [tracking, setTracking] = useState(false);
  const [trackProgress, setTrackProgress] = useState({ done: 0, total: 0, quality: null as number | null, etaMs: null as number | null });
  const trackCancelRef = useRef(false);
  const trackerRef = useRef<Sam2Client | null>(null);
  const [engineState, setEngineState] = useState<EngineState>('checking');
  const [engineError, setEngineError] = useState<string | null>(null);
  const [sam2Status, setSam2Status] = useState<Sam2Status | null>(null);
  const [sam2Progress, setSam2Progress] = useState<Sam2Progress | null>(null);
  const [installing, setInstalling] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [importDraft, setImportDraft] = useState<{ name: string; kind: 'video' | 'image' | 'sequence'; paths: string[] }>({ name: '', kind: 'video', paths: [] });
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState(false);
  const [exporting, setExporting] = useState(false);
  const chartRef = useRef<ChartHandle | null>(null);

  const selectedObject = analysis ? analysis.objects.find((o) => o.id === analysis.selectedObjectId) ?? analysis.objects[0] ?? null : null;
  const selectedResult = useMemo(
    () => (analysis && selectedObject ? analyseObject(selectedObject, analysis.calibration, analysis.settings) : null),
    [analysis, selectedObject],
  );
  const currentResult = selectedResult?.frames.find((r) => r.frame === frame) ?? null;
  const currentGeometry = selectedObject ? geometryAt(selectedObject, frame) : null;
  const displayPolygon = draftPolygon.length ? draftPolygon : currentGeometry?.polygon ?? [];
  const displayReferences = draftReferences.length ? draftReferences : currentGeometry?.references ?? [];
  const times = analysis?.media.timestamps ?? [];
  const frameCount = analysis ? frameCountOf(analysis) : 0;
  const maxFrame = analysis ? maxFrameOf(analysis) : 0;
  const timingKnown = !!analysis && times.length > 0 && (frameCount === 0 || times.length >= frameCount);
  const frameTime = times[frame] ?? null;

  useEffect(() => {
    analysisRef.current = analysis;
  }, [analysis]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    confirmRef.current = confirm;
  }, [confirm]);

  useEffect(() => {
    scanningRef.current = scanning;
  }, [scanning]);

  useEffect(() => {
    trackingRef.current = tracking;
  }, [tracking]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  const refreshEngine = useCallback(async () => {
    try {
      const status: Sam2Status = await api.sam2Status();
      setSam2Status(status);
      setEngineError(status.error ?? null);
      setEngineState(
        status.installed ? 'ready' : status.stage === 'error' ? 'error' : status.stage === 'loading' ? 'loading' : 'not-installed',
      );
    } catch (err: any) {
      setEngineState('error');
      setEngineError(err?.message ?? 'The SAM 2.1 component status could not be read');
    }
  }, []);

  const installSam2Model = useCallback(async () => {
    if (installing) return;
    setInstalling(true);
    setEngineState('installing');
    setEngineError(null);
    setSam2Progress({ stage: 'downloading', received: 0, total: SAM2_COMPONENT.archiveBytes, message: 'Starting the SAM 2.1 download…' });
    try {
      const result = await api.sam2Install();
      setSam2Status(result.status);
      if (result.installed) {
        setEngineState('ready');
        notify('SAM 2.1 Small is installed. Tracking is ready.', 'success');
      }
    } catch (err: any) {
      setEngineState('error');
      setEngineError(err?.message ?? 'SAM 2.1 Small could not be installed');
    } finally {
      setInstalling(false);
      void refreshEngine();
    }
  }, [installing, notify, refreshEngine]);

  const cancelSam2Download = useCallback(async () => {
    try {
      await api.sam2CancelInstall();
      notify('Cancelling the SAM 2.1 download…', 'warn');
    } catch (err: any) {
      notify(err?.message ?? 'The download could not be cancelled', 'error');
    }
  }, [notify]);

  const removeSam2Model = useCallback(async () => {
    const ok = await confirmRef.current({
      title: 'Remove SAM 2.1 Small?',
      message: 'Tracking will be unavailable until the model is installed again. Saved analyses, measurements and corrections are not affected.',
      confirmLabel: 'Remove model',
      danger: true,
    });
    if (!ok) return;
    try {
      const status = await api.sam2Remove();
      setSam2Status(status);
      setSam2Progress(null);
      setEngineState('not-installed');
      notify('SAM 2.1 Small was removed', 'success');
    } catch (err: any) {
      notify(err?.message ?? 'The SAM 2.1 model could not be removed', 'error');
    }
  }, [notify]);

  useEffect(() => {
    if (!recordId) return;
    const client = new Sam2Client();
    trackerRef.current = client;
    let alive = true;
    setEngineState('checking');
    setEngineError(null);
    void refreshEngine();
    const off = onSam2Progress((progress: Sam2Progress) => {
      if (!alive) return;
      setSam2Progress(progress);
      if (progress.stage === 'loading') setEngineState('loading');
      if (progress.stage === 'downloading' || progress.stage === 'verifying' || progress.stage === 'extracting') {
        setInstalling(true);
        setEngineState('installing');
      }
      if (progress.stage === 'ready') {
        setInstalling(false);
        void refreshEngine();
      }
      if (progress.stage === 'cancelled') {
        setInstalling(false);
        setEngineState('not-installed');
      }
      if (progress.stage === 'error') {
        setInstalling(false);
        setEngineState('error');
        setEngineError(progress.error ?? progress.message);
      }
    });
    return () => {
      alive = false;
      off();
      if (trackerRef.current === client) trackerRef.current = null;
      void client.dispose();
    };
  }, [recordId, refreshEngine]);

  useEffect(() => {
    if (!analysis?.media) return;
    setFpsInput(analysis.media.fps ? String(Number(analysis.media.fps.toFixed(4))) : '30');
  }, [analysis?.media.path, analysis?.media.fps]);

  useEffect(() => {
    if (trackingRef.current) return;
    setDraftPolygon([]);
    setDraftReferences([]);
    setSelectedPoint(-1);
    setUndoStack([]);
    setRedoStack([]);
  }, [frame]);

  useEffect(() => {
    loadedIdRef.current = null;
    setAnalysis(null);
    setRecordId(null);
    setVideoUrl('');
    setImageUrl('');
    setMediaMissing(false);
    setMediaError(null);
    setFrame(0);
    setDraftPolygon([]);
    setDraftReferences([]);
    setTool('select');
  }, [projectId]);

  const updateAnalysis = useCallback((mutate: (draft: MotionAnalysis) => void) => {
    setAnalysis((previous) => {
      if (!previous) return previous;
      const next = structuredClone(previous);
      mutate(next);
      next.updatedAt = new Date().toISOString();
      analysisRef.current = next;
      return next;
    });
    setDirty(true);
  }, []);

  const updateMedia = useCallback(
    (patch: Partial<MotionMedia>) => {
      updateAnalysis((draft) => {
        draft.media = { ...draft.media, ...patch };
      });
    },
    [updateAnalysis],
  );

  const updateSettings = useCallback(
    (patch: Partial<MotionSettings>) => {
      updateAnalysis((draft) => {
        draft.settings = { ...draft.settings, ...patch };
      });
    },
    [updateAnalysis],
  );

  const updateCalibration = useCallback(
    (patch: Partial<MotionCalibration>) => {
      updateAnalysis((draft) => {
        draft.calibration = { ...draft.calibration, ...patch };
      });
    },
    [updateAnalysis],
  );

  const refreshFrameTimes = useCallback(
    (timestamps: number[]) => {
      updateAnalysis((draft) => {
        for (const object of draft.objects) {
          for (const track of object.frames) {
            const time = timestamps[track.frame];
            if (Number.isFinite(time)) track.time = time;
          }
        }
      });
    },
    [updateAnalysis],
  );

  const updateObject = useCallback(
    (id: string, patch: Partial<MotionObject>) => {
      updateAnalysis((draft) => {
        const object = draft.objects.find((o) => o.id === id);
        if (object) Object.assign(object, patch);
      });
    },
    [updateAnalysis],
  );

  const attachMedia = useCallback(async (current: MotionAnalysis) => {
    const mediaPath = current.media.kind === 'sequence' ? current.media.paths?.[0] ?? current.media.path : current.media.path;
    if (!mediaPath) {
      setMediaMissing(true);
      setMediaError('This analysis does not reference a media file.');
      return;
    }
    try {
      const info = await api.motionMediaUrl(mediaPath);
      if (current.media.kind === 'video') {
        setVideoUrl(info.url);
        setImageUrl('');
      } else {
        setVideoUrl('');
        setImageUrl(info.url);
      }
      setMediaMissing(false);
      setMediaError(null);
    } catch (err: any) {
      setVideoUrl('');
      setImageUrl('');
      setMediaMissing(true);
      setMediaError(err?.message ?? 'The source media is missing.');
    }
  }, []);

  const openAnalysis = useCallback(
    async (rowOrId: any) => {
      if (trackingRef.current || scanningRef.current) {
        notify('Stop the current tracking or timing scan before opening another analysis', 'warn');
        return;
      }
      const nextId = typeof rowOrId === 'string' ? rowOrId : rowOrId?.id;
      if (dirtyRef.current && loadedIdRef.current && nextId && nextId !== loadedIdRef.current) {
        const ok = await confirmRef.current({
          title: 'Open another analysis?',
          message: 'Unsaved changes in the current analysis will be discarded.',
          confirmLabel: 'Discard and open',
          danger: true,
        });
        if (!ok) {
          if (loadedIdRef.current) navigate(`#/motion?analysis=${loadedIdRef.current}`);
          else navigate('#/motion');
          return;
        }
      }
      setOpening(true);
      try {
        const row = typeof rowOrId === 'string' ? await api.get('motion_analysis', rowOrId) : rowOrId;
        if (!row) throw new Error('Analysis not found');
        const raw = row.data ?? (row.data_json ? JSON.parse(row.data_json) : null);
        if (!raw) throw new Error('This motion analysis has no saved project data');
        const next = normaliseAnalysis(raw);
        setAnalysis(next);
        analysisRef.current = next;
        setRecordId(row.id);
        loadedIdRef.current = row.id;
        dirtyRef.current = false;
        setDirty(false);
        setVideoReady(false);
        playingRef.current = false;
        setPlaying(false);
        setDraftPolygon([]);
        setDraftReferences([]);
        setSelectedPoint(-1);
        setUndoStack([]);
        setRedoStack([]);
        setTool('select');
        setTab('objects');
        setFrame(Math.min(Math.max(0, next.settings.startFrame || 0), maxFrameOf(next)));
        await attachMedia(next);
      } catch (err: any) {
        notify(err?.message ?? 'Could not open the motion analysis', 'error');
      } finally {
        setOpening(false);
      }
    },
    [attachMedia, navigate, notify],
  );

  useEffect(() => {
    const id = route.query.analysis;
    if (!id || id === loadedIdRef.current) return;
    void openAnalysis(id);
  }, [route.query.analysis, openAnalysis]);

  const imagePath = analysis?.media.kind === 'sequence' ? analysis.media.paths?.[frame] : analysis?.media.path;
  useEffect(() => {
    if (!analysis || analysis.media.kind === 'video') return;
    if (!imagePath) {
      setImageUrl('');
      setMediaMissing(true);
      setMediaError(`Image ${frame + 1} is not present in the sequence`);
      return;
    }
    let cancelled = false;
    api
      .motionMediaUrl(imagePath)
      .then((info) => {
        if (!cancelled) {
          setImageUrl(info.url);
          setMediaMissing(false);
          setMediaError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setImageUrl('');
          setMediaMissing(true);
          setMediaError(err?.message ?? 'The image is missing.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [analysis?.media.kind, imagePath, frame]);

  const save = useCallback(
    async (loud = false) => {
      const current = analysisRef.current;
      if (!current || !recordId) return;
      setSaving(true);
      try {
        const row = await api.update('motion_analysis', recordId, {
          name: current.name,
          media_type: current.media.kind,
          media_path: current.media.path,
          media_paths_json: current.media.paths ?? [],
          data_json: current,
          notes: current.notes,
        });
        if (analysisRef.current?.updatedAt === current.updatedAt) {
          dirtyRef.current = false;
          setDirty(false);
        }
        if (row) setRecordId(row.id ?? recordId);
        analyses.reload();
        if (loud) notify('Analysis saved', 'success');
      } catch (err: any) {
        notify(err?.message ?? 'Could not save the analysis', 'error');
      } finally {
        setSaving(false);
      }
    },
    [analyses, notify, recordId],
  );
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    if (!analysis || !dirty || !recordId || tracking || saving) return;
    const timer = window.setTimeout(() => void saveRef.current(false), 1500);
    return () => window.clearTimeout(timer);
  }, [analysis, dirty, recordId, saving, tracking]);

  const seekToFrame = useCallback((nextFrame: number) => {
    const current = analysisRef.current;
    if (!current) return;
    const clamped = Math.max(0, Math.min(maxFrameOf(current), Math.round(nextFrame)));
    setFrame(clamped);
    const video = videoRef.current;
    if (video && current.media.kind === 'video') {
      // Stepping, graph selection and frame jumps are inspection actions. Do
      // not let ongoing playback immediately overwrite the selected frame.
      if (!video.paused) {
        video.pause();
        playingRef.current = false;
        setPlaying(false);
      }
      if (current.media.timestamps[clamped] !== undefined) {
        try {
          video.currentTime = current.media.timestamps[clamped];
        } catch {
          /* the player will catch up when metadata is ready */
        }
      }
    }
  }, []);

  const handleVideoTime = useCallback(
    (time: number) => {
      const current = analysisRef.current;
      if (!current || scanningRef.current || trackingRef.current || !playingRef.current) return;
      const list = current.media.timestamps;
      if (!list.length) return;
      const index = nearestFrame(list, time);
      setFrame((prev) => (prev === index ? prev : index));
    },
    [],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!playing || !video || typeof (video as any).requestVideoFrameCallback !== 'function') return;
    let handle = 0;
    let dead = false;
    const tick = (_now: number, metadata: any) => {
      if (dead) return;
      if (typeof metadata?.mediaTime === 'number') handleVideoTime(metadata.mediaTime);
      handle = (video as any).requestVideoFrameCallback(tick);
    };
    handle = (video as any).requestVideoFrameCallback(tick);
    return () => {
      dead = true;
      if (handle && (video as any).cancelVideoFrameCallback) (video as any).cancelVideoFrameCallback(handle);
    };
  }, [playing, handleVideoTime]);

  useEffect(() => {
    if (!videoReady || playing) return;
    const video = videoRef.current;
    const current = analysisRef.current;
    if (!video || !current || current.media.kind !== 'video') return;
    const time = current.media.timestamps[frame];
    if (!Number.isFinite(time)) return;
    if (Math.abs(video.currentTime - time) > 1e-4) {
      try {
        video.currentTime = time;
      } catch {
        /* seeking can be unavailable before enough data is buffered */
      }
    }
  }, [frame, playing, videoReady]);

  const handleVideoReady = useCallback(() => {
    setVideoReady(true);
    const video = videoRef.current;
    const current = analysisRef.current;
    if (!video || !current || current.media.kind !== 'video') return;
    const patch: Partial<MotionMedia> = {};
    const dimensionsMismatch =
      current.media.width > 0 &&
      current.media.height > 0 &&
      video.videoWidth > 0 &&
      (current.media.width !== video.videoWidth || current.media.height !== video.videoHeight);
    const durationMismatch =
      current.media.duration !== null &&
      current.media.duration > 0 &&
      Number.isFinite(video.duration) &&
      Math.abs(current.media.duration - video.duration) > 0.5;
    if (dimensionsMismatch) {
      const message = `The source video is ${video.videoWidth}×${video.videoHeight}, but this analysis was saved at ${current.media.width}×${current.media.height}. Restore the original media before tracking so saved coordinates remain valid.`;
      setMediaError(message);
      notify(message, 'warn');
    } else if (durationMismatch) {
      const message = `The source video duration is ${video.duration.toFixed(2)} s, but this analysis was saved for ${current.media.duration?.toFixed(2)} s. Restore the original media before tracking so frame timing remains valid.`;
      setMediaError(message);
      notify(message, 'warn');
    } else {
      if (video.videoWidth > 0 && (!current.media.width || !current.media.height)) {
        patch.width = video.videoWidth;
        patch.height = video.videoHeight;
      }
      if (Number.isFinite(video.duration) && (!current.media.duration || Math.abs(current.media.duration - video.duration) > 0.001)) {
        patch.duration = video.duration;
      }
    }
    if (Object.keys(patch).length) updateMedia(patch);
  }, [notify, updateMedia]);

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (video.paused) {
        video.playbackRate = speed;
        await video.play();
      } else {
        video.pause();
      }
    } catch (err: any) {
      notify(err?.message ?? 'Playback is not available for this media', 'error');
    }
  };

  const stopPlayback = () => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      try {
        video.currentTime = 0;
      } catch {
        /* noop */
      }
    }
    setPlaying(false);
    seekToFrame(0);
  };

  const applyManualFps = () => {
    const current = analysisRef.current;
    if (!current) return;
    if (mediaError) {
      notify(mediaError, 'warn');
      return;
    }
    const fps = Number(fpsInput);
    if (!(fps > 0)) {
      notify('Enter a positive frame rate', 'warn');
      return;
    }
    if (current.media.kind === 'video') {
      const duration = current.media.duration ?? videoRef.current?.duration ?? 0;
      if (!(duration > 0)) {
        notify('Video duration is not available yet. Let the video load before applying a manual FPS.', 'warn');
        return;
      }
      const timing = manualVideoTiming(duration, fps);
      updateMedia(timing);
      refreshFrameTimes(timing.timestamps);
      updateSettings({ endFrame: 0, startFrame: 0 });
    } else {
      const count = current.media.paths?.length ?? current.media.frameCount ?? 1;
      const timestamps = Array.from({ length: count }, (_, i) => Number((i / fps).toFixed(9)));
      updateMedia({ timestamps, frameCount: count, fps, duration: count / fps, timingSource: 'image-sequence', variableFrameRate: false });
      refreshFrameTimes(timestamps);
      updateSettings({ endFrame: 0, startFrame: 0 });
    }
    seekToFrame(0);
    notify(`Frame timing set to ${fps} fps`, 'success');
  };

  const scanTiming = async () => {
    const current = analysisRef.current;
    const video = videoRef.current;
    if (!current || !video || !videoReady) {
      notify('The video is not ready yet', 'warn');
      return;
    }
    if (trackingRef.current) {
      notify('Stop tracking before scanning frame timing', 'warn');
      return;
    }
    if (mediaError) {
      notify(mediaError, 'warn');
      return;
    }
    setScanning(true);
    scanningRef.current = true;
    scanCancelRef.current = false;
    setScanProgress({ progress: 0, frames: 0 });
    playingRef.current = false;
    setPlaying(false);
    video.pause();
    try {
      const result = await scanVideoTiming(
        video,
        () => scanCancelRef.current,
        (progress, frames) => setScanProgress({ progress, frames }),
      );
      if (analysisRef.current !== current) {
        notify('Timing scan cancelled because the active analysis changed', 'warn');
        return;
      }
      if (scanCancelRef.current) {
        notify('Timing scan cancelled; no timing was changed', 'warn');
        return;
      }
      if (result.timestamps.length < 2) throw new Error('No usable frame timestamps were decoded');
      const timing = videoTimingFromScan(result.duration, result.timestamps, result.droppedFrames);
      updateMedia(timing);
      refreshFrameTimes(timing.timestamps ?? []);
      updateSettings({ startFrame: 0, endFrame: 0 });
      seekToFrame(0);
      notify(
        `Timing scanned: ${result.timestamps.length} frames${timing.variableFrameRate ? ' (variable or dropped frames detected)' : ''}`,
        'success',
      );
    } catch (err: any) {
      notify(err?.message ?? 'Could not scan frame timings', 'error');
    } finally {
      setScanning(false);
      scanningRef.current = false;
      setScanProgress({ progress: 0, frames: 0 });
    }
  };

  const relink = async () => {
    if (trackingRef.current || scanningRef.current) {
      notify('Stop the current tracking or timing scan before relinking the media', 'warn');
      return;
    }
    try {
      const result = await api.relinkMedia();
      if (result.canceled) return;
      const current = analysisRef.current;
      if (!current) return;
      const expectedKind = current.media.kind === 'video' ? 'video' : 'image';
      const pickedKind = guessKind(result.path);
      if (pickedKind !== expectedKind) {
        notify(`Choose a ${expectedKind === 'video' ? 'video' : 'still image'} to relink this analysis`, 'warn');
        return;
      }
      let probe: { width: number; height: number; duration: number | null } | null = null;
      try {
        if (current.media.kind === 'video') {
          const videoProbe = await probeVideo(result.url);
          probe = {
            width: videoProbe.width,
            height: videoProbe.height,
            duration: Number.isFinite(videoProbe.duration) ? videoProbe.duration : null,
          };
          videoProbe.video.src = '';
        } else {
          const dimensions = await probeImage(result.url);
          probe = { ...dimensions, duration: null };
        }
      } catch (err: any) {
        notify(err?.message ?? 'The selected file could not be decoded', 'error');
        return;
      }
      if (!probe) {
        notify('The selected file could not be decoded', 'error');
        return;
      }
      if (
        current.media.width > 0 &&
        current.media.height > 0 &&
        (probe.width !== current.media.width || probe.height !== current.media.height)
      ) {
        notify(
          `The selected file is ${probe.width}×${probe.height}, but this analysis was tracked at ${current.media.width}×${current.media.height}. Relink a file with the same dimensions so existing track coordinates remain valid.`,
          'error',
        );
        return;
      }
      const paths = current.media.paths ? [...current.media.paths] : [];
      if (paths.length) paths[0] = result.path;
      const name = result.name ?? baseName(result.path);
      // Replacing a source file invalidates its timing. A relinked image is a
      // single frame; a relinked video must be scanned again rather than using
      // timestamps from the previous file.
      const timingPatch =
        current.media.kind === 'video'
          ? { duration: probe.duration, frameCount: null, fps: null, timestamps: [], timingSource: 'unknown' as const, variableFrameRate: false }
          : current.media.kind === 'image'
            ? { duration: null, frameCount: 1, fps: null, timestamps: [0], timingSource: 'image-sequence' as const, variableFrameRate: false }
            : {};
      const dimensionPatch = { width: probe.width, height: probe.height };
      setVideoReady(false);
      setPlaying(false);
      setFrame(0);
      updateMedia({ path: result.path, paths: paths.length ? paths : undefined, name, ...timingPatch, ...dimensionPatch });
      const next = {
        ...current,
        media: { ...current.media, ...timingPatch, ...dimensionPatch, path: result.path, paths: paths.length ? paths : undefined, name },
      };
      await attachMedia(next);
      notify(current.media.kind === 'video' ? 'Source media relinked. Scan frame timing again before tracking.' : 'Source media relinked', 'success');
    } catch (err: any) {
      notify(err?.message ?? 'Could not relink the media', 'error');
    }
  };

  const pickImportFiles = async () => {
    try {
      const result = await api.pickOpen({
        title: importDraft.kind === 'sequence' ? 'Select an image sequence' : `Select a ${importDraft.kind}`,
        multi: importDraft.kind === 'sequence',
        filters: [
          importDraft.kind === 'video'
            ? { name: 'Videos', extensions: VIDEO_EXTENSIONS }
            : { name: 'Images', extensions: IMAGE_EXTENSIONS },
        ],
      });
      if (result.canceled || !result.paths?.length) return;
      const paths = importDraft.kind === 'sequence'
        ? [...result.paths].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
        : result.paths;
      setImportDraft((prev) => ({
        ...prev,
        paths,
        name: prev.name || (prev.kind === 'sequence' ? `${baseTitle(paths[0])} sequence` : baseTitle(paths[0])),
      }));
    } catch (err: any) {
      notify(err?.message ?? 'Could not select media', 'error');
    }
  };

  const createAnalysis = async () => {
    if (!projectId) {
      notify('Select a project first', 'warn');
      return;
    }
    if (!importDraft.paths.length) {
      notify('Choose a media file or sequence first', 'warn');
      return;
    }
    setCreating(true);
    let probe: Awaited<ReturnType<typeof probeVideo>> | null = null;
    try {
      const info = await api.motionMediaUrl(importDraft.paths[0]);
      let width = 0;
      let height = 0;
      let duration: number | null = null;
      if (importDraft.kind === 'video') {
        probe = await probeVideo(info.url);
        width = probe.width;
        height = probe.height;
        duration = Number.isFinite(probe.duration) ? probe.duration : null;
      } else {
        const dimensions = await probeImage(info.url);
        width = dimensions.width;
        height = dimensions.height;
      }
      const isImage = importDraft.kind === 'image';
      const media: MotionMedia = {
        kind: importDraft.kind,
        path: importDraft.paths[0],
        paths: importDraft.kind === 'sequence' ? importDraft.paths : undefined,
        name: baseName(importDraft.paths[0]),
        width,
        height,
        duration: isImage ? null : duration,
        frameCount: isImage ? 1 : importDraft.kind === 'sequence' ? importDraft.paths.length : null,
        fps: null,
        timestamps: isImage ? [0] : [],
        timingSource: isImage ? 'image-sequence' : 'unknown',
        variableFrameRate: false,
        fileSize: info.size,
      };
      const now = new Date().toISOString();
      const object = emptyObject(0);
      const next: MotionAnalysis = {
        version: 1,
        name: importDraft.name.trim() || 'Motion analysis',
        media,
        objects: [object],
        calibration: { ...DEFAULT_CALIBRATION },
        settings: { ...DEFAULT_MOTION_SETTINGS },
        selectedObjectId: object.id,
        importantFrames: [],
        notes: '',
        createdAt: now,
        updatedAt: now,
      };
      const record = await api.create('motion_analysis', {
        project_id: projectId,
        name: next.name,
        media_type: media.kind,
        media_path: media.path,
        media_paths_json: media.paths ?? [],
        data_json: next,
        notes: '',
      });
      setAnalysis(next);
      analysisRef.current = next;
      setRecordId(record.id);
      loadedIdRef.current = record.id;
      setDirty(false);
      setVideoReady(false);
      setPlaying(false);
      setFrame(0);
      setDraftPolygon([]);
      setDraftReferences([]);
      setTool('polygon');
      setTab('objects');
      setImportOpen(false);
      setImportDraft({ name: '', kind: 'video', paths: [] });
      await attachMedia(next);
      analyses.reload();
      navigate(`#/motion?analysis=${record.id}`);
      notify('Analysis created. Draw around the object to begin.', 'success');
    } catch (err: any) {
      notify(err?.message ?? 'Could not import the media', 'error');
    } finally {
      if (probe) {
        probe.video.pause();
        probe.video.src = '';
      }
      setCreating(false);
    }
  };

  const importProject = async () => {
    try {
      const result = await api.importMotionProject();
      if (result.canceled) return;
      const imported = normaliseAnalysis(result.project);
      const record = await api.create('motion_analysis', {
        project_id: projectId,
        name: imported.name,
        media_type: imported.media.kind,
        media_path: imported.media.path,
        media_paths_json: imported.media.paths ?? [],
        data_json: imported,
        notes: imported.notes,
      });
      await openAnalysis({ ...record, data: imported });
      analyses.reload();
      navigate(`#/motion?analysis=${record.id}`);
      notify(result.missingMedia ? 'Project imported, but its source media needs relinking' : 'Motion analysis project imported', result.missingMedia ? 'warn' : 'success');
    } catch (err: any) {
      notify(err?.message ?? 'Could not import the analysis project', 'error');
    }
  };

  const pushHistory = (
    polygon: MotionPoint[] = draftPolygon,
    references: MotionReferencePoint[] = draftReferences,
  ) => {
    setUndoStack((previous) => [...previous.slice(-29), {
      polygon: polygon.map((point) => ({ ...point })),
      references: references.map((reference) => ({ ...reference, point: { ...reference.point } })),
    }]);
    setRedoStack([]);
  };

  const beginDraft = (polygon: MotionPoint[] = [], references: MotionReferencePoint[] = []) => {
    setDraftPolygon(polygon.map((p) => ({ ...p })));
    setDraftReferences(references.map((r) => ({ ...r, point: { ...r.point } })));
    setUndoStack([]);
    setRedoStack([]);
    setSelectedPoint(-1);
  };

  const undoDraft = () => {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setRedoStack((stack) => [...stack, { polygon: draftPolygon, references: draftReferences }]);
    setUndoStack((stack) => stack.slice(0, -1));
    setDraftPolygon(previous.polygon);
    setDraftReferences(previous.references);
    setSelectedPoint(-1);
  };

  const redoDraft = () => {
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setUndoStack((stack) => [...stack, { polygon: draftPolygon, references: draftReferences }]);
    setRedoStack((stack) => stack.slice(0, -1));
    setDraftPolygon(next.polygon);
    setDraftReferences(next.references);
    setSelectedPoint(-1);
  };

  const addPoint = (point: MotionPoint) => {
    if (!selectedObject) {
      notify('Create or select an object first', 'warn');
      return;
    }
    pushHistory();
    setDraftPolygon((previous) => [...previous, point]);
  };

  const addReference = (point: MotionPoint) => {
    if (!selectedObject) {
      notify('Create or select an object first', 'warn');
      return;
    }
    const base = draftReferences.length ? draftReferences : currentGeometry?.references ?? selectedObject.initialReferences;
    const polygon = draftPolygon.length ? draftPolygon : currentGeometry?.polygon ?? [];
    pushHistory(polygon, base);
    const name = referenceName.trim() || `Point ${base.length + 1}`;
    setDraftReferences([...base, { id: uid(), name, point }]);
    if (!draftPolygon.length && polygon.length) setDraftPolygon(polygon);
    setReferenceName(base.length === 0 ? 'Tail' : `Point ${base.length + 1}`);
  };

  const beginPointDrag = () => {
    if (!selectedObject) return;
    const polygon = draftPolygon.length ? draftPolygon : currentGeometry?.polygon ?? [];
    const references = draftReferences.length ? draftReferences : currentGeometry?.references ?? selectedObject.initialReferences;
    pushHistory(polygon, references);
    if (!draftPolygon.length && polygon.length) {
      setDraftPolygon(polygon);
      setDraftReferences(references);
    }
  };

  const movePoint = (index: number, point: MotionPoint) => {
    setDraftPolygon((previous) => {
      const base = previous.length ? previous : currentGeometry?.polygon ?? [];
      return base.map((p, i) => (i === index ? point : p));
    });
  };

  const moveReference = (index: number, point: MotionPoint) => {
    setDraftReferences((previous) => {
      const base = previous.length ? previous : currentGeometry?.references ?? selectedObject?.initialReferences ?? [];
      return base.map((r, i) => (i === index ? { ...r, point } : r));
    });
  };

  const beginReferenceDrag = () => {
    if (!selectedObject) return;
    const polygon = draftPolygon.length ? draftPolygon : currentGeometry?.polygon ?? [];
    const references = draftReferences.length ? draftReferences : currentGeometry?.references ?? selectedObject.initialReferences;
    pushHistory(polygon, references);
    if (!draftPolygon.length && polygon.length) {
      setDraftPolygon(polygon);
      setDraftReferences(references);
    }
  };

  const insertPoint = (edge: number, point: MotionPoint) => {
    const base = draftPolygon.length ? draftPolygon : currentGeometry?.polygon ?? [];
    const references = draftReferences.length ? draftReferences : currentGeometry?.references ?? selectedObject?.initialReferences ?? [];
    pushHistory(base, references);
    setDraftPolygon((previous) => {
      const current = previous.length ? previous : base;
      const next = [...current];
      next.splice(edge + 1, 0, point);
      return next;
    });
  };

  const deleteSelectedPoint = () => {
    if (selectedPoint < 0) return;
    pushHistory();
    setDraftPolygon((previous) => previous.filter((_, index) => index !== selectedPoint));
    setSelectedPoint(-1);
  };

  const deleteReference = (index: number) => {
    const base = draftReferences.length ? draftReferences : currentGeometry?.references ?? selectedObject?.initialReferences ?? [];
    const polygon = draftPolygon.length ? draftPolygon : currentGeometry?.polygon ?? [];
    pushHistory(polygon, base);
    setDraftReferences(base.filter((_, i) => i !== index));
    if (!draftPolygon.length && polygon.length) setDraftPolygon(polygon);
  };

  const applyDraft = () => {
    const current = analysisRef.current;
    if (!current || !selectedObject) return;
    if (draftPolygon.length < 3) {
      notify('An outline needs at least three points', 'warn');
      return;
    }
    const references = draftReferences.length ? draftReferences : currentGeometry?.references ?? selectedObject.initialReferences;
    const time = current.media.timestamps[frame] ?? 0;
    updateAnalysis((draft) => {
      const object = draft.objects.find((o) => o.id === selectedObject.id);
      if (!object) return;
      const existing = object.frames.find((item) => item.frame === frame);
      if (existing) {
        archiveKeyframe(object, frame, time, existing.status === 'manual' ? 'Keyframe replaced' : 'Tracked frame corrected');
      }
      const track = makeTrackFrame(object, frame, time, draftPolygon, references);
      const others = object.frames.filter((f) => f.frame !== frame);
      object.frames = [...others, track].sort((a, b) => a.frame - b.frame);
      object.manualFrames = [...new Set([...object.manualFrames, frame])].sort((a, b) => a - b);
      if (draft.settings.startFrame > frame) draft.settings.startFrame = frame;
      if (draft.settings.endFrame > 0 && draft.settings.endFrame < frame) draft.settings.endFrame = 0;
      if (!object.initialPolygon.length) {
        object.initialFrame = frame;
        object.initialPolygon = draftPolygon;
        object.initialReferences = references;
      }
      if (object.initialFrame === frame) {
        object.initialPolygon = draftPolygon;
        object.initialReferences = references;
      }
    });
    beginDraft([], []);
    setTool('select');
    notify('Outline applied. Use Track to follow subsequent frames.', 'success');
  };

  const correctHere = () => {
    if (!selectedObject) return;
    if (currentGeometry) {
      beginDraft(currentGeometry.polygon, currentGeometry.references);
      setTool('select');
    } else {
      beginDraft([], selectedObject.initialReferences);
      setTool('polygon');
      notify('This frame has no tracked position. Draw a new outline to reidentify the object.', 'info');
    }
  };

  const addKeyframeHere = () => {
    const current = analysisRef.current;
    if (!current || !selectedObject || !currentGeometry) {
      notify('This frame has no geometry to confirm as a keyframe', 'warn');
      return;
    }
    const time = current.media.timestamps[frame] ?? 0;
    updateAnalysis((draft) => {
      const object = draft.objects.find((o) => o.id === selectedObject.id);
      if (!object) return;
      const existing = object.frames.find((item) => item.frame === frame);
      if (existing) {
        archiveKeyframe(object, frame, time, existing.status === 'manual' ? 'Keyframe confirmed again' : 'Tracked frame converted to keyframe');
      }
      const track = makeTrackFrame(object, frame, time, currentGeometry.polygon, currentGeometry.references);
      object.frames = [...object.frames.filter((f) => f.frame !== frame), track].sort((a, b) => a.frame - b.frame);
      object.manualFrames = [...new Set([...object.manualFrames, frame])].sort((a, b) => a - b);
    });
    notify('Keyframe added at this frame', 'success');
  };

  const redraw = () => {
    beginDraft([], []);
    setTool('polygon');
  };

  const newObject = () => {
    if (!analysis) return;
    const object = emptyObject(frame, analysis.objects.length);
    updateAnalysis((draft) => {
      draft.objects.push(object);
      draft.selectedObjectId = object.id;
    });
    beginDraft([], []);
    setTool('polygon');
  };

  const removeObject = async () => {
    if (!analysis || !selectedObject) return;
    const ok = await confirm({ title: `Delete ${selectedObject.name}?`, message: 'Its tracking history and reference points will be removed from this analysis.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    updateAnalysis((draft) => {
      draft.objects = draft.objects.filter((o) => o.id !== selectedObject.id);
      draft.selectedObjectId = draft.objects[0]?.id ?? '';
    });
    beginDraft([], []);
  };

  const removeKeyframe = async (atFrame: number) => {
    if (!selectedObject) return;
    const ok = await confirm({
      title: `Delete keyframe at frame ${atFrame + 1}?`,
      message: 'The frame and its manual correction will be removed. Other keyframes and tracked frames are preserved; re-track to fill the gap if needed.',
      confirmLabel: 'Delete keyframe',
      danger: true,
    });
    if (!ok) return;
    updateAnalysis((draft) => {
      const object = draft.objects.find((o) => o.id === selectedObject.id);
      if (!object) return;
      archiveKeyframe(object, atFrame, object.frames.find((track) => track.frame === atFrame)?.time ?? 0, 'Keyframe deleted');
      object.frames = object.frames.filter((track) => track.frame !== atFrame);
      object.manualFrames = object.manualFrames.filter((value) => value !== atFrame);
      if (object.initialFrame === atFrame) {
        const next = [...object.manualFrames, ...object.frames.map((track) => track.frame)].sort((a, b) => a - b)[0];
        const nextTrack = object.frames.find((track) => track.frame === next);
        object.initialFrame = nextTrack?.frame ?? 0;
        object.initialPolygon = nextTrack?.polygon ?? [];
        object.initialReferences = nextTrack?.references ?? [];
      }
    });
    if (frame === atFrame) beginDraft([], []);
    notify('Keyframe deleted', 'success');
  };

  const restoreKeyframe = (entry: MotionHistoryEntry) => {
    if (!selectedObject || entry.polygon.length < 3) return;
    updateAnalysis((draft) => {
      const object = draft.objects.find((o) => o.id === selectedObject.id);
      if (!object) return;
      const current = object.frames.find((track) => track.frame === entry.frame);
      if (current) {
        object.history = [
          ...(object.history ?? []),
          {
            id: uid(),
            at: new Date().toISOString(),
            frame: entry.frame,
            time: current.time,
            polygon: current.polygon.map((point) => ({ ...point })),
            references: current.references.map((reference) => ({ ...reference, point: { ...reference.point } })),
            action: 'Keyframe restored from history',
          },
        ].slice(-50);
      }
      const time = draft.media.timestamps[entry.frame] ?? entry.time;
      const track = makeTrackFrame(
        object,
        entry.frame,
        time,
        entry.polygon.map((point) => ({ ...point })),
        entry.references.map((reference) => ({ ...reference, point: { ...reference.point } })),
      );
      object.frames = [...object.frames.filter((item) => item.frame !== entry.frame), track].sort((a, b) => a.frame - b.frame);
      object.manualFrames = [...new Set([...object.manualFrames, entry.frame])].sort((a, b) => a - b);
      if (object.initialFrame === entry.frame) {
        object.initialPolygon = entry.polygon.map((point) => ({ ...point }));
        object.initialReferences = entry.references.map((reference) => ({ ...reference, point: { ...reference.point } }));
      }
    });
    seekToFrame(entry.frame);
    notify(`Restored keyframe at frame ${entry.frame + 1}`, 'success');
  };

  const startTracking = async () => {
    const current = analysisRef.current;
    if (!current || !selectedObject) return;
    if (scanningRef.current) {
      notify('Wait for the timing scan to finish before tracking', 'warn');
      return;
    }
    if (mediaError) {
      notify(mediaError, 'warn');
      return;
    }
    if (!timingKnown || current.media.kind === 'image') {
      notify('Frame timing must be known before tracking. Scan the video or apply a manual FPS.', 'warn');
      return;
    }
    if (frameCount < 2) {
      notify('At least two frames are required for tracking', 'warn');
      return;
    }
    const geometry = draftPolygon.length >= 3 ? { polygon: draftPolygon, references: draftReferences.length ? draftReferences : currentGeometry?.references ?? selectedObject.initialReferences } : currentGeometry;
    if (!geometry || geometry.polygon.length < 3) {
      notify('Draw an outline around the object on this frame first', 'warn');
      return;
    }
    const endFrame = current.settings.endFrame > 0 ? Math.min(current.settings.endFrame, maxFrame) : maxFrame;
    if (frame >= endFrame) {
      notify('The current frame is at the end of the analysis range', 'warn');
      return;
    }
    if (frame < current.settings.startFrame) {
      notify(`The analysis range starts at frame ${current.settings.startFrame + 1}. Adjust the analysis start frame in Calibration → Analysis settings.`, 'warn');
      return;
    }
    const client = trackerRef.current;
    if (!client) {
      notify('The SAM 2.1 tracking engine is still starting. Wait a moment and try again.', 'warn');
      return;
    }
    if (!sam2Status?.installed) {
      notify('Install SAM 2.1 Small from the tracking panel before tracking.', 'warn');
      return;
    }
    setTracking(true);
    trackingRef.current = true;
    trackCancelRef.current = false;
    // OpenCV is a supporting engine: it predicts motion between SAM 2.1 frames
    // and seeds the next SAM frame. If it cannot start, tracking still runs
    // with SAM 2.1 on every frame, exactly as before.
    const flowClient = new FlowClient();
    let flowEnabled = true;
    playingRef.current = false;
    setPlaying(false);
    videoRef.current?.pause();
    setTrackProgress({ done: 0, total: Math.max(1, endFrame - frame), quality: null, etaMs: null });
    try {
      const pack = createFrameSource(current.media, videoRef.current, async (path) => (await api.motionMediaUrl(path)).url, current.settings.processingMaxWidth);
      if (analysisRef.current !== current) throw new Error('Tracking was cancelled because the active analysis changed');
      if (trackCancelRef.current) throw new Error('Tracking was cancelled');

      // Manual frames are keyframes. Track each interval from its own keyframe
      // geometry, and never use tracking to overwrite a later correction.
      const segments = planTrackingSegments(frame, endFrame, selectedObject.manualFrames);
      const frames: TrackFrame[] = [];
      let stoppedAt: number | null = null;
      let reason = '';
      let completedSegments = 0;
      const startedAt = Date.now();
      let processed = 0;

      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        if (trackCancelRef.current) {
          stoppedAt = frame;
          reason = 'cancelled by the user';
          break;
        }
        const segment = segments[segmentIndex];
        const segmentStart = segment.start;
        const segmentEnd = segment.end;
        if (segmentEnd < segmentStart) continue;
        const segmentGeometry = segmentStart === frame ? geometry : geometryAt(selectedObject, segmentStart);
        if (!segmentGeometry || segmentGeometry.polygon.length < 3) {
          stoppedAt = segmentStart;
          reason = `keyframe ${segmentStart + 1} has no usable outline`;
          break;
        }
        await client.start({
          object: {
            id: selectedObject.id,
            name: selectedObject.name,
            polygon: segmentGeometry.polygon,
            references: segmentGeometry.references,
          },
          sourceWidth: current.media.width,
          sourceHeight: current.media.height,
          scale: pack.dimensions.width / Math.max(1, current.media.width),
          startFrame: segmentStart,
          endFrame: segmentEnd,
          frameCount,
          qualityThreshold: current.settings.qualityThreshold,
          compensateCamera: current.settings.compensateCamera,
        });

        let segmentFailed = false;
        let lastImage: ImageData | null = null;
        let lastTrack: TrackFrame | null = null;
        let framesSinceSam = 0;
        for (let index = segmentStart; index <= segmentEnd; index++) {
          if (trackCancelRef.current) {
            stoppedAt = index;
            reason = 'cancelled by the user';
            segmentFailed = true;
            break;
          }
          const canvas = await pack.source.getFrame(index);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) throw new Error('A canvas is unavailable for image processing');
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const time = current.media.timestamps[index];
          if (!Number.isFinite(time)) throw new Error(`No timestamp is available for frame ${index + 1}`);
          const scaleX = image.width / Math.max(1, current.media.width);
          const scaleY = image.height / Math.max(1, current.media.height);

          // Optical flow between the last accepted frame and this one. On frames
          // where it is trustworthy, SAM 2.1 is skipped and the warped outline
          // becomes the tracking result; otherwise its outline is handed to SAM
          // as the mask prompt so the model starts at the object's new position.
          let flow: FlowReply | null = null;
          let prediction: { track: TrackFrame; confidence: number } | null = null;
          if (flowEnabled && lastImage && lastTrack) {
            const previousFramePolygon = lastTrack.polygon.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }));
            const previousFrameReferences = lastTrack.references.map((reference) => ({
              ...reference,
              point: { x: reference.point.x * scaleX, y: reference.point.y * scaleY },
            }));
            const samples = samplePolygon(previousFramePolygon, 20);
            const axis = flowAxisPoints(previousFramePolygon);
            const points = [...samples, ...previousFrameReferences.map((reference) => reference.point), axis.nose, axis.tail, axis.centre];
            try {
              const flowReply = await flowClient.track(lastImage, image, points, previousFramePolygon);
              flow = flowReply;
              const trackedReferences = previousFrameReferences.map((reference, offset) => {
                const tracked = flowReply.points[samples.length + offset];
                return { ...reference, point: tracked?.found ? tracked.point : reference.point };
              });
              prediction = buildFlowTrack({
                frame: index,
                time,
                previous: lastTrack,
                flow: flowReply,
                scaleX,
                scaleY,
                frameWidth: image.width,
                frameHeight: image.height,
                sourceWidth: current.media.width,
                sourceHeight: current.media.height,
                references: trackedReferences,
                qualityThreshold: current.settings.qualityThreshold,
              });
            } catch (error) {
              flowEnabled = false;
              flow = null;
              prediction = null;
              console.warn('OpenCV optical flow is unavailable; continuing with SAM 2.1 only.', error);
            }
          }

          // Camera compensation needs a SAM mask on every frame, so no flow-only gaps.
          const maxGap = current.settings.compensateCamera ? 0 : FLOW_MAX_GAP;
          // A frame whose flow quality is below the review threshold gets SAM's
          // confirmation instead of being stored as an uncertain prediction.
          const runSam =
            !prediction ||
            prediction.track.quality < current.settings.qualityThreshold ||
            shouldRunSam({
              hasPrevious: !!lastTrack,
              framesSinceSam,
              confidence: prediction.confidence,
              maxGap,
            });
          let reply: Sam2FrameReply | null = null;
          if (runSam) reply = await client.step(index, time, image, prediction?.track.polygon);
          if (analysisRef.current !== current) throw new Error('Tracking was cancelled because the active analysis changed');
          if (reply?.type === 'stopped') {
            stoppedAt = reply.stoppedAt ?? index;
            reason = reply.reason ?? `tracking stopped at frame ${index + 1}`;
            segmentFailed = true;
            break;
          }

          let produced: TrackFrame | null = null;
          if (reply?.track) {
            const track = reply.track;
            if (flow?.affine && prediction) {
              // Combine both engines: the SAM mask stays authoritative, while
              // the flow measurement provides the nose/tail/centre positions
              // and the cross-check that the two engines agree.
              const agreement = polygonIou(track.polygon, prediction.track.polygon);
              const axis = flowAxisPoints(track.polygon);
              const flowInfo = prediction.track.flow!;
              track.flow = {
                ...flowInfo,
                skipped: false,
                agreement,
                nose: axis.nose,
                tail: axis.tail,
                centre: axis.centre,
                dx: polygonCentroid(track.polygon).x - polygonCentroid(lastTrack!.polygon).x,
                dy: polygonCentroid(track.polygon).y - polygonCentroid(lastTrack!.polygon).y,
              };
              track.inlierRatio = Math.max(track.inlierRatio, flow.inlierRatio);
              track.fbError = flow.fbError;
              track.featureCount = Math.max(track.featureCount, Math.round(flow.features));
              if (agreement < 0.5) track.qualityNotes = [...track.qualityNotes, 'OpenCV and SAM 2.1 outlines disagree on this frame'];
            }
            produced = track;
            framesSinceSam = 0;
          } else if (prediction) {
            produced = prediction.track;
            framesSinceSam++;
          }

          if (!produced) {
            stoppedAt = index;
            reason = `tracking produced no result at frame ${index + 1}`;
            segmentFailed = true;
            break;
          }
          // The later keyframe itself is user-owned; the next segment starts
          // from it. The current frame's start geometry is useful metadata.
          if (index !== segmentStart || segmentStart === frame || !segment.keyframe) frames.push(produced);
          processed++;
          const elapsed = Date.now() - startedAt;
          const remaining = Math.max(0, endFrame - index);
          const etaMs = processed > 0 ? (elapsed / processed) * remaining : null;
          seekToFrame(index);
          setTrackProgress({
            done: Math.max(0, index - frame),
            total: Math.max(1, endFrame - frame),
            quality: produced.quality,
            etaMs,
          });
          lastImage = image;
          lastTrack = produced;
        }
        if (segmentFailed) break;
        completedSegments++;
      }

      if (!frames.length) throw new Error(reason || 'Tracking produced no frames');
      if (analysisRef.current !== current) throw new Error('Tracking was cancelled because the active analysis changed');
      updateAnalysis((draft) => {
        const object = draft.objects.find((o) => o.id === selectedObject.id);
        if (!object) return;
        const manualFrames = [...new Set([...object.manualFrames, ...selectedObject.manualFrames, frame])].sort((a, b) => a - b);
        object.frames = mergeTrackedFrames(object.frames, frames, manualFrames, frame, endFrame, stoppedAt);
        object.manualFrames = manualFrames;
        if (!object.initialPolygon.length) {
          object.initialFrame = frame;
          object.initialPolygon = geometry.polygon;
          object.initialReferences = geometry.references;
        }
      });
      beginDraft([], []);
      const last = frames[frames.length - 1];
      seekToFrame(last.frame);
      notify(
        `Tracked ${frames.length} frames across ${completedSegments} keyframe interval${completedSegments === 1 ? '' : 's'}${stoppedAt !== null ? ` · ${reason}` : ''}`,
        stoppedAt !== null ? 'warn' : 'success',
      );
    } catch (err: any) {
      const message = err?.message ?? 'Tracking failed';
      if (trackCancelRef.current || /cancel/i.test(message)) {
        notify('Tracking cancelled', 'warn');
      } else {
        if (/SAM 2\.1|engine|model/i.test(message)) {
          setEngineState('error');
          setEngineError(message);
        }
        notify(message, 'error');
      }
    } finally {
      flowClient.dispose();
      void client.cancel();
      setTracking(false);
      trackingRef.current = false;
      setTrackProgress({ done: 0, total: 0, quality: null, etaMs: null });
      // Re-derive the panel state from the installed component: a stopped run or
      // a cancelled one must not leave the Track button disabled.
      void refreshEngine();
    }
  };

  const cancelTracking = () => {
    trackCancelRef.current = true;
  };

  const pickTime = (time: number) => {
    const current = analysisRef.current;
    if (!current || !current.media.timestamps.length) return;
    seekToFrame(nearestFrame(current.media.timestamps, time));
  };

  const calibrationPoint = (kind: MotionTool, point: MotionPoint) => {
    if (!analysis) return;
    const homographyCount = analysis.calibration.homographyPoints.length + (kind === 'homography' ? 1 : 0);
    updateAnalysis((draft) => {
      const calibration = draft.calibration;
      if (kind === 'origin') calibration.origin = point;
      if (kind === 'xaxis') calibration.xAxisPoint = point;
      if (kind === 'yaxis') calibration.yAxisPoint = point;
      if (kind === 'scale-a') {
        calibration.scalePointA = point;
        if (calibration.mode === 'none') calibration.mode = 'scale';
      }
      if (kind === 'scale-b') {
        calibration.scalePointB = point;
        if (calibration.mode === 'none') calibration.mode = 'scale';
      }
      if (kind === 'homography') {
        calibration.homographyPoints = [...calibration.homographyPoints, point].slice(0, 4);
        calibration.mode = 'homography';
      }
    });
    if (kind === 'homography' && homographyCount >= 4) setTool('select');
    else if (kind !== 'homography') setTool('select');
  };

  const useObjectReferences = () => {
    if (!selectedObject) return;
    const references = currentGeometry?.references ?? selectedObject.initialReferences;
    if (references.length < 2) {
      notify('Add and name at least two reference points first', 'warn');
      return;
    }
    if (!(selectedObject.actualLength > 0)) {
      notify('Enter the object’s actual length before using it as a scale reference', 'warn');
      return;
    }
    updateCalibration({
      mode: 'scale',
      scalePointA: references[0].point,
      scalePointB: references[1].point,
      knownLength: selectedObject.actualLength,
      lengthUnit: selectedObject.lengthUnit,
    });
    notify('Scale calibration taken from the first two reference points', 'success');
  };

  const exportCsv = async () => {
    const current = analysisRef.current;
    if (!current) return;
    if (!current.objects.some((o) => o.frames.length)) {
      notify('There are no tracked frames to export', 'warn');
      return;
    }
    try {
      setExporting(true);
      const result = await api.exportMotionCsv(current.name, csvFor(current));
      if (!result.canceled) notify('Measurements exported as CSV', 'success');
    } catch (err: any) {
      notify(err?.message ?? 'CSV export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  const exportProject = async () => {
    const current = analysisRef.current;
    if (!current) return;
    try {
      setExporting(true);
      await save(false);
      const result = await api.exportMotionProject(analysisRef.current ?? current, current.name);
      if (!result.canceled) notify('Motion analysis project exported', 'success');
    } catch (err: any) {
      notify(err?.message ?? 'Project export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  const captureFrameImage = (format: 'image/jpeg' | 'image/png' = 'image/jpeg'): string | null => {
    const stage = document.querySelector('.motion-stage') as HTMLElement | null;
    const mediaElement = stage?.querySelector('.motion-media') as HTMLVideoElement | HTMLImageElement | null;
    const overlay = stage?.querySelector('canvas.motion-overlay') as HTMLCanvasElement | null;
    const inner = stage?.querySelector('.motion-stage-inner') as HTMLElement | null;
    if (!stage || !mediaElement) return null;
    const width = mediaElement instanceof HTMLVideoElement ? mediaElement.videoWidth : mediaElement.naturalWidth;
    const height = mediaElement instanceof HTMLVideoElement ? mediaElement.videoHeight : mediaElement.naturalHeight;
    if (!width || !height) return null;
    const rect = stage.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const context = canvas.getContext('2d');
    if (!context) return null;
    // Match the stage's current pan/zoom; the overlay canvas already uses the
    // same viewport-resolution transform, so the two images align exactly.
    const transform = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(inner?.style.transform ?? '');
    const panX = transform ? Number(transform[1]) : 0;
    const panY = transform ? Number(transform[2]) : 0;
    const zoom = transform ? Number(transform[3]) : 1;
    context.save();
    context.translate(panX * dpr, panY * dpr);
    context.scale(zoom, zoom);
    context.drawImage(mediaElement, 0, 0, rect.width, rect.height);
    context.restore();
    if (overlay) context.drawImage(overlay, 0, 0, canvas.width, canvas.height);
    try {
      return format === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.9);
    } catch {
      return null;
    }
  };

  const exportAnnotatedFrame = async () => {
    const dataUrl = captureFrameImage('image/png');
    if (!dataUrl) {
      notify('The current frame is not ready to export', 'warn');
      return;
    }
    try {
      const result = await api.saveImage(dataUrl, `${analysis?.name ?? 'motion'}-frame-${frame + 1}`, 'Export annotated frame as PNG');
      if (!result.canceled) notify('Annotated frame saved as PNG', 'success');
    } catch (err: any) {
      notify(err?.message ?? 'Annotated frame export failed', 'error');
    }
  };

  const exportReport = async () => {
    const current = analysisRef.current;
    if (!current) return;
    if (!current.objects.some((o) => o.frames.length)) {
      notify('Track at least one object before generating a report', 'warn');
      return;
    }
    try {
      setExporting(true);
      const results = allObjectResults(current);
      const html = buildMotionReport({
        analysis: current,
        projectName: project?.name ?? '',
        results,
        frameImage: captureFrameImage(),
        selectedFrame: frame,
      });
      const result = await api.exportMotionReport(current.name, html);
      if (!result.canceled) notify(`PDF report saved${result.path ? `: ${result.path}` : ''}`, 'success');
    } catch (err: any) {
      notify(err?.message ?? 'Report export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  const exportGraph = async () => {
    const dataUrl = chartRef.current?.exportPng();
    if (!dataUrl) {
      notify('Open a graph with data before exporting', 'warn');
      return;
    }
    try {
      const result = await api.saveImage(dataUrl, `${analysis?.name ?? 'motion'}-graph`, 'Export graph as PNG');
      if (!result.canceled) notify('Graph image saved', 'success');
    } catch (err: any) {
      notify(err?.message ?? 'Graph export failed', 'error');
    }
  };

  const closeAnalysis = async () => {
    if (trackingRef.current || scanningRef.current) {
      notify('Stop the current tracking or timing scan before closing the analysis', 'warn');
      return;
    }
    if (dirty) {
      const ok = await confirm({ title: 'Close without saving?', message: 'Unsaved tracking or calibration changes will be lost.', confirmLabel: 'Close without saving', danger: true });
      if (!ok) return;
    }
    setAnalysis(null);
    analysisRef.current = null;
    setRecordId(null);
    loadedIdRef.current = null;
    setVideoUrl('');
    setImageUrl('');
    dirtyRef.current = false;
    setDirty(false);
    setDraftPolygon([]);
    setDraftReferences([]);
    navigate('#/motion');
  };

  const removeAnalysis = async (row: any) => {
    if (row.id === recordId && (trackingRef.current || scanningRef.current)) {
      notify('Stop the current tracking or timing scan before deleting this analysis', 'warn');
      return;
    }
    const ok = await confirm({ title: `Delete “${row.name}”?`, message: 'The analysis project will be deleted. The original media file is not touched.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.remove('motion_analysis', row.id);
      analyses.reload();
      if (recordId === row.id) {
        setAnalysis(null);
        analysisRef.current = null;
        setRecordId(null);
        loadedIdRef.current = null;
        dirtyRef.current = false;
        navigate('#/motion');
      }
      notify('Motion analysis deleted', 'success');
    } catch (err: any) {
      notify(err?.message ?? 'Could not delete the analysis', 'error');
    }
  };

  const calibrationDescription = useMemo(() => {
    if (!analysis) return null;
    return analysis.calibration.mode !== 'none' ? analysis.calibration : null;
  }, [analysis]);

  const readout = {
    time: frameTime,
    x: currentResult?.x ?? null,
    y: currentResult?.y ?? null,
    speed: currentResult?.speed ?? null,
    calibrated: currentResult?.calibrated ?? false,
    unit: selectedResult?.summary.unit ?? 'px',
  };

  if (!projectId) {
    return (
      <div className="page">
        <PageHeader title="Video & Image Analysis" subtitle="Local motion measurement and tracking" />
        <EmptyState title="Select a project" message="Motion analyses are stored inside a project." icon="video" />
      </div>
    );
  }

  if (opening) {
    return (
      <div className="page">
        <PageHeader title="Video & Image Analysis" subtitle="Opening analysis…" />
        <Spinner label="Loading analysis and media…" />
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="page motion-page">
        <PageHeader
          title="Video & Image Analysis"
          subtitle="Track objects in ordinary video, calibrate physical scale and extract scientific motion measurements — fully offline."
          actions={
            <>
              <Button icon="upload" onClick={() => setImportOpen(true)}>New analysis</Button>
              <Button icon="download" onClick={() => void importProject()}>Import project</Button>
            </>
          }
        />
        <div className="motion-library-intro">
          <div>
            <strong>From footage to measurements.</strong> Import a video, image or image sequence. Draw a polygon around an object, let SAM 2.1 segment and track it, and correct any frame. Add a coordinate system and a known distance to obtain calibrated position, speed, velocity, acceleration and angles. Everything stays on this computer.
          </div>
          <div className="motion-badge-row">
            <Badge tone="ok">Offline</Badge>
            <Badge tone="ok">On-device SAM 2.1</Badge>
            <Badge tone="neutral">Meta SAM 2.1 Small · Apache-2.0</Badge>
            <Badge tone="warn">2D measurements with stated assumptions</Badge>
          </div>
        </div>
        <Panel
          title={`Saved analyses (${analyses.data?.length ?? 0})`}
          actions={<Button size="sm" icon="plus" onClick={() => setImportOpen(true)}>New</Button>}
        >
          {(analyses.data?.length ?? 0) === 0 ? (
            <EmptyState title="No motion analyses yet" message="Create an analysis and import a video, still image or image sequence." icon="video" action={<Button variant="primary" icon="upload" onClick={() => setImportOpen(true)}>Import media</Button>} />
          ) : (
            <DataTable
              rows={analyses.data ?? []}
              columns={[
                { key: 'name', label: 'Analysis', render: (r) => <span className="link-like">{r.name}</span> },
                { key: 'media_type', label: 'Media', render: (r) => <Badge>{r.media_type ?? 'file'}</Badge> },
                { key: 'media_path', label: 'Source', render: (r) => <span className="mono small">{baseName(r.media_path || '') || 'missing'}</span> },
                { key: 'updated_at', label: 'Updated', render: (r) => fmtDateTime(r.updated_at), width: '150px' },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  render: (r) => (
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn danger" title="Delete analysis" onClick={() => void removeAnalysis(r)}><Icon name="trash" size={14} /></button>
                    </div>
                  ),
                },
              ]}
              onRowClick={(r) => navigate(`#/motion?analysis=${r.id}`)}
            />
          )}
        </Panel>
        <div className="motion-workflow-grid">
          {[
            ['1', 'Import', 'Video, still image or image sequence. Read resolution and duration, then retrieve or enter real frame timing.'],
            ['2', 'Define', 'Draw a polygon or rectangle and name nose, tail or other reference points for each object.'],
            ['3', 'Track', 'SAM 2.1 segments the outlined object and propagates its mask through the clip. Correct any frame; later tracking resumes from that correction.'],
            ['4', 'Calibrate', 'Set an origin, axes and a known distance, or use a four-corner planar homography.'],
            ['5', 'Analyse', 'Position, displacement, distance, speed, velocity, acceleration, direction and projected orientation — with raw and smoothed series.'],
            ['6', 'Export', 'CSV measurements, PDF report with graphs, graph images and a versioned .tbmotion project.'],
          ].map(([n, title, text]) => (
            <div className="motion-workflow-card" key={n}>
              <span className="motion-workflow-number">{n}</span>
              <strong>{title}</strong>
              <p>{text}</p>
            </div>
          ))}
        </div>
        <p className="muted small">
          Limitations are part of the result: a single ordinary video is a 2D projection. A simple pixel scale is not valid when depth changes; homography applies only to its calibrated plane. No depth or camera mounting angle is invented.
        </p>
        <ImportModal
          open={importOpen}
          draft={importDraft}
          creating={creating}
          onClose={() => setImportOpen(false)}
          onChange={setImportDraft}
          onPick={() => void pickImportFiles()}
          onCreate={() => void createAnalysis()}
        />
      </div>
    );
  }

  const media = analysis.media;
  const canTrack =
    !!selectedObject &&
    timingKnown &&
    media.kind !== 'image' &&
    frameCount > 1 &&
    (draftPolygon.length >= 3 || (currentGeometry?.polygon.length ?? 0) >= 3) &&
    !tracking;

  return (
    <div className="page motion-page">
      <PageHeader
        title="Video & Image Analysis"
        subtitle={
          <span>
            {analysis.name} · {media.width} × {media.height} px · {media.kind}
            {media.variableFrameRate ? ' · variable timing' : ''}
          </span>
        }
        actions={
          <>
            <Button icon="chevron" onClick={() => void closeAnalysis()}>Library</Button>
            <Button icon="save" onClick={() => void save(true)} disabled={saving}>{saving ? 'Saving…' : dirty ? 'Save *' : 'Saved'}</Button>
            <Button icon="download" variant="primary" onClick={() => setTab('export')}>Export</Button>
          </>
        }
      />

      {mediaMissing && (
        <div className="motion-missing">
          <Icon name="warning" size={18} />
          <div>
            <strong>Source media is missing.</strong> {mediaError ?? 'The file was moved, renamed or is on an unavailable drive.'} The analysis data is preserved.
          </div>
          <Button size="sm" icon="link" onClick={() => void relink()}>Relink media</Button>
        </div>
      )}
      {mediaError && !mediaMissing && (
        <div className="motion-warn small" role="alert">
          {mediaError}
        </div>
      )}

      <div className="motion-workspace">
        <div className="motion-main">
          <div className="motion-workspace-head">
            <Input value={analysis.name} onChange={(e) => updateAnalysis((draft) => { draft.name = e.target.value; })} aria-label="Analysis name" />
            <span className={`motion-save-state ${dirty ? 'dirty' : ''}`}>{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
            <Badge tone={selectedResult?.calibration.calibrated ? 'ok' : 'warn'}>{selectedResult?.calibration.description.label ?? 'Image-plane only'}</Badge>
          </div>

          <MotionStage
            analysis={analysis}
            mediaUrl={imageUrl}
            videoUrl={videoUrl}
            videoRef={videoRef}
            selectedObject={selectedObject}
            frame={frame}
            tool={tool}
            draftPolygon={draftPolygon}
            draftReferences={draftReferences}
            selectedPoint={selectedPoint}
            readout={readout}
            onCanvasPoint={(point) => {
              if (tool === 'reference') addReference(point);
              else if (tool === 'polygon') addPoint(point);
            }}
            onRectangle={(a, b) => {
              pushHistory();
              setDraftPolygon(rectanglePolygon(a, b));
              setTool('select');
              notify('Rectangle ready. Apply it or drag its vertices to refine.', 'info');
            }}
            onMovePoint={movePoint}
            onMoveReference={moveReference}
            onInsertPoint={insertPoint}
            onBeginPointDrag={beginPointDrag}
            onBeginReferenceDrag={beginReferenceDrag}
            onSelectPoint={setSelectedPoint}
            onCalibrationPoint={calibrationPoint}
            onVideoTime={handleVideoTime}
            onVideoReady={handleVideoReady}
            onPlayState={setPlaying}
            onFinishPolygon={applyDraft}
          />

          <div className="motion-transport">
            <Button icon={playing ? 'pause' : 'play'} onClick={() => void togglePlay()} title={playing ? 'Pause' : 'Play'} disabled={media.kind !== 'video' || !videoReady || tracking || scanning} />
            <Button icon="stop" onClick={stopPlayback} title="Stop" disabled={media.kind !== 'video' || tracking || scanning} />
            <Button icon="step-back" onClick={() => seekToFrame(frame - 1)} title="Previous frame" disabled={frame <= 0 || tracking || scanning} />
            <Button icon="step-forward" onClick={() => seekToFrame(frame + 1)} title="Next frame" disabled={frame >= maxFrame || tracking || scanning} />
            <input
              className="motion-range"
              type="range"
              min={0}
              max={Math.max(0, maxFrame)}
              step={1}
              value={Math.min(frame, Math.max(0, maxFrame))}
              onChange={(e) => seekToFrame(Number(e.target.value))}
              disabled={tracking || scanning}
              aria-label="Timeline frame"
            />
            <div className="motion-frame-readout">
              <Input
                type="number"
                min={1}
                max={Math.max(1, frameCount)}
                value={frame + 1}
                onChange={(e) => seekToFrame(Number(e.target.value) - 1)}
                disabled={tracking || scanning}
                className="motion-frame-input"
                aria-label="Frame number"
              />
              <span className="muted small">/ {frameCount || '—'}</span>
              <span className="mono small">{frameTime !== null ? `${frameTime.toFixed(4)} s` : 'time unknown'}</span>
            </div>
            <Select
              value={String(speed)}
              onChange={(value) => {
                const valueNumber = Number(value);
                setSpeed(valueNumber);
                if (videoRef.current) videoRef.current.playbackRate = valueNumber;
              }}
              options={[0.25, 0.5, 1, 2, 4].map((value) => ({ value: String(value), label: `${value}×` }))}
              className="motion-speed"
              disabled={tracking || scanning}
            />
            <form
              className="motion-jump"
              onSubmit={(e) => {
                e.preventDefault();
                const value = Number(jumpTime);
                if (Number.isFinite(value)) {
                  const index = nearestFrame(times, value);
                  seekToFrame(index);
                }
              }}
            >
              <Input value={jumpTime} onChange={(e) => setJumpTime(e.target.value)} placeholder="jump to s" aria-label="Jump to timestamp" disabled={tracking || scanning} />
              <Button size="sm" type="submit" disabled={tracking || scanning}>Go</Button>
            </form>
          </div>

          <div className="motion-timing-bar">
            <div className="motion-timing-status">
              <Badge tone={timingKnown ? 'ok' : 'warn'}>{timingLabel(media.timingSource)}</Badge>
              <span className="small muted">{frameCount ? `${frameCount} frames` : 'frame count unknown'}{media.fps ? ` · mean ${media.fps.toFixed(3)} fps` : ''}{media.variableFrameRate ? ' · variable intervals' : ''}</span>
            </div>
            {media.kind !== 'image' && (
              <div className="motion-timing-actions">
                {media.kind === 'video' && (
                  <>
                    <Button size="sm" icon="refresh" onClick={() => void scanTiming()} disabled={!videoReady || scanning || tracking}>
                      {scanning ? `Scanning ${Math.round(scanProgress.progress * 100)}%` : 'Scan real timestamps'}
                    </Button>
                    {scanning && <Button size="sm" onClick={() => { scanCancelRef.current = true; }}>Cancel scan</Button>}
                  </>
                )}
                <div className="inline-field">
                  <Input value={fpsInput} onChange={(e) => setFpsInput(e.target.value)} aria-label="Manual frame rate" className="motion-fps-input" />
                  <span className="muted small">fps</span>
                  <Button size="sm" onClick={applyManualFps} disabled={scanning || tracking}>Apply manual FPS</Button>
                </div>
              </div>
            )}
            {!timingKnown && media.kind !== 'image' && <div className="motion-warn small">Tracking is disabled until frame timing is known. No FPS has been assumed.</div>}
          </div>

          {tracking && (
            <div className="motion-progress">
              <div className="motion-progress-bar"><span style={{ width: `${trackProgress.total ? Math.min(100, (trackProgress.done / trackProgress.total) * 100) : 0}%` }} /></div>
              <span className="small">
                {trackProgress.total === 0 && !trackProgress.done
                  ? 'Loading SAM 2.1 Small…'
                  : `Tracking frame ${frame + 1} · ${trackProgress.quality !== null ? `mask confidence ${Math.round(trackProgress.quality)}` : 'segmentation starting…'}${formatDuration(trackProgress.etaMs) ? ` · about ${formatDuration(trackProgress.etaMs)} left` : ''}`}
              </span>
              <Button size="sm" variant="danger" onClick={cancelTracking}>Stop</Button>
            </div>
          )}

          <Tabs
            tabs={[
              { key: 'objects', label: 'Objects & tracking', count: analysis.objects.length },
              { key: 'calibration', label: 'Calibration' },
              { key: 'analysis', label: 'Motion analysis', count: selectedObject?.frames.length },
              { key: 'export', label: 'Export' },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === 'objects' && (
            <div className="stack">
              <Panel title="Object definition & reference points">
                {!selectedObject ? (
                  <EmptyState title="No objects" message="Create an object, then draw its outline." icon="target" action={<Button variant="primary" icon="plus" onClick={newObject}>Add object</Button>} />
                ) : (
                  <div className="stack">
                    <div className="form-grid">
                      <Field label="Object name">
                        <Input value={selectedObject.name} onChange={(e) => updateObject(selectedObject.id, { name: e.target.value })} />
                      </Field>
                      <Field label="Current geometry">
                        <div className="muted small">
                          Frame {frame + 1}: {displayPolygon.length} outline points · {displayReferences.length} reference points
                          {currentResult ? ` · ${Math.round(currentResult.quality)}/100 quality` : ' · no tracked position'}
                        </div>
                      </Field>
                    </div>
                    <div className="motion-tool-row">
                      <Button size="sm" icon="target" variant={tool === 'polygon' ? 'primary' : 'default'} onClick={redraw}>Draw polygon</Button>
                      <Button size="sm" variant={tool === 'rectangle' ? 'primary' : 'default'} onClick={() => { beginDraft([], []); setTool('rectangle'); }}>Rectangle</Button>
                      <Button size="sm" onClick={correctHere}>Correct this frame</Button>
                      <Button size="sm" icon="check" onClick={addKeyframeHere} disabled={!currentGeometry}>Add keyframe here</Button>
                      <Button size="sm" icon="undo" onClick={undoDraft} disabled={!undoStack.length}>Undo</Button>
                      <Button size="sm" icon="redo" onClick={redoDraft} disabled={!redoStack.length}>Redo</Button>
                      <Button size="sm" icon="trash" onClick={deleteSelectedPoint} disabled={selectedPoint < 0}>Delete point</Button>
                      <Button size="sm" icon="check" variant="primary" onClick={applyDraft} disabled={draftPolygon.length < 3}>Apply outline</Button>
                    </div>
                    <div className="motion-hint small muted">
                      Polygon: click to add points, double-click or Apply outline to finish. Select tool: drag vertices or reference points. Alt+double-click an edge inserts a point. Hold Space and drag to pan; wheel to zoom.
                    </div>
                    <div className="motion-reference-row">
                      <Input value={referenceName} onChange={(e) => setReferenceName(e.target.value)} placeholder="Reference name" />
                      <Button size="sm" variant={tool === 'reference' ? 'primary' : 'default'} onClick={() => setTool('reference')}>Place reference point</Button>
                      <Button size="sm" onClick={() => setReferenceName('Nose')}>Nose</Button>
                      <Button size="sm" onClick={() => setReferenceName('Tail')}>Tail</Button>
                    </div>
                    {displayReferences.length > 0 && (
                      <div className="motion-reference-list">
                        {displayReferences.map((reference, index) => (
                          <div className="motion-reference-item" key={reference.id || index}>
                            <span className="motion-ref-dot" />
                            <span>{reference.name}</span>
                            <span className="mono small">({reference.point.x.toFixed(1)}, {reference.point.y.toFixed(1)}) px</span>
                            <button className="icon-btn danger" title="Remove reference" onClick={() => deleteReference(index)}><Icon name="x" size={12} /></button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="motion-warn small">
                      Reference points define apparent length and projected orientation. The first two points are used as the orientation axis; name them Nose and Tail in order. A reference point is not a 3D point.
                    </div>
                  </div>
                )}
              </Panel>
              <Panel title="Tracking history">
                {!selectedObject || selectedObject.frames.length === 0 ? (
                  <div className="muted small">No tracked frames yet. Draw an outline and use Track.</div>
                ) : (
                  <>
                    <div className="motion-tracking-meta">
                      <span>{selectedObject.frames.length} tracked frames</span>
                      <span>{selectedObject.manualFrames.length} keyframes / corrections</span>
                      <span>{selectedObject.frames.filter((f) => f.status === 'uncertain').length} uncertain frames</span>
                      {analysis.settings.compensateCamera && <span>camera compensation requested</span>}
                    </div>
                    {selectedObject.manualFrames.length > 0 && (
                      <div className="motion-keyframe-list">
                        {[...selectedObject.manualFrames].sort((a, b) => a - b).map((keyframe) => (
                          <div className="motion-keyframe-item" key={keyframe}>
                            <button className="link-like mono" onClick={() => seekToFrame(keyframe)}>
                              frame {keyframe + 1}
                            </button>
                            <span className="muted small">{analysis.media.timestamps[keyframe] !== undefined ? `${analysis.media.timestamps[keyframe].toFixed(4)} s` : 'time unknown'}</span>
                            <Badge tone="neutral">keyframe</Badge>
                            <button className="icon-btn danger" title="Delete keyframe" onClick={() => void removeKeyframe(keyframe)}>
                              <Icon name="trash" size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {(selectedObject.history?.length ?? 0) > 0 && (
                      <div className="motion-history-list">
                        <div className="field-label">Correction history</div>
                        {[...(selectedObject.history ?? [])].reverse().slice(0, 6).map((entry) => (
                          <div className="motion-keyframe-item" key={entry.id}>
                            <span className="mono small">frame {entry.frame + 1}</span>
                            <span className="muted small">{entry.action}</span>
                            <span className="muted small">{new Date(entry.at).toLocaleString()}</span>
                            <Button size="sm" onClick={() => restoreKeyframe(entry)} disabled={entry.polygon.length < 3}>Restore</Button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="motion-review-list">
                      {selectedObject.frames
                        .filter((f) => f.status === 'uncertain' || f.status === 'manual' || f.quality < analysis.settings.qualityThreshold)
                        .slice(0, 80)
                        .map((f) => (
                          <button key={f.frame} className={`motion-review-item ${f.frame === frame ? 'active' : ''}`} onClick={() => seekToFrame(f.frame)}>
                            <span className="mono">frame {f.frame + 1}</span>
                            <Badge tone={f.status === 'manual' ? 'neutral' : f.status === 'uncertain' ? 'warn' : 'ok'}>{f.status}</Badge>
                            <span className="mono">{Math.round(f.quality)}</span>
                            <span className="muted small">{f.qualityNotes[0] ?? ''}</span>
                          </button>
                        ))}
                    </div>
                  </>
                )}
              </Panel>
            </div>
          )}

          {tab === 'calibration' && (
            <CalibrationPanel
              analysis={analysis}
              selectedObject={selectedObject}
              result={selectedResult}
              frame={frame}
              currentTime={frameTime}
              tool={tool}
              onTool={setTool}
              onCalibration={updateCalibration}
              onSettings={updateSettings}
              onObject={(patch) => selectedObject && updateObject(selectedObject.id, patch)}
              onUseObjectReferences={useObjectReferences}
              onClearCalibration={() => updateCalibration({ mode: 'none', homographyPoints: [] })}
            />
          )}

          {tab === 'analysis' && (
            <AnalysisPanel
              analysis={analysis}
              selectedObject={selectedObject}
              results={selectedResult ? { [selectedObject?.id ?? '']: selectedResult } : {}}
              frame={frame}
              onPickTime={pickTime}
              chartRef={chartRef}
              onExportGraph={() => void exportGraph()}
            />
          )}

          {tab === 'export' && (
            <div className="stack">
              <Panel title="Export results" subtitle="Exports use the current tracking history and calibration" actions={<Badge tone={dirty ? 'warn' : 'ok'}>{dirty ? 'Unsaved changes' : 'Saved'}</Badge>}>
                <div className="motion-export-grid">
                  <div className="motion-export-card">
                    <Icon name="doc" size={20} />
                    <strong>Frame-by-frame CSV</strong>
                    <p>One row per tracked frame and object, with units, raw and smoothed values, quality and measurement status.</p>
                    <Button icon="download" onClick={() => void exportCsv()} disabled={exporting}>Export CSV</Button>
                  </div>
                  <div className="motion-export-card">
                    <Icon name="report" size={20} />
                    <strong>PDF analysis report</strong>
                    <p>Project and media metadata, calibration, object definitions, keyframes, graphs, trajectory, frame data, assumptions and limitations. The selected graph can also be saved as a PNG from the Motion analysis tab.</p>
                    <Button icon="download" onClick={() => void exportReport()} disabled={exporting}>Generate PDF</Button>
                  </div>
                  <div className="motion-export-card">
                    <Icon name="save" size={20} />
                    <strong>Portable project</strong>
                    <p>A versioned .tbmotion project with media references, calibration, tracking history and manual corrections.</p>
                    <Button icon="download" onClick={() => void exportProject()} disabled={exporting}>Export project</Button>
                  </div>
                  <div className="motion-export-card">
                    <Icon name="video" size={20} />
                    <strong>Annotated frame</strong>
                    <p>The current video frame, outline, reference points, axes and overlays at the current view, saved as a PNG.</p>
                    <Button icon="download" onClick={() => void exportAnnotatedFrame()} disabled={exporting || !videoReady && media.kind === 'video'}>Export frame PNG</Button>
                  </div>
                </div>
              </Panel>
              <Panel title="Data status">
                <div className="motion-tracking-meta">
                  <span>Media: {media.name}</span>
                  <span>Timing: {timingLabel(media.timingSource)}</span>
                  <span>Calibration: {selectedResult?.calibration.description.label ?? 'none'}</span>
                  <span>Objects: {analysis.objects.length}</span>
                  <span>Tracked frames: {analysis.objects.reduce((sum, object) => sum + object.frames.length, 0)}</span>
                </div>
                <div className="motion-warn small">
                  Annotated-video export and bundled media copies are not provided. The original media file is never modified. The report includes the current stage frame and inline vector graphs; choose Export CSV for the authoritative data.
                </div>
                <div className="row-actions">
                  <Button icon="save" onClick={() => void save(true)} disabled={saving}>Save analysis</Button>
                  <Button icon="link" onClick={() => void relink()}>Relink source media</Button>
                </div>
              </Panel>
            </div>
          )}
        </div>

        <aside className="motion-sidebar">
          <Panel title="Objects" actions={<Button size="sm" icon="plus" onClick={newObject}>Add</Button>}>
            <div className="motion-object-list">
              {analysis.objects.map((object) => (
                <button
                  key={object.id}
                  className={`motion-object-item ${object.id === selectedObject?.id ? 'active' : ''}`}
                  onClick={() => { updateAnalysis((draft) => { draft.selectedObjectId = object.id; }); beginDraft([], []); setTool('select'); }}
                >
                  <span className="motion-object-dot" style={{ background: object.color }} />
                  <span className="motion-object-name">{object.name}</span>
                  <span className="motion-object-meta">{object.frames.length > 0 ? `${object.frames.length} frames` : 'no track'}</span>
                </button>
              ))}
              {analysis.objects.length === 0 && <div className="muted small">Add an object to begin.</div>}
            </div>
          </Panel>

          <Panel title="Tracking" subtitle={`Start at frame ${frame + 1}`}>
            {!selectedObject ? (
              <div className="muted small">Create an object first.</div>
            ) : (
              <div className="stack">
                <Button
                  variant="primary"
                  icon="target"
                  onClick={() => void startTracking()}
                  disabled={!canTrack || tracking || scanning || engineState !== 'ready'}
                >
                  {tracking ? (engineState === 'loading' ? 'Loading SAM 2.1…' : 'Tracking…') : `Track ${selectedObject.name} through keyframes`}
                </Button>
                {tracking && (
                  <Button variant="danger" onClick={cancelTracking}>Stop tracking</Button>
                )}
                <div className={`motion-engine small ${engineState === 'error' ? 'motion-warn' : 'muted'}`}>
                  <div className="motion-tracking-meta">
                    <span>{SAM2_COMPONENT.name}</span>
                    <span>{SAM2_COMPONENT.license}</span>
                    <span>{sam2Status?.installed ? `${formatBytes(sam2Status.bytes)} installed` : `${formatBytes(SAM2_COMPONENT.archiveBytes)} download`}</span>
                  </div>
                  {sam2Status?.installed ? (
                    <div className="stack" style={{ gap: 3 }}>
                      <div>Segmentation runs locally · {sam2Status.runtime.replace(/ · /g, ', ')}</div>
                      <div>
                        <button type="button" className="link-like" onClick={() => void removeSam2Model()}>Remove model</button>
                      </div>
                    </div>
                  ) : installing ? (
                    <div className="stack" style={{ gap: 6 }}>
                      <div className="motion-progress-row">
                        <div className="motion-progress-bar">
                          <span style={{ width: `${sam2Progress?.total ? Math.min(100, ((sam2Progress.received ?? 0) / sam2Progress.total) * 100) : 6}%` }} />
                        </div>
                        <Button size="sm" onClick={() => void cancelSam2Download()}>Cancel</Button>
                      </div>
                      <div>{sam2Progress?.message ?? 'Installing SAM 2.1 Small…'}</div>
                    </div>
                  ) : (
                    <div className="stack" style={{ gap: 6 }}>
                      <div>
                        Download SAM 2.1 Small once ({formatBytes(SAM2_COMPONENT.archiveBytes)}). It is checksum-verified, stored outside the installer and then runs offline on the CPU. About 300 MB of free disk space is needed.
                      </div>
                      <Button size="sm" icon="download" onClick={() => void installSam2Model()} disabled={engineState === 'checking'}>
                        Install SAM 2.1 Small
                      </Button>
                    </div>
                  )}
                  {engineState === 'checking' && <div><Spinner /> Checking the local SAM 2.1 component…</div>}
                  {engineState === 'loading' && <div><Spinner /> Loading the model into memory…</div>}
                </div>
                {engineState === 'error' && (
                  <div className="motion-warn small">Tracking engine error: {engineError}</div>
                )}
                {!tracking && (
                  <div className="muted small">
                    {!timingKnown
                      ? 'Timing is required. Scan the video or apply a manual FPS.'
                      : draftPolygon.length >= 3
                        ? 'The current draft outline will be used to reinitialise tracking.'
                        : currentGeometry
                          ? 'Tracking starts here, reinitialises at every later keyframe and preserves earlier frames and manual corrections.'
                          : 'Draw an outline on this frame, or jump to a tracked frame.'}
                  </div>
                )}
                <div className="motion-side-setting">
                  <span className="small muted">Review threshold</span>
                  <Input type="number" min="0" max="100" value={analysis.settings.qualityThreshold} onChange={(e) => updateSettings({ qualityThreshold: Math.min(100, Math.max(0, Number(e.target.value))) })} />
                </div>
                <div className="motion-warn small">
                  Quality combines the SAM 2.1 decoder's mask score, frame-to-frame mask overlap and area continuity. It is a heuristic confidence indicator, not a calibrated probability.
                </div>
              </div>
            )}
          </Panel>

          <Panel title="Measurement basis">
            <div className="motion-basis">
              <Badge tone={selectedResult?.calibration.calibrated ? 'ok' : 'warn'}>{selectedResult?.calibration.calibrated ? 'Calibrated' : 'Image plane'}</Badge>
              <div className="small muted">
                {calibrationDescription?.mode === 'none'
                  ? 'No physical scale. Positions are pixel offsets from the origin; speed is px/s.'
                  : selectedResult?.calibration.description.detail}
              </div>
              {selectedResult?.calibration.description.warnings.slice(0, 2).map((warning) => (
                <div className="motion-warn small" key={warning}>{warning}</div>
              ))}
            </div>
          </Panel>

          <Panel title="Notes">
            <textarea className="input textarea" rows={4} value={analysis.notes} onChange={(e) => updateAnalysis((draft) => { draft.notes = e.target.value; })} placeholder="Camera setup, assumptions, uncertainty…" />
          </Panel>
        </aside>
      </div>

      <ImportModal
        open={importOpen}
        draft={importDraft}
        creating={creating}
        onClose={() => setImportOpen(false)}
        onChange={setImportDraft}
        onPick={() => void pickImportFiles()}
        onCreate={() => void createAnalysis()}
      />
    </div>
  );
}

function ImportModal({
  open,
  draft,
  creating,
  onClose,
  onChange,
  onPick,
  onCreate,
}: {
  open: boolean;
  draft: { name: string; kind: 'video' | 'image' | 'sequence'; paths: string[] };
  creating: boolean;
  onClose: () => void;
  onChange: (value: { name: string; kind: 'video' | 'image' | 'sequence'; paths: string[] }) => void;
  onPick: () => void;
  onCreate: () => void;
}) {
  if (!open) return null;
  return (
    <Modal
      title="New motion analysis"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="upload" onClick={onCreate} disabled={creating || !draft.paths.length}>
            {creating ? 'Preparing media…' : 'Create analysis'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <Field label="Analysis name">
            <Input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="e.g. Launch 12 — ascent" />
          </Field>
          <Field label="Media type">
            <Select
              value={draft.kind}
              onChange={(value) => onChange({ ...draft, kind: value as any, paths: [] })}
              options={[
                { value: 'video', label: 'Video file' },
                { value: 'image', label: 'Single image' },
                { value: 'sequence', label: 'Image sequence' },
              ]}
            />
          </Field>
        </div>
        <div className="motion-file-picker">
          <Button icon="folder" onClick={onPick}>{draft.paths.length ? 'Choose different files' : 'Choose files'}</Button>
          <span className="muted small">
            {draft.paths.length ? `${draft.paths.length} file${draft.paths.length === 1 ? '' : 's'} selected: ${draft.paths.map(baseName).slice(0, 3).join(', ')}${draft.paths.length > 3 ? '…' : ''}` : 'Nothing selected'}
          </span>
        </div>
        <div className="muted small">
          Media files are referenced in place rather than copied, so keep them available. For video, the application reads real presentation timestamps where the local decoder provides them. It never assumes a frame rate silently. A sequence must have a known FPS before tracking.
        </div>
        <div className="motion-warn small">
          No cloud service or external API is used. Object definition is manual; segmentation and tracking run on this computer with Meta's SAM 2.1 Small model once you install that component. Media files never leave the machine.
        </div>
      </div>
    </Modal>
  );
}
