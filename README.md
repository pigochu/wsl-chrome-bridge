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

## How It Works

```text
[chrome-devtools-mcp]
       |
    stdio pipe
       |
[wsl-chrome-bridge]
       |
 PowerShell websocket relay
       |
[Windows Chrome]
```

`wsl-chrome-bridge` will:

- Accept Chrome launch arguments from `chrome-devtools-mcp`
- Launch Windows Chrome via PowerShell
- Receive/return CDP messages through stdio pipe (OS pipe)
- Relay CDP messages bidirectionally to Windows Chrome through PowerShell websocket relay

## Requirements

- Windows 11 with the latest Chrome installed
- `powershell.exe` available for WSL2
- WSL2 with Node 20+

## Install and Use

### Install

In WSL, choose one of the following installation methods:

1. Install globally with `npm install -g wsl-chrome-bridge`.
2. Or clone source and install with `npm link`.

### Example (Codex)

1. Find the actual path of `wsl-chrome-bridge`, for example `/home/pigochu/.local/share/mise/shims/wsl-chrome-bridge`.
2. Configure `.codex/config.toml` like this:

```toml
[sandbox_workspace_write]
network_access = true

[mcp_servers.chrome-devtools]
command = "npx"
args = [
    "-y",
    "chrome-devtools-mcp@latest",
    "--executablePath",
    "/home/pigochu/.local/share/mise/shims/wsl-chrome-bridge",
    "--chrome-arg=--window-size=720,400",
    "--chrome-arg=--new-window",
    "--chrome-arg=--user-data-dir=%TEMP%\\wsl-chrome-bridge\\chrome-profile-test",
    "--chrome-arg=--bridge-remote-debugging-port=9222",
    "--no-sandbox"
]
enabled = true
```

In this example, Windows Chrome is launched with port `9222`, and `wsl-chrome-bridge` relays traffic between Windows Chrome and `chrome-devtools-mcp`.

> [!NOTE]
> See the FAQ for how to locate `--executablePath`.

## Development Stack

- Node 24
- TypeScript v6
- Commander v14
- ws v8.20
- Test framework: Vitest v4.1

## Build

```bash
npm install
npm run build
```

## Local Tests

```bash
npm test
```

Test layers:

- Unit tests: path conversion, argument normalization, bridge launch planning
- Scenario tests: CLI argument passing integration into bridge runner

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

### Why `--user-data-dir` is not recommended

`chrome-devtools-mcp` checks whether `--user-data-dir` is an absolute path (starts with `/`). If not, it may be treated as relative, which does not work well with `%TEMP%\\...` style values. Use `--chrome-arg=--user-data-dir=...` instead.

## Important Argument Notes

- `--user-data-dir`: this original `chrome-devtools-mcp` option is not recommended here. It may pass an unexpected path and should be avoided.
- `--chrome-arg=--user-data-dir=...`: set Chrome profile path.
- `--chrome-arg=--bridge-chrome-executablePath=...`: optionally set the Chrome executable absolute path (Windows format required, for example `C:\\...`).
- `--chrome-arg=--bridge-remote-debugging-port=9222`: optionally set the Windows Chrome debug port. Default is `9222` if omitted. This is a bridge-only argument, not a native Chrome flag.
- `--chrome-arg=--bridge-debug-file=/tmp/xxx.log`: optional debug output file in WSL.

### Known incompatible original arguments

The following original `chrome-devtools-mcp` options are currently known as incompatible in this bridge setup:

- `--user-data-dir`: internal handling in `chrome-devtools-mcp` may turn an intended Windows-style path into Linux-style behavior, so this option is filtered out by this bridge and is not recommended for profile path configuration.
- `--browser-url`: this enables remote-connection mode in `chrome-devtools-mcp` instead of pipe mode, so it cannot work with `wsl-chrome-bridge`. Use `--chrome-arg=--bridge-remote-debugging-port=...` instead.

> Other original `chrome-devtools-mcp` arguments are not all fully validated yet. This project is still under development, so only currently tested limitations are listed here.
