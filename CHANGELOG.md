wsl-chrome-bridge Change Log
============================

0.2.0 2026-04-18
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
