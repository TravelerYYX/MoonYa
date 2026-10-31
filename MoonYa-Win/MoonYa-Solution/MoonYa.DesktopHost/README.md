# Hidden-desktop feasibility host

> Historical implementation only. MoonYa now uses the physical primary desktop. This project is not started or packaged by the client; see `../MoonYa.DesktopCapture/README.md`. Existing disabled virtual devices remain disabled.

This project is deliberately **not connected to MoonYa**. The accepted plan requires the installed Calculator and Edge to pass isolation checks before integration. That gate has not passed.

The executable creates a uniquely named Win32 desktop on a pristine worker thread and starts an application there with `STARTUPINFO.lpDesktop`. A kill-on-close job owns the application before its first instruction runs. Windows are enumerated through the explicit desktop handle and checked against that job. Capture composites `PrintWindow` output into a 1920×1080 logical frame. Coordinate actions search UI Automation descendants of verified window handles only; unsupported actions fail.

There is no `SwitchDesktop`, global `SendInput`, `ElementFromPoint`, foreground activation, physical-screen capture, or host-shell launch fallback. A 35-second deadline exits the worker process and closes its owned job if a capture or UIA call blocks. This probe is not a general-purpose production desktop service: hotkeys, drag/scroll, window controls, readiness, recovery, preview and application catalog integration remain unimplemented.

Build:

```powershell
dotnet build MoonYa.DesktopHost.csproj -c Debug
```

Probe arguments are an output directory, an installed application executable, optional command-line arguments, an optional coordinate-action JSON file and an optional package family name. No calculator-specific action or executable name is embedded in the host.

```text
MoonYa.DesktopHost --probe OUTPUT APPLICATION [ARGUMENTS] [ACTIONS_JSON] [PACKAGE_FAMILY]
```

For startup crash diagnosis, replace `--probe` with `--diagnose`. This attaches the native debugger only at creation of the owned application, records first/second-chance exception addresses and registers in `debug-events.json`, and writes `crash.dmp` on a second-chance exception. It does not attach to existing user processes, patch application memory or retry on the physical desktop. Startup diagnosis has a 15-second deadline inside the outer 35-second probe watchdog. Dumps remain local and may contain application memory.

Each action is either `{"method":"click","x":348,"y":60}` or `{"method":"type","x":400,"y":100,"text":"..."}` in logical pixel coordinates. Controls, screenshots, launch failure, before/after physical desktop state and process cleanup are recorded under the output directory.

For an AppContainer probe, only the newly-created desktop receives an explicit package SID grant and a low-integrity label; Default, WinSta0 and pre-existing objects are not modified. This adjusted launch still failed for the installed Calculator and is retained as a diagnostic attempt, not a verified production launch strategy.

## Actual results, 2026-09-27

- Edge 153.0.4234.48: startup, native screenshot, coordinate click creating a tab, and text entry through scoped UIA succeeded. Foreground HWND, physical mouse position, active input desktop and physical display layout were unchanged before/after; owned process cleanup passed. A separate browser profile was used, though Edge may apply Windows account sign-in automatically. No account dialog was accepted by the test.
- Installed Calculator 11.2607.0.0: ordinary hidden-desktop launch exited `0xC0000142` before creating a window. Adding the package grant on the newly-created desktop changed the failure to `0xC0000005`. Windows Application event 1000 identifies `CoreUIComponents.dll` 10.0.26100.9278, offset `0x2a25e`. The precise cause is unresolved. Both failed probes preserved physical foreground/mouse/display state and cleaned up their owned application processes.
- A follow-up owned-process diagnostic (`calculator-5`) reproduced the same exception and captured RAX `0x87B20C1C`. Matching Microsoft public symbols identify `Windows::Phone::UI::Core::NavigationClient::Initialize + 0x356`. Read-only disassembly shows an intentional null write after a failed `NavigationClient::SetState` call; the meaning and safe remedy for its failure remain unresolved. Physical state and process cleanup checks passed again. This is additional blocker evidence, not a successful isolation acceptance.
- Evidence from repository root: `artifacts/hidden-desktop/edge-5`, `artifacts/hidden-desktop/calculator-3`, `artifacts/hidden-desktop/calculator-4`, and `artifacts/hidden-desktop/VERIFICATION.md`.

Historical result: the hidden-desktop isolation gate failed. MoonYa now uses `desktop_automation.provider=physical` by explicit product decision. This host remains disconnected and its isolation gate is not claimed to have passed. The old VirtualDrivers device remains disabled and is never enabled by the physical provider.
