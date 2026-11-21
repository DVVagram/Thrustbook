# Rocket Lab — Rocket Development, Testing & Engineering Analysis Platform

Rocket Lab is a standalone desktop application for managing an entire experimental rocket
programme: projects, rocket revisions, components, sensors, ground tests, flights, experimental
runs, imported measurement data, analysis workspaces, dataset comparisons and PDF reports.

Everything is local. There is no account, no server and no cloud dependency. The application runs
offline; the only network feature is an optional update check against GitHub Releases.

Supported targets: Windows 10/11 x64 (NSIS `.exe`), Linux x64 (AppImage and `.deb`), macOS
(Intel and Apple Silicon DMG).

---

## 1. Feature map

| Module | What it does |
| --- | --- |
| Dashboard | Programme state: active projects, recent activity, upcoming tests, unresolved issues, recent datasets, milestones; configurable widgets |
| Projects | Multiple projects, rockets, campaigns, objectives, status, activity history, archived projects |
| Rocket Development | Configurable development stages with notes, measurements, files, linked components/tests/datasets/issues, timeline |
| Components & Electronics | Component inventory, electronics configurations, installation and test history, substitution history |
| Sensors | Sensor database, calibration records, installation history, measurement history |
| Revision History | Revision records, revision-to-revision comparison, configuration comparison |
| Ground Testing | Test records with configuration, environment, expected/actual results, custom fields, attached datasets |
| Flight Testing | Flight records with weather, firmware, electronics/sensor configuration, post-flight inspection, recordings |
| Experimental Testing | User-defined experiments with independent/measured variables and repeated runs |
| Data Log | Unified chronological timeline, table view, project/test/flight/revision/measurement history, full-text search |
| Data Analysis | Multi-panel interactive graphs, linked time range, unit conversion, statistics, event markers, saved workspaces |
| Dataset Comparison | Multi-dataset overlay, side-by-side, difference, percentage difference, distributions, alignment and paired statistics |
| Engineering Documentation | Document library with checksums, previews, tags and links to any record |
| Issues & Observations | Issue lifecycle, severity, investigation and verification links |
| Reports | Ten report kinds rendered to HTML and PDF, with recorded/derived content separated |
| Settings | Theme, units, date formats, storage location, backups, imports, graph defaults, updates, diagnostics |

Data is relational and traceable: a dataset belongs to a project and optionally to a ground test, a
flight or an experimental run; tests and flights point at a rocket revision and an electronics
configuration; issues, documents, events and derived datasets link back to their source records.

## 2. Architecture

```
src/
  main/        Electron main process (Node 24)
    index.ts       window, menu, CSP, single-instance lock, daily backup
    ipc.ts         one validated channel (rocketlab:invoke) + handler allow-list
    db.ts          SQLite schema and ordered migrations
    repo.ts        entity/column allow-lists, CRUD, activity log, search, overviews
    datasets.ts    streaming import, channel files, quality report, series, derive, events
    comparison.ts  alignment, resampling, normalization, paired statistics
    engineering.ts data log, measurement history, revision/config comparison
    reports.ts     report builders + printToPDF
    archive.ts     streaming tar.gz backups, project export/import, integrity checks
    importers.ts   CSV/TSV/TXT/JSON/XLSX readers and header/type detection
    updates.ts     electron-updater integration
    paths.ts       user-data layout and path containment
  preload/     contextBridge surface (no Node access for the UI)
  renderer/    React 19 + TypeScript UI (Vite build)
    Chart.tsx      custom canvas chart engine (no chart dependency)
    pages/         one page per module
  shared/      units, statistics, constants, types shared by both processes
```

- **SQLite** stores metadata and relationships (`node:sqlite`, WAL, foreign keys).
- **Channel data** is stored as raw `Float64` columns (`ch_NN.f64` plus `time.f64`) inside a
  per-dataset folder. Original imported files are copied untouched into the same folder and
  checksummed (SHA-256).
- **UI** talks to the main process only through a single IPC method with a handler whitelist and a
  preload bridge that exposes no filesystem or Node primitives.
- **Charts** are drawn on canvas by the application (line, scatter, area, bar, histogram,
  distribution, box, XY, difference, percentage difference, multi-axis, zoom/pan, markers, PNG
  export, downsampling indicator).

## 3. Data integrity rules

- Imported datasets are immutable. Originals are copied, never re-written.
- Every transformation (`convert_unit`, `smooth`, `rate`, `offset`, `polynomial`, `crop`,
  `decimate`) creates a new dataset with a `processing_json` provenance record (operation,
  parameters, software version, source dataset).
- Import quality checks flag invalid timestamps, duplicates, out-of-order rows, data gaps,
  inconsistent sampling and missing values; questionable rows are preserved as `NaN` gaps and
  reported, not silently dropped.
- Units are stored explicitly per channel. Conversions use the shared unit table (including affine
  temperature conversion); incompatible quantities are refused rather than compared.
- Alignment for comparison is analysis-only. Interpolation/resampling is labelled, and the common
  range and alignment method are shown with the result.
- Statistics state their method (sample statistics, `n-1` standard deviation, linear-interpolation
  percentiles, finite values only).
- Deleting a dataset archives its folder under `deleted/`; datasets that are sources of derived
  datasets cannot be deleted until the derivatives are handled.
- Database migrations run in order and are never edited after release; a backup is taken before a
  migration that changes structure.
