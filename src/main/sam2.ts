/**
 * On-demand SAM 2.1 Small component and the native ONNX tracking engine.
 *
 * Installation downloads Meta's SAM 2.1 Hiera-Small ONNX export once, verifies
 * its published SHA-256, unpacks it into the user data folder and never touches
 * the network again. Inference runs on ONNX Runtime's CPU provider inside the
 * main process, so no GPU is required; the model is used with a region-of-interest
 * crop so a rocket only needs to occupy part of the frame.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import os from 'node:os';
import { BrowserWindow, app } from 'electron';
import AdmZip from 'adm-zip';
import * as ort from 'onnxruntime-node';
import {
  SAM2_COMPONENT,
  Sam2FramePacket,
  Sam2FrameReply,
  Sam2FrameStats,
  Sam2InstallResult,
  Sam2Progress,
  Sam2SessionInfo,
  Sam2Stage,
  Sam2Status,
  Sam2TrackRequest,
} from '../shared/sam2';
import {
  CanvasMapping,
  Roi,
  clamp,
  estimateBackgroundTranslation,
  interiorPromptCandidates,
  mappingFor,
  maskOverlap,
  polygonArea,
  maskPromptFromPolygon,
  promptPointsForPolygon,
  resampleMaskInput,
  roiForBounds,
  scoreSegmentation,
  segmentationFromLogits,
  transformReferences,
} from '../shared/sam2-geometry';
import { polygonCentroid } from '../shared/motion';
import { MotionPoint, MotionReferencePoint, TrackFrame, polygonBounds } from '../shared/motion';

const IMAGE_MEAN = [0.485, 0.456, 0.406];
const IMAGE_STD = [0.229, 0.224, 0.225];
const MASK_GRID = 256;
const MAX_MASK_FRACTION = 0.6;

function componentRoot(): string {
  const override = process.env.THURSTBOOK_SAM2_DIR;
  if (override && override.trim()) return path.resolve(override);
  return path.join(app.getPath('userData'), 'models', SAM2_COMPONENT.id);
}

function manifestPath(): string {
  return path.join(componentRoot(), 'component.json');
}

function archivePath(): string {
  return path.join(componentRoot(), 'model.zip.part');
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

function installedFiles(): { encoder: string; decoder: string } {
  return {
    encoder: path.join(componentRoot(), SAM2_COMPONENT.encoderFile),
    decoder: path.join(componentRoot(), SAM2_COMPONENT.decoderFile),
  };
}

interface InstallState {
  stage: Sam2Stage;
  received: number;
  total: number | null;
  error: string | null;
  cancelled: boolean;
}

let installState: InstallState = { stage: 'idle', received: 0, total: null, error: null, cancelled: false };
let installing = false;
let activeRequest: import('node:http').ClientRequest | null = null;
let activeStream: fs.WriteStream | null = null;

export function sam2Status(): Sam2Status {
  const files = installedFiles();
  const encoderBytes = fileSize(files.encoder);
  const decoderBytes = fileSize(files.decoder);
  let manifest: any = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  } catch {
    manifest = null;
  }
  const installed =
    !!manifest &&
    manifest.id === SAM2_COMPONENT.id &&
    manifest.version === SAM2_COMPONENT.version &&
    encoderBytes === SAM2_COMPONENT.encoderBytes &&
    decoderBytes === SAM2_COMPONENT.decoderBytes;
  const bytes = (encoderBytes > 0 ? encoderBytes : 0) + (decoderBytes > 0 ? decoderBytes : 0);
  return {
    installed,
    stage: installing ? installState.stage : installState.error ? 'error' : installed ? 'ready' : installState.stage,
    component: SAM2_COMPONENT.name,
    version: SAM2_COMPONENT.version,
    directory: componentRoot(),
    bytes,
    runtime: 'ONNX Runtime · CPU · fp32',
    error: installState.error,
  };
}

function broadcast(progress: Sam2Progress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('rocketlab:sam2-progress', progress);
  }
}

function emit(stage: Sam2Stage, received: number, total: number | null, message: string, error: string | null = null): void {
  installState.stage = stage;
  installState.received = received;
  installState.total = total;
  if (error !== null) installState.error = error;
  broadcast({ stage, received, total, message, error });
}

function friendlyDownloadError(error: any): string {
  const code = error?.code ?? '';
  if (code === 'ENOSPC') return `Not enough disk space to install SAM 2.1 Small (about 300 MB is needed during installation). Free some space in ${componentRoot()} and retry.`;
  if (code === 'EACCES' || code === 'EPERM') return `Thrustbook cannot write the model to ${componentRoot()}. Check the folder permissions and retry.`;
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH'].includes(code)) {
    return 'The SAM 2.1 download could not reach the model host. Check your internet connection and retry.';
  }
  if (typeof error?.httpStatus === 'number') return `The model host returned HTTP ${error.httpStatus}. Retry in a moment or check the network connection.`;
  if (error?.message === 'checksum') return 'The downloaded SAM 2.1 archive did not match its published checksum. The file was discarded; please retry.';
  return error?.message ?? 'SAM 2.1 Small could not be installed.';
}

/** Stream the archive to disk, following redirects, with bounded progress events. */
function downloadArchive(url: string, destination: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      reject(new Error('The model host redirected too many times.'));
      return;
    }
    const request = https.get(
      url,
      { headers: { 'user-agent': 'Thrustbook/2.2 (+https://github.com/DVVagram/Thrustbook)', accept: 'application/octet-stream' } },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          downloadArchive(new URL(response.headers.location, url).href, destination, redirects + 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          const error: any = new Error(`The model host returned HTTP ${status}.`);
          error.httpStatus = status;
          reject(error);
          return;
        }
        const total = Number(response.headers['content-length']) || SAM2_COMPONENT.archiveBytes;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const stream = fs.createWriteStream(destination);
        activeStream = stream;
        let received = 0;
        let lastEmit = 0;
        response.on('data', (chunk: Buffer) => {
          if (installState.cancelled) {
            request.destroy();
            stream.destroy();
            try {
              fs.rmSync(destination, { force: true });
            } catch {
              /* best effort */
            }
            reject(new Error('cancelled'));
            return;
          }
          received += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 120) {
            lastEmit = now;
            emit('downloading', received, total, `Downloading SAM 2.1 Small · ${(received / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(0)} MB`);
          }
        });
        response.pipe(stream);
        stream.on('finish', () => {
          stream.close(() => {
            if (activeStream === stream) activeStream = null;
            if (installState.cancelled) reject(new Error('cancelled'));
            else resolve();
          });
        });
        stream.on('error', (error) => {
          if (activeStream === stream) activeStream = null;
          try {
            fs.rmSync(destination, { force: true });
          } catch {
            /* best effort */
          }
          reject(error);
        });
        response.on('error', reject);
      },
    );
    activeRequest = request;
    request.on('error', (error) => {
      if (activeRequest === request) activeRequest = null;
      reject(error);
    });
    request.on('close', () => {
      if (activeRequest === request) activeRequest = null;
    });
    request.setTimeout(120000, () => {
      request.destroy();
      const error: any = new Error('The SAM 2.1 download timed out. Check your internet connection and retry.');
      error.code = 'ETIMEDOUT';
      reject(error);
    });
  });
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function installSam2(): Promise<Sam2InstallResult> {
  if (installing) throw new Error('SAM 2.1 Small is already being installed');
  const current = sam2Status();
  if (current.installed) return { installed: true, status: current };
  installing = true;
  installState = { stage: 'downloading', received: 0, total: SAM2_COMPONENT.archiveBytes, error: null, cancelled: false };
  const root = componentRoot();
  const archive = archivePath();
  const temporary = `${root}.installing-${process.pid}`;
  try {
    fs.mkdirSync(root, { recursive: true });
    emit('downloading', 0, SAM2_COMPONENT.archiveBytes, 'Preparing the SAM 2.1 Small download…');
    await downloadArchive(SAM2_COMPONENT.archiveUrl, archive);

    emit('verifying', SAM2_COMPONENT.archiveBytes, SAM2_COMPONENT.archiveBytes, 'Verifying the model archive…');
    const digest = await sha256(archive);
    if (digest !== SAM2_COMPONENT.archiveSha256) {
      throw new Error('checksum');
    }
    if (installState.cancelled) throw new Error('cancelled');

    emit('extracting', SAM2_COMPONENT.archiveBytes, SAM2_COMPONENT.archiveBytes, 'Unpacking SAM 2.1 Small…');
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.mkdirSync(temporary, { recursive: true });
    const zip = new AdmZip(archive);
    const wanted: Array<[string, string, number]> = [
      [SAM2_COMPONENT.encoderFile, SAM2_COMPONENT.encoderFile, SAM2_COMPONENT.encoderBytes],
      [SAM2_COMPONENT.decoderFile, SAM2_COMPONENT.decoderFile, SAM2_COMPONENT.decoderBytes],
    ];
    for (const [entryName, targetName, expected] of wanted) {
      const entry = zip.getEntry(entryName);
      if (!entry) throw new Error(`The model archive does not contain ${entryName}.`);
      const data = entry.getData();
      if (data.length !== expected) {
        throw new Error(`The unpacked ${targetName} has an unexpected size (${data.length} bytes).`);
      }
      fs.writeFileSync(path.join(temporary, targetName), data);
    }
    for (const [entryName] of wanted) {
      const target = entryName;
      const staged = path.join(temporary, target);
      const final = path.join(root, target);
      fs.rmSync(final, { force: true });
      fs.renameSync(staged, final);
    }
    fs.writeFileSync(
      manifestPath(),
      JSON.stringify(
        {
          id: SAM2_COMPONENT.id,
          version: SAM2_COMPONENT.version,
          component: SAM2_COMPONENT.name,
          license: SAM2_COMPONENT.license,
          source: SAM2_COMPONENT.sourcePage,
          archiveSha256: SAM2_COMPONENT.archiveSha256,
          precision: SAM2_COMPONENT.precision,
          installedAt: new Date().toISOString(),
          files: wanted.map(([name, , bytes]) => ({ name, bytes })),
        },
        null,
        2,
      ),
    );
    installState = { stage: 'ready', received: 0, total: null, error: null, cancelled: false };
    const status = sam2Status();
    broadcast({ stage: 'ready', received: 0, total: null, message: 'SAM 2.1 Small is installed and ready.' });
    return { installed: status.installed, status };
  } catch (error: any) {
    if (installState.cancelled) {
      installState = { stage: 'cancelled', received: 0, total: null, error: null, cancelled: false };
      broadcast({ stage: 'cancelled', received: 0, total: null, message: 'The SAM 2.1 download was cancelled.' });
      return { installed: false, status: sam2Status() };
    }
    installState.error = friendlyDownloadError(error);
    installState.stage = 'error';
    console.error('SAM 2.1 install failed:', error);
    broadcast({ stage: 'error', received: 0, total: null, message: installState.error, error: installState.error });
    throw new Error(installState.error);
  } finally {
    installing = false;
    activeRequest = null;
    activeStream = null;
    try {
      fs.rmSync(archive, { force: true });
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(temporary, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export function cancelSam2Install(): { cancelled: boolean } {
  if (!installing) return { cancelled: false };
  installState.cancelled = true;
  // Stop an in-flight transfer at once instead of waiting for the next chunk.
  try {
    activeStream?.destroy();
  } catch {
    /* best effort */
  }
  try {
    activeRequest?.destroy();
  } catch {
    /* best effort */
  }
  return { cancelled: true };
}

export function removeSam2(): Sam2Status {
  if (installing) throw new Error('Wait for the SAM 2.1 installation to finish before removing it');
  disposeModels();
  fs.rmSync(componentRoot(), { recursive: true, force: true });
  installState = { stage: 'idle', received: 0, total: null, error: null, cancelled: false };
  return sam2Status();
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

let encoder: ort.InferenceSession | null = null;
let decoder: ort.InferenceSession | null = null;
let loading: Promise<void> | null = null;
let modelStage: Sam2Stage = 'idle';

function threadCount(): number {
  const cpus = os.cpus()?.length ?? 4;
  return Math.max(1, Math.min(8, cpus - 1));
}

async function ensureModels(): Promise<void> {
  if (encoder && decoder) return;
  if (loading) return loading;
  const status = sam2Status();
  if (!status.installed) {
    throw new Error('SAM 2.1 Small is not installed. Install it from the tracking panel, then track again.');
  }
  loading = (async () => {
    const files = installedFiles();
    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
      intraOpNumThreads: threadCount(),
    };
    try {
      modelStage = 'loading';
      broadcast({ stage: 'loading', received: 0, total: null, message: 'Loading SAM 2.1 Small into memory…' });
      encoder = await ort.InferenceSession.create(files.encoder, options);
      decoder = await ort.InferenceSession.create(files.decoder, options);
      modelStage = 'ready';
      broadcast({ stage: 'ready', received: 1, total: 1, message: 'SAM 2.1 Small is loaded.' });
    } catch (error: any) {
      encoder = null;
      decoder = null;
      modelStage = 'error';
      console.error('SAM 2.1 model load failed:', error);
      throw new Error(
        `The SAM 2.1 model could not be loaded (${error?.message ?? error}). It may be incomplete: remove and reinstall it from the tracking panel.`,
      );
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function disposeModels(): void {
  encoder = null;
  decoder = null;
  loading = null;
  modelStage = 'idle';
  sessions.clear();
}

interface Session {
  id: string;
  request: Sam2TrackRequest;
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  imageWidth: number;
  imageHeight: number;
  mapping: CanvasMapping | null;
  logits: Float32Array | null;
  polygon: MotionPoint[] | null;
  maskArea: number | null;
  centroid: MotionPoint | null;
  references: MotionReferencePoint[];
  previousImage: Uint8Array | null;
  previousBox: Roi | null;
  lastIndex: number;
  started: boolean;
  stopped: boolean;
  endFrame: number;
}

const sessions = new Map<string, Session>();

const INPUT_SIZE = SAM2_COMPONENT.inputSize;

export async function startSam2Session(payload: any): Promise<Sam2SessionInfo> {
  const request = payload?.request as Sam2TrackRequest;
  if (!request || !request.object || !Array.isArray(request.object.polygon) || request.object.polygon.length < 3) {
    throw new Error('A valid object outline is required to start SAM 2.1 tracking');
  }
  if (!(request.sourceWidth > 0) || !(request.sourceHeight > 0)) throw new Error('The media dimensions are unknown');
  if (!(request.scale > 0)) throw new Error('The processing scale is invalid');
  await ensureModels();
  const session: Session = {
    id: `sam2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    request,
    sourceWidth: Math.round(request.sourceWidth),
    sourceHeight: Math.round(request.sourceHeight),
    scale: request.scale,
    imageWidth: Math.max(1, Math.round(request.sourceWidth * request.scale)),
    imageHeight: Math.max(1, Math.round(request.sourceHeight * request.scale)),
    mapping: null,
    logits: null,
    polygon: null,
    maskArea: null,
    centroid: null,
    references: (Array.isArray(request.object.references) ? request.object.references : []).map((reference) => ({
      ...reference,
      point: { ...reference.point },
    })),
    previousImage: null,
    previousBox: null,
    lastIndex: request.startFrame - 1,
    started: false,
    stopped: false,
    endFrame: Math.min(request.endFrame, Math.max(0, request.frameCount - 1)),
  };
  sessions.set(session.id, session);
  return { sessionId: session.id, startFrame: request.startFrame, endFrame: session.endFrame };
}

export function stopSam2Session(payload: any): { cancelled: boolean } {
  const id = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  const session = sessions.get(id);
  if (!session) return { cancelled: false };
  session.stopped = true;
  sessions.delete(id);
  return { cancelled: true };
}

export async function stepSam2Session(payload: any): Promise<Sam2FrameReply> {
  const id = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  const session = sessions.get(id);
  if (!session) return { type: 'stopped', stoppedAt: null, reason: 'the SAM 2.1 session was closed' };
  const frame = payload?.frame as Sam2FramePacket;
  if (!frame) throw new Error('No frame was supplied to SAM 2.1');
  const data = toBytes(frame.data);
  const width = Math.round(frame.width);
  const height = Math.round(frame.height);
  if (width <= 0 || height <= 0) throw new Error('The frame has no pixels');
  if (data.length < width * height * 4) {
    throw new Error(`The frame buffer is too small (${data.length} bytes for ${width}×${height})`);
  }
  if (session.stopped) return { type: 'stopped', stoppedAt: frame.index, reason: 'tracking was cancelled' };
  if (!session.started && frame.index !== session.request.startFrame) {
    return { type: 'stopped', stoppedAt: frame.index, reason: 'SAM 2.1 tracking did not start at the requested frame' };
  }
  const hasPrompt = Array.isArray(frame.promptPolygon) && frame.promptPolygon.length >= 3;
  if (session.started && frame.index !== session.lastIndex + 1) {
    // Optical flow may have covered intermediate frames. The prompt polygon
    // carries the object's predicted position, so a forward jump is valid as
    // long as it is bounded; anything else is a bad request.
    const gap = frame.index - session.lastIndex;
    if (!hasPrompt || gap <= 0 || gap > 12) {
      return { type: 'stopped', stoppedAt: frame.index, reason: 'non-consecutive frame supplied' };
    }
  }
  if (frame.index > session.endFrame) {
    return { type: 'stopped', stoppedAt: frame.index, reason: 'reached the end of the selected range' };
  }
  if (session.imageWidth !== width || session.imageHeight !== height) {
    session.imageWidth = width;
    session.imageHeight = height;
    session.scale = width / Math.max(1, session.sourceWidth);
  }
  const result = await trackFrame(session, frame, data, width, height);
  if (result.type === 'stopped') sessions.delete(id);
  return result;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array((value as ArrayBufferView).buffer, (value as ArrayBufferView).byteOffset, (value as ArrayBufferView).byteLength);
  const shaped = value as { type?: string; data?: number[] } | null;
  if (shaped && shaped.type === 'Buffer' && Array.isArray(shaped.data)) return Uint8Array.from(shaped.data);
  throw new Error('The frame pixels could not be read');
}

interface Features {
  image_embed: ort.Tensor;
  high_res_feats_0: ort.Tensor;
  high_res_feats_1: ort.Tensor;
}

/** Bilinear-crop the ROI onto the 1024² model canvas and normalise it. */
function encodeInput(image: Uint8Array, width: number, height: number, roi: Roi, mapping: CanvasMapping): Float32Array {
  const size = INPUT_SIZE;
  const tensor = new Float32Array(3 * size * size);
  const scale = mapping.scale;
  const contentWidth = Math.min(size, Math.max(1, Math.round(roi.width * scale)));
  const contentHeight = Math.min(size, Math.max(1, Math.round(roi.height * scale)));
  const plane = size * size;
  const xs = new Int32Array(contentWidth + 1);
  const xf = new Float32Array(contentWidth + 1);
  for (let x = 0; x < contentWidth; x++) {
    const sample = clamp(roi.x + (x + 0.5) / scale - 0.5, 0, width - 1);
    const base = Math.floor(sample);
    xs[x] = base;
    xf[x] = sample - base;
  }
  xs[contentWidth] = xs[contentWidth - 1];
  xf[contentWidth] = xf[contentWidth - 1];
  for (let y = 0; y < contentHeight; y++) {
    const sample = clamp(roi.y + (y + 0.5) / scale - 0.5, 0, height - 1);
    const y0 = Math.floor(sample);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sample - y0;
    const row0 = y0 * width * 4;
    const row1 = y1 * width * 4;
    const target = y * size;
    for (let x = 0; x < contentWidth; x++) {
      const x0 = xs[x];
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = xf[x];
      const a = row0 + x0 * 4;
      const b = row0 + x1 * 4;
      const c = row1 + x0 * 4;
      const d = row1 + x1 * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const r = image[a] * w00 + image[b] * w10 + image[c] * w01 + image[d] * w11;
      const g = image[a + 1] * w00 + image[b + 1] * w10 + image[c + 1] * w01 + image[d + 1] * w11;
      const bl = image[a + 2] * w00 + image[b + 2] * w10 + image[c + 2] * w01 + image[d + 2] * w11;
      const offset = target + x;
      tensor[offset] = (r / 255 - IMAGE_MEAN[0]) / IMAGE_STD[0];
      tensor[plane + offset] = (g / 255 - IMAGE_MEAN[1]) / IMAGE_STD[1];
      tensor[plane * 2 + offset] = (bl / 255 - IMAGE_MEAN[2]) / IMAGE_STD[2];
    }
  }
  return tensor;
}

async function runEncoder(tensor: Float32Array): Promise<Features> {
  if (!encoder) throw new Error('SAM 2.1 Small is not loaded');
  const results = await encoder.run({ image: new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]) });
  const image_embed = results.image_embed;
  const high_res_feats_0 = results.high_res_feats_0;
  const high_res_feats_1 = results.high_res_feats_1;
  if (!image_embed || !high_res_feats_0 || !high_res_feats_1) throw new Error('The SAM 2.1 encoder returned no features');
  return { image_embed, high_res_feats_0, high_res_feats_1 };
}

interface Candidate {
  index: number;
  logits: Float32Array;
  iou: number;
  area: number;
}

async function runDecoder(
  features: Features,
  points: Array<{ x: number; y: number; label: 0 | 1 }>,
  maskInput: Float32Array,
  hasMask: boolean,
): Promise<Candidate[]> {
  if (!decoder) throw new Error('SAM 2.1 Small is not loaded');
  const count = Math.max(1, points.length);
  const coords = new Float32Array(count * 2);
  const labels = new Float32Array(count);
  points.forEach((point, index) => {
    coords[index * 2] = point.x;
    coords[index * 2 + 1] = point.y;
    labels[index] = point.label;
  });
  const results = await decoder.run({
    image_embed: features.image_embed,
    high_res_feats_0: features.high_res_feats_0,
    high_res_feats_1: features.high_res_feats_1,
    point_coords: new ort.Tensor('float32', coords, [1, count, 2]),
    point_labels: new ort.Tensor('float32', labels, [1, count]),
    mask_input: new ort.Tensor('float32', maskInput, [1, 1, MASK_GRID, MASK_GRID]),
    has_mask_input: new ort.Tensor('float32', Float32Array.from([hasMask ? 1 : 0]), [1]),
  });
  const masks = results.masks;
  const iou = results.iou_predictions;
  if (!masks || !iou) throw new Error('The SAM 2.1 decoder returned no mask');
  const dims = masks.dims;
  const candidates = dims[1] ?? 1;
  const data = masks.data as Float32Array;
  const cell = MASK_GRID * MASK_GRID;
  const scores = iou.data as Float32Array;
  const list: Candidate[] = [];
  for (let index = 0; index < candidates; index++) {
    const logits = data.slice(index * cell, (index + 1) * cell);
    let area = 0;
    for (let i = 0; i < logits.length; i++) if (logits[i] > 0) area++;
    list.push({ index, logits, iou: Number(scores[index] ?? 0), area });
  }
  return list;
}

function toSourcePoint(point: MotionPoint, scale: number, width: number, height: number): MotionPoint {
  return {
    x: clamp(point.x / scale, 0, width),
    y: clamp(point.y / scale, 0, height),
  };
}

/**
 * Score a first-frame candidate. The decoder's own IoU is the primary signal;
 * masks whose area is wildly different from the drawn outline are penalised,
 * which rejects "the whole sky" masks without overruling a tight outline.
 */
function initialAreaRatio(candidate: Candidate, outlineArea: number, cellArea: number): number | null {
  if (!candidate.area || outlineArea <= 0) return null;
  const ratio = (candidate.area * cellArea) / outlineArea;
  return ratio >= 0.06 && ratio <= 2.5 ? ratio : null;
}

function initialCandidateScore(candidate: Candidate, outlineArea: number, frameArea: number, cellArea: number): number {
  if (!candidate.area) return -Infinity;
  if (candidate.area * cellArea > frameArea * MAX_MASK_FRACTION) return -1;
  const ratio = initialAreaRatio(candidate, outlineArea, cellArea);
  if (ratio === null) return -0.75 + candidate.iou;
  const agreement = clamp(1 - Math.abs(Math.log(Math.max(ratio, 1e-6))) / 1.6, 0, 1);
  // The decoder's own mask score decides between plausible candidates; a loose
  // outline must not pull the mask onto the background just to fill it.
  return candidate.iou + 0.05 * agreement;
}

async function trackFrame(session: Session, frame: Sam2FramePacket, image: Uint8Array, width: number, height: number): Promise<Sam2FrameReply> {
  const started = Date.now();
  const scale = session.scale;
  const sourceWidth = session.sourceWidth;
  const sourceHeight = session.sourceHeight;
  const outline = session.request.object.polygon.map((point) => ({ x: point.x * scale, y: point.y * scale }));
  // Optical flow predicts the object for frames where SAM 2.1 was skipped. On
  // the next SAM frame that outline both places the ROI and seeds the mask
  // prompt, so the model does not start from a stale mask several frames old.
  const prompt =
    Array.isArray(frame.promptPolygon) && frame.promptPolygon.length >= 3
      ? frame.promptPolygon
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
          .map((point) => ({ x: clamp(point.x * scale, 0, width), y: clamp(point.y * scale, 0, height) }))
      : [];
  const promptPolygon = prompt.length >= 3 ? prompt : null;
  let mapping: CanvasMapping;
  let roi: Roi;
  if (promptPolygon) {
    const bounds = polygonBounds(promptPolygon);
    roi = roiForBounds(bounds, width, height, 0.55, Math.max(bounds.width, bounds.height) * 1.8);
    mapping = mappingFor(roi, INPUT_SIZE);
  } else if (!session.started || !session.mapping || !session.polygon || !session.logits) {
    const bounds = polygonBounds(outline);
    roi = roiForBounds(bounds, width, height, 0.6, Math.max(bounds.width, bounds.height) * 1.4);
    mapping = mappingFor(roi, INPUT_SIZE);
  } else {
    const previousBounds = polygonBounds(session.polygon);
    const margin = 0.55;
    const minimum = Math.max(previousBounds.width, previousBounds.height) * 1.8;
    roi = roiForBounds(previousBounds, width, height, margin, minimum);
    mapping = mappingFor(roi, INPUT_SIZE);
  }

  let encodeMs = 0;
  let decodeMs = 0;
  let features: Features;
  const encodeStart = Date.now();
  try {
    features = await runEncoder(encodeInput(image, width, height, roi, mapping));
  } catch (error: any) {
    console.error('SAM 2.1 encoder failed:', error);
    return {
      type: 'stopped',
      stoppedAt: frame.index,
      reason: `SAM 2.1 could not encode frame ${frame.index + 1} (${error?.message ?? error}). Stop other heavy applications and retry.`,
    };
  }
  encodeMs = Date.now() - encodeStart;

  let maskInput: Float32Array;
  let hasMask = false;
  let promptSets: Array<Array<{ x: number; y: number; label: 0 | 1 }>>;
  let outlineArea = 0;
  let previousCentroid: MotionPoint | null = null;
  if (!session.started) {
    maskInput = new Float32Array(MASK_GRID * MASK_GRID);
    promptSets = [promptPointsForPolygon(outline, mapping)];
    outlineArea = polygonArea(outline);
  } else if (promptPolygon) {
    maskInput = maskPromptFromPolygon(promptPolygon, mapping, MASK_GRID);
    hasMask = true;
    const centroid = polygonCentroid(promptPolygon);
    const canvasPoint = { x: (centroid.x - roi.x) * mapping.scale, y: (centroid.y - roi.y) * mapping.scale };
    const inside = canvasPoint.x > 2 && canvasPoint.y > 2 && canvasPoint.x < INPUT_SIZE - 2 && canvasPoint.y < INPUT_SIZE - 2;
    promptSets = [[inside ? { ...canvasPoint, label: 1 as const } : { x: INPUT_SIZE / 2, y: INPUT_SIZE / 2, label: 1 as const }]];
    previousCentroid = centroid;
  } else {
    const previousMapping = session.mapping!;
    maskInput = resampleMaskInput(session.logits!, previousMapping, mapping, MASK_GRID);
    hasMask = true;
    const centroid = session.centroid;
    const canvasPoint = centroid ? { x: (centroid.x - roi.x) * mapping.scale, y: (centroid.y - roi.y) * mapping.scale } : null;
    const inside = canvasPoint && canvasPoint.x > 2 && canvasPoint.y > 2 && canvasPoint.x < INPUT_SIZE - 2 && canvasPoint.y < INPUT_SIZE - 2;
    promptSets = inside
      ? [[{ x: canvasPoint!.x, y: canvasPoint!.y, label: 1 as const }]]
      : [[{ x: INPUT_SIZE / 2, y: INPUT_SIZE / 2, label: 1 as const }]];
    previousCentroid = centroid;
  }

  const frameArea = width * height;
  // Grid cells are model-canvas pixels; the ROI is upscaled to the canvas, so
  // convert back to video pixels before comparing with the drawn outline.
  const cellArea = Math.pow(INPUT_SIZE / MASK_GRID / mapping.scale, 2);
  const candidates: Candidate[] = [];
  const decodeStart = Date.now();
  try {
    for (const set of promptSets) candidates.push(...(await runDecoder(features, set, maskInput, hasMask)));
    if (!hasMask) {
      // A loose outline can put the centroid on the background, where the
      // centre prompt returns a partial or empty mask. Probing points spread
      // across the outline costs a few decodes and recovers the object.
      for (const set of interiorPromptCandidates(outline, mapping, 4)) {
        candidates.push(...(await runDecoder(features, set, maskInput, false)));
      }
    }
  } catch (error: any) {
    console.error('SAM 2.1 decoder failed:', error);
    return { type: 'stopped', stoppedAt: frame.index, reason: `SAM 2.1 could not segment frame ${frame.index + 1} (${error?.message ?? error}).` };
  }
  decodeMs = Date.now() - decodeStart;
  if (process.env.SAM2_TRACE) {
    console.log('[sam2]', {
      frame: frame.index,
      roi,
      candidates: candidates.map((c) => ({ iou: Number(c.iou.toFixed(3)), area: c.area })),
    });
  }
  if (!candidates.length) {
    return { type: 'stopped', stoppedAt: frame.index, reason: `SAM 2.1 returned an empty mask at frame ${frame.index + 1}.` };
  }

  let best: Candidate = candidates[0];
  let bestScore = -Infinity;
  let bestOverlap: number | null = null;
  for (const candidate of candidates) {
    let score: number;
    if (hasMask) {
      const overlap = maskOverlap(candidate.logits, maskInput);
      score = overlap > 0.12 ? 0.5 * candidate.iou + 0.5 * overlap : 0.8 * candidate.iou + 0.2 * overlap;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
        bestOverlap = overlap;
      }
    } else {
      score = initialCandidateScore(candidate, outlineArea, frameArea, cellArea);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
        bestOverlap = null;
      }
    }
  }
  if (process.env.SAM2_TRACE) console.log('[sam2] chosen', best.index, best.iou, best.area);
  const previousMaskArea = promptPolygon ? polygonArea(promptPolygon) : session.maskArea;
  const segment = segmentationFromLogits(best.logits, MASK_GRID, mapping, {
    frameWidth: width,
    frameHeight: height,
    seed: previousCentroid,
    longSide: 300,
  });
  const stats: Sam2FrameStats = {
    encodeMs,
    decodeMs,
    totalMs: Date.now() - started,
    roi: { x: Math.round(roi.x), y: Math.round(roi.y), width: Math.round(roi.width), height: Math.round(roi.height) },
  };
  if (!segment) {
    return { type: 'stopped', stoppedAt: frame.index, reason: `SAM 2.1 found no object at frame ${frame.index + 1}. Correct the outline on this frame and track again.`, stats };
  }
  if (previousMaskArea === null && outlineArea > 0) {
    const ratio = segment.area / outlineArea;
    if (ratio < 0.12 || ratio > 7) {
      return {
        type: 'stopped',
        stoppedAt: frame.index,
        reason: `SAM 2.1 segmented ${(segment.area / Math.max(1, outlineArea)).toFixed(1)}× the drawn outline on frame ${frame.index + 1}. Draw a tighter outline around the rocket and track again.`,
        stats,
      };
    }
  }
  if (segment.area > frameArea * MAX_MASK_FRACTION) {
    return { type: 'stopped', stoppedAt: frame.index, reason: `The segmented area covers too much of frame ${frame.index + 1}. Draw a tighter outline and track again.`, stats };
  }

  const overlap = bestOverlap;
  const areaRatio = previousMaskArea && previousMaskArea > 0 ? segment.area / previousMaskArea : null;
  const step = previousCentroid ? Math.hypot(segment.centroid.x - previousCentroid.x, segment.centroid.y - previousCentroid.y) / Math.max(1, Math.sqrt(segment.area)) : 0;
  const score = scoreSegmentation({
    predictedIou: best.iou,
    overlap,
    areaRatio,
    centroidStep: step,
    clipped: segment.touchesEdge,
    initial: !session.started,
    componentRatio: segment.componentRatio,
  });
  const minimum = Math.max(12, session.request.qualityThreshold * 0.45);
  if (!session.started && score.quality < minimum) {
    return {
      type: 'stopped',
      stoppedAt: frame.index,
      reason: `SAM 2.1 could not confirm the outline on frame ${frame.index + 1} (confidence ${Math.round(score.quality)}). Draw a tighter outline around the rocket and track again.`,
      stats,
    };
  }
  if (session.started && score.quality < minimum) {
    session.stopped = true;
    return { type: 'stopped', stoppedAt: frame.index, reason: `Segmentation lost at frame ${frame.index + 1} (confidence ${Math.round(score.quality)})`, stats };
  }

  let camera = { dx: 0, dy: 0, valid: false };
  if (session.request.compensateCamera && session.previousImage && session.previousBox) {
    camera = estimateBackgroundTranslation(session.previousImage, image, width, height, session.previousBox);
    if (!camera.valid) score.notes.push('Background motion could not be estimated on this frame');
  }
  // Reference points arrive in source coordinates; tracking works in frame
  // (processing) coordinates, so lift them to the frame before the first track.
  const references = session.started
    ? transformReferences(session.polygon!, segment.polygon, session.references)
    : session.references.map((reference) => ({
        ...reference,
        point: { x: reference.point.x * scale, y: reference.point.y * scale },
      }));

  const polygon = segment.polygon.map((point) => toSourcePoint(point, scale, sourceWidth, sourceHeight));
  const nextReferences = references.map((reference) => ({
    ...reference,
    point: toSourcePoint(reference.point, scale, sourceWidth, sourceHeight),
  }));
  const status = score.quality >= session.request.qualityThreshold ? 'tracked' : 'uncertain';
  if (status === 'uncertain') score.notes.unshift('Segmentation confidence is below the review threshold');
  const track: TrackFrame = {
    frame: frame.index,
    time: frame.time,
    polygon,
    references: nextReferences,
    bbox: polygonBounds(polygon),
    status,
    quality: score.quality,
    qualityNotes: score.notes,
    featureCount: polygon.length,
    inlierRatio: overlap ?? 1,
    fbError: 0,
    cameraDx: camera.dx / scale,
    cameraDy: camera.dy / scale,
    cameraValid: session.request.compensateCamera ? camera.valid : false,
    engine: 'sam2',
    predictedIou: best.iou,
    maskIou: overlap ?? undefined,
    maskArea: segment.area / (scale * scale),
  };

  session.started = true;
  session.mapping = mapping;
  session.logits = best.logits;
  session.polygon = segment.polygon;
  session.maskArea = segment.area;
  session.centroid = segment.centroid;
  session.references = references;
  session.previousBox = segment.bbox;
  session.previousImage = image;
  session.lastIndex = frame.index;

  return { type: 'track', track, stats };
}

export function sam2EngineInfo(): { stage: Sam2Stage; runtime: string; threads: number } {
  return { stage: modelStage, runtime: 'ONNX Runtime · CPU · fp32', threads: threadCount() };
}
