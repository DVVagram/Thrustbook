import { api } from '../api';
import type { Sam2FramePacket, Sam2FrameReply, Sam2SessionInfo, Sam2TrackRequest } from '../../shared/sam2';
import type { MotionPoint } from '../../shared/motion';

export type EngineState = 'checking' | 'not-installed' | 'installing' | 'loading' | 'ready' | 'error';

/**
 * Thin renderer client for the SAM 2.1 component running in the main process.
 * Frames are sent as raw RGBA pixels; no model work happens on the UI thread.
 */
export class Sam2Client {
  private sessionId: string | null = null;
  private disposed = false;

  async start(request: Sam2TrackRequest): Promise<Sam2SessionInfo> {
    const info = await api.sam2Start(request);
    if (this.disposed) {
      void api.sam2Cancel(info.sessionId).catch(() => undefined);
      throw new Error('Tracking was cancelled');
    }
    this.sessionId = info.sessionId;
    return info;
  }

  async step(frame: number, time: number, image: ImageData, promptPolygon?: MotionPoint[]): Promise<Sam2FrameReply> {
    const sessionId = this.sessionId;
    if (!sessionId) throw new Error('No SAM 2.1 tracking session is active');
    const packet: Sam2FramePacket = {
      index: frame,
      time,
      width: image.width,
      height: image.height,
      data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      promptPolygon: promptPolygon && promptPolygon.length >= 3 ? promptPolygon : undefined,
    };
    return api.sam2Frame(sessionId, packet);
  }

  async cancel(): Promise<void> {
    const sessionId = this.sessionId;
    this.sessionId = null;
    if (!sessionId) return;
    try {
      await api.sam2Cancel(sessionId);
    } catch {
      /* the session may already be closed */
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
  }
}
