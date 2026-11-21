import React, { useEffect, useState } from 'react';
import { api, onUpdateEvent } from '../api';
import { useApp, useAsync } from '../state';
import { Badge, Button, DataTable, EmptyState, Field, Icon, Input, KeyValue, Modal, PageHeader, Panel, Select, Tabs, Toggle } from '../ui';
import { bytes, fmtDateTime } from '../format';
import { UNITS, unitsForDimension } from '../../shared/units';
import { APP_NAME, APP_TAGLINE } from '../../shared/constants';

const UNIT_SETTINGS: { key: string; label: string; dimension: string }[] = [
  { key: 'lengthUnit', label: 'Length', dimension: 'length' },
  { key: 'velocityUnit', label: 'Velocity', dimension: 'velocity' },
  { key: 'accelerationUnit', label: 'Acceleration', dimension: 'acceleration' },
  { key: 'pressureUnit', label: 'Pressure', dimension: 'pressure' },
  { key: 'temperatureUnit', label: 'Temperature', dimension: 'temperature' },
  { key: 'voltageUnit', label: 'Voltage', dimension: 'voltage' },
  { key: 'currentUnit', label: 'Current', dimension: 'current' },
];

export default function SettingsPage() {
  const { settings, setSetting, info, projectId, projects, setProject, notify, confirm, refresh, route } = useApp();
  const [tab, setTab] = useState(route.query.tab ?? 'general');
  const [storage, setStorage] = useState<any>(null);
  const [backups, setBackups] = useState<any[]>([]);
  const [integrity, setIntegrity] = useState<any>(null);
  const [updates, setUpdates] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [repoDraft, setRepoDraft] = useState(settings.updateRepo ?? '');
  const [newBackupLabel, setNewBackupLabel] = useState('');

  const loadStorage = async () => setStorage(await api.storage());
  const loadBackups = async () => setBackups(await api.backups());

  useEffect(() => {
    if (tab === 'storage' || tab === 'data') void loadStorage();
    if (tab === 'backups' || tab === 'data') void loadBackups();
    if (tab === 'updates') {
      api.updateStatus().then(setUpdates).catch(() => undefined);
    }
    if (tab === 'diagnostics') {
      void loadStorage();
      api.integrity().then(setIntegrity).catch((e) => notify(e.message, 'error'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => onUpdateEvent((payload) => setUpdates(payload)), []);

  const checkUpdates = async () => {
    setChecking(true);
    try {
      setUpdates(await api.checkUpdates());
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setChecking(false);
    }
  };

  const set = (key: string) => async (value: string) => {
    try {
      await setSetting(key, value);
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        subtitle={`${APP_NAME} ${info?.version ?? ''} · application-wide defaults and local data management`}
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'general', label: 'General' },
          { key: 'appearance', label: 'Appearance' },
          { key: 'units', label: 'Units & formats' },
          { key: 'data', label: 'Data & storage' },
          { key: 'backups', label: 'Backups' },
          { key: 'updates', label: 'Updates' },
          { key: 'diagnostics', label: 'Diagnostics' },
          { key: 'about', label: 'About' },
        ]}
      />

      {tab === 'general' && (
        <div className="settings-grid">
          <Panel title="Startup and defaults">
            <div className="stack">
              <Field label="Project opened at startup">
                <Select
                  value={settings.lastProjectId ?? ''}
                  onChange={(v) => {
                    setProject(v);
                    void setSetting('lastProjectId', v);
                  }}
                  placeholder="Most recently used"
                  options={projects.map((p) => ({ value: p.id, label: p.name }))}
                />
              </Field>
              <Field label="Default graph point limit" hint="Maximum points rendered per channel before peak-preserving downsampling">
                <Select
                  value={settings.defaultGraphPoints ?? '4000'}
                  onChange={set('defaultGraphPoints')}
                  options={['1000', '2000', '4000', '8000', '16000', '40000'].map((v) => ({ value: v, label: `${Number(v).toLocaleString()} points` }))}
                />
              </Field>
              <Field label="Default graph type">
                <Select
                  value={settings.defaultChartType ?? 'line'}
                  onChange={set('defaultChartType')}
                  options={[
                    { value: 'line', label: 'Line' },
                    { value: 'timeseries', label: 'Time series' },
                    { value: 'scatter', label: 'Scatter' },
                    { value: 'area', label: 'Area' },
                  ]}
                />
              </Field>
              <Toggle checked={settings.confirmDeletes !== 'false'} onChange={(v) => set('confirmDeletes')(String(v))} label="Confirm destructive actions" />
              <Toggle checked={settings.backupOnStart === 'true'} onChange={(v) => set('backupOnStart')(String(v))} label="Create an automatic daily backup" />
              <Field label="Automatic backup retention" hint="Number of rotating automatic backups kept">
                <Select value={settings.backupRetention ?? '10'} onChange={set('backupRetention')} options={['3', '5', '10', '20', '50'].map((v) => ({ value: v, label: `${v} backups` }))} />
              </Field>
            </div>
          </Panel>
          <Panel title="Import defaults">
            <div className="stack">
              <Field label="Default sampling frequency" hint="Used when a file has no timestamp column. Leave blank to ask per import.">
                <Input value={settings.importDefaultSamplingHz ?? ''} onChange={(e) => set('importDefaultSamplingHz')(e.target.value)} placeholder="e.g. 100" />
              </Field>
              <p className="muted small">
                Import mappings can be saved as reusable templates during import. Data quality checks always run and results are preserved even when warnings occur.
              </p>
            </div>
          </Panel>
        </div>
      )}

      {tab === 'appearance' && (
        <div className="settings-grid">
          <Panel title="Theme">
            <div className="theme-choices">
              {[
                ['dark', 'Dark — low-glare engineering console'],
                ['light', 'Light — printed-document style'],
              ].map(([value, label]) => (
                <button key={value} className={`theme-choice ${settings.theme === value ? 'active' : ''}`} onClick={() => set('theme')(value)}>
                  <span className={`theme-swatch theme-${value}`} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </Panel>
          <Panel title="Density">
            <Field label="Table and control density">
              <Select
                value={settings.density ?? 'compact'}
                onChange={set('density')}
                options={[
                  { value: 'compact', label: 'Compact — high information density' },
                  { value: 'comfortable', label: 'Comfortable — larger rows' },
                ]}
              />
            </Field>
            <p className="muted small">Density affects tables throughout the application and applies immediately.</p>
          </Panel>
        </div>
      )}

      {tab === 'units' && (
        <div className="settings-grid">
          <Panel title="Preferred display units">
            <div className="stack">
              {UNIT_SETTINGS.map((u) => {
                const options = unitsForDimension(u.dimension as any).map((def) => ({ value: def.symbol, label: `${def.symbol || '(none)'} — ${def.label}` }));
                return (
                  <Field key={u.key} label={u.label}>
                    <Select value={settings[u.key] ?? ''} onChange={set(u.key)} options={options} />
                  </Field>
                );
              })}
              <p className="muted small">
                Stored measurements always keep their recorded unit and original values. Display unit preferences are applied in analysis and comparison views;
                incompatible units are never compared.
              </p>
            </div>
          </Panel>
          <Panel title="Date and time">
            <div className="stack">
              <Field label="Date format">
                <Select
                  value={settings.dateFormat ?? 'YYYY-MM-DD'}
                  onChange={set('dateFormat')}
                  options={['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MMM-YYYY'].map((v) => ({ value: v, label: v }))}
                />
              </Field>
              <Field label="Time format">
                <Select value={settings.timeFormat ?? '24h'} onChange={set('timeFormat')} options={[{ value: '24h', label: '24-hour' }, { value: '12h', label: '12-hour' }]} />
              </Field>
              <div className="muted small">Dates and times are stored as ISO timestamps; formats affect display only.</div>
            </div>
          </Panel>
        </div>
      )}

      {(tab === 'storage' || tab === 'data') && (
        <div className="stack">
          <Panel title="Local data storage" actions={<Button size="sm" icon="refresh" onClick={loadStorage}>Refresh</Button>}>
            {!storage ? (
              <div className="loading">Reading storage…</div>
            ) : (
              <div className="stack">
                <KeyValue
                  columns={2}
                  items={[
                    ['Data folder', <span className="mono small">{storage.dataDir}</span>],
                    ['Database', <span className="mono small">{storage.dbFile}</span>],
                    ['Database size', bytes(storage.dbBytes)],
                    ['Dataset storage', bytes(storage.datasetsBytes)],
                    ['Attachments', bytes(storage.documentsBytes)],
                    ['Reports', bytes(storage.reportsBytes)],
                    ['Backups', bytes(storage.backupsBytes)],
                    ['Free disk space', storage.freeBytes === null ? 'unknown' : bytes(storage.freeBytes)],
                    ['Schema version', storage.schemaVersion],
                    ['Projects', storage.counts.projects],
                    ['Datasets', storage.counts.datasets],
                    ['Channels', storage.counts.channels],
                  ]}
                />
                <div className="modal-actions-row">
                  <Button icon="folder" onClick={() => api.openPath(storage.dataDir)}>Open data folder</Button>
                  <Button
                    icon="folder"
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Move data storage?',
                        message: 'All data will be copied to the selected folder and the application will use it from the next start.',
                        details: 'The existing folder is left untouched as a safety copy. Do not move data to a network drive that may be unavailable at startup.',
                        confirmLabel: 'Choose folder and copy',
                      });
                      if (!ok) return;
                      setBusy(true);
                      try {
                        const result = await api.moveStorage();
                        if (!result.canceled) {
                          notify('Storage copied. Restart the application to use the new location.', 'success');
                          await loadStorage();
                        }
                      } catch (err: any) {
                        notify(err.message, 'error');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Change storage location
                  </Button>
                </div>
              </div>
            )}
          </Panel>
          <Panel title="Project transfer">
            <div className="modal-actions-row">
              <Button icon="download" onClick={() => api.exportProject(projectId).then((r) => !r.canceled && notify('Project exported', 'success')).catch((e) => notify(e.message, 'error'))}>
                Export current project
              </Button>
              <Button
                icon="upload"
                onClick={async () => {
                  try {
                    const result = await api.importProject();
                    if (result.canceled) return;
                    notify(`Imported ${result.result.projectName}`, 'success');
                    await refresh();
                  } catch (err: any) {
                    notify(err.message, 'error');
                  }
                }}
              >
                Import project archive
              </Button>
              <Button icon="download" onClick={() => api.exportTableCsv('datasets').then((r) => !r.canceled && notify('CSV exported', 'success')).catch((e) => notify(e.message, 'error'))}>
                Export records as CSV
              </Button>
            </div>
            <p className="muted small">
              Project exports include all records, original dataset files, documents, configurations and their relationships. Importing remaps identifiers so
              relationships are preserved and existing projects are never overwritten.
            </p>
          </Panel>
        </div>
      )}

      {tab === 'backups' && (
        <div className="stack">
          <Panel
            title="Backups"
            actions={
              <>
                <Input placeholder="Label (optional)" value={newBackupLabel} onChange={(e) => setNewBackupLabel(e.target.value)} />
                <Button
                  size="sm"
                  variant="primary"
                  icon="save"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const backup = await api.createBackup(newBackupLabel, 'manual');
                      setNewBackupLabel('');
                      notify(`Backup created (${bytes(backup.sizeBytes)}) and verified`, 'success');
                      await loadBackups();
                    } catch (err: any) {
                      notify(err.message, 'error');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Create backup
                </Button>
              </>
            }
          >
            <DataTable
              rows={backups}
              columns={[
                { key: 'createdAt', label: 'Created', render: (b) => fmtDateTime(b.createdAt) },
                { key: 'name', label: 'File', render: (b) => <span className="mono small">{b.name}</span> },
                { key: 'kind', label: 'Kind', render: (b) => <Badge>{b.kind}</Badge> },
                { key: 'sizeBytes', label: 'Size', align: 'right', render: (b) => bytes(b.sizeBytes) },
                { key: 'schemaVersion', label: 'Schema', align: 'right' },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  render: (b) => (
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="icon-btn"
                        title="Restore this backup"
                        onClick={async () => {
                          const ok = await confirm({
                            title: 'Restore backup?',
                            message: `The current database will be replaced with the contents of “${b.name}”.`,
                            details: 'A safety backup of the current data is created first. The application will reload its data after restoring.',
                            confirmLabel: 'Restore backup',
                            danger: true,
                          });
                          if (!ok) return;
                          setBusy(true);
                          try {
                            await api.restoreBackup(b.file);
                            notify('Backup restored. Reloading data…', 'success');
                            await refresh();
                            await loadBackups();
                          } catch (err: any) {
                            notify(err.message, 'error');
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <Icon name="refresh" size={14} />
                      </button>
                      <button className="icon-btn" title="Show in folder" onClick={() => api.reveal(b.file)}>
                        <Icon name="folder" size={14} />
                      </button>
                      <button
                        className="icon-btn danger"
                        title="Delete backup"
                        onClick={async () => {
                          const ok = await confirm({ title: 'Delete backup file?', message: b.name, confirmLabel: 'Delete', danger: true });
                          if (!ok) return;
                          await api.removeBackup(b.file);
                          await loadBackups();
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  ),
                },
              ]}
              empty={<EmptyState title="No backups" message="Create a backup before migrations, major changes or hardware moves." icon="save" />}
            />
            <div className="modal-actions-row">
              <Button
                icon="upload"
                onClick={async () => {
                  try {
                    const result = await api.pickAndRestore();
                    if (result.canceled) return;
                    notify('Backup restored', 'success');
                    await refresh();
                    await loadBackups();
                  } catch (err: any) {
                    notify(err.message, 'error');
                  }
                }}
              >
                Restore from backup file…
              </Button>
            </div>
          </Panel>
          <Panel title="Update safety">
            <p className="muted small">
              The database checks schema version on start and migrates forward, taking a pre-migration copy first. Backups include the database, all dataset
              files, documents and generated reports. User data lives outside the installation folder, so installing a new version never overwrites it.
            </p>
          </Panel>
        </div>
      )}

      {tab === 'updates' && (
        <div className="stack">
          <Panel
            title="Application updates"
            actions={
              <>
                <Button size="sm" icon="refresh" onClick={checkUpdates} disabled={checking}>
                  {checking ? 'Checking…' : 'Check for updates'}
                </Button>
                <Button size="sm" icon="link" onClick={() => api.openReleasePage()}>
                  Release page
                </Button>
              </>
            }
          >
            <div className="stack">
              <KeyValue
                columns={2}
                items={[
                  ['Installed version', info?.version],
                  ['Build', info?.packaged ? 'Release build' : 'Development build'],
                  ['Operating system', `${info?.platform} ${info?.arch}`],
                  ['Release feed', settings.updateRepo || 'Not configured (set owner/repository below)'],
                  ['Status', updates?.state ? <Badge>{updates.state}</Badge> : 'Not checked in this session'],
                  ['Latest version', updates?.latestVersion ?? '—'],
                  ['Release date', updates?.releaseDate ? fmtDateTime(updates.releaseDate) : '—'],
                ]}
              />
              {updates?.message && <div className={updates.state === 'error' ? 'error-box' : 'warn-banner'}>{updates.message}</div>}
              {typeof updates?.progress === 'number' && updates.state === 'downloading' && (
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${updates.progress}%` }} />
                </div>
              )}
              {updates?.releaseNotes && (
                <div className="release-notes">
                  <h4>Release notes</h4>
                  <pre className="code-block scroll">{updates.releaseNotes}</pre>
                </div>
              )}
              <div className="modal-actions-row">
                <Button
                  variant="primary"
                  icon="download"
                  disabled={!updates?.available}
                  onClick={async () => {
                    try {
                      setUpdates(await api.downloadUpdate());
                    } catch (err: any) {
                      notify(err.message, 'error');
                    }
                  }}
                >
                  Download update
                </Button>
                <Button
                  icon="refresh"
                  disabled={updates?.state !== 'downloaded'}
                  onClick={async () => {
                    try {
                      const result = await api.installUpdate();
                      notify(result.message, result.ok ? 'success' : 'warn');
                    } catch (err: any) {
                      notify(err.message, 'error');
                    }
                  }}
                >
                  Install and restart
                </Button>
              </div>
              <p className="muted small">
                Automatic installation is supported for the Windows NSIS installer and macOS builds. For Linux, download the new AppImage or .deb from the
                release page. Updates never modify your project data.
              </p>
            </div>
          </Panel>
          <Panel title="Release feed configuration">
            <div className="stack">
              <Field label="GitHub repository" hint="owner/repository used for release checks">
                <Input value={repoDraft} onChange={(e) => setRepoDraft(e.target.value)} placeholder="my-org/rocket-lab" />
              </Field>
              <div className="modal-actions-row">
                <Button
                  variant="primary"
                  onClick={async () => {
                    await set('updateRepo')(repoDraft.trim());
                    notify('Release feed updated', 'success');
                  }}
                >
                  Save repository
                </Button>
              </div>
              <Toggle checked={settings.autoCheckUpdates !== 'false'} onChange={(v) => set('autoCheckUpdates')(String(v))} label="Check for updates periodically" />
              <div className="muted small">
                Code signing is configured through CI secrets. Signed Windows builds and notarized macOS builds are produced by the release workflow; unsigned
                builds may show operating-system warnings.
              </div>
            </div>
          </Panel>
        </div>
      )}

      {tab === 'diagnostics' && (
        <div className="stack">
          <Panel title="Application" actions={<Button size="sm" icon="refresh" onClick={loadStorage}>Refresh</Button>}>
            <KeyValue
              columns={2}
              items={[
                ['Application', `${APP_NAME} ${info?.version}`],
                ['Electron', info?.electron],
                ['Chromium', info?.chrome],
                ['Node.js', info?.node],
                ['Platform', `${info?.platform} ${info?.arch}`],
                ['Data folder', <span className="mono small">{info?.dataDir}</span>],
                ['Schema version', storage?.schemaVersion ?? '—'],
                ['Database size', storage ? bytes(storage.dbBytes) : '—'],
              ]}
            />
          </Panel>
          <Panel
            title="Data integrity"
            actions={
              <Button
                size="sm"
                icon="check"
                onClick={async () => {
                  try {
                    setIntegrity(await api.integrity());
                  } catch (err: any) {
                    notify(err.message, 'error');
                  }
                }}
              >
                Run integrity check
              </Button>
            }
          >
            {!integrity ? (
              <p className="muted small">Run a check to verify the database, detect orphaned references and confirm dataset files exist.</p>
            ) : (
              <div className="stack">
                <div className={`banner ${integrity.ok ? 'success-banner' : 'warn-banner'}`}>
                  {integrity.ok ? 'All integrity checks passed.' : 'Integrity issues were found.'}
                  <span className="muted small"> Checked {fmtDateTime(integrity.checkedAt)}</span>
                </div>
                <KeyValue
                  columns={1}
                  items={[
                    ['SQLite integrity', integrity.sqliteOk ? 'ok' : integrity.sqliteMessages.join('; ')],
                    ['Orphaned rows', integrity.orphanIssues.length ? integrity.orphanIssues.join('; ') : 'none'],
                    ['Dataset files', integrity.missingDatasets.length ? integrity.missingDatasets.join('; ') : 'all present'],
                  ]}
                />
              </div>
            )}
          </Panel>
          <Panel title="Support information">
            <p className="muted small">
              When reporting a problem, include the application version, schema version and the exact error message. No engineering data leaves this computer
              unless you export it yourself.
            </p>
          </Panel>
        </div>
      )}

      {tab === 'about' && (
        <div className="settings-grid">
          <Panel title={APP_NAME}>
            <div className="stack">
              <div className="about-brand">ROCKET LAB</div>
              <div className="muted">{APP_TAGLINE}</div>
              <p>
                A local-first engineering environment for rocket development programmes: project and revision history, component and electronics records,
                ground, flight and experimental testing, measurement data management, analysis, comparison and reporting.
              </p>
              <KeyValue columns={1} items={[['Version', info?.version], ['Build', info?.packaged ? 'Release' : 'Development'], ['Storage', info?.dataDir]]} />
            </div>
          </Panel>
          <Panel title="Engineering limitations">
            <ul className="plain-list">
              <li>The platform documents and analyses recorded information. It does not certify that a rocket, component or procedure is safe or flight-ready.</li>
              <li>Recorded measurements, user-entered information, derived calculations, statistics, algorithmic suggestions and user conclusions are kept distinct.</li>
              <li>Statistical and alignment results carry stated assumptions; correlation is not causation.</li>
              <li>The application does not control launch, propulsion or in-flight actuation systems.</li>
              <li>All project data is stored locally. No account or cloud service is required to use core functionality.</li>
            </ul>
          </Panel>
        </div>
      )}

      {busy && <div className="muted small">Working…</div>}
    </div>
  );
}
