import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { allSettings, getDb, schemaVersion, setSetting } from './db';
import {
  createRecord,
  dashboard,
  findOne,
  getRecord,
  linkedRecords,
  list,
  logActivity,
  projectOverview,
  removeRecord,
  searchGlobal,
  tableFor,
  updateRecord,
} from './repo';
import {
  channelValues,
  commitImport,
  confirmEvents,
  createEvent,
  datasetDetail,
  datasetStatistics,
  deleteDataset,
  deriveDataset,
  exportDatasetCsv,
  listEvents,
  previewImport,
  removeEvent,
  seriesBundle,
  suggestEvents,
  updateEvent,
} from './datasets';
import { compareDatasets, comparisonCandidates } from './comparison';
import { componentHistory, configCompare, dataLog, measurementHistory, revisionCompare, sensorHistory } from './engineering';
import { buildReportHtml, generateReport, REPORT_KINDS } from './reports';
import {
  createBackup,
  exportProject,
  exportTableCsv,
  importProject,
  inspectBackup,
  integrityCheck,
  listBackups,
  moveStorage,
  removeBackup,
  restoreBackup,
  storageInfo,
} from './archive';
import { checkForUpdates, downloadUpdate, installUpdate, openReleasePage, updateStatus } from './updates';
import { isKnownMediaPath, mediaUrl, rememberMediaPath } from './media';
import { projectFileName, readMotionProjectFile, writeMotionPdf, writeTextFile } from './motion';
import { dataDir, documentsDir, examplesRoot, isInside, safeFileName, setWorkspaceMode, uniquePath, workspaceMode } from './paths';
import { deleteExamplesWorkspace, examplesStatus } from './examples';
import { DEFAULT_STAGES } from '../shared/constants';
import { newId, nowIso } from './repo';

void newId;

const pickedPaths = new Set<string>();

function assertAuthorisedPath(candidate: unknown, mode: 'read' | 'write' = 'read'): string {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('A file path is required');
  const resolved = path.resolve(candidate);
  if (pickedPaths.has(resolved)) return resolved;
  if (isInside(dataDir(), resolved)) return resolved;
  if (mode === 'write') throw new Error('Choose the destination with the file dialog');
  throw new Error('This file was not selected through the application file dialog');
}

function fileFilters(list: { name: string; extensions: string[] }[] | undefined, fallback?: string[]) {
  if (list?.length) return list;
  return [{ name: 'All files', extensions: fallback ?? ['*'] }];
}

async function handlePickOpen(payload: any, win: BrowserWindow | null) {
  const result = await dialog.showOpenDialog(win ?? undefined!, {
    title: payload?.title ?? 'Select file',
    properties: payload?.multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: fileFilters(payload?.filters),
  });
  if (result.canceled) return { canceled: true, paths: [] };
  result.filePaths.forEach((p) => {
    pickedPaths.add(path.resolve(p));
    rememberMediaPath(p);
  });
  return { canceled: false, paths: result.filePaths };
}

