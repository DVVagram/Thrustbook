# Third-party notices and license inventory

Thrustbook itself is released under the MIT License (see `LICENSE`). This file records the
third-party components used by the application, their versions, licenses and distribution
requirements. It is shipped with packaged builds.

No GPL or AGPL dependency is included in the application dependency tree. No paid, cloud or
AI service is required by the Video & Image Analysis module.

## Runtime dependencies

| Component | Version | License | Purpose | Distribution requirement |
| --- | --- | --- | --- | --- |
| Electron | 45.4.1 | MIT | Desktop runtime (Chromium + Node.js) | Include Electron's MIT copyright and license; Electron's own `LICENSE` and `LICENSES.chromium.html` are distributed with the Electron runtime |
| @techstark/opencv-js | 4.12.0-release.1 | Apache-2.0 | OpenCV.js WebAssembly build used for optical flow and feature detection | Include the Apache-2.0 license and copyright notice; state any modifications. The package is used unmodified |
| electron-updater | 6.8.11 | MIT | Optional update checking/installation | Include MIT copyright and license |
| React | 19.3.1 | MIT | Renderer UI | Include MIT copyright and license |
| React DOM | 19.3.1 | MIT | Renderer UI | Include MIT copyright and license |

The OpenCV.js build is derived from OpenCV (https://opencv.org/, https://github.com/opencv/opencv),
Copyright (C) OpenCV contributors, licensed under Apache-2.0. The `@techstark/opencv-js` package
redistributes the official OpenCV.js build and TypeScript declarations.

## Build and packaging dependencies

| Component | Version | License | Purpose |
| --- | --- | --- | --- |
| TypeScript | 7.0.2 | Apache-2.0 | Type checking and build |
| Vite | 8.3.8 | MIT | Renderer build/dev server |
| esbuild | 0.28.2 | MIT | Main, preload and worker bundling |
| electron-builder | 26.18.0 | MIT | Windows/Linux/macOS packaging |
| @vitejs/plugin-react | 6.3.0 | MIT | React transform |
| @types/node / @types/react / @types/react-dom | as pinned in `package.json` | MIT | Type declarations |

## Transitive dependencies

`npm ls --all` resolves 266 installed packages in this workspace. Their declared licenses are
predominantly MIT, ISC, BSD-2-Clause, BSD-3-Clause and Apache-2.0. The complete resolved tree and
versions are recorded in `package-lock.json`; each package carries its own license file under
`node_modules`.

The only non-permissive license found in the installed tree is:

| Component | License | Notes |
| --- | --- | --- |
| `lightningcss` and `lightningcss-win32-x64-msvc` 1.33.0 | MPL-2.0 | Build-time CSS minifier used by Vite. MPL-2.0 is file-level copyleft: it does not require releasing Thrustbook's source. The unmodified package is used; its source is available at https://github.com/parcel-bundler/lightningcss |

No GPL, AGPL, SSPL or commercial runtime dependency was found in the installed dependency tree.
No proprietary codec, AI model, paid API or mandatory network service is included.

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
`LICENSES.chromium.html` are distributed by the Electron runtime. The Apache-2.0 text for
OpenCV.js is reproduced in `THIRD_PARTY_LICENSES/opencv-js-LICENSE.txt`. Build-time-only MPL-2.0
packages are not present in the application bundle.

If a dependency is updated, re-run the license inventory before publishing a release and update
this file with the new version, license and obligations.
