# Upgrade Guide: 0.1.0 -> 0.2.0

This document describes the required and recommended changes when upgrading `wsl-chrome-bridge` from `0.1.0` to `0.2.0`.

## 1. Required Changes

### 1.1 Use environment variable for debug log

Starting in `0.2.0`, the legacy format below is deprecated and will fail:

- `--chrome-arg=--bridge-debug-file=/tmp/xxx.log`

Use MCP `env` instead:

```toml
WSL_CHROME_BRIDGE_DEBUG_FILE = "/tmp/debug-bridge.log"
```

### 1.2 Use environment variable for Chrome executable path

Starting in `0.2.0`, the legacy format below is deprecated and will fail:

```text
--bridge-chrome-executablePath=C:\Custom\Chrome\chrome.exe
```

If you pass it through `chrome-devtools-mcp`, this is a common old form:

```text
--chrome-arg=--bridge-chrome-executablePath=C:\Custom\Chrome\chrome.exe
```

Use MCP `env` instead:

```toml
WSL_CHROME_BRIDGE_EXECUTABLE_PATH = "C:\\Custom\\Chrome\\chrome.exe"
```

### 1.3 Official `--user-data-dir` support and new recommended env

In `0.2.0`, only Windows-style paths are forwarded to Windows Chrome.
Resolved forms such as `/cwd/%TEMP%\\...` will be normalized back to a Windows path when possible.

Also, Playwright may create a local Linux-path directory first and then pass it to bridge.
Bridge now checks that path and safely removes it only when it is empty; non-empty directories are kept.
`chrome-devtools-mcp` usually does not have this empty-directory side effect.

So while `--user-data-dir` is still supported, the recommended approach is MCP `env`:

```toml
WSL_CHROME_BRIDGE_USER_DATA_DIR = "%TEMP%\\wsl-chrome-bridge\\chrome-profile-xxx"
```

`--user-data-dir` still works, but using `WSL_CHROME_BRIDGE_USER_DATA_DIR` is recommended to keep a unified configuration style across both MCPs.

If you previously used:

```text
--chrome-arg=--user-data-dir=%TEMP%\wsl-chrome-bridge\chrome-profile-xxx
```

After upgrading to `0.2.0`, migrate to the `WSL_CHROME_BRIDGE_USER_DATA_DIR` approach above.

## 2. Recommended Changes

### 2.1 Optional fixed debug port via environment variable

If you need a fixed port (for example firewall rules or debugging tools), set:

```toml
WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT = "9222"
```

If you previously used:

```text
--chrome-arg=--bridge-remote-debugging-port=9222
```

In `0.2.0`, migrate to MCP `env` using `WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT`.
Using environment variables is recommended to avoid mixed styles between different MCP setups.

If not specified, `0.2.0` now defaults to a random available port instead of fixed `9222`.

### 2.2 Use different profiles for chrome-devtools and playwright (optional but strongly recommended)

If both tools share the same profile (via either `--user-data-dir` or `WSL_CHROME_BRIDGE_USER_DATA_DIR`), they may interfere with the same Windows Chrome instance.
Use separate profile directories for each MCP.

### 2.3 For Playwright, add `--browser chrome`

In bridge + Windows Chrome scenarios, `playwright-mcp` without an explicit browser channel may send `--no-sandbox`, which can show a warning banner in Chrome.

Add this in Playwright MCP args:

```text
--browser chrome
```

This is a configuration recommendation and does not change bridge core behavior, but it avoids the common `--no-sandbox` UI warning.

## 3. Verification Checklist

After upgrading, use this quick checklist:

1. Start `chrome-devtools-mcp` and verify bridge can open pages.
2. Start `playwright-mcp` and verify navigation works (for example `https://www.google.com`).
3. Check debug log (`WSL_CHROME_BRIDGE_DEBUG_FILE`):
   - Contains `launchPlan` / `windowsArgs`
   - `windowsUserDataDir` or `--user-data-dir` inside `windowsArgs` matches your expected Windows path

## 4. Example (MCP env)

```toml
env = {
  WSL_CHROME_BRIDGE_DEBUG_FILE = "/tmp/debug-bridge.log",
  WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT = "9222",
  WSL_CHROME_BRIDGE_USER_DATA_DIR = "%TEMP%\\wsl-chrome-bridge\\chrome-profile-bridge"
}
```

`WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT` is optional; when omitted, bridge uses a random available port.
