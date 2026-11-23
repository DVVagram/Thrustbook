import { frameTiming, normaliseTimestamps, KeyframeMedia } from '../../shared/keyframes';

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
      reject(new Error('The video could not be decoded by the local player'));
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

export async function probeVideo(url: string): Promise<{ video: HTMLVideoElement; width: number; height: number; duration: number | null }> {
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
    throw new Error('The selected video has no decodable dimensions');
  }
  return {
    video,
    width: video.videoWidth,
    height: video.videoHeight,
    duration: Number.isFinite(video.duration) ? video.duration : null,
  };
}

export async function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  const target = Math.max(0, time);
  if (Math.abs(video.currentTime - target) < 1e-5 && video.readyState >= 2) return;
  const promise = waitForEvent(video, 'seeked', 15_000);
  video.currentTime = target;
  await promise;
}

/**
 * Play the clip once and record the presentation timestamp of every frame the
 * decoder presents. No frame rate is assumed; dropped frames are reported.
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
  const durationHint = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  const scanRate = durationHint && durationHint > 120 ? 4 : 1;
  video.playbackRate = scanRate;
  const timeoutMs = Math.min(300_000, Math.max(15_000, durationHint ? (durationHint * 1000) / scanRate + 15_000 : 300_000));
  try {
    await seekVideo(video, 0);
  } catch {
    /* some containers cannot seek to zero before playback */
  }
  const timestamps: number[] = [];
  let cancelled = false;
  let expectedFrames = 0;
  const player = video as any;
  const useCallback = typeof player.requestVideoFrameCallback === 'function';

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
      resolve({
        timestamps: ordered,
        droppedFrames: useCallback ? Math.max(0, expectedFrames - ordered.length) : 0,
        duration: video.duration,
      });
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
    const onError = () => fail('The video could not be played for the timing scan');
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
      if (!video.ended) player.requestVideoFrameCallback(tick);
    };
    video.addEventListener('ended', onEnded, { once: true });
    video.addEventListener('error', onError, { once: true });
    timeout = setTimeout(() => fail('The timing scan timed out before the video finished'), timeoutMs);
    if (useCallback) player.requestVideoFrameCallback(tick);
    else fail('This player does not expose decoded video frame timestamps. Use the manual frame rate instead.');
    video.play().catch(() => fail('The video could not be played for the timing scan'));
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

export function timingFromTimestamps(duration: number, timestamps: number[]): Pick<KeyframeMedia, 'timestamps' | 'frameCount' | 'fps' | 'duration' | 'timingSource' | 'variableFrameRate'> {
  const stats = frameTiming(timestamps);
  return {
    timestamps,
    frameCount: timestamps.length,
    fps: stats.fps,
    duration,
    timingSource: 'video-timestamps',
    variableFrameRate: stats.variable,
  };
}

export function manualTiming(duration: number, fps: number): Pick<KeyframeMedia, 'timestamps' | 'frameCount' | 'fps' | 'duration' | 'timingSource' | 'variableFrameRate'> {
  const count = Math.max(1, Math.round(duration * fps));
  return {
    timestamps: Array.from({ length: count }, (_, index) => Number((index / fps).toFixed(9))),
    frameCount: count,
    fps,
    duration,
    timingSource: 'manual-fps',
    variableFrameRate: false,
  };
}

export function timingLabel(source: KeyframeMedia['timingSource']): string {
  switch (source) {
    case 'video-timestamps':
      return 'Decoded video timestamps';
    case 'manual-fps':
      return 'Manual FPS (estimated frame times)';
    case 'image-sequence':
      return 'Image sequence with supplied FPS';
    default:
      return 'Frame timing unknown';
  }
}

export function nearestFrameIndex(timestamps: number[], time: number): number {
  if (!timestamps.length) return 0;
  let best = 0;
  let bestDelta = Infinity;
  for (let index = 0; index < timestamps.length; index++) {
    const delta = Math.abs(timestamps[index] - time);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = index;
    }
  }
  return best;
}
