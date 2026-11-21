import { contextBridge, ipcRenderer } from 'electron';

/**
 * Restricted preload API: the renderer can only call whitelisted main-process
 * handlers through a single validated channel. No Node.js or filesystem access
 * is exposed to UI code.
 */
const api = {
  invoke: (method: string, payload?: any): Promise<{ ok: boolean; data?: any; error?: string }> =>
    ipcRenderer.invoke('rocketlab:invoke', String(method), payload ?? {}),

  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  onUpdateEvent: (callback: (payload: any) => void) => {
    const listener = (_event: unknown, payload: any) => callback(payload);
    ipcRenderer.on('rocketlab:update-event', listener);
    return () => ipcRenderer.removeListener('rocketlab:update-event', listener);
  },

  onMenuAction: (callback: (action: string) => void) => {
    const listener = (_event: unknown, action: string) => callback(action);
    ipcRenderer.on('rocketlab:menu-action', listener);
    return () => ipcRenderer.removeListener('rocketlab:menu-action', listener);
  },

  onImportProgress: (callback: (payload: any) => void) => {
    const listener = (_event: unknown, payload: any) => callback(payload);
    ipcRenderer.on('rocketlab:import-progress', listener);
    return () => ipcRenderer.removeListener('rocketlab:import-progress', listener);
  },
};

contextBridge.exposeInMainWorld('rocketlab', api);

export type ThrustbookApi = typeof api;
