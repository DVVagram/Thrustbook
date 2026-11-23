import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { Badge, Button, DataTable, EmptyState, Field, Icon, Input, Modal, PageHeader, Panel, Select, Spinner } from '../ui';
import { fmtDateTime } from '../format';
import { unitsForDimension } from '../../shared/units';
import {
  Keyframe,
  KeyframeCalibration,
  KeyframeMedia,
  KeyframeSet,
  analyseKeyframeSet,
  describeKeyframeScale,
  emptyKeyframeCalibration,
  keyframeId,
  keyframeTime,
  normaliseKeyframeSet,
  removeKeyframeAt,
  reuseKeyframeSet,
  upsertKeyframe,
} from '../../shared/keyframes';
import { KeyframeStage, KeyframeTool } from '../keyframes/KeyframeStage';
import {
  manualTiming,
  nearestFrameIndex,
  probeVideo,
  scanVideoTiming,
  timingFromTimestamps,
  timingLabel,
} from '../keyframes/media';

const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi'];

interface KeyframeSetRecord {
  id: string;
  project_id: string;
  name: string;
  media_kind: string;
  media_path: string;
  notes: string;
  created_at: string;
  updated_at: string;
  set: KeyframeSet;
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function baseTitle(filePath: string): string {
  return baseName(filePath).replace(/\.[^.]+$/, '');
}

function formatNumber(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  // Suppress floating-point residue from symmetric interval differences.
  if (abs < 1e-9) return (0).toFixed(digits);
  if (abs < 1e-4 || abs >= 1e7) return value.toExponential(2);
  return value.toFixed(abs >= 1000 ? 1 : abs >= 100 ? 2 : digits);
}

export default function KeyframesPage() {
  const { projectId, route, navigate, notify, confirm } = useApp();
  const records = useAsync<KeyframeSetRecord[]>(
    () => (projectId ? api.keyframeSets(projectId) : Promise.resolve([])),
    [projectId],
  );

  const [draft, setDraft] = useState<KeyframeSet | null>(null);
  const draftRef = useRef<KeyframeSet | null>(null);
  const [setId, setSetId] = useState<string | null>(null);
  const setRef = useRef<string | null>(null);
  const loadedIdRef = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const changeSeqRef = useRef(0);
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  const [opening, setOpening] = useState(false);
  const [mediaMissing, setMediaMissing] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [videoReady, setVideoReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [frame, setFrame] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [jumpTime, setJumpTime] = useState('');
  const [fpsInput, setFpsInput] = useState('30');
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(false);
  const scanCancelRef = useRef(false);
  const [scanProgress, setScanProgress] = useState({ progress: 0, frames: 0 });

  const [tool, setTool] = useState<KeyframeTool>('mark');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [calibrationTarget, setCalibrationTarget] = useState<'A' | 'B' | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createPath, setCreatePath] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    scanningRef.current = scanning;
  }, [scanning]);

  useEffect(() => {
    setRef.current = setId;
  }, [setId]);

  const updateSet = useCallback((mutate: (next: KeyframeSet) => void) => {
    changeSeqRef.current += 1;
    setDirty(true);
    setDraft((previous) => {
      if (!previous) return previous;
      const next: KeyframeSet = {
        ...previous,
        media: { ...previous.media, timestamps: [...previous.media.timestamps] },
        keyframes: previous.keyframes.map((entry) => ({ ...entry })),
        calibration: { ...previous.calibration, pointA: previous.calibration.pointA ? { ...previous.calibration.pointA } : null, pointB: previous.calibration.pointB ? { ...previous.calibration.pointB } : null },
      };
      mutate(next);
      next.updatedAt = new Date().toISOString();
      draftRef.current = next;
      return next;
    });
  }, []);

  const save = useCallback(
    async (loud = false) => {
      const current = draftRef.current;
      const id = setRef.current;
      if (!current || !id || savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      const revision = changeSeqRef.current;
      try {
        const record = await api.saveKeyframeSet({ id, set: current, name: current.name, notes: current.notes });
        if (changeSeqRef.current === revision) {
          dirtyRef.current = false;
          setDirty(false);
        }
        if (record?.id) {
          loadedIdRef.current = record.id;
          setRef.current = record.id;
        }
        records.reload();
        if (loud) notify('Keyframe set saved', 'success');
      } catch (err: any) {
        notify(err?.message ?? 'Could not save the keyframe set', 'error');
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [notify, records],
  );
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    if (!draft || !dirty || !setId || saving || scanning) return;
    const timer = window.setTimeout(() => void saveRef.current(false), 1200);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, setId, saving, scanning]);

  const attachMedia = useCallback(async (next: KeyframeSet) => {
    if (!next.media.path) {
      setVideoUrl('');
      setImageUrl('');
      setMediaMissing(true);
      setMediaError('This keyframe set does not reference a video file.');
      return;
    }
    try {
      const info = await api.keyframeMediaUrl(next.media.path);
      if (next.media.kind === 'video') {
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
      setMediaError(err?.message ?? 'The source video is missing.');
    }
  }, []);

  const openSet = useCallback(
    async (id: string): Promise<boolean> => {
      if (!id || id === loadedIdRef.current) return true;
      if (dirtyRef.current && loadedIdRef.current && id !== loadedIdRef.current) {
        const ok = await confirmRef.current({
          title: 'Open another keyframe set?',
          message: 'Unsaved changes in the current set will be discarded.',
          confirmLabel: 'Discard and open',
          danger: true,
        });
        if (!ok) return false;
      }
      setOpening(true);
      try {
        const record = await api.keyframeSet(id);
        const next = normaliseKeyframeSet(record.set ?? record);
        next.name = record.name || next.name;
        next.createdAt = record.created_at || next.createdAt;
        next.updatedAt = record.updated_at || next.updatedAt;
        loadedIdRef.current = record.id;
        setRef.current = record.id;
        setSetId(record.id);
        setDraft(next);
        draftRef.current = next;
        setDirty(false);
        dirtyRef.current = false;
        setVideoReady(false);
        setPlaying(false);
        playingRef.current = false;
        setFrame(0);
        setSelectedId(null);
        setTool('mark');
        setCalibrationTarget(null);
        await attachMedia(next);
        return true;
      } catch (err: any) {
        notify(err?.message ?? 'Could not open the keyframe set', 'error');
        return false;
      } finally {
        setOpening(false);
      }
    },
    [attachMedia, notify],
  );

  useEffect(() => {
    const id = route.query.set;
    if (!id || id === loadedIdRef.current) return;
    void openSet(id);
  }, [route.query.set, openSet]);

  const frameCount = draft ? draft.media.frameCount ?? draft.media.timestamps.length : 0;
  const maxFrame = Math.max(0, frameCount - 1);
  const timingKnown = !!draft && draft.media.timestamps.length > 1;
  const frameTime = draft?.media.timestamps[frame] ?? null;
  const analysis = useMemo(() => (draft ? analyseKeyframeSet(draft) : null), [draft]);

  useEffect(() => {
    if (frame > maxFrame) setFrame(maxFrame);
  }, [frame, maxFrame]);

  const seekToFrame = useCallback((target: number) => {
    const current = draftRef.current;
    if (!current) return;
    const count = current.media.frameCount ?? current.media.timestamps.length;
    const next = Math.max(0, Math.min(Math.max(0, count - 1), Math.round(target)));
    setFrame(next);
    const video = videoRef.current;
    if (video && current.media.kind === 'video') {
      if (!video.paused) {
        video.pause();
        playingRef.current = false;
        setPlaying(false);
      }
      const time = current.media.timestamps[next];
      if (time !== undefined) {
        try {
          video.currentTime = time;
        } catch {
          /* the player catches up once metadata is ready */
        }
      }
    }
  }, []);

  const handleVideoTime = useCallback((time: number) => {
    const current = draftRef.current;
    if (!current || !playingRef.current || !current.media.timestamps.length) return;
    const index = nearestFrameIndex(current.media.timestamps, time);
    setFrame((previous) => (previous === index ? previous : index));
  }, []);

  useEffect(() => {
    if (!videoReady || playing || !timingKnown) return;
    const video = videoRef.current;
    const current = draftRef.current;
    if (!video || !current) return;
    const time = current.media.timestamps[frame];
    if (!Number.isFinite(time)) return;
    if (Math.abs(video.currentTime - time) > 1e-4) {
      try {
        video.currentTime = time;
      } catch {
        /* seeking can fail before enough data is buffered */
      }
    }
  }, [frame, playing, timingKnown, videoReady]);

  const handleVideoReady = useCallback(() => {
    setVideoReady(true);
    const video = videoRef.current;
    const current = draftRef.current;
    if (!video || !current || current.media.kind !== 'video') return;
    if (
      current.media.width > 0 &&
      current.media.height > 0 &&
      video.videoWidth > 0 &&
      (current.media.width !== video.videoWidth || current.media.height !== video.videoHeight)
    ) {
      setMediaError(
        `The source video is ${video.videoWidth}×${video.videoHeight}, but this set was saved at ${current.media.width}×${current.media.height}. Relink the original video so keyframe coordinates remain valid.`,
      );
      return;
    }
    const patch: Partial<KeyframeMedia> = {};
    if (video.videoWidth > 0 && (!current.media.width || !current.media.height)) {
      patch.width = video.videoWidth;
      patch.height = video.videoHeight;
    }
    if (current.media.duration === null && Number.isFinite(video.duration)) patch.duration = video.duration;
    if (Object.keys(patch).length) updateSet((next) => Object.assign(next.media, patch));
  }, [updateSet]);

  const applyTiming = useCallback(
    (timing: Pick<KeyframeMedia, 'timestamps' | 'frameCount' | 'fps' | 'duration' | 'timingSource' | 'variableFrameRate'>) => {
      updateSet((next) => {
        next.media = { ...next.media, ...timing };
        next.keyframes = next.keyframes.map((entry) => ({ ...entry, time: keyframeTime(next.media, entry.frame) }));
      });
      setFrame(0);
      const video = videoRef.current;
      if (video) {
        try {
          video.currentTime = timing.timestamps[0] ?? 0;
        } catch {
          /* noop */
        }
      }
    },
    [updateSet],
  );

  const scanTiming = async () => {
    const current = draftRef.current;
    const video = videoRef.current;
    if (!current || !video || !videoReady) {
      notify('Wait for the video to load before scanning its timing', 'warn');
      return;
    }
    if (scanningRef.current) return;
    scanningRef.current = true;
    scanCancelRef.current = false;
    setScanning(true);
    setScanProgress({ progress: 0, frames: 0 });
    try {
      const result = await scanVideoTiming(
        video,
        () => scanCancelRef.current,
        (progress, frames) => setScanProgress({ progress, frames }),
      );
      if (scanCancelRef.current) {
        notify('Frame timing scan cancelled', 'warn');
        return;
      }
      if (result.timestamps.length < 2) {
        notify('The decoder did not present enough frames to establish timing. Use the manual FPS instead.', 'warn');
        return;
      }
      applyTiming(timingFromTimestamps(Number.isFinite(video.duration) ? video.duration : current.media.duration ?? 0, result.timestamps));
      notify(
        `Read ${result.timestamps.length} frame timestamps${result.droppedFrames > 0 ? ` · ${result.droppedFrames} presented frames were dropped` : ''}`,
        'success',
      );
    } catch (err: any) {
      notify(err?.message ?? 'The frame timing scan failed', 'error');
    } finally {
      scanningRef.current = false;
      setScanning(false);
    }
  };

  const applyManualFps = () => {
    const current = draftRef.current;
    if (!current) return;
    const fps = Number(fpsInput);
    if (!(fps > 0)) {
      notify('Enter a positive frame rate', 'warn');
      return;
    }
    const duration = current.media.duration ?? videoRef.current?.duration ?? 0;
    if (!(duration > 0)) {
      notify('The video duration is not known yet. Let it load before applying a manual FPS.', 'warn');
      return;
    }
    applyTiming(manualTiming(duration, fps));
    notify(`Frame timing set to ${fps} fps`, 'success');
  };

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
      notify(err?.message ?? 'Playback is unavailable for this video', 'error');
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
    playingRef.current = false;
    setPlaying(false);
    seekToFrame(0);
  };

  const placeKeyframe = (point: { x: number; y: number }) => {
    const current = draftRef.current;
    if (!current) return;
    if (!current.media.timestamps.length) {
      notify('Scan this video’s frame timing before placing keyframes', 'warn');
      return;
    }
    const time = keyframeTime(current.media, frame);
    if (time === null) {
      notify('This frame has no decoded timestamp', 'warn');
      return;
    }
    const existing = current.keyframes.find((entry) => entry.frame === frame);
    const keyframe: Keyframe = {
      id: existing?.id ?? keyframeId(),
      frame,
      time,
      x: point.x,
      y: point.y,
      notes: existing?.notes ?? '',
    };
    updateSet((next) => {
      next.keyframes = upsertKeyframe(next.keyframes, keyframe);
    });
    setSelectedId(keyframe.id);
    setTool('mark');
  };

  const moveKeyframe = (id: string, point: { x: number; y: number }) => {
    updateSet((next) => {
      next.keyframes = next.keyframes.map((entry) => (entry.id === id ? { ...entry, x: point.x, y: point.y } : entry));
    });
  };

  const deleteKeyframe = async (atFrame: number) => {
    const ok = await confirm({
      title: `Delete the keyframe at frame ${atFrame + 1}?`,
      message: 'The other keyframes and the saved set are unaffected.',
      confirmLabel: 'Delete keyframe',
      danger: true,
    });
    if (!ok) return;
    const remaining = (draftRef.current?.keyframes ?? []).filter((entry) => entry.frame !== atFrame);
    updateSet((next) => {
      next.keyframes = removeKeyframeAt(next.keyframes, atFrame);
    });
    if (!remaining.some((entry) => entry.id === selectedId)) setSelectedId(null);
  };

  const clearKeyframes = async () => {
    if (!draftRef.current?.keyframes.length) return;
    const ok = await confirm({
      title: 'Remove every keyframe?',
      message: 'The saved keyframe set keeps its video and scale but no marked positions.',
      confirmLabel: 'Clear keyframes',
      danger: true,
    });
    if (!ok) return;
    updateSet((next) => {
      next.keyframes = [];
    });
    setSelectedId(null);
  };

  const pickCalibration = (target: 'A' | 'B') => {
    setTool('calibration');
    setCalibrationTarget(target);
    notify(target === 'A' ? 'Click the first end of the known distance' : 'Click the second end of the known distance', 'info');
  };

  const handleCalibrationPoint = (point: { x: number; y: number }) => {
    updateSet((next) => {
      next.calibration.mode = 'scale';
      if (calibrationTarget === 'B') next.calibration.pointB = point;
      else next.calibration.pointA = point;
    });
    if (calibrationTarget === 'B') {
      setCalibrationTarget(null);
      setTool('mark');
    } else {
      setCalibrationTarget('B');
      notify('Now click the other end of the known distance', 'info');
    }
  };

  const chooseVideo = async () => {
    try {
      const result = await api.pickOpen({
        title: 'Choose the rocket video',
        filters: [{ name: 'Videos', extensions: VIDEO_EXTENSIONS }],
      });
      if (result.canceled || !result.paths?.[0]) return;
      const path = result.paths[0];
      setCreatePath(path);
      setCreateName((previous) => (previous.trim() ? previous : baseTitle(path)));
    } catch (err: any) {
      notify(err?.message ?? 'Could not select the video', 'error');
    }
  };

  const createSet = async () => {
    if (!projectId) {
      notify('Select a project first', 'warn');
      return;
    }
    if (!createPath) {
      notify('Choose a video file first', 'warn');
      return;
    }
    setCreating(true);
    let probe: Awaited<ReturnType<typeof probeVideo>> | null = null;
    try {
      const info = await api.keyframeMediaUrl(createPath);
      probe = await probeVideo(info.url);
      const now = new Date().toISOString();
      const set: KeyframeSet = {
        version: 1,
        name: createName.trim() || baseTitle(createPath) || 'Rocket video analysis',
        media: {
          kind: 'video',
          path: createPath,
          name: baseName(createPath),
          width: probe.width,
          height: probe.height,
          duration: probe.duration,
          frameCount: null,
          fps: null,
          timestamps: [],
          timingSource: 'unknown',
          variableFrameRate: false,
          fileSize: info.size,
        },
        keyframes: [],
        calibration: emptyKeyframeCalibration(),
        notes: '',
        createdAt: now,
        updatedAt: now,
      };
      const record = await api.saveKeyframeSet({ projectId, set, name: set.name, notes: '' });
      const next = normaliseKeyframeSet(record.set);
      loadedIdRef.current = record.id;
      setRef.current = record.id;
      setSetId(record.id);
      setDraft(next);
      draftRef.current = next;
      setDirty(false);
      dirtyRef.current = false;
      setVideoReady(false);
      setPlaying(false);
      setFrame(0);
      setSelectedId(null);
      setTool('mark');
      setCreateOpen(false);
      setCreatePath('');
      setCreateName('');
      records.reload();
      await attachMedia(next);
      navigate(`#/keyframes?set=${record.id}`);
      notify('Analysis created. Scan its frame timing, then click the rocket at each keyframe.', 'success');
    } catch (err: any) {
      notify(err?.message ?? 'Could not create the analysis', 'error');
    } finally {
      if (probe) {
        probe.video.pause();
        probe.video.src = '';
      }
      setCreating(false);
    }
  };

  const openRecord = async (record: KeyframeSetRecord) => {
    if (record.id === setId) return;
    const opened = await openSet(record.id);
    if (opened) navigate(`#/keyframes?set=${record.id}`);
  };

  const applyRecord = async (record: KeyframeSetRecord) => {
    const current = draftRef.current;
    if (!current) return;
    const source = normaliseKeyframeSet(record.set);
    if (!source.keyframes.length) {
      notify('That saved set has no keyframes to reuse', 'warn');
      return;
    }
    if (current.keyframes.length) {
      const ok = await confirm({
        title: `Apply “${record.name}”?`,
        message: 'The current keyframes are replaced by the saved set. The saved set itself is unchanged.',
        confirmLabel: 'Apply keyframes',
      });
      if (!ok) return;
    }
    const reused = reuseKeyframeSet(source, current.media);
    updateSet((next) => {
      next.keyframes = reused.keyframes;
      if (reused.calibration.mode === 'scale') next.calibration = reused.calibration;
    });
    setSelectedId(null);
    notify(
      `Loaded ${reused.keyframes.length} keyframe${reused.keyframes.length === 1 ? '' : 's'}${
        reused.scaled ? ' · scaled to this resolution' : ''
      }${reused.dropped ? ` · ${reused.dropped} outside this clip skipped` : ''}`,
      'success',
    );
  };

  const deleteRecord = async (record: KeyframeSetRecord) => {
    const ok = await confirm({
      title: `Delete “${record.name}”?`,
      message: 'The reusable keyframe set is removed from the library. The source video file is never deleted.',
      confirmLabel: 'Delete keyframe set',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeKeyframeSet(record.id);
      if (record.id === setId) {
        loadedIdRef.current = null;
        setRef.current = null;
        setSetId(null);
        setDraft(null);
        draftRef.current = null;
        setDirty(false);
        navigate('#/keyframes');
      }
      records.reload();
      notify('Keyframe set deleted', 'success');
    } catch (err: any) {
      notify(err?.message ?? 'Could not delete the keyframe set', 'error');
    }
  };

  const closeToLibrary = async () => {
    if (dirtyRef.current) {
      const ok = await confirm({
        title: 'Return to the keyframe library?',
        message: 'Unsaved changes will be saved before the library opens.',
        confirmLabel: 'Save and return',
      });
      if (!ok) return;
      await saveRef.current(false);
    }
    loadedIdRef.current = null;
    setRef.current = null;
    setSetId(null);
    setDraft(null);
    draftRef.current = null;
    setDirty(false);
    setVideoReady(false);
    navigate('#/keyframes');
  };

  const relink = async () => {
    const current = draftRef.current;
    if (!current) return;
    try {
      const result = await api.relinkKeyframeMedia();
      if (result.canceled) return;
      const probe = await probeVideo(result.url);
      probe.video.pause();
      probe.video.src = '';
      const nextMedia: KeyframeMedia = {
        ...current.media,
        path: result.path,
        name: result.name ?? baseName(result.path),
        width: probe.width,
        height: probe.height,
        duration: probe.duration,
        frameCount: null,
        fps: null,
        timestamps: [],
        timingSource: 'unknown',
        variableFrameRate: false,
        fileSize: result.size,
      };
      const reused = reuseKeyframeSet(current, nextMedia);
      updateSet((next) => {
        next.media = nextMedia;
        next.keyframes = reused.keyframes;
        next.calibration = reused.calibration;
      });
      if (nextMedia.kind === 'video') {
        setVideoUrl(result.url);
        setImageUrl('');
      }
      setVideoReady(false);
      setMediaMissing(false);
      setMediaError(null);
      notify('Source video relinked. Scan its frame timing before measuring.', 'success');
    } catch (err: any) {
      notify(err?.message ?? 'Could not relink the video', 'error');
    }
  };

  const unitOptions = useMemo(
    () =>
      unitsForDimension('length')
        .filter((unit) => unit.offset === 0)
        .map((unit) => ({ value: unit.symbol, label: `${unit.symbol} — ${unit.label}` })),
    [],
  );

  if (!projectId) {
    return (
      <div className="page">
        <PageHeader title="Rocket Video Analyser" subtitle="Measurements from manual keyframes only" />
        <EmptyState title="Select a project" message="Keyframe analyses are stored inside a project." icon="video" />
      </div>
    );
  }

  if (opening) {
    return (
      <div className="page">
        <PageHeader title="Rocket Video Analyser" subtitle="Opening keyframe set…" />
        <Spinner label="Loading the saved keyframes and video…" />
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="page keyframe-page">
        <PageHeader
          title="Rocket Video Analyser"
          subtitle="Manual keyframes only: every speed and acceleration is the difference between two frames you marked."
          actions={
            <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
              New analysis
            </Button>
          }
        />
        <div className="keyframe-intro">
          <div>
            <strong>No tracking, no guessing.</strong> Choose a launch video, scan its decoded frame times, then click the rocket once at each
            frame you want to measure. The analyser reports the distance, average speed and acceleration for each interval between consecutive
            keyframes. Every set is saved to this project’s library, so its keyframes can be applied to another clip — scaled to that clip’s
            resolution.
          </div>
          <div className="keyframe-badge-row">
            <Badge tone="ok">Offline</Badge>
            <Badge tone="ok">Keyframe differences only</Badge>
            <Badge tone="neutral">No automatic tracking</Badge>
          </div>
        </div>
        <Panel title={`Saved keyframe sets (${records.data?.length ?? 0})`} actions={<Button size="sm" icon="plus" onClick={() => setCreateOpen(true)}>New</Button>}>
          {(records.data?.length ?? 0) === 0 ? (
            <EmptyState
              title="No keyframe sets yet"
              message="Create an analysis, mark the rocket on a launch video and the keyframes are saved here for reuse."
              icon="video"
              action={<Button variant="primary" icon="upload" onClick={() => setCreateOpen(true)}>Import a video</Button>}
            />
          ) : (
            <DataTable
              rows={records.data ?? []}
              columns={[
                { key: 'name', label: 'Keyframe set', render: (record) => <span className="link-like">{record.name}</span> },
                { key: 'media_path', label: 'Video', render: (record) => <span className="mono small">{baseName(record.media_path || '') || 'missing'}</span> },
                { key: 'count', label: 'Keyframes', width: '90px', align: 'right', render: (record) => record.set.keyframes.length },
                { key: 'updated_at', label: 'Updated', width: '150px', render: (record) => fmtDateTime(record.updated_at) },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  render: (record) => (
                    <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                      <button className="icon-btn danger" title="Delete keyframe set" onClick={() => void deleteRecord(record)}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  ),
                },
              ]}
              onRowClick={(record) => void openRecord(record as KeyframeSetRecord)}
            />
          )}
        </Panel>
        <div className="keyframe-steps">
          {[
            ['1', 'Choose a video', 'The file is referenced in place, never copied or uploaded.'],
            ['2', 'Scan frame times', 'Read real decoded timestamps, or enter an FPS explicitly.'],
            ['3', 'Mark keyframes', 'Click the rocket at two or more frames; drag a marker to refine it.'],
            ['4', 'Read the differences', 'Interval distance, average speed, acceleration and direction between your keyframes.'],
            ['5', 'Reuse', 'Every set is saved. Apply its keyframes to another clip, scaled to the new resolution.'],
          ].map(([number, title, text]) => (
            <div className="keyframe-step" key={number}>
              <span className="keyframe-step-number">{number}</span>
              <strong>{title}</strong>
              <p>{text}</p>
            </div>
          ))}
        </div>
        <p className="muted small">
          A single ordinary video is a 2D projection. A known distance gives a scale only for the plane you measured it on; depth changes and lens
          distortion are not corrected.
        </p>

        <Modal
          title="New rocket video analysis"
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button variant="primary" icon="upload" onClick={() => void createSet()} disabled={creating || !createPath}>
                {creating ? 'Reading video…' : 'Create analysis'}
              </Button>
            </>
          }
        >
          <div className="stack">
            <Field label="Analysis name">
              <Input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="e.g. Launch 12 — ascent" />
            </Field>
            <div className="keyframe-picker">
              <Button icon="folder" onClick={() => void chooseVideo()}>
                {createPath ? 'Choose a different video' : 'Choose video'}
              </Button>
              <span className="muted small">{createPath ? baseName(createPath) : 'No video selected'}</span>
            </div>
            <div className="muted small">
              The video is read locally through the application. After creating the analysis, scan its frame timing before placing keyframes — no
              frame rate is assumed.
            </div>
          </div>
        </Modal>
      </div>
    );
  }

  const media = draft.media;
  const currentKeyframe = draft.keyframes.find((entry) => entry.frame === frame) ?? null;
  const activeRow = analysis?.rows.find((row) => row.id === selectedId) ?? analysis?.rows.find((row) => row.frame === frame) ?? null;
  const warnings = [...new Set(analysis?.summary.warnings ?? [])];

  return (
    <div className="page keyframe-page">
      <PageHeader
        title="Rocket Video Analyser"
        subtitle={
          <span>
            {draft.name} · {media.width} × {media.height} px · {draft.keyframes.length} keyframe{draft.keyframes.length === 1 ? '' : 's'}
            {media.variableFrameRate ? ' · variable timing' : ''}
          </span>
        }
        actions={
          <>
            <Button icon="chevron" onClick={() => void closeToLibrary()}>Library</Button>
            <Button icon="save" onClick={() => void save(true)} disabled={saving}>{saving ? 'Saving…' : dirty ? 'Save *' : 'Saved'}</Button>
          </>
        }
      />

      {mediaMissing && (
        <div className="keyframe-missing">
          <Icon name="warning" size={18} />
          <div>
            <strong>Source video is missing.</strong> {mediaError ?? 'The file was moved, renamed or is on an unavailable drive.'} The keyframes are preserved.
          </div>
          <Button size="sm" icon="link" onClick={() => void relink()}>Relink video</Button>
        </div>
      )}
      {mediaError && !mediaMissing && <div className="keyframe-warn small" role="alert">{mediaError}</div>}

      <div className="keyframe-workspace">
        <div className="keyframe-main">
          <div className="keyframe-workspace-head">
            <Input value={draft.name} onChange={(event) => updateSet((next) => { next.name = event.target.value; })} aria-label="Analysis name" />
            <span className={`keyframe-save-state ${dirty ? 'dirty' : ''}`}>{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
            <Badge tone={analysis?.summary.calibrated ? 'ok' : 'warn'}>{analysis?.summary.calibrated ? 'Calibrated' : 'Pixels only'}</Badge>
          </div>

          <KeyframeStage
            media={media}
            mediaUrl={imageUrl}
            videoUrl={videoUrl}
            videoRef={videoRef}
            keyframes={draft.keyframes}
            analysis={analysis!}
            frame={frame}
            time={frameTime}
            tool={tool}
            selectedId={selectedId}
            scalePointA={draft.calibration.pointA}
            scalePointB={draft.calibration.pointB}
            onPlace={placeKeyframe}
            onMove={moveKeyframe}
            onSelect={setSelectedId}
            onCalibrationPoint={handleCalibrationPoint}
            onVideoTime={handleVideoTime}
            onVideoReady={handleVideoReady}
            onPlayState={(state) => {
              playingRef.current = state;
              setPlaying(state);
            }}
          />

          <div className="keyframe-transport">
            <Button
              icon={playing ? 'pause' : 'play'}
              onClick={() => void togglePlay()}
              title={playing ? 'Pause' : 'Play'}
              disabled={media.kind !== 'video' || !videoReady || scanning}
            />
            <Button icon="stop" onClick={stopPlayback} title="Stop" disabled={media.kind !== 'video' || scanning} />
            <Button icon="step-back" onClick={() => seekToFrame(frame - 1)} title="Previous frame" disabled={!timingKnown || frame <= 0 || scanning} />
            <Button icon="step-forward" onClick={() => seekToFrame(frame + 1)} title="Next frame" disabled={!timingKnown || frame >= maxFrame || scanning} />
            <input
              className="keyframe-range"
              type="range"
              min={0}
              max={Math.max(0, maxFrame)}
              step={1}
              value={Math.min(frame, Math.max(0, maxFrame))}
              onChange={(event) => seekToFrame(Number(event.target.value))}
              disabled={!timingKnown || scanning}
              aria-label="Timeline frame"
            />
            <div className="keyframe-frame-readout">
              <Input
                type="number"
                min={1}
                max={Math.max(1, frameCount)}
                value={frame + 1}
                onChange={(event) => seekToFrame(Number(event.target.value) - 1)}
                disabled={!timingKnown || scanning}
                className="keyframe-frame-input"
                aria-label="Keyframe frame"
              />
              <span className="muted small">/ {frameCount || '—'}</span>
              <span className="mono small">{frameTime !== null ? `${frameTime.toFixed(4)} s` : 'time unknown'}</span>
            </div>
            <Select
              value={String(speed)}
              onChange={(value) => {
                const next = Number(value);
                setSpeed(next);
                if (videoRef.current) videoRef.current.playbackRate = next;
              }}
              options={[0.25, 0.5, 1, 2, 4].map((value) => ({ value: String(value), label: `${value}×` }))}
              className="keyframe-speed"
              disabled={scanning}
            />
            <form
              className="keyframe-jump"
              onSubmit={(event) => {
                event.preventDefault();
                const value = Number(jumpTime);
                if (Number.isFinite(value) && draft.media.timestamps.length) seekToFrame(nearestFrameIndex(draft.media.timestamps, value));
              }}
            >
              <Input value={jumpTime} onChange={(event) => setJumpTime(event.target.value)} placeholder="jump to s" aria-label="Jump to timestamp" disabled={!timingKnown || scanning} />
              <Button size="sm" type="submit" disabled={!timingKnown || scanning}>Go</Button>
            </form>
          </div>

          <div className="keyframe-timing-bar">
            <div className="keyframe-timing-status">
              <Badge tone={timingKnown ? 'ok' : 'warn'}>{timingLabel(media.timingSource)}</Badge>
              <span className="small muted">
                {frameCount ? `${frameCount} frames` : 'frame count unknown'}
                {media.fps ? ` · mean ${media.fps.toFixed(3)} fps` : ''}
                {media.variableFrameRate ? ' · variable intervals' : ''}
              </span>
            </div>
            <div className="keyframe-timing-actions">
              <Button size="sm" icon="refresh" onClick={() => void scanTiming()} disabled={!videoReady || scanning}>
                {scanning ? `Scanning ${Math.round(scanProgress.progress * 100)}%` : 'Scan real timestamps'}
              </Button>
              {scanning && <Button size="sm" onClick={() => { scanCancelRef.current = true; }}>Cancel scan</Button>}
              <div className="keyframe-inline">
                <Input value={fpsInput} onChange={(event) => setFpsInput(event.target.value)} aria-label="Manual frame rate" className="keyframe-fps-input" />
                <span className="muted small">fps</span>
                <Button size="sm" onClick={applyManualFps} disabled={scanning}>Apply manual FPS</Button>
              </div>
            </div>
            {!timingKnown && <div className="keyframe-warn small">Keyframes are disabled until frame timing is known. No FPS is assumed.</div>}
          </div>

          <Panel
            title="Keyframes"
            subtitle="Click the rocket on the stage at the current frame"
            actions={
              <div className="row-actions">
                <Button size="sm" icon="target" variant={tool === 'mark' ? 'primary' : 'default'} onClick={() => { setTool('mark'); setCalibrationTarget(null); }}>
                  Mark rocket
                </Button>
                <Button size="sm" icon="trash" onClick={() => void clearKeyframes()} disabled={!draft.keyframes.length}>Clear</Button>
              </div>
            }
          >
            {draft.keyframes.length === 0 ? (
              <div className="muted small">
                {timingKnown
                  ? 'No keyframes yet. Step to a frame and click the rocket. The marker is stored at that frame only.'
                  : 'Scan the video timing, then click the rocket at two or more frames.'}
              </div>
            ) : (
              <div className="keyframe-list">
                {draft.keyframes.map((entry, index) => (
                  <div key={entry.id} className={`keyframe-item ${entry.id === selectedId ? 'active' : ''}`}>
                    <span className="keyframe-index">#{index + 1}</span>
                    <button className="link-btn mono" onClick={() => { setSelectedId(entry.id); seekToFrame(entry.frame); }}>
                      frame {entry.frame + 1}
                    </button>
                    <span className="muted small">{entry.time !== null ? `${entry.time.toFixed(4)} s` : 'time unknown'}</span>
                    <span className="mono small">({entry.x.toFixed(1)}, {entry.y.toFixed(1)}) px</span>
                    <button
                      className="icon-btn danger"
                      title="Delete keyframe"
                      aria-label={`Delete keyframe at frame ${entry.frame + 1}`}
                      onClick={() => void deleteKeyframe(entry.frame)}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="keyframe-hint small muted">
              Every keyframe is saved with this set. Drag a marker in the current frame to refine it; markers on other frames can be selected from
              the list.
            </div>
          </Panel>

          <Panel className="keyframe-results" title="Measured intervals" subtitle="Differences between consecutive manual keyframes">
            {analysis && (
              <>
                <div className="stat-row">
                  <div className="stat"><span className="stat-label">Keyframes</span><span className="stat-value">{analysis.summary.keyframes}</span><span className="stat-sub">{analysis.summary.timedKeyframes} with time</span></div>
                  <div className="stat"><span className="stat-label">Duration</span><span className="stat-value">{formatNumber(analysis.summary.duration, 3)} s</span><span className="stat-sub">first to last keyframe</span></div>
                  <div className="stat"><span className="stat-label">Total distance</span><span className="stat-value">{formatNumber(analysis.summary.totalDistance, 3)} {analysis.summary.unit}</span><span className="stat-sub">sum of intervals</span></div>
                  <div className="stat"><span className="stat-label">Net displacement</span><span className="stat-value">{formatNumber(analysis.summary.displacement, 3)} {analysis.summary.unit}</span><span className="stat-sub">first to last position</span></div>
                  <div className="stat"><span className="stat-label">Average speed</span><span className="stat-value">{formatNumber(analysis.summary.averageSpeed, 3)} {analysis.summary.velocityUnit}</span><span className="stat-sub">distance / duration</span></div>
                  <div className="stat"><span className="stat-label">Max interval speed</span><span className="stat-value">{formatNumber(analysis.summary.maxSpeed, 3)} {analysis.summary.velocityUnit}</span><span className="stat-sub">fastest interval</span></div>
                  <div className="stat"><span className="stat-label">Max acceleration</span><span className="stat-value">{formatNumber(analysis.summary.maxAcceleration, 2)} {analysis.summary.accelerationUnit}</span><span className="stat-sub">between intervals</span></div>
                  <div className="stat"><span className="stat-label">Net direction</span><span className="stat-value">{analysis.summary.netDirectionDeg === null ? '—' : `${formatNumber(analysis.summary.netDirectionDeg, 1)}°`}</span><span className="stat-sub">first to last keyframe</span></div>
                </div>
                <DataTable
                  rows={analysis.rows}
                  rowKey={(row) => String(row.frame)}
                  maxHeight="340px"
                  selectedKey={currentKeyframe ? String(currentKeyframe.frame) : null}
                  onRowClick={(row) => seekToFrame(row.frame)}
                  empty={<div className="muted small">Mark at least one keyframe.</div>}
                  columns={[
                    { key: 'frame', label: 'Frame', width: '62px', render: (row) => <span className="mono">#{row.frame + 1}</span> },
                    { key: 'time', label: 'Time', width: '82px', render: (row) => <span className="mono">{row.time === null ? '—' : row.time.toFixed(4)}</span> },
                    { key: 'intervalSeconds', label: 'Δt (s)', width: '74px', render: (row) => <span className="mono">{formatNumber(row.intervalSeconds, 4)}</span> },
                    { key: 'intervalDistance', label: `Δs (${analysis.summary.unit})`, width: '90px', render: (row) => <span className="mono">{formatNumber(row.intervalDistance, 3)}</span> },
                    { key: 'speed', label: `Speed (${analysis.summary.velocityUnit})`, width: '110px', render: (row) => <span className="mono">{formatNumber(row.speed, 3)}</span> },
                    { key: 'acceleration', label: `Accel. (${analysis.summary.accelerationUnit})`, width: '110px', render: (row) => <span className="mono">{formatNumber(row.acceleration, 2)}</span> },
                    { key: 'directionDeg', label: 'Direction', width: '84px', render: (row) => <span className="mono">{row.directionDeg === null ? '—' : `${formatNumber(row.directionDeg, 1)}°`}</span> },
                    { key: 'x', label: `X (${analysis.summary.unit})`, width: '84px', render: (row) => <span className="mono">{formatNumber(row.x, 2)}</span> },
                    { key: 'y', label: `Y (${analysis.summary.unit})`, width: '84px', render: (row) => <span className="mono">{formatNumber(row.y, 2)}</span> },
                  ]}
                />
                {warnings.length > 0 && (
                  <div className="keyframe-warnings">
                    {warnings.map((warning) => <div className="keyframe-warn small" key={warning}>{warning}</div>)}
                  </div>
                )}
              </>
            )}
            {activeRow && (
              <div className="keyframe-readout small muted">
                Selected keyframe: frame {activeRow.frame + 1}
                {activeRow.time !== null ? ` at ${activeRow.time.toFixed(4)} s` : ''} · {activeRow.x.toFixed(1)}, {activeRow.y.toFixed(1)} {analysis!.summary.unit}
              </div>
            )}
          </Panel>
        </div>

        <aside className="keyframe-sidebar">
          <Panel title="Keyframe library" subtitle="Saved in this project">
            {(records.data?.length ?? 0) === 0 ? (
              <div className="muted small">Save this set and it appears here for reuse.</div>
            ) : (
              <div className="keyframe-library">
                {(records.data ?? []).map((record) => (
                  <div className={`keyframe-library-item ${record.id === setId ? 'active' : ''}`} key={record.id}>
                    <div className="keyframe-library-main">
                      <button className="link-btn" onClick={() => void openRecord(record)}>{record.name}</button>
                      <span className="muted small">
                        {record.set.keyframes.length} keyframe{record.set.keyframes.length === 1 ? '' : 's'} · {baseName(record.media_path || '') || 'no video'}
                      </span>
                    </div>
                    <div className="row-actions">
                      <Button size="sm" title={`Apply ${record.name} to this video`} onClick={() => void applyRecord(record)} disabled={record.id === setId}>
                        Apply
                      </Button>
                      <button className="icon-btn danger" title="Delete keyframe set" onClick={() => void deleteRecord(record)}>
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="keyframe-hint small muted">
              Apply copies a saved set’s keyframes onto the current video. Positions are scaled when the resolutions differ, and keyframes beyond the
              clip are skipped.
            </div>
          </Panel>

          <Panel title="Known distance" subtitle="Optional physical scale">
            <div className="stack">
              <Field label="Scale mode">
                <Select
                  value={draft.calibration.mode}
                  onChange={(value) => {
                    updateSet((next) => {
                      next.calibration.mode = value === 'scale' ? 'scale' : 'none';
                    });
                    setTool('mark');
                  }}
                  options={[
                    { value: 'none', label: 'None — pixels' },
                    { value: 'scale', label: 'Known distance' },
                  ]}
                />
              </Field>
              {draft.calibration.mode === 'scale' && (
                <>
                  <div className="form-grid">
                    <Field label="Known length">
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        value={draft.calibration.knownLength}
                        onChange={(event) => updateSet((next) => { next.calibration.knownLength = Number(event.target.value) || 0; })}
                      />
                    </Field>
                    <Field label="Unit">
                      <Select
                        value={draft.calibration.lengthUnit}
                        onChange={(value) => updateSet((next) => { next.calibration.lengthUnit = value; })}
                        options={unitOptions}
                      />
                    </Field>
                  </div>
                  <div className="keyframe-inline">
                    <Button size="sm" variant={tool === 'calibration' && calibrationTarget === 'A' ? 'primary' : 'default'} onClick={() => pickCalibration('A')}>Place point A</Button>
                    <Button size="sm" variant={tool === 'calibration' && calibrationTarget === 'B' ? 'primary' : 'default'} onClick={() => pickCalibration('B')}>Place point B</Button>
                  </div>
                  <div className="muted small">
                    A: {draft.calibration.pointA ? `${draft.calibration.pointA.x.toFixed(1)}, ${draft.calibration.pointA.y.toFixed(1)} px` : 'not placed'}
                    <br />
                    B: {draft.calibration.pointB ? `${draft.calibration.pointB.x.toFixed(1)}, ${draft.calibration.pointB.y.toFixed(1)} px` : 'not placed'}
                  </div>
                  <div className={`keyframe-scale-note ${analysis?.summary.calibrated ? 'ok' : 'warn'}`}>
                    {analysis ? describeKeyframeScale(analysis.scale, draft.calibration) : ''}
                  </div>
                  <Button size="sm" icon="refresh" onClick={() => { updateSet((next) => { next.calibration = emptyKeyframeCalibration(); }); notify('Calibration cleared', 'info'); }}>
                    Clear calibration
                  </Button>
                </>
              )}
              <div className="keyframe-hint small muted">
                Place both ends on one known length in the same plane as the rocket. The scale is used only for distances and speeds; it does not
                correct perspective or depth.
              </div>
            </div>
          </Panel>

          <Panel title="Analysis notes">
            <textarea
              className="input textarea"
              rows={4}
              value={draft.notes}
              onChange={(event) => updateSet((next) => { next.notes = event.target.value; })}
              placeholder="Camera position, launch pad reference, assumptions…"
            />
          </Panel>

          <Panel title="Method">
            <div className="muted small">
              <p>Positions are the exact points you marked. Nothing is interpolated between keyframes.</p>
              <p>Each interval uses the straight line between two consecutive keyframes and the decoded time difference between those frames.</p>
              <p>Acceleration is the second difference of the interval speeds, so it needs at least three keyframes.</p>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