- Application updates replace only the installation. User data lives in the OS user-data folder and
  is untouched by installers and updates.

## 4. Local data layout

```
<userData>/storage.json            optional pointer to a relocated data folder
<userData>/data/
  rocketlab.db                     metadata, schema version in PRAGMA user_version
  datasets/<datasetId>/            original.<ext>, time.f64, ch_00.f64 …
  documents/                       uploaded attachments (original retained)
  reports/                         generated HTML + PDF
  backups/                         versioned .rlbak archives
  deleted/                         archived dataset folders
```

The storage folder can be shown, backed up, restored or moved from **Settings → Data**.
`ROCKETLAB_DATA_DIR` overrides the location for portable or QA runs.

Backups (`.rlbak`) and project exports (`.rlproj`) are streaming tar+gzip archives containing a
manifest, the SQLite database (consistent copy) and the referenced dataset/document files. Project
import remaps all identifiers and rewrites stored paths so relationships survive the transfer.

## 5. Development

Requirements: Node.js 24 and npm. Electron ships its own Node runtime; end users need nothing else.

```bash
npm install
npm run dev        # Vite dev server + Electron with hot reload
npm run typecheck  # TypeScript, no emit
npm run build      # esbuild main/preload + Vite renderer -> dist/
npm start          # build, then launch the packaged runtime locally
```

If npm is configured to skip lifecycle scripts, Electron's binary must be installed once with
`node node_modules/electron/install.js` (Electron cannot download itself later).

## 6. Packaging

```bash
npm run dist:win     # release/RocketLab-Setup-<version>-x64.exe (NSIS)
npm run dist:linux   # AppImage + .deb
npm run dist:mac     # DMG (x64 + arm64)
```

`electron-builder.yml` defines the targets. The Windows installer is per-user by default, allows
choosing the directory, creates Start Menu and desktop shortcuts and does **not** delete application
data on uninstall (`deleteAppDataOnUninstall: false`). Upgrading installs over the previous version
while `%APPDATA%\Rocket Lab\data` (or the relocated folder) is preserved.

macOS builds are hardened-runtime signed and notarized when certificates are supplied; without
credentials the DMG is unsigned and Gatekeeper will warn.

## 7. Releases, updates and CI

`.github/workflows/release.yml` builds all three platforms on a version tag (`v1.2.3`) and publishes
the installers plus `latest.yml` / `latest-linux.yml` / `latest-mac.yml` to GitHub Releases.

1. The update feed is configured for `DVVagram/rocket-lab` in `electron-builder.yml`
   (`publish.owner` / `publish.repo`); CI overrides it from the repository context. The app can be
   pointed at another repository at runtime with the `updateRepo` setting (`owner/repo`).
2. Push a tag: `git tag v1.0.1 && git push origin v1.0.1`.
3. Approve the draft release after the artifacts are attached.

Signing secrets (all optional; unsigned builds install with OS warnings):

| Secret | Purpose |
| --- | --- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Windows Authenticode certificate (base64 `.pfx`) and password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization |
| `CSC_LINK`, `CSC_KEY_PASSWORD` (macOS job) | Developer ID Application certificate |
| `GH_TOKEN` | Provided automatically by Actions; used to publish releases |

Linux uses AppImage, which supports in-place updates when the app is launched from a writable
location; otherwise the app offers the release page. Windows uses the NSIS installer through
`electron-updater`; macOS uses the DMG/zip update feed. Updates are only installed when the user
explicitly starts the download/install, and never touch user data.

## 8. Verification performed

- `npm run typecheck` clean; `npm run build` produces `dist/main`, `dist/preload`, `dist/renderer`.
- The built application launches, creates/migrates the SQLite schema (v2) and renders the shell and
  all module pages without console errors.
- An end-to-end run through the real IPC layer created a project, rocket, revision, ground test and
  flight; imported two CSVs (100 Hz, 200 Hz) with different durations and units; produced channel
  statistics, a derived dataset, a comparison (Pearson r ≈ 0.97, mean difference reported), event
  suggestions, a saved workspace, a saved comparison, a project report with PDF, a backup and an
  integrity check.
- Every module route was loaded in the packaged renderer with no console errors.
- The NSIS installer was installed silently, launched as a packaged application (`packaged: true`),
  and then upgraded from 1.0.0 to 1.0.1 in place: the project and all three datasets were still
  present after the upgrade. Installers produced locally are unsigned unless signing credentials
  are configured.

## 9. Safety scope

Rocket Lab records, organizes and analyses measurements. It does not certify airworthiness, flight
readiness, structural margins or motor safety, and it does not control launch, propulsion or
actuation systems. Recorded values, user-entered text, derived calculations, statistics and
algorithmic event suggestions are kept visibly distinct; correlation is never presented as proof of
causation and no design change is automatically credited with a measured difference.

## 10. Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + K` | Global search |
| `Ctrl/Cmd + N` | New project |
| `Ctrl/Cmd + O` | Import dataset |
| `Ctrl/Cmd + Shift + T` | New ground test |
| `Ctrl/Cmd + Shift + F` | New flight |
| `Ctrl/Cmd + 1…5` | Dashboard, Projects, Data Log, Analysis, Comparison |
| `Ctrl/Cmd + Shift + L` | Toggle light/dark theme |
| `Ctrl/Cmd + ,` | Settings |
