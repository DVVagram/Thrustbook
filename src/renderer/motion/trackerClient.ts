import workerAssetUrl from './tracker-worker.js?url';
import opencvAssetUrl from '@techstark/opencv-js/dist/opencv.js?url';
import type { MotionPoint, MotionReferencePoint, TrackFrame } from '../../shared/motion';

export type EngineState = 'idle' | 'loading' | 'ready' | 'error';

export interface TrackRequest {
  object: { id: string; name: string; polygon: MotionPoint[]; references: MotionReferencePoint[] };
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  startFrame: number;
  endFrame: number;
  frameCount: number;
  qualityThreshold: number;
  maxFeatures: number;
  protectedFrames: number[];
  compensateCamera: boolean;
}

interface WorkerReply {
  id?: number;
  type: string;
  track?: TrackFrame;
  stoppedAt?: number | null;
  reason?: string;
  message?: string;
  stack?: string;
}

interface Pending {
  resolve: (value: WorkerReply) => void;
  reject: (error: Error) => void;
}

/**
 * Client for the classic tracking worker. OpenCV.js is a large embedded-WASM
 * build, so it is never imported or initialised on the renderer thread.
 */
export class TrackerClient {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private readyPromise: Promise<void> | null = null;

  constructor() {
    const workerUrl = new URL(workerAssetUrl, document.baseURI).href;
    this.worker = new Worker(workerUrl);
    this.worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => this.onMessage(event.data));
    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'The tracking worker crashed');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.readyPromise = null;
    });
  }

  private onMessage(message: WorkerReply): void {
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.type === 'error') {
      pending.reject(new Error(message.message || 'Tracking failed'));
    } else {
      pending.resolve(message);
    }
  }

  private send(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<WorkerReply> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, type, ...payload }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  get opencvUrl(): string {
    return new URL(opencvAssetUrl, document.baseURI).href;
  }

  async ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.send('load', { opencvUrl: this.opencvUrl }).then(() => undefined);
    }
    return this.readyPromise;
  }

  async start(request: TrackRequest): Promise<void> {
    const object = request.object;
    await this.send('start', {
      opencvUrl: this.opencvUrl,
      config: {
        sourceWidth: request.sourceWidth,
        sourceHeight: request.sourceHeight,
        scale: request.scale,
        frameCount: request.frameCount,
        startFrame: request.startFrame,
        endFrame: request.endFrame,
        qualityThreshold: request.qualityThreshold,
        maxFeatures: request.maxFeatures,
        protectedFrames: request.protectedFrames,
        compensateCamera: request.compensateCamera,
        polygon: object.polygon,
        references: object.references,
        objectId: object.id,
        objectName: object.name,
      },
    });
    this.readyPromise = Promise.resolve();
  }

  async step(frame: number, time: number, image: ImageData): Promise<WorkerReply> {
    const buffer = image.data.buffer as ArrayBuffer;
    return this.send('frame', { frame: { index: frame, time, width: image.width, height: image.height, buffer } }, [buffer]);
  }

  async reset(): Promise<void> {
    if (!this.readyPromise) return;
    try {
      await this.send('reset');
    } catch {
      /* the worker is terminated below */
    }
  }

  dispose(): void {
    for (const pending of this.pending.values()) pending.reject(new Error('Tracking was cancelled'));
    this.pending.clear();
    this.worker.terminate();
    this.readyPromise = null;
  }
}
