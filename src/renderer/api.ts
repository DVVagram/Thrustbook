export interface InvokeResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

const bridge = (window as any).rocketlab;

export async function call<T = any>(method: string, payload: any = {}): Promise<T> {
  if (!bridge?.invoke) throw new Error('The desktop bridge is unavailable. Run the application through Electron.');
  const result: InvokeResult<T> = await bridge.invoke(method, payload);
  if (!result.ok) throw new Error(result.error ?? 'Application request failed');
  return result.data as T;
}

export const api = {
  info: () => call('app.info'),
  workspaceInfo: () => call<any>('workspace.info'),
  switchWorkspace: (mode: 'user' | 'examples') => call<any>('workspace.switch', { mode }),
  resetExamples: () => call<any>('workspace.resetExamples'),
  deleteExamples: () => call<any>('workspace.deleteExamples'),
  settingsAll: () => call<Record<string, string>>('settings.all'),
  setSetting: (key: string, value: string) => call('settings.set', { key, value }),

  list: (entity: string, opts: any = {}) => call<any[]>('records.list', { entity, ...opts }),
  get: (entity: string, id: string) => call<any>('records.get', { entity, id }),
  create: (entity: string, data: any) => call<any>('records.create', { entity, data }),
  update: (entity: string, id: string, data: any) => call<any>('records.update', { entity, id, data }),
  remove: (entity: string, id: string) => call('records.remove', { entity, id }),
  count: (entity: string, where: any = {}) => call<number>('records.count', { entity, where }),
  linked: (entityType: string, entityId: string) => call<any>('records.linked', { entityType, entityId }),

  dashboard: () => call<any>('dashboard.get'),
  overview: (projectId: string) => call<any>('project.overview', { projectId }),
  bootstrap: (payload: any) => call<any>('project.bootstrap', payload),
  search: (term: string, projectId?: string) => call<any[]>('search.global', { term, projectId }),

  dataLog: (filter: any) => call<any>('datalog.query', filter),
  measurements: (projectId?: string, q?: string) => call<any[]>('measurements.history', { projectId, q }),
  revisionCompare: (aId: string, bId: string) => call<any>('revisions.compare', { aId, bId }),
  configCompare: (aId: string, bId: string) => call<any>('configs.compare', { aId, bId }),
  componentHistory: (componentId: string) => call<any>('components.history', { componentId }),
  sensorHistory: (sensorId: string) => call<any>('sensors.history', { sensorId }),

  pickOpen: (payload: any = {}) => call<any>('files.pickOpen', payload),
  pickDirectory: (payload: any = {}) => call<any>('files.pickDirectory', payload),
  pickSave: (payload: any = {}) => call<any>('files.pickSave', payload),
  reveal: (path: string) => call('files.reveal', { path }),
  openPath: (path: string) => call('files.openPath', { path }),
  openExternal: (url: string) => call('files.openExternal', { url }),
  saveImage: (dataUrl: string, defaultName: string) => call<any>('files.saveImage', { dataUrl, defaultName }),

  uploadDocuments: (payload: any) => call<any[]>('documents.upload', payload),
  importConfigFile: (payload: any) => call<any>('configs.importFile', payload),
  documentPreview: (id: string) => call<any>('documents.preview', { id }),
  removeDocument: (id: string, deleteFile = false) => call('documents.remove', { id, deleteFile }),

  previewImport: (filePath: string, sheetIndex = 0, headerRow?: number) => call<any>('import.preview', { filePath, sheetIndex, headerRow }),
  commitImport: (spec: any) => call<any>('import.commit', { spec }),
  importTemplates: () => call<any[]>('import.templates'),
  saveImportTemplate: (name: string, spec: any) => call('import.templateSave', { name, spec }),
  removeImportTemplate: (id: string) => call('import.templateRemove', { id }),

  datasetDetail: (datasetId: string) => call<any>('datasets.detail', { datasetId }),
  datasets: (opts: any) => call<any[]>('datasets.list', opts),
  series: (payload: any) => call<any>('datasets.series', payload),
  values: (datasetId: string, channelId: string, offset: number, count: number) =>
    call<any>('datasets.values', { datasetId, channelId, offset, count }),
  stats: (datasetId: string, channelId: string, t0?: number | null, t1?: number | null) =>
    call<any>('datasets.stats', { datasetId, channelId, t0, t1 }),
  derive: (payload: any) => call<any>('datasets.derive', payload),
  removeDataset: (datasetId: string) => call('datasets.remove', { datasetId }),
  exportDatasetCsv: (datasetId: string, name: string) => call<any>('datasets.exportCsv', { datasetId, name }),
  revealOriginal: (datasetId: string) => call('datasets.exportOriginal', { datasetId }),

  events: (datasetIds: string[]) => call<any[]>('events.list', { datasetIds }),
  createEvent: (data: any) => call<any>('events.create', data),
  updateEvent: (id: string, data: any) => call('events.update', { id, data }),
  removeEvent: (id: string) => call('events.remove', { id }),
  suggestEvents: (datasetId: string) => call<any[]>('events.suggest', { datasetId }),
  confirmEvents: (events: any[]) => call<any[]>('events.confirm', { events }),

  comparisonCandidates: (projectId?: string) => call<any[]>('comparisons.candidates', { projectId }),
  runComparison: (spec: any) => call<any>('comparisons.run', spec),
  saveComparison: (payload: any) => call('comparisons.save', payload),
  comparisons: (projectId: string) => call<any[]>('comparisons.list', { projectId }),
  removeComparison: (id: string) => call('comparisons.remove', { id }),

  graphs: (projectId: string) => call<any[]>('graphs.list', { projectId }),
  saveGraph: (payload: any) => call('graphs.save', payload),
  workspaces: (projectId: string) => call<any[]>('workspaces.list', { projectId }),
  saveWorkspace: (payload: any) => call('workspaces.save', payload),

  reportKinds: () => call<any[]>('reports.kinds'),
  generateReport: (spec: any) => call<any>('reports.generate', spec),
  reportPreview: (spec: any) => call<any>('reports.previewHtml', spec),
  reports: (projectId: string) => call<any[]>('reports.list', { projectId }),
  openReport: (id: string, format: 'pdf' | 'html') => call('reports.open', { id, format }),
  revealReport: (id: string) => call('reports.reveal', { id }),
  exportReportPdf: (id: string) => call<any>('reports.exportPdf', { id }),

  createBackup: (label = '', kind = 'manual') => call<any>('backup.create', { label, kind }),
  backups: () => call<any[]>('backup.list'),
  restoreBackup: (file: string) => call<any>('backup.restore', { file }),
  pickAndRestore: () => call<any>('backup.pickAndRestore'),
  removeBackup: (file: string) => call('backup.remove', { file }),
  inspectBackup: (file: string) => call<any>('backup.inspect', { file }),

  exportProject: (projectId: string) => call<any>('project.export', { projectId }),
  importProject: () => call<any>('project.import'),
  exportTableCsv: (table: string) => call<any>('project.exportCsv', { table }),

  storage: () => call<any>('storage.info'),
  integrity: () => call<any>('storage.integrity'),
  moveStorage: () => call<any>('storage.move'),

  keyframeSets: (projectId: string) => call<any[]>('keyframes.list', { projectId }),
  keyframeSet: (id: string) => call<any>('keyframes.get', { id }),
  saveKeyframeSet: (payload: any) => call<any>('keyframes.save', payload),
  removeKeyframeSet: (id: string) => call('keyframes.remove', { id }),
  keyframeMediaUrl: (path: string) => call<any>('keyframes.mediaUrl', { path }),
  relinkKeyframeMedia: () => call<any>('keyframes.relink'),

  updateStatus: () => call<any>('updates.status'),
  checkUpdates: () => call<any>('updates.check'),
  downloadUpdate: () => call<any>('updates.download'),
  installUpdate: () => call<any>('updates.install'),
  openReleasePage: () => call('updates.openReleasePage'),
};

export function onUpdateEvent(cb: (payload: any) => void): () => void {
  return bridge?.onUpdateEvent?.(cb) ?? (() => undefined);
}
export function onMenuAction(cb: (action: string) => void): () => void {
  return bridge?.onMenuAction?.(cb) ?? (() => undefined);
}
export function onImportProgress(cb: (payload: any) => void): () => void {
  return bridge?.onImportProgress?.(cb) ?? (() => undefined);
}
