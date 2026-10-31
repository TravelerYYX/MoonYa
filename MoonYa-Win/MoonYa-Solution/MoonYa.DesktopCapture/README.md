# Physical desktop capture

Run `./Build-Capture.ps1` to build the x64 DXGI capture DLL independently using Visual Studio C++ tools and the Windows SDK. WDK and display drivers are not required. Build this component before the Windows client.

The physical desktop service selects the current primary output at its actual resolution. The same capture supplies PNG model observations and JPEG previews. It never creates a monitor, changes display settings or falls back to another output. A lost capture or changed display layout ends the session. Reconnect and take a fresh observation.

MoonYa windows are excluded from capture during a session to avoid recursive previews. They remain visible on the actual desktop, and automation rejects input into MoonYa itself. User takeover means directly operating the actual application; preview input forwarding is disabled.

The old `MoonYa.VirtualDisplay` and `MoonYa.DesktopHost` projects remain as historical sources and are not runtime or release dependencies.
