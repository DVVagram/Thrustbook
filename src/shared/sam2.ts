/**
 * Meta SAM 2.1 Small (Hiera-S) on-device segmentation component.
 *
 * The model is not shipped inside the installer: it is a 143 MB Apache-2.0
 * artifact that is downloaded once, verified, and unpacked into the user data
 * folder. Everything after that runs locally.
 */
import type { MotionPoint, MotionReferencePoint, TrackFrame } from './motion';

export const SAM2_COMPONENT = {
  id: 'sam2.1-hiera-small',
  name: 'SAM 2.1 Small',
  engineLabel: 'Meta SAM 2.1 · Hiera-Small',
  version: '2.1',
  precision: 'fp32',
  license: 'Apache-2.0',
  /** One-time archive download. */
  archiveUrl:
    'https://huggingface.co/vietanhdev/segment-anything-2.1-onnx-models/resolve/main/sam2.1_hiera_small_20260221.zip',
  archiveBytes: 142896844,
  archiveSha256: '7c232acd0a95053704aa2ae9f9a3e8f9e93899fa51335b14d38e34bb7267973d',
  sourcePage: 'https://huggingface.co/vietanhdev/segment-anything-2.1-onnx-models',
  encoderFile: 'sam2.1_hiera_small.encoder.onnx',
  decoderFile: 'sam2.1_hiera_small.decoder.onnx',
  encoderBytes: 138018779,
  decoderBytes: 16519569,
  /** Fixed input resolution of the exported encoder. */
  inputSize: 1024,
} as const;

export type Sam2Stage = 'idle' | 'downloading' | 'verifying' | 'extracting' | 'loading' | 'ready' | 'cancelled' | 'error';

export interface Sam2Status {
  installed: boolean;
  stage: Sam2Stage;
  component: typeof SAM2_COMPONENT.name;
  version: string;
  directory: string;
  bytes: number;
  runtime: string;
  error: string | null;
}

export interface Sam2Progress {
  stage: Sam2Stage;
  received: number;
  total: number | null;
  message: string;
  error?: string | null;
}

export interface Sam2InstallResult {
  installed: boolean;
  status: Sam2Status;
}

export interface Sam2TrackObject {
  id: string;
  name: string;
  polygon: MotionPoint[];
  references: MotionReferencePoint[];
}

export interface Sam2TrackRequest {
  object: Sam2TrackObject;
  /** Image pixels are `sourceWidth × scale` wide. */
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  startFrame: number;
  endFrame: number;
  frameCount: number;
  qualityThreshold: number;
  compensateCamera: boolean;
}

export interface Sam2FramePacket {
  index: number;
  time: number;
  width: number;
  height: number;
  data: Uint8Array;
  /**
   * Optional outline (source coordinates) predicted by optical flow for this
   * frame. It becomes the decoder's mask prompt and places the ROI, so a SAM
   * frame after flow-only frames still starts from the object.
   */
  promptPolygon?: MotionPoint[];
}

export interface Sam2FrameStats {
  encodeMs: number;
  decodeMs: number;
  totalMs: number;
  roi: { x: number; y: number; width: number; height: number };
}

export type Sam2FrameReply =
  | { type: 'track'; track: TrackFrame; stats: Sam2FrameStats }
  | { type: 'stopped'; stoppedAt: number | null; reason: string; stats?: Sam2FrameStats };

export interface Sam2SessionInfo {
  sessionId: string;
  startFrame: number;
  endFrame: number;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${Math.round(bytes)} B`;
}
