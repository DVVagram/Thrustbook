/**
 * Runs inside Electron's main process (see archive-electron.mjs). It creates a
 * project with a saved keyframe set, exports it, imports the archive into a new
 * project and checks that the keyframe set survived with a remapped id.
 */
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../src/main/db';
import { exportProject, importProject } from '../src/main/archive';
import { newId, nowIso } from '../src/main/repo';

const MEDIA = 'C:/Users/example/Downloads/launch.mp4';

app.whenReady().then(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'thrustbook-archive-'));
  try {
    const db = openDatabase();
    const projectId = newId();
    const setId = newId();
    const now = nowIso();
    db.run(
      `INSERT INTO projects (id, name, code, description, objectives, status, stage, tags, archived, color, created_at, updated_at)
       VALUES (?, ?, ?, '', '', 'Testing', '', '', 0, '', ?, ?)`,
      [projectId, 'Archive round trip', 'RT-1', now, now],
    );
    const set = {
      version: 1,
      name: 'Round-trip launch',
      media: {
        kind: 'video',
        path: MEDIA,
        name: path.basename(MEDIA),
        width: 1280,
        height: 720,
        duration: 12.5,
        frameCount: 3,
        fps: 30,
        timestamps: [0, 0.5, 1],
        timingSource: 'video-timestamps',
        variableFrameRate: false,
      },
      keyframes: [
        { id: 'a', frame: 0, time: 0, x: 410, y: 620, notes: 'pad' },
        { id: 'b', frame: 15, time: 0.5, x: 450, y: 520, notes: '' },
        { id: 'c', frame: 30, time: 1, x: 490, y: 420, notes: '' },
      ],
      calibration: { mode: 'scale', pointA: { x: 100, y: 700 }, pointB: { x: 300, y: 700 }, knownLength: 1, lengthUnit: 'm', notes: '' },
      notes: 'Exported keyframe set',
    };
    db.run(
      `INSERT INTO keyframe_sets (id, project_id, name, media_kind, media_path, data_json, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [setId, projectId, set.name, 'video', MEDIA, JSON.stringify(set), set.notes, now, now],
    );

    const archive = path.join(temp, 'round-trip.rlproj');
    const exported = await exportProject(projectId, archive);
    if (!fs.existsSync(archive)) throw new Error('the project archive was not written');
    if (exported.counts.keyframe_sets !== 1) throw new Error(`export counted ${exported.counts.keyframe_sets} keyframe sets`);
    if (exported.counts.projects !== 1) throw new Error(`export counted ${exported.counts.projects} projects`);

    const imported = await importProject(archive, { rename: 'Archive import check' });
    if (!imported.ok) throw new Error('the project archive did not import');
    if (imported.counts.keyframe_sets !== 1) throw new Error(`import reported ${imported.counts.keyframe_sets} keyframe sets`);

    const rows = db.all<any>('SELECT * FROM keyframe_sets WHERE project_id = ?', [imported.projectId]);
    if (rows.length !== 1) throw new Error(`imported project has ${rows.length} keyframe sets`);
    const row = rows[0];
    const stored = JSON.parse(row.data_json);
    if (row.id === setId) throw new Error('the imported keyframe set kept its old id');
    if (row.name !== set.name || row.notes !== set.notes) throw new Error('the imported set name or notes changed');
    if (row.media_path !== MEDIA) throw new Error('the imported media path changed');
    if (stored.keyframes.length !== 3) throw new Error('the imported keyframes were lost');
    if (stored.keyframes[1].x !== 450 || stored.keyframes[1].time !== 0.5) throw new Error('the imported keyframe positions or times changed');
    if (stored.calibration.knownLength !== 1 || stored.calibration.pointB.x !== 300) throw new Error('the imported calibration changed');
    if (stored.media.timestamps.length !== 3 || stored.media.frameCount !== 3) throw new Error('the imported frame timing changed');

    const importedProject = db.get<any>('SELECT * FROM projects WHERE id = ?', [imported.projectId]);
    if (importedProject?.name !== 'Archive import check') throw new Error('the imported project name was not applied');

    console.log('ARCHIVE_ROUNDTRIP_OK', JSON.stringify({
      keyframeSets: exported.counts.keyframe_sets,
      keyframes: stored.keyframes.length,
      sourceId: setId,
      importedId: row.id,
    }));
  } catch (error: any) {
    console.error('ARCHIVE_ROUNDTRIP_FAILED', error?.stack ?? error?.message ?? String(error));
    process.exitCode = 1;
  } finally {
    closeDatabase();
    try {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* temp cleanup is best effort */
    }
    app.exit(process.exitCode ?? 0);
  }
});
