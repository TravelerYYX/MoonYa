# MoonYa runtime compatibility

Read this document together with SKILL.md before executing desktop cells. SKILL.md is preserved verbatim.

- `computer_use_tool(plane="cu", code, title)` runs a fresh Python process with the standard library and bundled `seed_computer_use` compatibility module. Only `cu` is supported by this tool.
- The computer's screen is the current Windows physical primary monitor. Screenshots and all 0–1000 coordinates refer to that monitor's actual resolution, not the union of monitors. Do not use other monitors or any virtual desktop.
- `interaction.request_action` maps to `interaction_request_action(type="desktopControl", display_message="...")`. This pauses AI input. The person operates the actual application directly on the physical desktop, then explicitly resumes AI. Always take a fresh screenshot afterward.
- `Read`, `Write`, `Glob`, `Grep` and shell map to `read_file`, `create_file`/`edit_file`, `glob`, `grep` and `execute_command`. Files remain subject to the selected workspace and user authorization. Python is not a security sandbox.
- For installed/local browser tasks, use `cu` throughout. Only explicitly requested built-in browser tasks use `browser_automation_control` and its browser skill. Never change surfaces silently.
- The physical desktop shares mouse, keyboard, focus and clipboard with the user. Fresh observations are required after foreground or window geometry changes. The host never silently refocuses an old observed application. Use screenshots between actions that change the target.
- The chat preview card opens the separate MoonYa physical-desktop preview window. Both show the same primary screen. Preview windows only provide observation, takeover, resume and stop; they never forward mouse or keyboard input. MoonYa windows are excluded from capture to prevent recursive previews, but still occupy the physical screen. Never click or type into MoonYa itself; ask the user to minimize it if it obstructs a target.
- Launching an application activates its normal window and does not move or resize it. An application opening outside the primary screen needs the user to move it; do not repeat an accepted but unverified launch. App discovery bindings persist across fresh Python cells; a new listing invalidates the old generation.
- A changed primary monitor, layout or DPI, lock/security desktop, or lost capture ends the desktop session and releases held inputs. Re-establish the session and observe again. Do not invent shell scripts to enable/install virtual devices or bypass desktop initialization errors.
- Screenshots returned by `cu.screenshot()` enter model vision; continuous preview frames do not. User-visible activity uses `title`, code output and screenshots, never hidden reasoning.
