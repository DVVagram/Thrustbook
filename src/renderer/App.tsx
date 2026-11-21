import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, onMenuAction } from './api';
import { useApp } from './state';
import { Badge, Button, Icon, Modal, SearchInput, Select } from './ui';
import { fmtDate, relativeTime } from './format';
import { NAV_ITEMS } from '../shared/constants';

import Dashboard from './pages/Dashboard';
import ProjectsPage from './pages/Projects';
import ProjectOverviewPage from './pages/ProjectOverview';
import DevelopmentPage from './pages/Development';
import GroundPage from './pages/Ground';
import FlightsPage from './pages/Flights';
import ExperimentsPage from './pages/Experiments';
import DataLogPage from './pages/DataLog';
import AnalysisPage from './pages/Analysis';
import ComparePage from './pages/Compare';
import ComponentsPage from './pages/Components';
import SensorsPage from './pages/Sensors';
import RevisionsPage from './pages/Revisions';
import RevisionDetailPage from './pages/RevisionDetail';
import DocumentsPage from './pages/Documents';
import IssuesPage from './pages/Issues';
import ReportsPage from './pages/Reports';
import SettingsPage from './pages/Settings';
import TemplatesPage from './pages/Templates';

const PAGE_ROUTES: Record<string, { nav: string; render: () => React.ReactNode }> = {
  dashboard: { nav: 'dashboard', render: () => <Dashboard /> },
  projects: { nav: 'projects', render: () => <ProjectsPage /> },
  project: { nav: 'projects', render: () => <ProjectOverviewPage /> },
  development: { nav: 'development', render: () => <DevelopmentPage /> },
  ground: { nav: 'ground', render: () => <GroundPage /> },
  flights: { nav: 'flights', render: () => <FlightsPage /> },
  experiments: { nav: 'experiments', render: () => <ExperimentsPage /> },
  datalog: { nav: 'datalog', render: () => <DataLogPage /> },
  analysis: { nav: 'analysis', render: () => <AnalysisPage /> },
  compare: { nav: 'compare', render: () => <ComparePage /> },
  components: { nav: 'components', render: () => <ComponentsPage /> },
  sensors: { nav: 'sensors', render: () => <SensorsPage /> },
  revisions: { nav: 'revisions', render: () => <RevisionsPage /> },
  revision: { nav: 'revisions', render: () => <RevisionDetailPage /> },
  documents: { nav: 'documents', render: () => <DocumentsPage /> },
  issues: { nav: 'issues', render: () => <IssuesPage /> },
  reports: { nav: 'reports', render: () => <ReportsPage /> },
  templates: { nav: 'templates', render: () => <TemplatesPage /> },
  settings: { nav: 'settings', render: () => <SettingsPage /> },
};

const NAV_PATHS: Record<string, string> = {
  dashboard: '#/dashboard',
  projects: '#/projects',
  development: '#/development',
  components: '#/components',
  sensors: '#/sensors',
  revisions: '#/revisions',
  ground: '#/ground',
  flights: '#/flights',
  experiments: '#/experiments',
  datalog: '#/datalog',
  analysis: '#/analysis',
  compare: '#/compare',
  documents: '#/documents',
  issues: '#/issues',
  reports: '#/reports',
  templates: '#/templates',
  settings: '#/settings',
};

