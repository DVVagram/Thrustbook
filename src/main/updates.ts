import { app, shell, BrowserWindow } from 'electron';
import { getSetting, setSetting } from './db';
import type { UpdateStatus } from '../shared/types';

/**
 * Update handling.
 *
 * Packaged builds use electron-updater against the configured GitHub release
 * feed. Development builds never attempt to install: they only report status.
 * Installation preserves user data because the database and files live in the
 * user data directory, never in the install directory.
 */

let state: UpdateStatus = {
  currentVersion: '0.0.0',
  platform: process.platform,
  packaged: false,
  feedConfigured: false,
  state: 'idle',
  progress: null,
  message: null,
};

let updater: any = null;
let initialized = false;

function broadcast(payload: any): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('rocketlab:update-event', payload);
  }
}

function feedConfig(): { owner: string; repo: string } | null {
  const configured = (getSetting('updateRepo') || '').trim();
  if (configured) {
    const [owner, repo] = configured.split('/').map((s) => s.trim());
    if (owner && repo) return { owner, repo };
  }
  try {
    const pkg = require('../../package.json');
    const publish = (pkg.build && pkg.build.publish) || pkg.publish;
    if (publish && publish.owner && publish.repo && !String(publish.owner).startsWith('YOUR-')) {
      return { owner: publish.owner, repo: publish.repo };
    }
  } catch {
    /* no package metadata */
  }
  return null;
}

function getUpdater(): any {
  if (initialized) return updater;
  initialized = true;
  try {
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    const feed = feedConfig();
    if (feed) {
      updater.setFeedURL({ provider: 'github', owner: feed.owner, repo: feed.repo });
    }
    updater.on('checking-for-update', () => {
      state = { ...state, state: 'checking', message: 'Checking the release feed…' };
      broadcast(state);
    });
    updater.on('update-available', (info: any) => {
      state = {
        ...state,
        state: 'available',
        latestVersion: info?.version ?? null,
        releaseDate: info?.releaseDate ?? null,
        releaseNotes: normalizeNotes(info?.releaseNotes),
        available: true,
        message: `Version ${info?.version} is available.`,
      };
      broadcast(state);
    });
    updater.on('update-not-available', (info: any) => {
      state = {
        ...state,
        state: 'not-available',
        latestVersion: info?.version ?? state.currentVersion,
        available: false,
        message: 'This is the latest release.',
      };
      broadcast(state);
    });
    updater.on('download-progress', (progress: any) => {
      state = {
        ...state,
        state: 'downloading',
        progress: typeof progress?.percent === 'number' ? progress.percent : null,
        message: `Downloading update… ${progress?.percent ? progress.percent.toFixed(1) : '0'}%`,
      };
      broadcast(state);
    });
    updater.on('update-downloaded', (info: any) => {
      state = {
        ...state,
        state: 'downloaded',
        progress: 100,
        latestVersion: info?.version ?? state.latestVersion,
        message: 'Update downloaded and ready to install. Your projects and datasets will be preserved.',
      };
      broadcast(state);
    });
    updater.on('error', (err: any) => {
      state = { ...state, state: 'error', message: err?.message ?? 'Update error' };
      broadcast(state);
    });
  } catch (err: any) {
    updater = null;
    state = { ...state, state: 'error', message: `Updater unavailable: ${err?.message ?? err}` };
  }
  return updater;
}

function normalizeNotes(notes: any): string {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((n) => {
        if (typeof n === 'string') return n;
        const version = n.version ? `## ${n.version}\n` : '';
        return `${version}${n.note ?? ''}`;
      })
      .join('\n\n');
  }
  return String(notes);
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((x) => Number(x.replace(/[^0-9].*$/, '')) || 0);
  const pb = b.replace(/^v/, '').split('.').map((x) => Number(x.replace(/[^0-9].*$/, '')) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function updateStatus(): UpdateStatus {
  const feed = feedConfig();
  const packaged = app.isPackaged;
  state = {
    ...state,
    currentVersion: app.getVersion(),
    packaged,
    platform: process.platform,
    feedConfigured: !!feed,
  };
  return state;
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  const feed = feedConfig();
  state = { ...updateStatus(), state: 'checking', message: 'Checking for updates…', progress: null };
  broadcast(state);

  if (!app.isPackaged) {
    state = {
      ...state,
      state: 'unsupported',
      message: 'This is a development build. Update installation is available in packaged releases.',
      feedConfigured: !!feed,
    };
    broadcast(state);
    return state;
  }

  if (!feed) {
    state = {
      ...state,
      state: 'error',
      message: 'No release repository is configured. Set owner/repository in Settings → Updates.',
    };
    broadcast(state);
    return state;
  }

  try {
    const up = getUpdater();
    if (!up) throw new Error('Updater could not be initialised');
    const result = await up.checkForUpdates();
    const latest = result?.updateInfo?.version ?? null;
    const notes = normalizeNotes(result?.updateInfo?.releaseNotes);
    if (latest && compareVersions(latest, app.getVersion()) > 0) {
      state = {
        ...state,
        state: 'available',
        latestVersion: latest,
        releaseDate: result?.updateInfo?.releaseDate ?? null,
        releaseNotes: notes,
        releaseUrl: `https://github.com/${feed.owner}/${feed.repo}/releases/tag/v${latest}`,
        available: true,
        message: `Version ${latest} is available.`,
      };
    } else {
      state = {
        ...state,
        state: 'not-available',
        latestVersion: latest ?? app.getVersion(),
        available: false,
        message: 'This is the latest release.',
      };
    }
  } catch (err: any) {
    state = {
      ...state,
      state: 'error',
      message: describeUpdateError(err, feed),
    };
  }
  broadcast(state);
  return state;
}

function describeUpdateError(err: any, feed: { owner: string; repo: string }): string {
  const raw = String(err?.message ?? err);
  if (/404|not found/i.test(raw)) {
    return `The release feed github.com/${feed.owner}/${feed.repo} could not be read. Check that the repository exists and has published releases.`;
  }
  if (/net::|ENOTFOUND|ECONN|EAI_AGAIN/i.test(raw)) {
    return 'The update server could not be reached. Check your internet connection; the application remains fully usable offline.';
  }
  return `Update check failed: ${raw}`;
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (state.state !== 'available') {
    return { ...state, message: 'No update is available to download.' };
  }
  try {
    const up = getUpdater();
    if (!up) throw new Error('Updater unavailable');
    await up.downloadUpdate();
  } catch (err: any) {
    state = { ...state, state: 'error', message: `Download failed: ${err?.message ?? err}` };
    broadcast(state);
  }
  return state;
}

export function installUpdate(): any {
  if (state.state !== 'downloaded') {
    return { ok: false, message: 'No downloaded update is ready to install.' };
  }
  if (process.platform === 'linux') {
    return {
      ok: false,
      message: 'Automatic installation is not supported for this Linux package. Download the new AppImage or .deb from the release page and install it; your project data is stored separately and is preserved.',
    };
  }
  setImmediate(() => {
    try {
      const up = getUpdater();
      up?.quitAndInstall(false, true);
    } catch (err) {
      console.error('Installing update failed', err);
    }
  });
  return { ok: true, message: 'Installing the update and restarting…' };
}

export function openReleasePage(): void {
  const feed = feedConfig();
  if (feed) shell.openExternal(`https://github.com/${feed.owner}/${feed.repo}/releases`);
}

export function openExternalUrl(url: string): void {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}
