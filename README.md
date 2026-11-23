# Thrustbook — Rocket Development, Testing & Engineering Analysis Platform

Thrustbook is a standalone desktop application for managing an entire experimental rocket
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
| Components & Electronics | Component catalog, electronics configurations, installation and test history, substitution history |
| Inventory | Costed stock of parts, materials, consumables and tools with quantities, units, unit costs, suppliers, locations, reorder levels and calculated stock value |
| Finance | Project income and expenditure ledger with dates, categories, counterparties, references, payment methods and per-currency net balances |
| Sensors | Sensor database, calibration records, installation history, measurement history |
| Revision History | Revision records, revision-to-revision comparison, configuration comparison |
| Ground Testing | Test records with configuration, environment, expected/actual results, custom fields, attached datasets |
| Flight Testing | Flight records with weather, firmware, electronics/sensor configuration, post-flight inspection, recordings |
| Experimental Testing | User-defined experiments with independent/measured variables and repeated runs |
| Data Log | Unified chronological timeline, table view, project/test/flight/revision/measurement history, full-text search |
| Data Analysis | Multi-panel interactive graphs, linked time range, unit conversion, statistics, event markers, saved workspaces |
| Dataset Comparison | Multi-dataset overlay, side-by-side, difference, percentage difference, distributions, alignment and paired statistics |
| Video & Image Analysis | Import video, still images or image sequences; manually outline objects; Meta SAM 2.1 mask segmentation with OpenCV optical-flow assistance and per-frame correction; calibration, 2D motion measurements, graphs, CSV/PDF/project exports |
| Engineering Documentation | Document library with checksums, previews, tags and links to any record |
| Issues & Observations | Issue lifecycle, severity, investigation and verification links |
| Reports | Ten report kinds rendered to HTML and PDF, with recorded/derived content separated |
| Entry Templates | Reusable, project-scoped or application-wide data-entry templates with typed custom fields for tests, flights and experimental runs |
| Settings | Theme, units, date formats, storage location, backups, imports, graph defaults, updates, diagnostics, example workspace |

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
    media.ts       authorised, range-capable thrustbook-media:// protocol for source footage
    motion.ts      motion-project validation, PDF report and export writers
    sam2.ts       SAM 2.1 component installer, ONNX sessions and mask propagation
    updates.ts     electron-updater integration
    paths.ts       user-data layout and path containment
  preload/     contextBridge surface (no Node access for the UI)
  renderer/    React 19 + TypeScript UI (Vite build)
    Chart.tsx      custom canvas chart engine (no chart dependency)
    motion/        SAM 2.1 client, OpenCV optical-flow worker/client, frame source, canvas overlay, calibration, report
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
- **Video & Image Analysis** runs Meta SAM 2.1 Small in the main process through `onnxruntime-node`
  on the CPU, with a bounded intra-op thread count. The renderer decodes one frame at a time and
  transfers RGBA buffers over IPC; the engine crops a region around the object, encodes it once per
  frame and reuses the previous mask as a prompt for the decoder, so the interface never blocks on
  the model. The 143 MB component is not bundled: it is downloaded once from a public Hugging Face
  release, checked against a pinned SHA-256, and unpacked into the application data folder.
- **OpenCV optical flow** supports SAM 2.1 rather than replacing it. A classic Web Worker loads the
  bundled OpenCV.js build (Apache-2.0) and tracks the outline's contour, the object's nose, tail and
  centre, and its reference points between frames with pyramidal Lucas–Kanade flow, a
  forward–backward consistency check and a robust similarity fit (RANSAC-style outlier rejection).
  A masked template match of the previous outline anchors the translation when a low-texture body
  would otherwise let the flow slide, and an outline whose contour covers less than 60% of its
  segmented mask falls back to the mask extent instead of a partial or degenerate shape.
  When the flow is confident, SAM is skipped for up to two consecutive frames and the warped
  outline becomes that frame's tracking result; on the next SAM frame the predicted outline is
  passed as the decoder mask prompt and used to place the ROI, so the model restarts at the object
  instead of a stale mask. Sampled frames record both engines' outlines (IoU agreement), flow
  confidence, inlier ratio, forward–backward error, scale, rotation and the nose/tail/centre
  positions. If OpenCV cannot load, the renderer automatically falls back to SAM on every frame.
