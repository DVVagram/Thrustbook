import { MotionMedia, TimingSource, frameIntervalStats, normaliseTimestamps } from '../../shared/motion';

export interface VideoProbe {
  width: number;
  height: number;
  duration: number | null;
  poster?: string;
}

export function waitForEvent(target: EventTarget, event: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const done = () => {
      window.clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
      resolve();
    };
    const failed = () => {
      window.clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
      reject(new Error('Media could not be decoded by the local player'));
    };
    timer = window.setTimeout(() => {
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', failed, { once: true });
  });
}

export async function probeVideo(url: string): Promise<VideoProbe & { video: HTMLVideoElement }> {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await waitForEvent(video, 'loadedmetadata');
  } catch (error) {
    video.src = '';
    throw error;
  }
  if (!(video.videoWidth > 0 && video.videoHeight > 0)) {
    video.src = '';
    throw new Error('The selected media has no decodable video dimensions');
  }
  return {
    video,
    width: video.videoWidth,
    height: video.videoHeight,
    duration: Number.isFinite(video.duration) ? video.duration : null,
  };
}

export async function probeImage(url: string): Promise<{ width: number; height: number }> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  image.src = url;
  let timer = 0;
  try {
    await Promise.race([
      image.decode(),
      new Promise<void>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('Timed out decoding the selected image')), 20_000);
      }),
    ]);
  } catch (error) {
    image.src = '';
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
  const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
  image.src = '';
  if (!(dimensions.width > 0 && dimensions.height > 0)) {
    throw new Error('The selected image has no decodable dimensions');
  }
  return dimensions;
}

export async function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  const target = Math.max(0, time);
  if (Math.abs(video.currentTime - target) < 1e-5 && video.readyState >= 2) return;
  const promise = waitForEvent(video, 'seeked', 15_000);
  video.currentTime = target;
  await promise;
}

/**
 * Play once through the file and capture browser-presented media timestamps.
 * This handles variable-frame-rate files without assuming a constant FPS.
 * Dropped presentation frames are reported rather than silently invented.
 */
export async function scanVideoTiming(
  video: HTMLVideoElement,
  shouldCancel: () => boolean,
  onProgress: (progress: number, frames: number) => void,
): Promise<{ timestamps: number[]; droppedFrames: number; duration: number }> {
  const previousTime = video.currentTime;
  const previousMuted = video.muted;
  const previousRate = video.playbackRate;
  video.pause();
  video.muted = true;
  // Preserve every presented frame for ordinary clips. Long clips scan faster
  // so the operation can finish; presented frames are still timestamped by the
  // decoder, and any dropped frames are reported rather than invented.
  const durationHint = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  const scanRate = durationHint && durationHint > 120 ? 4 : 1;
  video.playbackRate = scanRate;
  const timeoutMs = Math.min(300_000, Math.max(15_000, durationHint ? (durationHint * 1000) / scanRate + 15_000 : 300_000));
  try {
    await seekVideo(video, 0);
  } catch {
    /* some formats cannot seek to exact zero before playback */
  }
  const timestamps: number[] = [];
  let cancelled = false;
  let expectedFrames = 0;
  const v = video as any;
  const useCallback = typeof v.requestVideoFrameCallback === 'function';
  return await new Promise<{ timestamps: number[]; droppedFrames: number; duration: number }>((resolve, reject) => {
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      try {
        video.pause();
      } catch {
        /* noop */
      }
      const ordered = normaliseTimestamps(timestamps);
      const dropped = useCallback ? Math.max(0, expectedFrames - ordered.length) : 0;
      resolve({ timestamps: ordered, droppedFrames: dropped, duration: video.duration });
    };
    const fail = (message: string) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      try {
        video.pause();
      } catch {
        /* noop */
      }
      reject(new Error(message));
    };
    const onEnded = () => cleanup();
    const onError = () => fail('The video could not be played for timing analysis');
    const tick = (_now: number, metadata: any) => {
      if (finished) return;
      if (shouldCancel()) {
        cancelled = true;
        cleanup();
        return;
      }
      if (metadata?.mediaTime !== undefined) timestamps.push(metadata.mediaTime);
      if (metadata?.presentedFrames !== undefined) expectedFrames = Math.max(expectedFrames, Number(metadata.presentedFrames) || 0);
      onProgress(video.duration > 0 ? Math.min(1, metadata.mediaTime / video.duration) : 0, timestamps.length);
      if (!video.ended) v.requestVideoFrameCallback(tick);
    };
    video.addEventListener('ended', onEnded, { once: true });
    video.addEventListener('error', onError, { once: true });
    timeout = setTimeout(
      () => fail('Timing analysis timed out before the video finished playing'),
      timeoutMs,
    );
    if (useCallback) v.requestVideoFrameCallback(tick);
    else onError();
    video.play().catch(() => onError());
  }).finally(async () => {
    video.pause();
    video.muted = previousMuted;
    video.playbackRate = previousRate;
    try {
      await seekVideo(video, previousTime);
    } catch {
      /* restore best effort */
    }
    if (cancelled) onProgress(0, timestamps.length);
  });
}