async function handlePickDirectory(payload: any, win: BrowserWindow | null) {
  const result = await dialog.showOpenDialog(win ?? undefined!, {
    title: payload?.title ?? 'Select folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled) return { canceled: true, path: null };
  const p = path.resolve(result.filePaths[0]);
  pickedPaths.add(p);
  return { canceled: false, path: p };
}

async function handlePickSave(payload: any, win: BrowserWindow | null) {
  const result = await dialog.showSaveDialog(win ?? undefined!, {
    title: payload?.title ?? 'Save file',
    defaultPath: payload?.defaultName ?? undefined,
    filters: fileFilters(payload?.filters),
  });
  if (result.canceled || !result.filePath) return { canceled: true, path: null };
  const p = path.resolve(result.filePath);
  pickedPaths.add(p);
  return { canceled: false, path: p };
}

function uploadDocuments(payload: any): any[] {
  const { projectId, entityType = '', entityId = '', kind = 'Other', tags = '', description = '' } = payload ?? {};
  const project = getRecord('project', projectId);
  if (!project) throw new Error('Project not found');
  const paths: string[] = (payload?.paths ?? []).map((p: string) => assertAuthorisedPath(p));
  const created: any[] = [];
  for (const source of paths) {
    const stat = fs.statSync(source);
    if (!stat.isFile()) continue;
    if (stat.size > 1024 * 1024 * 1024) throw new Error(`File is larger than the 1 GB attachment limit: ${path.basename(source)}`);
    const target = uniquePath(documentsDir(), path.basename(source));
    fs.copyFileSync(source, target);
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    const ext = path.extname(source).toLowerCase();
    const mime =
      ext === '.pdf' ? 'application/pdf'
        : ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext) ? `image/${ext.replace('.', '').replace('jpg', 'jpeg')}`
          : ext === '.json' ? 'application/json'
            : ext === '.csv' ? 'text/csv'
              : ext === '.txt' || ext === '.md' ? 'text/plain'
                : 'application/octet-stream';
    created.push(
      createRecord('document', {
        project_id: projectId,
        entity_type: entityType,
        entity_id: entityId,
        title: path.basename(source, ext),
        description,
        kind,
        tags,
        original_name: path.basename(source),
        stored_path: target,
        mime,
        size: stat.size,
        checksum,
      }),
    );
  }
  return created;
}

function readDocumentPreview(documentId: string): any {
  const doc = getRecord('document', documentId);
  if (!doc) throw new Error('Document not found');
  if (!doc.stored_path || !fs.existsSync(doc.stored_path)) return { ...doc, preview: null, missing: true };
  const ext = path.extname(doc.stored_path).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
    const stat = fs.statSync(doc.stored_path);
    if (stat.size > 12 * 1024 * 1024) return { ...doc, preview: { kind: 'too-large' } };
    return { ...doc, preview: { kind: 'image', dataUrl: `data:${doc.mime};base64,${fs.readFileSync(doc.stored_path).toString('base64')}` } };
  }
  if (['.txt', '.md', '.csv', '.json', '.log', '.ini', '.cfg', '.yaml', '.yml'].includes(ext)) {
    const text = fs.readFileSync(doc.stored_path, 'utf8').slice(0, 200_000);
    return { ...doc, preview: { kind: 'text', text } };
  }
  return { ...doc, preview: { kind: 'unsupported' } };
}

function bootstrapProject(payload: any): any {
  const name = String(payload?.name ?? '').trim();
  if (!name) throw new Error('Project name is required');
  const project = createRecord('project', {
    name,
    code: payload.code ?? '',
    description: payload.description ?? '',
    objectives: payload.objectives ?? '',
    status: payload.status ?? 'Planning',
    stage: payload.stage ?? DEFAULT_STAGES[0],
    tags: payload.tags ?? '',
  });
  const rocket = createRecord('rocket', {
    project_id: project.id,
    name: payload.rocketName || `${name} vehicle`,
    identifier: payload.rocketCode ?? '',
    description: '',
    status: 'In development',
  });
  const revision = createRecord('revision', {
    project_id: project.id,
    rocket_id: rocket.id,
    label: payload.revisionLabel || 'Rev A',
    description: 'Initial revision',
    status: 'Concept',
  });
  const stages = DEFAULT_STAGES.map((stageName, index) =>
    createRecord('stage', {
      project_id: project.id,
      rocket_id: rocket.id,
      revision_id: revision.id,
      name: stageName,
      status: index === 0 ? 'In progress' : 'Not started',
      started_at: index === 0 ? nowIso() : '',
      sort_order: index,
    }),
  );
  setSetting('lastProjectId', project.id);
  return { project, rocket, revision, stages };
}

type Handler = (payload: any, win: BrowserWindow | null, event: Electron.IpcMainInvokeEvent) => any;