- **Source media** is delivered through `thrustbook-media://local/<base64url-path>`, which only serves
  a path chosen in a file dialog this session or referenced by a saved motion analysis. It supports
  HTTP Range requests and CORS so canvas processing is not tainted. Original files are never changed.

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
- Inventory value is derived, never stored: quantity on hand × unit cost, calculated per item and
  totalled separately for each recorded currency. A low-stock flag is shown only when a reorder level
  above zero is configured. Stock changes do not post a finance entry automatically.
- Finance entries record a positive amount and an explicit type. Income adds to and expenditure
  subtracts from the net balance; the net is calculated and labelled as derived. Amounts in different
  currencies are never converted or combined into one total.

## 4. Local data layout

```
<userData>/storage.json            optional pointer to a relocated data folder
<userData>/workspace.json          which workspace opens: { "mode": "user" | "examples" }
<userData>/data/                   the user's own workspace
  rocketlab.db                     metadata, schema version (legacy filename kept for upgrades)
  datasets/<datasetId>/            original.<ext>, time.f64, ch_00.f64 …
  documents/                       uploaded attachments (original retained)
  reports/                         generated HTML + PDF
  backups/                         versioned .rlbak archives
  deleted/                         archived dataset folders
<userData>/examples/               the example workspace (separate database and folders)
  seed.json                        seed version marker
  data/                            same layout as above, never mixed with user data
```

The storage folder can be shown, backed up, restored or moved from **Settings → Data**.
`THRUSTBOOK_DATA_DIR` overrides the location for portable or QA runs; `THRUSTBOOK_WORKSPACE`
(`user` or `examples`) and `THRUSTBOOK_EXAMPLES_ROOT` override workspace selection for QA. The
legacy `ROCKETLAB_*` names are still accepted for existing scripts.

Thrustbook was previously published as “Rocket Lab”. On first start it copies the old
`%APPDATA%/Rocket Lab` profile into `%APPDATA%/Thrustbook`, rewrites stored dataset, document and
report paths, and leaves the old folder untouched as a safety copy. The bundled example workspace is
rebuilt in the new profile instead of being copied.

### Entry templates

**Entry Templates** (System) defines reusable field sheets per record type — ground test, flight
test or experimental run — optionally narrowed to a test category and either project-scoped or
available to every project. Field types are text, number, measurement (with unit), yes/no, date,
select and long text; each field can carry a default, help text and a “required” flag.

A template chosen on a record copies its fields as defaults into the record's own `custom_json`.
Values are stored with that record and never change when the template is later edited, so
historical entries stay intact. Required fields are enforced when a record is marked final
(Completed, Complete, Failed, Aborted, Verified, Closed or Archived); planned records can be
created before their measurements exist. Select and numeric values are validated on every write,
and template values appear in the ground-test and flight-test reports under a clearly labelled
user-entered section.

### Example workspace

The bundled example programme (project “Kestrel-1 — example programme”, with revisions, stages,
components, sensors, calibration, tests, flight, experiment runs, templates, datasets and events)
lives in its own database and folder tree under `<userData>/examples`. It is created through the
same import pipeline as real recordings, so it exercises the real analysis code rather than a
mock layer.

The workspace is selected before the database opens; **Open example data** / **Return to my data**
(in the sidebar or Settings → Data & storage) restarts the application into the chosen workspace.
Because the two workspaces never share a database or file tree, example records cannot appear in
user searches, dashboards, backups, exports or reports, and user edits in the example workspace
are never copied into user projects. The example workspace can be reset or deleted from the same
panel, and automatic daily backups and storage relocation are disabled while it is active.

Backups (`.rlbak`) and project exports (`.rlproj`) are streaming tar+gzip archives containing a
manifest, the SQLite database (consistent copy) and the referenced dataset/document files. Project
import remaps all identifiers and rewrites stored paths so relationships survive the transfer.

