import workerAssetUrl from './flow-worker.js?url';
import opencvAssetUrl from '@techstark/opencv-js/dist/opencv.js?url';
import type { FlowReply } from '../../shared/flow';
import type { MotionPoint } from '../../shared/motion';

interface WorkerReply {
  id?: number;
  ok?: boolean;
  result?: FlowReply;
  error?: string;
  type?: string;
}

interface Pending {
  resolve: (reply: FlowReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Renderer client for the OpenCV.js optical-flow worker. The 11 MB OpenCV
 * bundle is an embedded-WASM build, so it is loaded with `importScripts` inside
 * a classic worker and never parsed on the UI thread.
 */
export class FlowClient {
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private sequence = 0;

  private ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.dispose();
        reject(error);
      };
      try {
        const worker = new Worker(new URL(workerAssetUrl, document.baseURI).href);
        this.worker = worker;
        const timeout = setTimeout(() => fail(new Error('OpenCV.js timed out while initialising')), 120_000);
        worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
          const message = event.data;
          if (message?.type === 'ready') {
            clearTimeout(timeout);
            if (!settled) {
              settled = true;
              resolve();
            }
            return;
          }
          if (message?.type === 'error') {
            clearTimeout(timeout);
            fail(new Error(message.error || 'OpenCV.js could not be initialised'));
            return;
          }
          if (typeof message?.id !== 'number') return;
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.ok && message.result) pending.resolve(message.result);
          else pending.reject(new Error(message.error || 'Optical flow failed'));
        });
        worker.addEventListener('error', (event) => fail(new Error(event.message || 'The optical-flow worker crashed')));
        worker.postMessage({ type: 'init', opencvUrl: new URL(opencvAssetUrl, document.baseURI).href });
      } catch (error) {
        fail(error as Error);
      }
    });
    return this.readyPromise;
  }

  async track(previous: ImageData, current: ImageData, points: MotionPoint[], polygon: MotionPoint[]): Promise<FlowReply> {
    await this.ensureReady();
    const worker = this.worker;
    if (!worker) throw new Error('The optical-flow worker is not running');
    const id = ++this.sequence;
    return new Promise<FlowReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Optical flow timed out'));
      }, 8_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({
          type: 'flow',
          id,
          prev: previous.data,
          curr: current.data,
          width: current.width,
          height: current.height,
          points,
          polygon,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  dispose(): void {
    this.readyPromise = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Optical flow was disposed'));
    }
    this.pending.clear();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
