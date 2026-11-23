import path from 'node:path';
import { app, BrowserWindow, Menu, shell, session } from 'electron';
import { getSetting, closeDatabase, openDatabase, schemaVersion } from './db';
import { ensureStorage, dataDir, workspaceMode } from './paths';
import { ensureExamplesWorkspace } from './examples';
import { migrateLegacyUserData } from './migrate';
import { registerIpc } from './ipc';
import { createBackup, listBackups } from './archive';
import { installMediaProtocol, registerMediaScheme } from './media';
import { APP_NAME } from '../shared/constants';

registerMediaScheme();

const isDev = !app.isPackaged;
const devUrl = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const saved = readWindowState();
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1560,
    height: saved?.height ?? 980,
    x: saved?.x,
    y: saved?.y,
    minWidth: 1120,
    minHeight: 700,
    backgroundColor: '#11161d',
    show: false,
    title: APP_NAME,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (saved?.maximized) mainWindow?.maximize();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  mainWindow.on('close', () => {
    if (mainWindow) writeWindowState(mainWindow);
  });

  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState(): any {
  try {
    const fs = require('node:fs');
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
}

function writeWindowState(win: BrowserWindow): void {
  try {
    const fs = require('node:fs');
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }, null, 2),
    );
  } catch {
    /* window state is non-critical */
  }
}

function sendMenuAction(action: string): void {
  mainWindow?.webContents.send('rocketlab:menu-action', action);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: APP_NAME,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { label: 'Settings…', accelerator: 'Cmd+,', click: () => sendMenuAction('settings') },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }]
      : []),
    {
      label: '&File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-project') },
        { label: 'Import Dataset…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('import-dataset') },
        { label: 'New Ground Test…', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendMenuAction('new-test') },
        { label: 'New Flight…', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendMenuAction('new-flight') },
        { type: 'separator' },
        { label: 'Back Up Data Now', click: () => sendMenuAction('backup-now') },
        { label: 'Export Current Project…', click: () => sendMenuAction('export-project') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => sendMenuAction('go-dashboard') },
        { label: 'Projects', accelerator: 'CmdOrCtrl+2', click: () => sendMenuAction('go-projects') },
        { label: 'Data Log', accelerator: 'CmdOrCtrl+3', click: () => sendMenuAction('go-datalog') },
        { label: 'Data Analysis', accelerator: 'CmdOrCtrl+4', click: () => sendMenuAction('go-analysis') },
        { label: 'Dataset Comparison', accelerator: 'CmdOrCtrl+5', click: () => sendMenuAction('go-compare') },
        { type: 'separator' },
        { label: 'Toggle Light / Dark Theme', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendMenuAction('toggle-theme') },
        { label: 'Global Search', accelerator: 'CmdOrCtrl+K', click: () => sendMenuAction('focus-search') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools', visible: isDev },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Release Notes', click: () => sendMenuAction('release-notes') },
        { label: 'Data Folder', click: () => shell.openPath(dataDir()) },
        { type: 'separator' },
        {
          label: `About ${APP_NAME}`,
          click: () => {
            mainWindow?.webContents.send('rocketlab:menu-action', 'about');
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function applyContentSecurityPolicy(): void {
  const csp = isDev
    ? "default-src 'self' http://localhost:5273 thrustbook-media:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' http://localhost:5273; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: thrustbook-media:; media-src 'self' blob: thrustbook-media:; font-src 'self' data:; connect-src 'self' http://localhost:5273 ws://localhost:5273 thrustbook-media:"
    : "default-src 'self' thrustbook-media:; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: thrustbook-media:; media-src 'self' blob: thrustbook-media:; font-src 'self' data:; connect-src 'self' thrustbook-media:; object-src 'none'; base-uri 'none'; form-action 'none'";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.thrustbook.desktop');
    migrateLegacyUserData();
    ensureStorage();
    try {
      openDatabase();
      console.log(`Storage: ${dataDir()} · schema v${schemaVersion()} · workspace ${workspaceMode()}`);
      await ensureExamplesWorkspace();
    } catch (err) {
      console.error('Database startup failed', err);
    }
    installMediaProtocol();
    applyContentSecurityPolicy();
    registerIpc();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // A single lightweight automatic backup per day, never blocking startup.
    setTimeout(async () => {
      try {
        if (workspaceMode() === 'examples') return;
        if (getSetting('backupOnStart') !== 'true') return;
        const backups = listBackups().filter((b) => b.kind === 'automatic');
        const newest = backups[0];
        const age = newest ? Date.now() - Date.parse(newest.createdAt) : Infinity;
        if (age > 24 * 60 * 60 * 1000) {
          await createBackup('daily', 'automatic');
          console.log('Automatic daily backup created');
        }
      } catch (err) {
        console.error('Automatic backup failed', err);
      }
    }, 8000);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    closeDatabase();
  });

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception in main process', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection in main process', err);
  });
}