## 5. Development

Requirements: Node.js 24 and npm. Electron ships its own Node runtime; end users need nothing else.

```bash
npm install
npm run dev        # Vite dev server + Electron (renderer hot reload)
npm run typecheck  # TypeScript, no emit
npm run build      # esbuild main/preload + Vite renderer -> dist/
npm run test:motion    # 23 deterministic measurement/calibration/tracking-merge tests
npm run test:sam2      # 11 deterministic SAM 2.1 mask-geometry tests
npm run test:stage     # canvas overlay, viewport and pointer-coordinate tests
npm run test:sam2-engine # real SAM 2.1 model in Electron; needs the installed component
npm run test:sam2-ui   # real model through the UI: import, Track, saved outlines (needs the component)
npm run test:page      # Electron page smoke test: load, keyframes, history and overlay
npm run check:layout  # launch an isolated app and check all main pages at 1120px
npm run check      # measurement, SAM geometry, stage, typecheck, build, page and layout checks
npm start          # build, then launch the packaged runtime locally
```

If npm is configured to skip lifecycle scripts, Electron's binary must be installed once with
`node node_modules/electron/install.js` (Electron cannot download itself later).

## 6. Packaging

```bash
npm run dist:win     # release/Thrustbook-Setup-<version>-x64.exe (NSIS)
npm run dist:linux   # AppImage + .deb
npm run dist:mac     # DMG (x64 + arm64)
```

`electron-builder.yml` defines the targets. The Windows installer is per-user by default, allows
choosing the directory, creates Start Menu and desktop shortcuts and does **not** delete application
data on uninstall (`deleteAppDataOnUninstall: false`). Upgrading installs over the previous version
while `%APPDATA%\Thrustbook\data` (or the relocated folder) is preserved.

macOS builds are hardened-runtime signed and notarized when certificates are supplied; without
credentials the DMG is unsigned and Gatekeeper will warn.

## 7. Releases, updates and CI

`.github/workflows/check.yml` runs `npm run check` (typecheck, build and the 1120px layout audit)
on every push to `main` and every pull request. `.github/workflows/release.yml` builds all three
platforms on a version tag (`v1.2.3`) and publishes the installers plus `latest.yml` /
`latest-linux.yml` / `latest-mac.yml` to GitHub Releases.

1. The update feed is configured for `DVVagram/Thrustbook` in `electron-builder.yml`
   (`publish.owner` / `publish.repo`); CI overrides it from the repository context. New profiles
   default `updateRepo` to `DVVagram/Thrustbook`, and an empty value falls back to the same repository,
   so a fresh install does not need any feed entry. The app can be pointed at another repository at
   runtime with the `updateRepo` setting (`owner/repo`).
2. Push a tag: `git tag v2.1.1 && git push origin v2.1.1`.
3. The workflow publishes the release directly with all platform assets attached.

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
- The built application launches, creates/migrates the SQLite schema (v4) and renders the shell and
  all module pages without console errors.
- An end-to-end run through the real IPC layer created a project, rocket, revision, ground test and
  flight; imported two CSVs (100 Hz, 200 Hz) with different durations and units; produced channel
  statistics, a derived dataset, a comparison (Pearson r ≈ 0.97, mean difference reported), event
  suggestions, a saved workspace, a saved comparison, a project report with PDF, a backup and an
  integrity check.
- Every module route was loaded in the packaged renderer with no console errors.
- Entry templates were exercised through the IPC layer and the UI: a template with required text,
  measurement and select fields rejected invalid/missing final values, allowed a Planned record to
  be created first, persisted and re-read its values, rejected non-numeric measurements, appeared in
  ground-test reports, was found by global search, and was included in backup counts. In the new
  ground-test form, choosing the matching category auto-selected the template and rendered its five
  fields; clearing the template was honoured rather than re-applied.
