# Third-party notices and license inventory

Thrustbook itself is released under the MIT License (see `LICENSE`). This file records the
third-party components used by the application, their versions, licenses and distribution
requirements. It is shipped with packaged builds.

No GPL or AGPL dependency is included in the application dependency tree. The Video & Image
Analysis module needs no paid or cloud service: the optional SAM 2.1 model is downloaded once and
runs locally.

## Runtime dependencies

| Component | Version | License | Purpose | Distribution requirement |
| --- | --- | --- | --- | --- |
| Electron | 45.4.1 | MIT | Desktop runtime (Chromium + Node.js) | Include Electron's MIT copyright and license; Electron's own `LICENSE` and `LICENSES.chromium.html` are distributed with the Electron runtime |
| onnxruntime-node | 1.31.1 | MIT | CPU inference runtime for the SAM 2.1 ONNX encoder and decoder | Include the MIT copyright and license (`THIRD_PARTY_LICENSES/onnxruntime-LICENSE.txt`) |
| adm-zip | 0.5.16 | MIT | Unpacks the verified SAM 2.1 component archive | Include the MIT copyright and license (`THIRD_PARTY_LICENSES/adm-zip-LICENSE.txt`) |
| @techstark/opencv-js | 4.12.0-release.1 | Apache-2.0 | OpenCV.js (embedded WASM) optical flow, similarity fit and tracking-consistency checks that support the SAM 2.1 engine | Include the Apache-2.0 license (`THIRD_PARTY_LICENSES/opencv-js-LICENSE.txt`) |
| electron-updater | 6.8.11 | MIT | Optional update checking/installation | Include MIT copyright and license |
| React | 19.3.1 | MIT | Renderer UI | Include MIT copyright and license |
| React DOM | 19.3.1 | MIT | Renderer UI | Include MIT copyright and license |

`onnxruntime-node` bundles the ONNX Runtime shared library (Microsoft Corporation, MIT) for each
packaged platform; only the binaries for the target platform are included in a build.

The OpenCV.js embedded-WASM build is bundled with the renderer (about 11 MB) and runs inside a Web
Worker; no native OpenCV library is installed. It is loaded by the application's optical-flow worker
when tracking starts. Sources: OpenCV — https://github.com/opencv/opencv, Apache-2.0; OpenCV.js
package — https://github.com/techstark/opencv-js, Apache-2.0.

## On-device model component (downloaded, not bundled)

| Component | Version | License | Purpose |
| --- | --- | --- | --- |
| Meta SAM 2.1 Small (Hiera-S), ONNX export | 2.1, fp32, export `_20260221` | Apache-2.0 | Object segmentation and mask propagation in Video & Image Analysis |

The installer does not contain the model. When the user chooses *Install* in the tracking panel, the
application downloads `sam2.1_hiera_small_20260221.zip` (142,896,844 bytes) from the public
Hugging Face repository `vietanhdev/segment-anything-2.1-onnx-models`, verifies the pinned SHA-256
`7c232acd…7973d`, and unpacks the two ONNX files into the application data folder
(`models/sam2.1-hiera-small`). The component can be removed from the same panel.

The ONNX export redistributes Meta's original SAM 2.1 weights unchanged; its license is unchanged
from upstream (Apache-2.0). Sources:

- SAM 2 — https://github.com/facebookresearch/sam2, Copyright (c) Meta Platforms, Inc. and
  affiliates, Apache-2.0.
- ONNX export — https://huggingface.co/vietanhdev/segment-anything-2.1-onnx-models, Apache-2.0.

The model is not part of the repository or the installer, so it is not redistributed by Thrustbook.
The application shows the model name, precision and license in the tracking panel and names the
source page in this notice.

## Build and packaging dependencies

| Component | Version | License | Purpose |
| --- | --- | --- | --- |
| TypeScript | 7.0.2 | Apache-2.0 | Type checking and build |
| Vite | 8.3.8 | MIT | Renderer build/dev server |
| esbuild | 0.28.2 | MIT | Main, preload and worker bundling |
| electron-builder | 26.18.0 | MIT | Windows/Linux/macOS packaging |
| @vitejs/plugin-react | 6.3.0 | MIT | React transform |
| @types/node / @types/react / @types/react-dom | as pinned in `package.json` | MIT | Type declarations |
| @types/adm-zip | as pinned in `package.json` | MIT | Type declarations |

## Transitive dependencies

The complete resolved tree and versions are recorded in `package-lock.json`; each package carries
its own license file under `node_modules`. Declared licenses are predominantly MIT, ISC,
BSD-2-Clause, BSD-3-Clause and Apache-2.0.

The only non-permissive license found in the installed tree is:

| Component | License | Notes |
| --- | --- | --- |
| `lightningcss` and `lightningcss-win32-x64-msvc` 1.33.0 | MPL-2.0 | Build-time CSS minifier used by Vite. MPL-2.0 is file-level copyleft: it does not require releasing Thrustbook's source. The unmodified package is used; its source is available at https://github.com/parcel-bundler/lightningcss |

No GPL, AGPL, SSPL or commercial runtime dependency was found in the installed dependency tree.
No proprietary codec, paid API or mandatory network service is included. The optional SAM 2.1 model
is Apache-2.0 and runs on the local CPU.

## Media decoding

Thrustbook does not ship a standalone FFmpeg executable. Video decoding, frame presentation
timestamps and `requestVideoFrameCallback` are provided by the Chromium media stack inside Electron,
including Chromium's bundled FFmpeg library. Electron distributes its own `LICENSES.chromium.html`
and `LICENSE` with the runtime; those files contain the Chromium, FFmpeg and other third-party
notices. The application does not modify or redistribute those binaries separately.

Supported containers/codecs therefore depend on the Chromium build shipped with Electron. The UI
reports a decoding error when a file cannot be decoded rather than substituting a different codec.

## Distribution actions

Packaged builds include this notice and the project `LICENSE`. Electron's `LICENSE` and
`LICENSES.chromium.html` are distributed by the Electron runtime. The MIT texts for
`onnxruntime-node` and `adm-zip` and the Apache-2.0 text for OpenCV.js are reproduced in
`THIRD_PARTY_LICENSES/`. Build-time-only MPL-2.0
packages are not present in the application bundle. The SAM 2.1 model is fetched at the user's
request and is not included in any installer or archive produced by this repository.

If a dependency is updated, re-run the license inventory before publishing a release and update
this file with the new version, license and obligations.
