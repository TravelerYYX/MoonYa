# Third-party notices

The desktop frontend bundles the same fixed browser libraries as the original UI:
Highlight.js 11.9.0 (BSD 3-Clause, copyright Ivan Sagalaev), Mammoth.js 1.8.0
(BSD 2-Clause, copyright Michael Williamson), and Mozilla PDF.js 3.11.174
(Apache-2.0). Their full upstream licenses ship in
`frontend/vendor/highlight-LICENSE.txt`, `mammoth-LICENSE.txt`, and `pdfjs-LICENSE.txt`.
Sources: https://github.com/highlightjs/highlight.js/tree/11.9.0,
https://github.com/mwilliamson/mammoth.js/tree/1.8.0,
https://github.com/mozilla/pdf.js/tree/v3.11.174.

The optional `virtualdrivers` backend installs the unmodified signed VirtualDrivers/Virtual-Display-Driver release `25.7.23` from its upstream GitHub release. The source project is MIT licensed; no upstream driver source or signed binary is bundled in MoonYa's application package. Installation downloads or accepts the pinned upstream archive separately. Upstream source, license and releases: https://github.com/VirtualDrivers/Virtual-Display-Driver. MoonYa's display adapter and installer scripts are implemented here.

MoonYa.VirtualDisplay includes adapted `Driver.cpp` and `Driver.h` from [Microsoft Windows-driver-samples](https://github.com/microsoft/Windows-driver-samples/tree/2dc3fd3a0cc84a2933f2194e7ec0871584979071/video/IndirectDisplay/IddSampleDriver), commit `2dc3fd3a0cc84a2933f2194e7ec0871584979071`. Copyright (c) Microsoft Corporation. These files are governed by the Microsoft Public License; the full license is included at `MoonYa-Win/MoonYa-Solution/MoonYa.VirtualDisplay/LICENSE.MS-PL` and must accompany redistributions.

MoonYa incorporates and adapts concepts and source components from DeepSeek Harness.

The per-turn workspace change recorder adapts the queue and whole-file capture design of DeepSeek Harness's `packages/deliverables/workspace-changes`. `MoonYa-Harness/src/workspace-compare.mjs` adapts its `compare.ts` to JavaScript. Source hashes are recorded in `workspace-changes-source.json`, and the MIT license ships in `agent_runtime/src/workspace-changes-LICENSE.txt`. MoonYa adds persistent raw-byte backups, non-Git workspace scanning, guarded undo and default-directory migration. Text comparisons use jsdiff 9.0.0 (BSD-3-Clause), and ignore rules use node-ignore 7.0.5 (MIT); their licenses ship with the runtime dependencies.

The Work subagent runtime directly bundles the `subagent`, `subagent-spawn-in-process`, `subagent-in-process-driver`, `tool-subagent`, and `tool-subagent-control` source packages from `deepseek-harness-master`, with MoonYa package prefixes. The generated `MoonYa-Harness/src/subagent-source.json` records hashes of the 34 original files. Cordis Agent/Session and persistence dependencies are bundled with them. The build verifies source equivalence before packaging.

Windows durable session persistence uses Koffi 3.1.1 by Niels Martignène, MIT licensed. Its full license accompanies distributions in `agent_runtime/node_modules/koffi/LICENSE.txt` and is included in the single-file runtime assets. DeepSeek and the bundled source dependency licenses are collected in `agent_runtime/src/subagent-LICENSE.txt`.

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