- A second pass added eighteen IPC checks and fifteen UI checks for templates, runs, flights,
  reports, backup contents and record creation. Two defects were found and fixed: promoting a
  planned run to a completed status now re-runs required-field validation (previously the check ran
  only when template values were also edited), and the global search dialog is now rendered only
  when opened (it previously sat over the application as a blocking modal on every page).
- The example workspace was verified with separate `THRUSTBOOK_DATA_DIR` and example roots: it seeded
  one project, two datasets, four templates, one test, one flight and two runs on first open; its
  dataset series, analysis panels and project report rendered without errors; the user workspace
  still contained only its own project and template, no example record was found by search, and
  deleting the example workspace removed only its own folder before it reseeded on the next open.
- The NSIS installer was installed silently, launched as a packaged application (`packaged: true`),
  and then upgraded from 1.0.0 to 1.0.1 in place: the project and all three datasets were still
  present after the upgrade. The 2.0.0 Thrustbook installer was installed, launched with an isolated
  data folder, checked for templates, the example workspace and the search dialog, and uninstalled.
  Installers produced locally are unsigned unless signing credentials are configured.
- The rename from Rocket Lab to Thrustbook was verified against a real legacy profile containing a
  project, test and imported dataset: the profile was copied to `%APPDATA%/Thrustbook`, the dataset
  and original-file paths were rewritten, the channel series still returned its samples, the legacy
  folder remained untouched, and the renamed window, installer and report strings showed Thrustbook.
- Costed inventory and the income/expenditure ledger were exercised through the IPC layer and the UI
  with USD and EUR rows: quantities and unit costs were persisted, stock values were recalculated on
  edit, low-stock thresholds and filters worked, income/expenditure/net totals stayed separate by
  currency, the type tabs filtered correctly, and create, delete, global search, backups, project
  overview counts and project-deletion cascades all included the new records. Required names,
  quantities, costs, descriptions, amounts, types and dates were rejected when invalid. Two defects
  were found during this pass and fixed: a missing unit cost previously defaulted to zero, an
  impossible date such as `2026-02-31` was previously accepted by JavaScript date normalisation, and
  date-only ledger values could display a day earlier in some timezones.
- The 2.1.0 Windows package was installed with a fresh data folder: it reported version 2.1.0,
  migrated the database to v4, showed Inventory and Finance in the sidebar, and defaulted the release
  feed to `DVVagram/Thrustbook` without any manual entry.
- The 2.1.1 interface audit checked all 19 pages at 1120, 1280 and 1440px, plus populated inventory
  and finance tables, project cards with active and archived states, every Settings tab and the main
  tabbed pages. Project action buttons now use full labels instead of fixed-width icon buttons, so
  Export, Archive/Restore and Delete no longer overlap. No other clipping or control overlap was found.
- `npm run check` now runs the layout guard automatically after typecheck, build and the page test.
  It launches Electron with an isolated profile and the example workspace, walks all 20 main pages
  at the 1120px minimum width, and fails on button text that escapes its control or visible controls
  that overlap.
  The detector was verified against the original defect by injecting the old 24px Export button: the
  check failed with `projects: button text overflow`; the current UI passes all pages.
- The motion tests also bundle `tests/flow.test.ts`: outline sampling, principal-axis
  nose/tail/centre derivation (including motion direction), similarity warping, flow quality,
  polygon IoU, half-resolution coordinate mapping, rejection of implausible or low-confidence flow,
  and the SAM scheduling rules (including the every-frame rule under camera compensation).
- The motion engine has 23 deterministic tests (`npm run test:motion`) covering stationary,
  horizontal, vertical and diagonal motion, distance versus displacement, acceleration, variable
  frame timing, rotated axes, inches, homography, invalid calibration, relative length, orientation,
  angular velocity, foreshortening, geometry, CSV, uncertain status, keyframe segmentation, merge
  preservation, camera-translation compensation and report content/escaping.
