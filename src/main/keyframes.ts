import { getDb } from './db';
import { rememberMediaPath } from './media';
import { newId, nowIso } from './repo';
import { KeyframeSet, normaliseKeyframeSet } from '../shared/keyframes';

export interface KeyframeSetRecord {
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

function parseRow(row: any): KeyframeSetRecord {
  let stored: any = {};
  try {
    stored = JSON.parse(row.data_json || '{}');
  } catch {
    stored = {};
  }
  const set = normaliseKeyframeSet(stored);
  set.name = String(row.name ?? set.name);
  set.notes = String(row.notes ?? set.notes);
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    name: String(row.name ?? set.name),
    media_kind: String(row.media_kind ?? set.media.kind),
    media_path: String(row.media_path ?? set.media.path),
    notes: String(row.notes ?? ''),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    set,
  };
}

export function listKeyframeSets(projectId: string): KeyframeSetRecord[] {
  if (!projectId) throw new Error('Select a project first');
  const rows = getDb().all<any>(
    'SELECT * FROM keyframe_sets WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 300',
    [projectId],
  );
  return rows.map(parseRow);
}

export function getKeyframeSet(id: string): KeyframeSetRecord {
  if (!id) throw new Error('A keyframe set id is required');
  const row = getDb().get<any>('SELECT * FROM keyframe_sets WHERE id = ?', [id]);
  if (!row) throw new Error('Keyframe set not found');
  return parseRow(row);
}

/**
 * Create or update a reusable keyframe set. Keyframes, frame times, media
 * metadata and the optional known-distance scale are stored together as one
 * versioned document so a set can be reopened or applied to another clip.
 */
export function saveKeyframeSet(payload: any): KeyframeSetRecord {
  const set = normaliseKeyframeSet(payload?.set);
  const requestedName = String(payload?.name ?? set.name ?? '').trim();
  const name = requestedName || 'Rocket video analysis';
  set.name = name;
  set.notes = String(payload?.notes ?? set.notes ?? '');
  set.updatedAt = nowIso();

  let id = typeof payload?.id === 'string' && payload.id ? payload.id : '';
  let projectId = typeof payload?.projectId === 'string' ? payload.projectId : '';
  let createdAt = nowIso();

  if (id) {
    const existing = getDb().get<any>('SELECT * FROM keyframe_sets WHERE id = ?', [id]);
    if (!existing) throw new Error('Keyframe set not found');
    projectId = existing.project_id;
    createdAt = existing.created_at;
    getDb().run(
      'UPDATE keyframe_sets SET name = ?, media_kind = ?, media_path = ?, data_json = ?, notes = ?, updated_at = ? WHERE id = ?',
      [name, set.media.kind, set.media.path, JSON.stringify(set), set.notes, set.updatedAt, id],
    );
  } else {
    if (!projectId) throw new Error('Select a project first');
    const project = getDb().get<any>('SELECT id FROM projects WHERE id = ?', [projectId]);
    if (!project) throw new Error('Project not found');
    id = newId();
    getDb().run(
      'INSERT INTO keyframe_sets (id, project_id, name, media_kind, media_path, data_json, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, projectId, name, set.media.kind, set.media.path, JSON.stringify(set), set.notes, createdAt, set.updatedAt],
    );
  }

  if (set.media.path) rememberMediaPath(set.media.path);
  return getKeyframeSet(id);
}

export function removeKeyframeSet(id: string): { removed: boolean; id: string } {
  if (!id) throw new Error('A keyframe set id is required');
  const result = getDb().run('DELETE FROM keyframe_sets WHERE id = ?', [id]);
  return { removed: result.changes > 0, id };
}