function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { navigate, projectId, project } = useApp();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [allProjects, setAllProjects] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTerm('');
      setResults([]);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!term.trim()) {
      setResults([]);
      return;
    }
    const handle = setTimeout(() => {
      setLoading(true);
      api
        .search(term, allProjects ? undefined : projectId)
        .then((rows) => {
          setResults(rows);
          setActive(0);
        })
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(handle);
  }, [term, projectId, allProjects, open]);

  const go = (hit: any) => {
    navigate(hit.route);
    onClose();
  };

  return (
    <Modal title="Search engineering records" onClose={onClose} size="lg">
      <div className="stack">
        <div className="search-row">
          <SearchInput value={term} onChange={setTerm} placeholder="Projects, tests, flights, datasets, channels, documents, issues…" inputRef={inputRef} />
          <label className="checkbox">
            <input type="checkbox" checked={allProjects} onChange={(e) => setAllProjects(e.target.checked)} />
            <span>All projects</span>
          </label>
        </div>
        {!term.trim() && (
          <div className="muted small">
            Search across every record type. Results link directly to the record. Currently scoped to {allProjects ? 'all projects' : project?.name ?? 'this project'}.
          </div>
        )}
        {loading && <div className="loading">Searching…</div>}
        {!loading && term.trim() && results.length === 0 && <div className="muted">No records match “{term}”.</div>}
        {results.length > 0 && (
          <div
            className="search-results"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              }
              if (e.key === 'Enter' && results[active]) go(results[active]);
            }}
          >
            {results.slice(0, 60).map((hit, i) => (
              <button
                key={`${hit.type}-${hit.id}`}
                className={`search-hit ${i === active ? 'active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(hit)}
              >
                <span className="search-type">{hit.type}</span>
                <span className="search-title">{hit.title}</span>
                <span className="search-sub">{hit.subtitle}</span>
                <span className="search-project">{hit.project_name}</span>
                <span className="search-date">{hit.at ? fmtDate(hit.at) : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function App() {
  const { ready, error, projects, projectId, setProject, project, route, navigate, theme, toggleTheme, settings, notify, updateState, info, confirm, setBusy } = useApp();
  const [searchOpen, setSearchOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);

  const switchWorkspace = async () => {
    const target = info?.examplesWorkspace ? 'user' : 'examples';
    const ok = await confirm({
      title: target === 'examples' ? 'Open the example workspace?' : 'Return to your own data?',
      message:
        target === 'examples'
          ? 'The application restarts into a separate workspace containing the bundled example programme.'
          : 'The application restarts and reopens your own projects and recordings.',
      details:
        target === 'examples'
          ? 'Example projects use their own database and file folders. They are never mixed with your data, excluded from your backups, and can be reset or deleted at any time.'
          : 'Nothing in the example workspace is copied into your projects.',
      confirmLabel: target === 'examples' ? 'Open examples' : 'Return to my data',
    });
    if (!ok) return;
    try {
      setBusy('Switching workspace…');
      await api.switchWorkspace(target);
    } catch (err: any) {
      setBusy(null);
      notify(err.message, 'error');
    }
  };

  const handleAction = async (action: string) => {
    switch (action) {
      case 'new-project':
        navigate('#/projects?new=1');
        break;
      case 'import-dataset':
        navigate('#/analysis?import=1');
        break;
      case 'new-test':
        navigate('#/ground?new=1');
        break;
      case 'new-flight':
        navigate('#/flights?new=1');
        break;
      case 'backup-now':
        try {
          const backup = await api.createBackup('menu', 'manual');
          notify(`Backup created: ${backup.name}`, 'success');
        } catch (err: any) {
          notify(err.message, 'error');
        }
        break;
      case 'export-project':
        if (!projectId) {
          notify('Select a project first', 'warn');
          break;
        }
        try {
          const result = await api.exportProject(projectId);
          if (!result.canceled) notify(`Project exported (${result.counts?.datasets ?? 0} datasets)`, 'success');
        } catch (err: any) {
          notify(err.message, 'error');
        }
        break;
      case 'toggle-theme':
        toggleTheme();
        break;
      case 'focus-search':
        setSearchOpen(true);
        break;
      case 'go-dashboard':
        navigate('#/dashboard');
        break;
      case 'go-projects':
        navigate('#/projects');
        break;
      case 'go-datalog':
        navigate('#/datalog');
        break;
      case 'go-analysis':
        navigate('#/analysis');
        break;
      case 'go-compare':
        navigate('#/compare');
        break;
      case 'release-notes':
      case 'about':
        navigate('#/settings?tab=updates');
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    const off = onMenuAction((action) => void handleAction(action));
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, project?.name]);

  const currentNav = PAGE_ROUTES[route.page]?.nav ?? 'dashboard';
  const grouped = useMemo(() => {
    const groups: { name: string; items: typeof NAV_ITEMS }[] = [];
    for (const item of NAV_ITEMS) {
      let group = groups.find((g) => g.name === item.group);
      if (!group) {
        group = { name: item.group, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    return groups;
  }, []);

  if (error) {
    return (
      <div className="fatal">
        <Icon name="warning" size={26} />
        <h1>The application could not start</h1>
        <p>{error}</p>
        <p className="muted">Data folder: {info?.dataDir ?? 'unavailable'}</p>
        <Button onClick={() => window.location.reload()} icon="refresh">
          Retry
        </Button>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="splash">
        <div className="splash-brand">ROCKET LAB</div>
        <div className="spinner" />
        <div className="muted small">Opening engineering database…</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 2c3 2 5 6 5 10l-3 3H10l-3-3c0-4 2-8 5-10z" />
              <path d="M9 15l-3 5 4-2M15 15l3 5-4-2" />
            </svg>
          </div>
          <div>
            <div className="brand-name">ROCKET LAB</div>
            <div className="brand-sub">Development & Test Platform</div>
          </div>
        </div>

        <div className="project-switcher">
          <span className="project-switcher-label">Current project</span>
          <Select
            value={projectId}
            onChange={(id) => {
              setProject(id);
              navigate('#/dashboard');
            }}
            placeholder={projects.length ? 'Select project' : 'No projects'}
            options={projects.map((p) => ({ value: p.id, label: `${p.code ? `${p.code} · ` : ''}${p.name}` }))}
          />
          {project && (
            <button className="project-link" onClick={() => navigate(`#/project/${project.id}`)}>
              <Badge>{project.status}</Badge>
              <span className="muted small">{project.stage || 'No stage set'}</span>
            </button>
          )}
        </div>

        <nav className="nav">
          {grouped.map((group) => (
            <div className="nav-group" key={group.name}>
              <div className="nav-group-label">{group.name}</div>
              {group.items.map((item) => (
                <button
                  key={item.key}
                  className={`nav-item ${currentNav === item.key ? 'active' : ''}`}
                  onClick={() => navigate(NAV_PATHS[item.key] ?? '#/dashboard')}
                  title={item.label}
                >
                  <Icon name={item.icon} size={15} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className={`workspace-switch ${info?.examplesWorkspace ? 'examples' : ''}`} onClick={switchWorkspace} title="Switch workspace">
            <Icon name={info?.examplesWorkspace ? 'folder' : 'flask'} size={14} />
            <span>{info?.examplesWorkspace ? 'Return to my data' : 'Open example data'}</span>
          </button>
          <div className="version-line">
            v{info?.version} · local
            {updateState?.state === 'available' && (
              <button className="link-btn tiny" onClick={() => navigate('#/settings?tab=updates')}>
                update available
              </button>
            )}
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="topbar-btn" onClick={() => setSearchOpen(true)} title="Search (Ctrl+K)">
              <Icon name="search" size={15} />
              <span>Search</span>
              <kbd>Ctrl K</kbd>
            </button>
          </div>
          <div className="topbar-right">
            {project && <span className="topbar-project">{project.name}</span>}
            <button className="topbar-btn icon-only" onClick={toggleTheme} title="Toggle theme">
              <Icon name={theme === 'dark' ? 'sensor' : 'grid'} size={15} />
            </button>
            <button className="topbar-btn" onClick={() => setUserMenu((v) => !v)} title="Quick actions">
              <Icon name="plus" size={15} />
              <span>New</span>
            </button>
            {userMenu && (
              <>
                <div className="menu-backdrop" onClick={() => setUserMenu(false)} />
                <div className="dropdown">
                  {[
                    ['New project', '#/projects?new=1'],
                    ['New ground test', '#/ground?new=1'],
                    ['New flight', '#/flights?new=1'],
                    ['New experiment', '#/experiments?new=1'],
                    ['New issue', '#/issues?new=1'],
                    ['Import dataset', '#/analysis?import=1'],
                    ['Create backup', 'backup'],
                  ].map(([label, target]) => (
                    <button
                      key={label}
                      className="dropdown-item"
                      onClick={() => {
                        setUserMenu(false);
                        if (target === 'backup') void handleAction('backup-now');
                        else navigate(target);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </header>

        {info?.examplesWorkspace && (
          <div className="workspace-banner">
            <Icon name="flask" size={15} />
            <div>
              <strong>Example workspace</strong> — this is the bundled demonstration programme in its own database and folders. Nothing here affects your own
              projects, searches, backups or exports.
            </div>
            <Button size="sm" icon="folder" onClick={switchWorkspace}>
              Return to my data
            </Button>
          </div>
        )}

        <main className="content">{PAGE_ROUTES[route.page]?.render() ?? <Dashboard />}</main>

        <footer className="statusbar">
          <span className="status-item">
            <span className="dot ok" /> Local data · offline-first
          </span>
          <span className="status-item">
            <Icon name="folder" size={11} /> {info?.dataDir}
          </span>
          <span className="status-spacer" />
          <span className="status-item">{settings.density === 'comfortable' ? 'Comfortable' : 'Compact'} density</span>
          <span className="status-item">Schema v{info?.schemaVersion ?? '—'}</span>
          <span className="status-item">{info?.platform} · {info?.arch}</span>
          <span className="status-item">v{info?.version}</span>
        </footer>
      </div>

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