- SAM 2.1 mask handling has 12 deterministic tests (`npm run test:sam2`): ROI clamping to the frame,
  canvas mapping round-trips, prompt placement, mask-to-polygon conversion and simplification,
  component selection when a second blob appears, mask resampling after an ROI change, bounded
  reference-point motion, segmentation scoring, background translation under an ignored object,
  binary threshold alignment and rasterising a flow-predicted outline into the decoder mask prompt.
- The real-model Electron harness (`npm run test:sam2-engine`, not part of `npm run check` because
  it needs the installed component) refines a drawn outline and tracks a synthetic translating
  rocket for 10/10 frames with a mean centroid error of 1.7 px (maximum 8.3 px) and a minimum
  heuristic quality of 89; its nose reference point moves 58 px with the object; a corrected outline
  on frame 5 is re-segmented with its centre within 0.5 px of the rocket; a half-resolution segment
  (640×360 frames declared as 1280×720 footage, 3/3 frames at 1.0 px maximum centroid error) checks
  source-coordinate mapping, reference lift and mask area in source pixels; and background
  translation is measured as 3.6 px/frame against an injected 3 px/frame with 5 of 6 frames valid.
- The UI tracking test (`npm run test:sam2-ui`, also needs the component) creates a real
  image-sequence analysis with generated PNG frames, opens Video & Image Analysis, clicks *Track*
  and reads the saved analysis back. A five-frame run at the default 384 px processing width
  produces SAM 2.1, OpenCV, OpenCV, SAM 2.1, OpenCV: optical flow took over three frames (0.98–0.99
  confidence), SAM resumed after the two flow-only frames using the flow-seeded prompt (outline
  agreement above 0.4), every outline covered more than 1,500 px² (never a degenerate sliver or a
  partial contour), the template match scored 0.97–0.99, the maximum centroid error was 3.6 px
  (reference 5.0 px), qualities were 92–99, no renderer errors occurred, and the Track button was
  usable again afterwards. The same run at the 1280 px processing width kept the maximum centroid
  error at 1.2 px (reference 3.8 px) with qualities of 96–99. With camera compensation on (where
  every frame needs a SAM mask) all five frames were produced by SAM 2.1 (maximum centroid error
  5.0 px, reference 3.7 px), each later frame still carrying a flow measurement. In the five-frame
  hybrid run SAM encoded 2 of 5 frames, 60% fewer encoder passes than the previous every-frame
  tracking.
- The on-demand installer was exercised in a real Electron main process with the production user-data
  path: it downloaded the 142.9 MB archive in 64 s, verified the pinned SHA-256, unpacked the two
  model files (154.5 MB on disk), wrote the component manifest, reported `ready`, loaded the ONNX
  sessions, and tracked a probe frame through the installed copy. No progress listener was needed
  for the check; the progress events are the same ones the panel renders.
- The page test (`npm run test:page`) loads a saved analysis, restores a keyframe history entry and
  seeks the video, adds/deletes a keyframe, verifies auto-save persistence and toggles the outline
  overlay.
- A packaged-runtime integration check created an image-sequence analysis, waited for the worker
  engine to become ready, drew an outline programmatically through the stored project, clicked Track,
  and received 30 tracked frames with no renderer errors. This exercised the production CSP,
  `thrustbook-media://` CORS/range path and the UI-to-worker pipeline. It is a local development
  check, not part of `npm run check`.

Release installers are attached to the GitHub Releases page by the Release workflow; the `.exe`,
`.AppImage`, `.deb` and `.dmg` assets are published from the tag build.

## 9. Safety scope

Thrustbook records, organizes and analyses measurements. It does not certify airworthiness, flight
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

## 11. Video & Image Analysis

Open **Video & Image Analysis** from the sidebar. Analyses belong to the selected project.

1. **Import** a video, image or image sequence. Video metadata is read from the decoded file; frame
   timing is retrieved from decoded frame timestamps when available, or entered manually. The app
   never silently assumes an FPS: tracking stays disabled until timing is known.
2. **Define an object.** Draw a polygon or rectangle on a paused frame. Drag points to correct them,
   insert/delete points, undo/redo, then apply the outline. Add named reference points such as Nose
   and Tail, and enter known length/width/height. Objects are independent and keep their own outline,
   references, correction history and settings.
