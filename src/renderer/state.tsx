import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, onUpdateEvent } from './api';
import { setDatePrefs } from './format';

export interface Route {
  page: string;
  id: string | null;
  query: Record<string, string>;
  hash: string;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'warn' | 'error';
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  details?: string;
}

interface AppContextValue {
  info: any;
  settings: Record<string, string>;
  projects: any[];
  projectId: string;
  project: any;
  setProject: (id: string) => void;
  setSetting: (key: string, value: string) => Promise<void>;
  route: Route;
  navigate: (to: string) => void;
  refreshVersion: number;
  refresh: () => void;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  notify: (text: string, tone?: Toast['tone']) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  busy: string | null;
  setBusy: (message: string | null) => void;
  updateState: any;
  ready: boolean;
  error: string | null;
}

const AppContext = createContext<AppContextValue | null>(null);

function parseHash(): Route {
  const raw = window.location.hash || '#/dashboard';
  const [pathPart, queryPart] = raw.replace(/^#/, '').split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query: Record<string, string> = {};
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      const [k, v] = pair.split('=');
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
    }
  }
  return {
    page: segments[0] || 'dashboard',
    id: segments[1] ? decodeURIComponent(segments[1]) : null,
    query,
    hash: raw,
  };
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [info, setInfo] = useState<any>(null);
  const [settings, setSettingsState] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState('');
  const [route, setRoute] = useState<Route>(parseHash());
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<any>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toastSeq = useRef(0);

  const theme = (settings.theme === 'light' ? 'light' : 'dark') as 'dark' | 'light';

  const notify = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-4), { id, text, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), tone === 'error' ? 9000 : 4500);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => setConfirmState({ ...options, resolve }));
  }, []);

  const loadProjects = useCallback(async (preferredId?: string) => {
    const list = await api.list('project', { orderBy: 'updated_at', limit: 500 });
    setProjects(list);
    setProjectId((current) => {
      const wanted = preferredId ?? current ?? '';
      if (wanted && list.some((p) => p.id === wanted)) return wanted;
      return list[0]?.id ?? '';
    });
    return list;
  }, []);

  const boot = useCallback(async () => {
    try {
      const [appInfo, allSettings] = await Promise.all([api.info(), api.settingsAll()]);
      setInfo(appInfo);
      setSettingsState(allSettings);
      setDatePrefs(allSettings.dateFormat, allSettings.timeFormat);
      document.documentElement.dataset.theme = allSettings.theme === 'light' ? 'light' : 'dark';
      const list = await loadProjects(allSettings.lastProjectId || undefined);
      if (list.length > 0 && !window.location.hash) window.location.hash = '#/dashboard';
      setReady(true);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  }, [loadProjects]);

  useEffect(() => {
    void boot();
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    const off = onUpdateEvent((payload) => {
      setUpdateState(payload);
      if (payload?.state === 'downloaded') notify(payload.message ?? 'Update ready to install', 'success');
      if (payload?.state === 'available') notify(payload.message ?? 'Update available', 'info');
    });
    return () => {
      window.removeEventListener('hashchange', onHash);
      off();
    };
  }, [boot, notify]);

  const setSetting = useCallback(async (key: string, value: string) => {
    const next = await api.setSetting(key, value);
    setSettingsState(next);
    setDatePrefs(next.dateFormat, next.timeFormat);
    if (key === 'theme') document.documentElement.dataset.theme = value === 'light' ? 'light' : 'dark';
  }, []);

  const setProject = useCallback(
    (id: string) => {
      setProjectId(id);
      void api.setSetting('lastProjectId', id);
      setSettingsState((prev) => ({ ...prev, lastProjectId: id }));
    },
    [],
  );

  const navigate = useCallback((to: string) => {
    const target = to.startsWith('#') ? to : `#/${to.replace(/^\/+/, '')}`;
    if (window.location.hash === target) {
      setRoute(parseHash());
    } else {
      window.location.hash = target;
    }
  }, []);

  const refresh = useCallback(() => {
    setRefreshVersion((v) => v + 1);
    void loadProjects();
  }, [loadProjects]);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    void setSetting('theme', next);
  }, [theme, setSetting]);

  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId]);

  const value: AppContextValue = {
    info,
    settings,
    projects,
    projectId,
    project,
    setProject,
    setSetting,
    route,
    navigate,
    refreshVersion,
    refresh,
    theme,
    toggleTheme,
    notify,
    confirm,
    busy,
    setBusy,
    updateState,
    ready,
    error,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`} role="status">
            <span>{toast.text}</span>
            <button className="toast-close" onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
      {confirmState && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal modal-sm">
            <div className="modal-head">
              <h2>{confirmState.title}</h2>
            </div>
            <div className="modal-body">
              {confirmState.message && <p>{confirmState.message}</p>}
              {confirmState.details && <pre className="code-block">{confirmState.details}</pre>}
            </div>
            <div className="modal-foot">
              <button
                className="btn"
                onClick={() => {
                  confirmState.resolve(false);
                  setConfirmState(null);
                }}
              >
                Cancel
              </button>
              <button
                className={`btn ${confirmState.danger ? 'btn-danger' : 'btn-primary'}`}
                autoFocus
                onClick={() => {
                  confirmState.resolve(true);
                  setConfirmState(null);
                }}
              >
                {confirmState.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
      {busy && (
        <div className="busy-overlay">
          <div className="busy-box">
            <div className="spinner" />
            <div>{busy}</div>
          </div>
        </div>
      )}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

export function useAsync<T>(loader: () => Promise<T>, deps: any[], initial: T | null = null) {
  const [data, setData] = useState<T | null>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const token = useRef(0);

  useEffect(() => {
    const current = ++token.current;
    setLoading(true);
    loader()
      .then((result) => {
        if (current !== token.current) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (current !== token.current) return;
        setError(err?.message ?? String(err));
      })
      .finally(() => {
        if (current === token.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return {
    data,
    loading,
    error,
    setData,
    reload: () => setNonce((v) => v + 1),
  };
}
