# Desktop implementation verification — 2026-09-26

This is a development implementation with compiled native components. It is not a signed or accepted production driver release. Existing workspace changes were preserved. No display driver, signing certificate or system boot-policy change was installed on the development computer.

## Verified locally

| Area | Evidence | Result |
| --- | --- | --- |
| Original skill | SHA-256 against the supplied file; Git newline conversion disabled; editing the preserved original rejected; compatibility reference separate | Passed |
| Skill disclosure | PHP catalog and old-name alias checks; Harness integration reads the real original body and reference before its Python cell | Passed |
| Python compatibility | Application-bundled Python executes every documented helper against a controlled HTTP host; screenshot bytes/dimensions, Chinese text, fresh globals, unique operation IDs and input release | Passed |
| Takeover protocol | Model → skill → Python → takeover → completion → fresh image → cleanup, using a controlled host; cancellation aborts a paused RPC without replay | Passed |
| Harness suite | `npm test`, 65 passed, 1 skipped because the built-in browser service at localhost:58905 was not running | Passed with stated skip |
| Frontend | Headless Chromium renders video fixture, blue pointer and takeover status, opens the window bridge and reconnects; approval/SSE/IME tests (6 total); 12 PHP module JavaScript syntax checks | Passed |
| PHP contracts | `desktop_skill_test.php`, `skill_catalog_test.php`, `harness_browser_contract_test.php` | Passed |
| Coordinate/ownership smoke | Negative monitor origins, corners and center at several resolutions; preview/control denied for an unknown session; no monitor creation or input | Passed |
| Client | Windows x64 Debug and Release builds; existing nullable/unused-field warnings remain | Passed |
| Native components | Release x64 capture DLL, device host and UMDF/IddCx driver; pinned WDK dependencies | Passed; 2 WDK header alignment warnings |
| Driver package | INF universal validation and Inf2Cat generation | Passed, catalog **unsigned** |
| Release gate | Trusted signature check rejects the actual unsigned package before compilation/installation | Passed rejection |
| Source restriction | New desktop source files scanned for the user-prohibited brand terms | Passed |

## Pending acceptance and release

- A Microsoft-signed driver catalog, installer code-signing certificate and Inno Setup compiler are required to produce the single signed MoonYa setup executable. The installer source integrates driver installation and removal; end users do not install a separate driver.
- No test signing, production signing, driver install/reboot/uninstall or sleep/resume test has been performed.
- Real Calculator and Notepad/Chinese-save/read-back loops are pending. Mock RPC tests do not establish application-discovery correctness on a real target, package-window matching, input focus or clipboard integration.
- The two real viewer surfaces, scaled/letterboxed pointer mapping, different DPI values, shared-focus mouse dragging, keyboard takeover, held-input release and concurrent-chat exclusion need dedicated Windows acceptance. Compilation and a browser video fixture do not establish these behaviors on the virtual monitor.
- Monitor/capture removal, stream loss, capture recovery, driver restart and uncertain launch outcomes need real fault-injection acceptance. The host never falls back to the primary monitor.
- The 1080p/15 FPS and P95 ≤500 ms goals have not been measured.

See `README.md` for the dedicated-environment checklist and `../../Installer/README.md` for single-installer packaging.