3. **Install the engine and track.** Tracking uses Meta's SAM 2.1 Small model, which is a separate
   on-demand component. The tracking panel reports whether it is installed, its size on disk, and an
   *Install* button; installing downloads 143 MB from a public release, shows download progress with
   an estimate, verifies the archive against a pinned SHA-256, unpacks it into the application data
   folder and loads the ONNX sessions. The download can be cancelled and the component removed again;
   errors name the failing step. Tracking stays disabled until the component is ready.
   Click *Track … through keyframes*. The main process runs the Hiera-Small encoder and decoder on
   the CPU: a frame is cropped around the object, encoded once, and the previous mask is fed back as
   a mask prompt so the mask follows the object through the clip. Between those segmentation frames
   a bundled OpenCV worker measures pyramidal Lucas–Kanade optical flow over the outline, the
   object's nose, tail and centre and its reference points; while the flow stays confident the
   warped outline is used directly and SAM is skipped (at most two frames in a row), then the next
   SAM frame is seeded with that predicted outline as its mask prompt. Both outlines are compared on
   every SAM frame. Corrections are keyframes: a redrawn outline re-segments that frame and tracking
   continues from it, preserving every manual correction and every frame outside the recalculated
   interval. Keyframes can be confirmed, reviewed and deleted; replaced or deleted keyframes are
   retained in a correction history and can be restored. Each frame records the decoder's predicted
   IoU, mask overlap, mask area, a heuristic quality score and, when flow ran, its confidence,
   inlier ratio, forward–backward error, scale, rotation, agreement and nose/tail/centre positions.
   If the object is lost the run stops on that frame; it does not invent a position. If OpenCV fails
   to load, SAM tracks every frame exactly as before.
4. **Calibrate.** Set an origin and X/Y axes directly on the image, then calibrate with two points of
   known distance or four points forming a planar homography. Supported length units include mm, cm,
   m, in and ft. The active model is shown; a pixel scale is never presented as valid across depth
   changes.
5. **Analyse.** The measurement engine derives horizontal/vertical position, displacement, path
   distance, speed, velocity components and magnitude, acceleration, travel direction, projected
   orientation and angular velocity. Raw and smoothed series remain separate. Graphs, the video
   timeline and overlays are synchronised. Optional camera-motion compensation estimates
   background translation from features outside the object and subtracts it before measurement.
   Missing background estimates disable compensation rather than being silently treated as zero.
6. **Export.** CSV includes frame, time, pixels, calibrated values, quality, status, units and camera
   compensation columns. PDF reports include project/media information, object and calibration
   details, keyframes, camera status, graphs, an annotated frame, assumptions and limitations. The
   current annotated frame can also be saved as PNG. A versioned `.tbmotion` JSON project can be
   reopened; missing media can be relinked without losing tracking data.

**Measurement meaning.** Values are calibrated only when a scale/homography is active and the
measuring plane matches the calibration plane. Without one, values are image-plane pixel quantities.
Object-length ratios are relative measurements, not absolute distance. A single ordinary video is a
2D projection: no 3D coordinates, camera mounting angle or lens distortion correction is invented.
Foreshortening estimates use the stated orthographic assumption and are shown as an estimate.
Tracking quality is a heuristic score, not a calibrated probability. SAM 2.1 returns 2D image
masks, so a mask clipped by the crop or the frame, a partially occluded object or a low-contrast
edge lowers the score, and the run stops rather than interpolating through a lost object. Frames
filled in by optical flow are scored from flow inliers, forward–backward error and area continuity;
a prediction that scores below the review threshold is handed to SAM instead of being stored. Camera
compensation removes
estimated **background translation only**; camera zoom, rotation, rolling shutter and parallax are not
corrected. Annotated-video export and bundled FFmpeg are not implemented; video decoding and
timestamps use the Chromium media stack.

Third-party components, versions and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## 12. License

Thrustbook is released under the MIT License. See [LICENSE](LICENSE).