export function timingLabel(source: TimingSource): string {
  switch (source) {
    case 'video-timestamps':
      return 'Retrieved from decoded video timestamps';
    case 'manual-fps':
      return 'Manual FPS (estimated frame times)';
    case 'image-sequence':
      return 'Image sequence with supplied FPS';
    default:
      return 'Unknown timing — tracking unavailable';
  }
}

export function videoTimingFromScan(duration: number, timestamps: number[], droppedFrames: number): Pick<MotionMedia, 'duration' | 'timestamps' | 'frameCount' | 'fps' | 'timingSource' | 'variableFrameRate'> {
  const stats = frameIntervalStats(timestamps);
  return {
    duration,
    timestamps,
    frameCount: timestamps.length,
    fps: stats.fps,
    timingSource: 'video-timestamps',
    variableFrameRate: stats.variable || droppedFrames > 0,
  };
}

export function manualVideoTiming(duration: number, fps: number): Pick<MotionMedia, 'duration' | 'timestamps' | 'frameCount' | 'fps' | 'timingSource' | 'variableFrameRate'> {
  const count = Math.max(1, Math.round(duration * fps));
  return {
    duration,
    timestamps: Array.from({ length: count }, (_, i) => Number((i / fps).toFixed(9))),
    frameCount: count,
    fps,
    timingSource: 'manual-fps',
    variableFrameRate: false,
  };
}

/**
 * Creates a sequential frame provider. Video seeks are performed one at a time
 * and use the stored media timestamps, not an assumed FPS.
 */
export function createFrameSource(
  media: MotionMedia,
  video: HTMLVideoElement | null,
  resolveUrl: (path: string) => Promise<string>,
  processingMaxWidth: number,
): { source: { width: number; height: number; frameCount: number; times: number[]; getFrame(index: number): Promise<HTMLCanvasElement> }; dimensions: { width: number; height: number } } {
  const scale = Math.min(1, Math.max(160, processingMaxWidth) / Math.max(1, media.width));
  const width = Math.max(1, Math.round(media.width * scale));
  const height = Math.max(1, Math.round(media.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('A canvas is unavailable for image processing');
  const imageCache = new Map<number, HTMLImageElement>();
  const getImage = async (index: number): Promise<HTMLImageElement> => {
    const cached = imageCache.get(index);
    if (cached) return cached;
    const p =
      media.kind === 'sequence'
        ? media.paths?.[index]
        : media.paths && media.paths.length > 0
          ? media.paths[index]
          : media.path;
    if (!p) throw new Error(`Image ${index + 1} is missing from the sequence`);
    const url = await resolveUrl(p);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    if (imageCache.size > 12) imageCache.delete(imageCache.keys().next().value as number);
    imageCache.set(index, img);
    return img;
  };

  return {
    dimensions: { width, height },
    source: {
      width: media.width,
      height: media.height,
      frameCount: media.frameCount ?? media.timestamps.length,
      times: media.timestamps,
      async getFrame(index: number): Promise<HTMLCanvasElement> {
        if (media.kind === 'video') {
          if (!video) throw new Error('The video element is not ready');
          const time = media.timestamps[index];
          if (!Number.isFinite(time)) throw new Error(`No timestamp is available for frame ${index + 1}`);
          video.pause();
          await seekVideo(video, time);
          context.clearRect(0, 0, width, height);
          context.drawImage(video, 0, 0, width, height);
        } else {
          const img = await getImage(index);
          context.clearRect(0, 0, width, height);
          context.drawImage(img, 0, 0, width, height);
        }
        return canvas;
      },
    },
  };
}
