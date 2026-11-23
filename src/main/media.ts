import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { getDb } from './db';
import { dataDir, isInside } from './paths';

/**
 * Local media is served through a narrow, read-only protocol instead of exposing
 * arbitrary file:// access to the sandboxed renderer. A path is served only when
 * it was chosen in a file dialog this session or is referenced by a saved motion
 * analysis in the current workspace.
 */
export const MEDIA_SCHEME = 'thrustbook-media';
const remembered = new Set<string>();

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

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
    const rows = getDb().all<{ media_path: string; media_paths_json: string }>(
      'SELECT media_path, media_paths_json FROM motion_analyses',
    );
    for (const row of rows) {
      if (row.media_path && key(row.media_path) === key(resolved)) return true;
      try {
        const paths = JSON.parse(row.media_paths_json || '[]');
        if (Array.isArray(paths) && paths.some((p) => typeof p === 'string' && key(p) === key(resolved))) return true;
      } catch {
        /* ignore malformed legacy row */
      }
    }
  } catch {
    /* database may not be open yet */
  }
  return false;
}

export function mediaUrl(filePath: string): string {
  const encoded = Buffer.from(path.resolve(filePath), 'utf8').toString('base64url');
  return `${MEDIA_SCHEME}://local/${encoded}`;
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

function streamResponse(filePath: string, request: Request): Response {
  const stat = fs.statSync(filePath);
  const range = request.headers.get('range');
  const headers: Record<string, string> = {
    'Content-Type': mimeFor(filePath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  };
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
        const length = end - start + 1;
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['Content-Length'] = String(length);
        const stream = fs.createReadStream(filePath, { start, end });
        return new Response(request.method === 'HEAD' ? null : (Readable.toWeb(stream) as any), { status: 206, headers });
      }
    }
  }
  headers['Content-Length'] = String(stat.size);
  const stream = fs.createReadStream(filePath);
  return new Response(request.method === 'HEAD' ? null : (Readable.toWeb(stream) as any), { status: 200, headers });
}

export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'local') return new Response('Not found', { status: 404 });
      const encoded = url.pathname.replace(/^\/+/, '');
      if (!encoded) return new Response('Not found', { status: 404 });
      const filePath = Buffer.from(encoded, 'base64url').toString('utf8');
      if (!isKnownMediaPath(filePath)) return new Response('Media path is not authorised', { status: 403 });
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return new Response('Media file is missing', { status: 404 });
      return streamResponse(filePath, request);
    } catch (err: any) {
      console.error('Media protocol request failed', err);
      return new Response('Media could not be read', { status: 500 });
    }
  });
}