const handlers: Record<string, Handler> = {
  'app.info': () => ({
    version: app.getVersion(),
    name: app.getName(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    dataDir: dataDir(),
    schemaVersion: schemaVersion(),
    workspaceMode: workspaceMode(),
    examplesWorkspace: workspaceMode() === 'examples',
    examplesDir: examplesRoot(),
    packaged: app.isPackaged,
    isDev: !app.isPackaged,
  }),

  'workspace.info': () => ({ ...examplesStatus(), dataDir: dataDir(), examplesRoot: examplesRoot() }),
  'workspace.switch': (payload: any) => {
    const mode = payload?.mode === 'examples' ? 'examples' : 'user';
    if (workspaceMode() === mode) return { switched: false, mode };
    setWorkspaceMode(mode);
    // The database connection is bound to a workspace root, so the application
    // restarts rather than attempting to swap connections underneath open views.
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 250);
    return { switched: true, mode };
  },
  'workspace.resetExamples': () => {
    const inExamples = workspaceMode() === 'examples';
    deleteExamplesWorkspace();
    if (inExamples) {
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 250);
    }
    return { ok: true, inExamples };
  },
  'workspace.deleteExamples': () => {
    const inExamples = workspaceMode() === 'examples';
    if (inExamples) setWorkspaceMode('user');
    deleteExamplesWorkspace();
    if (inExamples) {
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 250);
    }
    return { ok: true, inExamples };
  },

  'settings.all': () => allSettings(),
  'settings.set': (payload: any) => {
    if (!payload?.key) throw new Error('Setting key required');
    setSetting(String(payload.key), String(payload.value ?? ''));
    return allSettings();
  },

  'records.list': (payload: any) => list(payload?.entity, payload ?? {}),
  'records.get': (payload: any) => {
    const row = getRecord(payload?.entity, payload?.id);
    if (!row) throw new Error('Record not found');
    return row;
  },
  'records.findOne': (payload: any) => findOne(payload?.entity, payload?.where ?? {}),
  'records.create': (payload: any) => createRecord(payload?.entity, payload?.data ?? {}),
  'records.update': (payload: any) => updateRecord(payload?.entity, payload?.id, payload?.data ?? {}),
  'records.remove': (payload: any) => removeRecord(payload?.entity, payload?.id),
  'records.linked': (payload: any) => linkedRecords(payload?.entityType, payload?.entityId),
  'records.count': (payload: any) => {
    const table = tableFor(payload?.entity);
    const where = payload?.where ?? {};
    const keys = Object.keys(where).filter((k) => (getDb().all(`PRAGMA table_info(${table})`) as any[]).some((c) => c.name === k));
    const sql = `SELECT COUNT(*) AS c FROM ${table}${keys.length ? ` WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}` : ''}`;
    return Number(getDb().get<any>(sql, keys.map((k) => where[k]))?.c ?? 0);
  },

  'dashboard.get': () => dashboard(),
  'project.overview': (payload: any) => projectOverview(payload?.projectId),
  'project.bootstrap': (payload: any) => bootstrapProject(payload),
  'search.global': (payload: any) => searchGlobal(payload?.term ?? '', payload?.projectId || undefined),

  'datalog.query': (payload: any) => dataLog(payload ?? {}),
  'measurements.history': (payload: any) => measurementHistory(payload?.projectId || undefined, payload?.q || undefined),
  'revisions.compare': (payload: any) => revisionCompare(payload?.aId, payload?.bId),
  'configs.compare': (payload: any) => configCompare(payload?.aId, payload?.bId),
  'components.history': (payload: any) => componentHistory(payload?.componentId),
  'sensors.history': (payload: any) => sensorHistory(payload?.sensorId),

  'files.pickOpen': (payload: any, win) => handlePickOpen(payload, win),
  'files.pickDirectory': (payload: any, win) => handlePickDirectory(payload, win),
  'files.pickSave': (payload: any, win) => handlePickSave(payload, win),
  'files.reveal': (payload: any) => {
    const p = assertAuthorisedPath(payload?.path);
    shell.showItemInFolder(p);
    return { ok: true };
  },
  'files.openPath': async (payload: any) => {
    const p = assertAuthorisedPath(payload?.path);
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return { ok: true };
  },
  'files.openExternal': (payload: any) => {
    const url = String(payload?.url ?? '');
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
    shell.openExternal(url);
    return { ok: true };
  },

  'motion.mediaUrl': (payload: any) => {
    if (typeof payload?.path !== 'string' || !payload.path.trim()) throw new Error('A media path is required');
    const filePath = path.resolve(payload.path);
    if (!isKnownMediaPath(filePath)) throw new Error('This media file is not referenced by a saved analysis');
    if (!fs.existsSync(filePath)) throw new Error('The selected media file is missing. Relink it to continue.');
    rememberMediaPath(filePath);
    const stat = fs.statSync(filePath);
    return { url: mediaUrl(filePath), path: filePath, size: stat.size, exists: true };
  },
  'motion.relinkMedia': async (payload: any, win) => {
    const picked = await handlePickOpen(
      {
        title: 'Relink source media',
        filters: [
          {
            name: 'Images and videos',
            extensions: ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'],
          },
        ],
      },
      win,
    );
    if (picked.canceled || !picked.paths[0]) return { canceled: true };
    const filePath = picked.paths[0];
    rememberMediaPath(filePath);
    return { canceled: false, path: filePath, url: mediaUrl(filePath), name: path.basename(filePath) };
  },
  'motion.exportCsv': async (payload: any, win) => {
    const content = String(payload?.csv ?? '');
    if (!content.trim()) throw new Error('There is no tracking data to export');
    const picked = await handlePickSave(
      {
        title: 'Export motion measurements',
        defaultName: `${safeFileName(payload?.name ?? 'motion-measurements').replace(/\.csv$/i, '') || 'motion-measurements'}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      },
      win,
    );
    if (picked.canceled || !picked.path) return { canceled: true };
    writeTextFile(picked.path, content);
    return { canceled: false, path: picked.path };
  },
  'motion.exportProject': async (payload: any, win) => {
    const project = payload?.project;
    if (!project || project.version !== 1) throw new Error('No valid analysis project to export');
    const picked = await handlePickSave(
      {
        title: 'Export motion analysis project',
        defaultName: projectFileName(payload?.name ?? project.name ?? 'motion-analysis'),
        filters: [{ name: 'Thrustbook motion analysis', extensions: ['tbmotion'] }],
      },
      win,
    );
    if (picked.canceled || !picked.path) return { canceled: true };
    writeTextFile(picked.path, JSON.stringify(project, null, 2));
    return { canceled: false, path: picked.path };
  },
  'motion.importProject': async (payload: any, win) => {
    let filePath = typeof payload?.file === 'string' && payload.file ? assertAuthorisedPath(payload.file) : '';
    if (!filePath) {
      const picked = await handlePickOpen(
        { title: 'Import motion analysis project', filters: [{ name: 'Thrustbook motion analysis', extensions: ['tbmotion'] }] },
        win,
      );
      if (picked.canceled || !picked.paths[0]) return { canceled: true };
      filePath = picked.paths[0];
    }
    const result = readMotionProjectFile(filePath);
    if (typeof result.project.media?.path === 'string') rememberMediaPath(result.project.media.path);
    if (Array.isArray(result.project.media?.paths)) {
      for (const p of result.project.media.paths) if (typeof p === 'string') rememberMediaPath(p);
    }
    return { canceled: false, path: filePath, ...result };
  },
  'motion.exportReport': async (payload: any, win) => {
    const html = String(payload?.html ?? '');
    if (!html.trim()) throw new Error('The analysis report is empty');
    const title = String(payload?.title ?? 'Motion analysis report');
    const picked = await handlePickSave(
      {
        title: 'Save motion analysis report',
        defaultName: `${safeFileName(title).replace(/\.pdf$/i, '') || 'motion-report'}.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      },
      win,
    );
    if (picked.canceled || !picked.path) return { canceled: true };
    const generated = await writeMotionPdf(html, title);
    fs.copyFileSync(generated.pdfPath, picked.path);
    return { canceled: false, path: picked.path, ...generated };
  },

  'files.saveImage': async (payload: any, win) => {
    const dataUrl = String(payload?.dataUrl ?? '');
    const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error('No PNG image data was provided');
    const picked = await handlePickSave(
      {
        title: String(payload?.title ?? 'Export image as PNG'),
        defaultName: `${safeFileName(payload?.defaultName ?? 'image').replace(/\.png$/i, '') || 'image'}.png`,
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      },
      win,
    );
    if (picked.canceled || !picked.path) return { canceled: true };
    fs.writeFileSync(picked.path, Buffer.from(match[1], 'base64'));
    return { canceled: false, path: picked.path };
  },

  'configs.importFile': (payload: any) => {
    const filePath = assertAuthorisedPath(payload?.filePath);
    const project = getRecord('project', payload?.projectId);
    if (!project) throw new Error('Project not found');
    const stat = fs.statSync(filePath);
    if (stat.size > 32 * 1024 * 1024) throw new Error('Configuration files above 32 MB should be attached as a document instead');
    const target = uniquePath(documentsDir(), path.basename(filePath));
    fs.copyFileSync(filePath, target);
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    return createRecord('config_snapshot', {
      project_id: payload.projectId,
      kind: payload.kind || 'Firmware',
      name: payload.name || path.basename(filePath),
      version: payload.version || '',
      description: payload.description || `Imported from ${path.basename(filePath)}`,
      content_json: {},
      file_path: target,
      checksum,
    });
  },

  'documents.upload': (payload: any) => uploadDocuments(payload),
  'documents.preview': (payload: any) => readDocumentPreview(payload?.id),
  'documents.remove': (payload: any) => {
    const doc = getRecord('document', payload?.id);
    if (!doc) throw new Error('Document not found');
    const result = removeRecord('document', payload.id);
    if (payload?.deleteFile && doc.stored_path && isInside(documentsDir(), doc.stored_path)) {
      try {
        fs.rmSync(doc.stored_path, { force: true });
      } catch (err) {
        console.error('Could not delete stored document file', err);
      }
    }
    return result;
  },

  'import.preview': (payload: any) => {
    const filePath = assertAuthorisedPath(payload?.filePath);
    return previewImport(filePath, payload?.sheetIndex ?? 0, payload?.headerRow);
  },
  'import.commit': async (payload: any, win, event) => {
    const spec = { ...payload?.spec };
    spec.filePath = assertAuthorisedPath(spec.filePath);
    if (!spec.projectId) throw new Error('Select a project');
    return commitImport(spec, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('rocketlab:import-progress', progress);
    });
  },
  'import.templates': () => list('import_template', { orderBy: 'created_at', order: 'desc' }),
  'import.templateSave': (payload: any) => createRecord('import_template', { name: payload?.name, spec_json: payload?.spec }),
  'import.templateRemove': (payload: any) => removeRecord('import_template', payload?.id),

  'datasets.detail': (payload: any) => datasetDetail(payload?.datasetId),
  'datasets.list': (payload: any) =>
    list('dataset', {
      where: { project_id: payload?.projectId, test_id: payload?.testId, flight_id: payload?.flightId, run_id: payload?.runId },
      q: payload?.q,
      limit: payload?.limit ?? 500,
      orderBy: 'created_at',
      order: 'desc',
    }),
  'datasets.series': (payload: any) => seriesBundle(payload ?? {}),
  'datasets.values': (payload: any) => channelValues(payload?.datasetId, payload?.channelId, payload?.offset ?? 0, payload?.count ?? 200),
  'datasets.stats': (payload: any) => datasetStatistics(payload?.datasetId, payload?.channelId, payload?.t0, payload?.t1),
  'datasets.derive': (payload: any) => deriveDataset(payload ?? {}),
  'datasets.remove': (payload: any) => deleteDataset(payload?.datasetId),
  'datasets.exportCsv': async (payload: any, win) => {
    const picked = await handlePickSave(
      { title: 'Export dataset as CSV', defaultName: `${safeFileName(payload?.name ?? 'dataset')}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] },
      win,
    );
    if (picked.canceled || !picked.path) return { canceled: true };
    exportDatasetCsv(payload?.datasetId, picked.path);
    return { canceled: false, path: picked.path };
  },
  'datasets.exportOriginal': async (payload: any) => {
    const detail = datasetDetail(payload?.datasetId);
    if (!detail.original_file || !fs.existsSync(detail.original_file)) throw new Error('The original recording is not available on disk');
    shell.showItemInFolder(detail.original_file);
    return { ok: true };
  },

  'events.list': (payload: any) => listEvents(payload?.datasetIds ?? []),
  'events.create': (payload: any) => createEvent(payload ?? {}),
  'events.update': (payload: any) => updateEvent(payload?.id, payload?.data ?? {}),
  'events.remove': (payload: any) => removeEvent(payload?.id),
  'events.suggest': (payload: any) => suggestEvents(payload?.datasetId),
  'events.confirm': (payload: any) => confirmEvents(payload?.events ?? []),

  'comparisons.candidates': (payload: any) => comparisonCandidates(payload?.projectId || undefined),
  'comparisons.run': (payload: any) => compareDatasets(payload ?? {}),
  'comparisons.save': (payload: any) => createRecord('comparison', payload ?? {}),
  'comparisons.list': (payload: any) => list('comparison', { where: { project_id: payload?.projectId }, limit: 200 }),
  'comparisons.remove': (payload: any) => removeRecord('comparison', payload?.id),

  'graphs.list': (payload: any) => list('graph', { where: { project_id: payload?.projectId }, limit: 300 }),
  'graphs.save': (payload: any) => createRecord('graph', payload ?? {}),
  'workspaces.list': (payload: any) => list('workspace', { where: { project_id: payload?.projectId }, limit: 200 }),
  'workspaces.save': (payload: any) => createRecord('workspace', payload ?? {}),

  'reports.kinds': () => REPORT_KINDS,
  'reports.generate': (payload: any) => generateReport(payload ?? {}),
  'reports.previewHtml': (payload: any) => {
    const { html, title } = buildReportHtml(payload ?? {});
    return { html, title };
  },
  'reports.list': (payload: any) => list('report', { where: { project_id: payload?.projectId }, limit: 300 }),
  'reports.open': async (payload: any) => {
    const report = getRecord('report', payload?.id);
    if (!report) throw new Error('Report not found');
    const target = payload?.format === 'html' ? report.html_path : report.pdf_path;
    if (!target || !fs.existsSync(target)) throw new Error('The report file is missing; regenerate the report');
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return { ok: true };
  },
  'reports.reveal': (payload: any) => {
    const report = getRecord('report', payload?.id);
    if (!report) throw new Error('Report not found');
    const target = report.pdf_path || report.html_path;
    if (target && fs.existsSync(target)) shell.showItemInFolder(target);
    return { ok: true };
  },
  'reports.exportPdf': async (payload: any, win) => {
    const report = getRecord('report', payload?.id);
    if (!report?.pdf_path || !fs.existsSync(report.pdf_path)) throw new Error('Generate the report first');
    const picked = await handlePickSave(
      { title: 'Save report PDF', defaultName: `${safeFileName(report.title)}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] },
      win,
    );
    if (picked.canceled || !picked.path) return { canceled: true };
    fs.copyFileSync(report.pdf_path, picked.path);
    return { canceled: false, path: picked.path };
  },

  'backup.create': async (payload: any) => createBackup(payload?.label ?? '', payload?.kind ?? 'manual'),
  'backup.list': () => listBackups(),
  'backup.restore': async (payload: any) => {
    const file = assertAuthorisedPath(payload?.file);
    return restoreBackup(file);
  },
  'backup.remove': (payload: any) => removeBackup(payload?.file),
  'backup.inspect': (payload: any) => inspectBackup(assertAuthorisedPath(payload?.file)),
  'backup.pickAndRestore': async (payload: any, win) => {
    const picked = await handlePickOpen(
      { title: 'Select a Thrustbook backup', filters: [{ name: 'Thrustbook backup', extensions: ['rlbak'] }] },
      win,
    );
    if (picked.canceled || !picked.paths[0]) return { canceled: true };
    return { canceled: false, result: await restoreBackup(picked.paths[0]) };
  },

  'project.export': async (payload: any, win) => {
    const project = getRecord('project', payload?.projectId);
    if (!project) throw new Error('Project not found');
    const picked = await handlePickSave(
      {
        title: 'Export project',
        defaultName: `${safeFileName(project.code || project.name)}.rlproj`,
        filters: [{ name: 'Thrustbook project', extensions: ['rlproj'] }],
      },
      win,
    );
    if (picked.canceled || !picked.path) return { canceled: true };
    const result = await exportProject(payload.projectId, picked.path);
    return { canceled: false, ...result };
  },
  'project.import': async (payload: any, win) => {
    if (payload?.file) {
      const result = await importProject(assertAuthorisedPath(payload.file), { rename: payload.rename });
      return result;
    }
    const picked = await handlePickOpen(
      { title: 'Import project archive', filters: [{ name: 'Thrustbook project', extensions: ['rlproj'] }] },
      win,
    );
    if (picked.canceled || !picked.paths[0]) return { canceled: true };
    return { canceled: false, result: await importProject(picked.paths[0]) };
  },
  'project.exportCsv': async (payload: any, win) => {
    const picked = await handlePickSave(
      { title: 'Export records as CSV', defaultName: `${payload?.table ?? 'records'}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] },
      win,
    );
    if (picked.canceled || !picked.path) return { canceled: true };
    return { canceled: false, path: exportTableCsv(payload?.table, picked.path) };
  },

  'storage.info': () => storageInfo(),
  'storage.integrity': () => integrityCheck(),
  'storage.move': (payload: any, win) => {
    if (workspaceMode() === 'examples') {
      throw new Error('The example workspace cannot be relocated. Return to your own data first.');
    }
    return handlePickDirectory({ title: 'Choose the new data folder' }, win).then(async (picked) => {
      if (picked.canceled || !picked.path) return { canceled: true };
      return { canceled: false, ...(await moveStorage(picked.path)) };
    });
  },

  'updates.status': () => updateStatus(),
  'updates.check': () => checkForUpdates(),
  'updates.download': () => downloadUpdate(),
  'updates.install': () => installUpdate(),
  'updates.openReleasePage': () => {
    openReleasePage();
    return { ok: true };
  },
};

export function registerIpc(): void {
  ipcMain.handle('rocketlab:invoke', async (event, method: string, payload: any) => {
    const handler = handlers[method];
    if (!handler) return { ok: false, error: `Unknown application request: ${method}` };
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const data = await handler(payload ?? {}, win, event);
      return { ok: true, data };
    } catch (err: any) {
      console.error(`IPC ${method} failed:`, err);
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
}

export function availableMethods(): string[] {
  return Object.keys(handlers);
}

export { newId };
