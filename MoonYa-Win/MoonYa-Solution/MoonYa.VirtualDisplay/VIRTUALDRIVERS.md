# Persistent VirtualDrivers backend

> Historical implementation only. MoonYa now uses the physical primary desktop. This project is not started or packaged by the client; see `../MoonYa.DesktopCapture/README.md`. Existing disabled virtual devices remain disabled.

The current trial uses an unmodified signed driver from VirtualDrivers release `25.7.23`, one persistent 1920×1080 60Hz monitor, and MoonYa's existing capture and input host. The monitor shares Windows focus, pointer and clipboard with physical screens; this is not input isolation.

`desktop_automation.provider` in `launcher_config.json` selects `virtualdrivers` or the retained `moonya` backend. `installation_record` identifies the installer JSON, defaulting to `%LOCALAPPDATA%\MoonYa\virtual-display\installation.json`. Runtime acquisition resolves the recorded PnP ancestor to exactly one monitor interface path and refuses the primary display. A changed path, layout or disconnected display stops input. Chat cleanup restores moved windows and releases capture and held inputs; it does not remove the persistent monitor.

## Installation and device state

Run the following scripts in an elevated x64 Windows PowerShell session. The installer verifies the pinned ZIP SHA256 and trusted CAT/DLL signatures, rejects existing MttVDD installations or configuration, captures the pre-install devices, driver packages, screen bounds and publisher certificates, and records every system change. It does not change boot policy, Secure Boot or test-signing settings.

```powershell
.\Install-VirtualDrivers.ps1
# Alternatively use -PackageZip with the original upstream release archive.
.\Set-VirtualDriversState.ps1 -State Disabled
.\Set-VirtualDriversState.ps1 -State Enabled
```

The package's `x86` filename is upstream naming; its INF targets `NTamd64`. The release archive SHA256 is `e24210692b442b39af763536330ce78b423f19342b7a7792c26de3944e418b3a`. A trusted SignPath Foundation signer is required. The optional publisher trust is added only to LocalMachine TrustedPublisher, never Root.

The state script targets only the installation's verified `Root\MttVDD` device. Do not kill a shared `WUDFHost.exe` process. When an explicitly requested desktop session starts, the host detects problem code 22 and invokes its packaged state component with elevation to enable the installed device, then waits for its monitor and verifies that the primary display identity is unchanged. Merely opening MoonYa does not enable or install drivers. Other device errors are reported and do not trigger a repeated enable operation.

## Rollback and diagnostics

Close MoonYa, then run `Rollback-VirtualDrivers.ps1` elevated. It removes only the recorded new device, the recorded new driver package when unused, and the publisher certificate if this installation added it. It removes the unchanged owned configuration file and deletes the directory only when empty. Modified configuration and other files are preserved. Original installation records and transcripts remain available.

The installation directory contains `installation.json`, `install.log`, `rollback.log` and `device-state.log`. Runtime display acquisitions and invalidations are logged to `%LOCALAPPDATA%\MoonYa\logs\desktop-display.jsonl` without preview tokens. A failed installation requires inspection/rollback before a retry; archive its record afterward rather than deleting logs.

The independent preview opens by clicking the chat preview card. It has a white title bar, centered rounded screen preserving its aspect ratio, and a compact bottom row for takeover, resume and stop. Closing the preview disconnects its stream; it is not a driver uninstall action.

Observations bind to the virtual-output target rather than to the viewer's foreground window. Before input the host focuses that observed target, then restores the physical-screen foreground and cursor after consumption. Held mouse/key sequences retain their return context until release. This remains shared Windows input, not VM/session isolation; concurrent human input is still handled through takeover.

## Verification

`MoonYa.DesktopSmoke` covers PnP identity, ambiguous and missing devices, primary-display rejection, repeated acquisition, path replacement, disconnect and persistent release. `--preview-style INPUT.png OUTPUT.png` renders the real WPF layout offline without starting MoonYa, streaming or creating a monitor. `--display-inventory` prints display paths, ancestors and screen bounds.

The live Harness fixture `MoonYa-Harness/scripts/verify-live-desktop.mjs` uses the running client's real Python/native path and a deterministic local model endpoint. Inspect its final screenshot before claiming a numeric result; successful tool returns alone do not prove the rendered result. `--restart` verifies history continuation across a Harness restart. This is not a live LLM acceptance test.
