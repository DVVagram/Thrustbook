import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb } from './db';
import { dataDir, isInside } from './paths';

/**
 * Source video is streamed to the renderer from a token-guarded server bound to
 * 127.0.0.1. This is used instead of a custom URL scheme because the media
 * element rejects unknown schemes. A path is served only when it was chosen in
 * a file dialog this session or is referenced by a saved keyframe set.
 */
const remembered = new Set<string>();
const token = crypto.randomBytes(24).toString('base64url');
let server: http.Server | null = null;
let serverOrigin = '';

function key(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function rememberMediaPath(filePath: string): void {
  if (typeof filePath === 'string' && filePath.trim()) remembered.add(key(filePath));
}

export function isKnownMediaPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  if (remembered.has(key(resolved))) return true;
  if (isInside(dataDir(), resolved)) return true;
  try {
    const rows = getDb().all<{ media_path: string }>('SELECT media_path FROM keyframe_sets');
    return rows.some((row) => row.media_path && key(row.media_path) === key(resolved));
  } catch {
    /* the database may not be open yet */
  }
  return false;
}

export function mediaUrl(filePath: string): string {
  if (!serverOrigin) throw new Error('The local video service is not running');
  const encoded = Buffer.from(path.resolve(filePath), 'utf8').toString('base64url');
  return `${serverOrigin}/media/${token}/${encoded}`;
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.ogg': 'video/ogg',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
  };
  return map[ext] ?? 'application/octet-stream';
}

function sendText(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(message);
}

function handleMediaRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, 'Method not allowed');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const prefix = `/media/${token}/`;
    if (!url.pathname.startsWith(prefix)) {
      sendText(response, 403, 'Media path is not authorised');
      return;
    }
    const encoded = url.pathname.slice(prefix.length);
    if (!encoded) {
      sendText(response, 404, 'Media path is missing');
      return;
    }
    const filePath = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!isKnownMediaPath(filePath)) {
      sendText(response, 403, 'Media path is not authorised');
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendText(response, 404, 'Media file is missing');
      return;
    }

    const stat = fs.statSync(filePath);
    const headers: Record<string, string | number> = {
      'Content-Type': mimeFor(filePath),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };

    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
      if (match) {
        let start = match[1] ? Number(match[1]) : NaN;
        let end = match[2] ? Number(match[2]) : NaN;
        if (!Number.isFinite(start) && Number.isFinite(end)) {
          start = Math.max(0, stat.size - end);
          end = stat.size - 1;
        }
        if (Number.isFinite(start) && !Number.isFinite(end)) end = stat.size - 1;
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size) {
          end = Math.min(end, stat.size - 1);
          headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
          headers['Content-Length'] = end - start + 1;
          response.writeHead(206, headers);
          if (request.method === 'HEAD') {
            response.end();
            return;
          }
          const stream = fs.createReadStream(filePath, { start, end });
          stream.on('error', () => response.destroy());
          stream.pipe(response);
          return;
        }
      }
    }

    headers['Content-Length'] = stat.size;
    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  } catch (err) {
    console.error('Media request failed', err);
    sendText(response, 500, 'Media could not be read');
  }
}

export async function startMediaServer(): Promise<string> {
  if (serverOrigin) return serverOrigin;
  await new Promise<void>((resolve, reject) => {
    const instance = http.createServer(handleMediaRequest);
    const failed = (error: Error) => {
      instance.off('listening', ready);
      reject(error);
    };
    const ready = () => {
      instance.off('error', failed);
      const address = instance.address();
      if (!address || typeof address === 'string') {
        instance.close();
        reject(new Error('The local video service did not bind to a loopback port'));
        return;
      }
      server = instance;
      serverOrigin = `http://127.0.0.1:${address.port}`;
      resolve();
    };
    instance.once('error', failed);
    instance.once('listening', ready);
    instance.listen(0, '127.0.0.1');
  });
  return serverOrigin;
}

export function stopMediaServer(): void {
  if (!server) return;
  try {
    server.close();
  } catch {
    /* closing an already closed server is harmless */
  }
  server = null;
  serverOrigin = '';
}
