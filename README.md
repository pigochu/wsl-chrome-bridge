# wsl-chrome-bridge

<p>
  <a href="./README-zh.md">
    <strong><span style="font-size: 1.2em;">[繁體中文說明請按此]</span></strong>
  </a>
</p>

This project provides a CLI tool: `wsl-chrome-bridge`.

From [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)'s perspective, `wsl-chrome-bridge` behaves like a Chrome executable.
It provides a DevTools connection entry in WSL and bridges CDP messages to Windows Chrome.

With the original `chrome-devtools-mcp` setup, you only need to change `--executablePath` and add a few bridge-specific arguments to let WSL agents control Windows Chrome, without system-level setup (for example `netsh interface portproxy` forwarding or WSL2 mirrored mode).

This idea came from [wsl-chrome-mcp](https://github.com/477174/wsl-chrome-mcp), which uses PowerShell to work around the same limitation. That project provides MCP server capability itself, while this project keeps using the widely maintained `chrome-devtools-mcp` and adds a bridge layer.

## Breaking Changes in 0.2.0 (Playwright Support)

`0.2.0` adds `playwright-mcp` compatibility and includes multiple bridge argument/configuration adjustments.

If you are upgrading from `0.1.0`, read the upgrade guide first: [UPGRADE.md](./UPGRADE.md).

## How It Works

```text
[Chrome DevTools MCP]             [Playwright MCP]
         |                              |
      stdio pipe                remote-debugging-port
         |                              |
         +------[wsl-chrome-bridge]-----+
                         |
            PowerShell websocket relay
                         |
                 [Windows Chrome]
```

`wsl-chrome-bridge` will:

- Accept Chrome launch arguments from both `chrome-devtools-mcp` and `playwright-mcp`
- Launch Windows Chrome via PowerShell
- In `chrome-devtools-mcp` mode, receive/return CDP messages through stdio pipe (OS pipe)
- In `playwright-mcp` mode, create a local WebSocket proxy on the mapped port and forward CDP traffic through it
- Relay CDP messages bidirectionally to Windows Chrome through PowerShell websocket relay

## Requirements

- Windows 11 with the latest Chrome installed
- `powershell.exe` available for WSL2
- WSL2 with Node 20+

## Install and Use

### Install

In WSL, choose one of the following installation methods:

1. Install globally with `npm install -g wsl-chrome-bridge`.
2. Or clone source, build it, then install with `npm link`:

```bash
git clone https://github.com/pigochu/wsl-chrome-bridge.git
cd wsl-chrome-bridge
npm install
npm run build
npm link
```

### Example (Codex)

1. Find the actual path of `wsl-chrome-bridge`, for example `/home/pigochu/.local/share/mise/shims/wsl-chrome-bridge`.
2. Configure `.codex/config.toml` like this.

Minimal working `chrome-devtools-mcp` setup:

```toml
[sandbox_workspace_write]
network_access = true

[mcp_servers.chrome-devtools]
command = "npx"
args = [
    "-y",
    "chrome-devtools-mcp@latest",
    "--executablePath",
    "/home/pigochu/.local/share/mise/shims/wsl-chrome-bridge"
]
enabled = true
```

This is the minimum working setup. `wsl-chrome-bridge` launches Windows Chrome and relays CDP traffic for `chrome-devtools-mcp` without extra bridge-specific arguments.

Minimal working `playwright-mcp` setup (with sandbox):

```toml
[sandbox_workspace_write]
network_access = true

[mcp_servers.playwright]
command = "npx"
args = [
    "-y",
    "@playwright/mcp@latest",
    "--browser",
    "chrome",
    "--sandbox",
    "--executable-path",
    "/home/pigochu/.local/share/mise/shims/wsl-chrome-bridge"
]
enabled = true

[mcp_servers.playwright.env]
DISPLAY = ":9999"
```

In bridge + system Chrome usage, `--browser chrome` helps avoid upstream `--no-sandbox` warning behavior while keeping Playwright launch behavior stable.

> [!NOTE]
> See the FAQ for how to locate `--executablePath`.
> For more configuration patterns, see `agent-config-sample/.codex/`.

## FAQ

### How to find `--executablePath`

`chrome-devtools-mcp` expects `--executablePath` to be a file path, not just a command name (for example `wsl-chrome-bridge`).

#### Scenario A: No Node version manager (system Node only)

Use `command` to locate the absolute path:

```bash
command -v wsl-chrome-bridge
```

Then paste that output into `--executablePath`.

#### Scenario B: Using mise for multiple Node versions (recommended)

If you use [mise](https://mise.jdx.dev/) and switch Node versions, do not hardcode a versioned path from `command -v` (for example `.../installs/node/<version>/bin/...`).

Prefer the mise shim entry:

```bash
echo $HOME/.local/share/mise/shims/wsl-chrome-bridge
```

Or inspect it directly:

```bash
ls -la ~/.local/share/mise/shims/wsl-chrome-bridge
```

#### Summary

- Without a version manager, `command -v` is a direct and valid way to get an absolute path.
- With mise multi-version Node, prefer `/home/<user>/.local/share/mise/shims/wsl-chrome-bridge` so path does not break when Node versions change.

### Why Playwright needs `DISPLAY`

In WSL/Linux, `playwright-mcp` checks display availability before launching the browser.  
If `DISPLAY` is not set, Playwright often switches to headless behavior (even when you did not explicitly pass `--headless`).

That decision happens upstream before bridge logic starts, so `wsl-chrome-bridge` cannot override it later.  
If you want to see a visible Chrome window on Windows, set `DISPLAY` in MCP `env` (for example `DISPLAY=:999`).

### Headless vs headed behavior on upstream MCP exit

`wsl-chrome-bridge` applies the following lifecycle policy when upstream MCP exits (for example `chrome-devtools-mcp` / `playwright-mcp`):

- If Chrome was started in headless mode, bridge always terminates that Chrome process.
- If Chrome was started in headed mode (non-headless), bridge always keeps that Chrome process.

This behavior is intentional and can differ from native Playwright defaults in some workflows.

### Why Playwright may show `--no-sandbox` warning

When `playwright-mcp` is launched without an explicit browser channel, it may resolve to launch args that include `--no-sandbox`. In headed Chrome, this shows the warning banner:
`You are using an unsupported command-line flag: --no-sandbox`.

For bridge usage with system Chrome, recommend adding:

```text
--browser chrome
```

This keeps Playwright on the Chrome channel and avoids passing `--no-sandbox` in the common setup.

### About `--user-data-dir`

`wsl-chrome-bridge` accepts direct `--user-data-dir` / `--userDataDir` values from upstream MCP.

Playwright may resolve a Windows-style path into a Linux path and pre-create a local empty directory before bridge logic starts.  
Bridge checks that local path and removes it only when it is an empty directory. Non-empty directories are never removed.

`chrome-devtools-mcp` typically does not create this local empty-directory artifact.

Bridge only passes Windows-style user-data-dir values to Windows Chrome. Path-resolved forms like `/cwd/%TEMP%\\...` are restored back to the original Windows-style path when possible.

If upstream does not send `--user-data-dir`, or the final value cannot be restored as a Windows-style path (and gets filtered), bridge automatically falls back to:

```text
%TEMP%\wsl-chrome-bridge\profile-default
```

This ensures Windows Chrome always starts with a usable profile directory and avoids launch behavior differences when no profile is provided.

To avoid Playwright-specific differences and keep a unified config style across `chrome-devtools-mcp` and `playwright-mcp`, prefer setting:

```toml
WSL_CHROME_BRIDGE_USER_DATA_DIR = "%TEMP%\\wsl-chrome-bridge\\chrome-profile-xxx"
```

`--user-data-dir` still works, but `WSL_CHROME_BRIDGE_USER_DATA_DIR` is recommended as the default style.

## Important Argument Notes

- `--user-data-dir` / `--userDataDir`: Bridge only forwards this flag when the final value is Windows-style (including restored `%TEMP%\\...` forms).
- If `--user-data-dir` is missing or filtered (non-Windows-style), bridge falls back to `%TEMP%\\wsl-chrome-bridge\\profile-default`.
- `playwright-mcp --browser chrome`: recommended for bridge usage to avoid upstream `--no-sandbox` banner in headed Chrome.

## Important Environment Variables

- `WSL_CHROME_BRIDGE_USER_DATA_DIR=%TEMP%\\...`: recommended default profile setting. It forces the Windows Chrome profile path, takes precedence over upstream `--user-data-dir`, avoids Playwright local empty-dir artifacts, and keeps a unified config style across MCP servers.
- `WSL_CHROME_BRIDGE_EXECUTABLE_PATH=C:\\...`: optional environment variable to override the Windows Chrome executable path.
- `WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT=9222`: optional environment variable for Windows Chrome debug port. If no port is specified, bridge uses a random port instead of fixed `9222`.
- Bridge now probes port availability on Windows before launching Chrome. In fixed-port mode, startup fails fast if that port is already occupied.
- `WSL_CHROME_BRIDGE_DEBUG_FILE=/tmp/xxx.log`: optional debug output file in WSL.
- `WSL_CHROME_BRIDGE_DEBUG_LEVEL=all|important`: optional debug verbosity level. `important` (default) logs only important session/navigation/disconnect-related CDP methods and error responses. `all` logs all CDP relay traffic.
- `WSL_CHROME_BRIDGE_DEBUG_RAW_DIR=/tmp/wsl-chrome-bridge-raw`: optional directory to store full raw CDP payload files. Each request/response/event payload is written as a separate `raw-<timestamp>.log` file, and `WSL_CHROME_BRIDGE_DEBUG_FILE` includes the corresponding `rawPath` for each relay log entry.

### Known incompatible original arguments

The following original `chrome-devtools-mcp` option is currently known as incompatible in this bridge setup:

- `--browser-url`: this enables remote-connection mode in `chrome-devtools-mcp` instead of pipe mode, so it cannot work with `wsl-chrome-bridge`.

> Other original `chrome-devtools-mcp` arguments are not all fully validated yet. This project is still under development, so only currently tested limitations are listed here.

## For Developer

Developer lifecycle and recovery reference:

- [docs/BRIDGE_CONNECTION_LIFECYCLE.md](./docs/BRIDGE_CONNECTION_LIFECYCLE.md)

### Development stack:

- Node 24
- TypeScript v6
- Commander v14
- ws v8.20
- Test framework: Vitest v4.1

### Build

```bash
npm install
npm run build
```

### Local Tests

```bash
npm test
```

Test layers:

- Unit tests: path conversion, argument normalization, bridge launch planning
- Scenario tests: CLI argument passing integration into bridge runner
