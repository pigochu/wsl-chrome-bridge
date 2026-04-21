wsl-chrome-bridge Change Log
============================

0.3.0 2026-04-21
-----------------------
 - Added Chrome instance reuse by matching `--user-data-dir` on Windows and reusing the matched instance `--remote-debugging-port` when available.
 - Added runtime ownership model (`attached` / `launched`) and removed bridge-driven Chrome termination from cleanup to keep user Chrome sessions intact.
 - Added `ws` degraded-state recovery flow: keep bridge alive after Chrome disconnect and recover on next upstream request.
 - Added disconnect heuristics with weak/strong signals and a bounded weak-event cache (10 events, 2-second correlation window) to classify browser-level disconnects.
 - Added recovery bootstrap via internal `Target.setAutoAttach` before queue flush, so upstream can receive fresh `Target.attachedToTarget` session events after reconnect.
 - Added degraded-state short-circuit for `Browser.close` when Chrome is already known disconnected, returning a synthetic success response without relaunching Chrome.
 - Improved relay diagnostics: enforced UTF-8 relay stdio and added structured exception logging (`hresult`, websocket/socket error codes, inner chain, stack top, socket state).

0.2.1 2026-04-20 (This version was not published to npmjs)
-----------------
 - Added relay CDP logging with explicit hop direction and message type labels (`Request` / `Response` / `Event`).
 - Added `WSL_CHROME_BRIDGE_DEBUG_RAW_DIR` to store large raw CDP payload fragments while keeping main logs readable.
 - Added `WSL_CHROME_BRIDGE_DEBUG_LEVEL` with `important` (default) and `all` modes for debug log volume control.
 - Added focused filtering for important session/navigation/disconnect CDP methods, including request-response method correlation by `id` and `sessionId`.
 - Added bounded request-method tracking (max 100 entries) and response-time cleanup to avoid unbounded memory growth.


0.2.0 2026-04-19
-----------------
 - Added `WSL_CHROME_BRIDGE_DEBUG_FILE` env support to write bridge debug logs to a target file.
 - Added `WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT` env support to control the Windows Chrome debug port.
 - Added `WSL_CHROME_BRIDGE_EXECUTABLE_PATH` env support for overriding Windows Chrome executable path.
 - Added `WSL_CHROME_BRIDGE_USER_DATA_DIR` env support to force the Windows Chrome profile path.
 - Deprecated and rejected `--bridge-chrome-executablePath`; use `WSL_CHROME_BRIDGE_EXECUTABLE_PATH` instead.
 - Updated `--user-data-dir` handling to restore Windows paths and only pass valid Windows-style paths to Chrome.
 - Added safe cleanup for Playwright-created local `--user-data-dir` artifacts: remove only when the directory is empty.
 - Added Playwright compatibility for `--remote-debugging-port` bridge flow (local proxy mode).
 - Improved temporary PowerShell script workspace layout under `/tmp/wsl-chrome-bridge-tmp`.

0.1.0 2026-04-08
-----------------
 - Initial version
