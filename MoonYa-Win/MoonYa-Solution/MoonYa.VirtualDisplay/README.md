# MoonYa virtual desktop components

> Historical implementation only. MoonYa now uses the physical primary desktop. This project is not started or packaged by the client; see `../MoonYa.DesktopCapture/README.md`. Existing disabled virtual devices remain disabled.

The Windows x64 implementation creates one additional 1920×1080 SDR display in the current Windows session. Mouse, keyboard focus and clipboard remain shared. The primary display is never used as an automation fallback.

## Build and packaging

Run `./Build-Desktop.ps1` from PowerShell. Visual Studio C++ tools and Windows SDK 10.0.26100 are required. The script restores pinned WDK NuGet dependencies to `.cache`, builds the capture DLL, software-device host and UMDF driver, validates the INF and creates an **unsigned** catalog. It does not install a driver or change system settings.

Build these native components in Release before building/publishing `MoonYa.csproj`; the client copies the capture DLL and device host into its output. The single MoonYa installer in `../../Installer` embeds the signed driver package and installs it automatically. Users never install a separate driver. Development DLL/catalog output is not a production release.

For a dedicated test machine/VM, provision the normal Windows test-signing environment separately, sign the catalog with the designated test certificate, and trust that certificate only in that environment. Then run `Install-Driver.ps1 -PackagePath ... -TestEnvironment` as administrator. This script requires an already trusted signature and never enables test signing, disables Secure Boot or bypasses signature enforcement. For production, obtain the appropriate Microsoft driver signing before distribution.

## Runtime interfaces

- Harness: `computer_use_tool(plane="cu", code, title)`; `interaction_request_action(type="desktopControl", display_message)`.
- Internal host: POST `/desktop/start`, `/desktop/rpc`, `/desktop/control`, `/desktop/release`, `/desktop/stop`, authenticated using the per-process `x-moonya-host-token`. Browser-origin requests cannot call these routes.
- Preview: a session-scoped, random-token WebSocket `/desktop/stream`; state JSON and JPEG frames. The trusted main CEF page obtains a token through `moonYaDesktop.preview(sessionId)`. Other browser panels do not register this bridge. No video frames are sent to the model.
- Control messages are `control` with `takeover`, `resume` or `stop`; `input` with `method`/`args` is accepted only when the owner is human; `release` clears held inputs.
- The software-device host holds a `SwDeviceCreate` handle until STOP or parent pipe closure. The driver enumerates one monitor; creating/removing the device supplies monitor lifecycle rather than a permanent global monitor.

Python is not a sandbox. File and shell work remain under the existing workspace/host policy. All compatibility GUI methods use host mediation, normalized coordinates, a live owned-monitor check and explicit screenshot observations. Unknown action results cannot be replayed with the same operation ID.

## Dedicated-environment acceptance

1. Install the signed test package; verify that physical primary status remains unchanged and only one MoonYa monitor appears. Restart and uninstall; verify that no unrelated display device is removed.
2. Launch Calculator using discovery, take a fresh screenshot, compute `123 + 456`, and visually verify `579`.
3. Discover and launch Notepad, take a fresh screenshot, enter Chinese text, save within the chosen workspace, and read the resulting file back in the same cell.
4. View the chat thumbnail and independent window simultaneously. Check cursor motion/click rings, resizing with letterboxing, and user pointer drag/scroll/Chinese keyboard input after takeover.
5. Take over during a cell, confirm AI input is paused, then resume and confirm old observations are rejected. Cancel a cell while holding a modifier; verify key/button release.
6. Run two chats, disconnect the monitor, change its layout/DPI, interrupt capture, and restart the driver. Confirm clear errors, no primary-screen fallback and no repeated side effects.
7. Verify sleep/resume recovery by restarting the screen session after a lost DXGI lease. Measure 1080p preview at 15 FPS with P95 capture-to-presentation latency ≤500 ms on the test hardware. Record results rather than inferring them from compilation.

Actual monitor installation, application GUI loops, sleep/resume and video performance require this dedicated environment. They have not been verified merely by building this repository.

## Source provenance

`Driver.cpp` and `Driver.h` derive from Microsoft's Windows-driver-samples, commit `2dc3fd3a0cc84a2933f2194e7ec0871584979071`, directory `video/IndirectDisplay/IddSampleDriver`. The Microsoft Public License is included in `LICENSE.MS-PL`. MoonYa changes restrict the monitor count, identify the adapter, use EDID-less SDR modes and separate build/sign/install workflows.

VirtualDrivers/Virtual-Display-Driver commit `d7244969b2aa8bb38e76d79505eda217996cefea` is recorded as an architectural reference for display modes and device control; no source or signed binary from that project is included. Capture, software-device host and MoonYa integration code are implemented here.
