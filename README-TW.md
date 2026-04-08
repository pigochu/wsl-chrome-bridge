# wsl-chrome-bridge

本專案主要提供一支 CLI `wsl-chrome-bridge`。

在 `chrome-devtools-mcp` 眼中，`wsl-chrome-bridge` 將會是一個可執行的 Chrome。
`wsl-chrome-bridge` 會在 WSL 端提供 DevTools 連線入口，並把 CDP 訊息橋接到 Windows Chrome。

原有 `chrome-devtools-mcp` 的設定方式，只需調整 `--executablePath` 並增加特定參數，即可讓 WSL 下的 Agent 調用 Windows Chrome，且無須做任何系統層級的設定(如 portproxy 轉發 , WSL2 Mirrored Mode)。

此構想是看到 [wsl-chrome-mcp](https://github.com/477174/wsl-chrome-mcp) 實作方式是利用 `powershell` 繞過限制，但由於此專案是以 MCP Server 方式提供服務，但我想繼續使用比較多人維護的 `chrome-devtools-mcp`，所以才寫了本專案作為橋接手段。


## 基本運作方式

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

wsl-chrome-bridge 會：

- 接收 `chrome-devtools-mcp` 傳入的 Chrome 啟動參數
- 啟動 Windows Chrome（透過PowerShell）
- 以 stdio pipe（OS pipe）接收/回傳 CDP 訊息
- 透過 PowerShell WebSocket relay 雙向轉發 CDP 訊息到 Windows Chrome


## 使用環境需求
- Windows 11 安裝最新版 chrome。
- Windows 11 需要有 powershell.exe 可供 WSL2 執行。
- Node 20+


## 安裝與使用方式

### 安裝方式

1. 透過 `npm install -g wsl-chrome-bridge` 安裝。
2. 下載原始碼以 `npm link` 安裝。

### 使用方式 (以 codex 為例子)

1. 找出 wsl-chrome-bridge 實際位置 , 假設是 `/home/pigochu/.local/share/mise/shims/wsl-chrome-bridge`。
2. 設定檔撰寫，如以下範例 `.codex/config.toml`

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
    "--chrome-arg=--bridge-debug-file=/tmp/wsl-chrome-bridge-debug.log",
    "--no-sandbox"
]
enabled = true
```

此範例會於 Windows 開啟 Chrome 時指定 port 9222 供 `wsl-chrome-bridge` 連接並與 `chrome-devtools-mcp` 互相收發資料。

> FAQ 章節有介紹 `--executablePath` 的路徑尋找的方式。


## 開發時所用的技術棧
- Node 24
- TypeScript v6
- Commander v14
- ws v8.20
- 測試框架: Vitest v4.1


## 安裝與建置

```bash
npm install
npm run build
```

## 本地測試

```bash
npm test
```

測試分成兩層：

- 單元測試：路徑轉換、參數標準化、bridge 啟動規劃
- 情境測試：CLI 對 bridge runner 的參數傳遞整合


## FAQ

### `--executablePath` 如何找

`chrome-devtools-mcp` 的 `--executablePath` 必須是「檔案路徑」，不能只填指令名（例如 `wsl-chrome-bridge`）。

#### 情境 A: 未使用 Node 版本管理工具（僅系統 Node）

這種情境下，通常就是用 `command` 找出絕對路徑再填入設定：

```bash
command -v wsl-chrome-bridge
```

把輸出結果直接填進 `--executablePath`。

#### 情境 B: 使用 mise 管理多版本 Node（建議做法）

若你使用 mise 且可能切換多個 Node 版本，不建議把 `command -v` 找到的版本化路徑（例如 `.../installs/node/<version>/bin/...`）直接寫死在設定檔。

建議改用 mise shim 固定入口：

如以下命令所印出的絕對路徑
```bash
echo $HOME/.local/share/mise/shims/wsl-chrome-bridge
```
或直接檢查：

```bash
ls -la ~/.local/share/mise/shims/wsl-chrome-bridge
```

#### 差異總結

- 不使用版本管理工具時，透過 `command -v` 找絕對路徑是可行且直接的方法。
- 使用 mise 多版本 Node 時，建議使用 `/home/<user>/.local/share/mise/shims/wsl-chrome-bridge`，避免 Node 版本切換後路徑失效。


### `--user-data-dir` 為何不建議用

因為 `chrome-devtools-mcp` 的實作方式會判斷 --user-data-dir 的路徑是否為絕對路徑 (以 '/' 開頭)，如果不是絕對路徑，會以相對路徑串接，因此就無法使用 `%TEMP%\\...` 這種方式提供，必須改用 `--chrome-arg=--user-data-dir=...` 作為 Chrome 啟動參數。


## 設定參數重要說明

- `--user-data-dir` : 原 `chrome-devtools-mcp` 提供用於設定 Chrome Profile 路徑，但 `chrome-devtools-mcp` 可能會傳入非預期的路徑，**請勿使用**。
- `--chrome-arg=--user-data-dir=...` : 用於設定 Chrome Profile 路徑。
- `--chrome-arg=--bridge-chrome-executablePath=...` : 用於指定 Chrome 的執行檔絕對路徑，這是可選參數，若用戶有自行安裝到特殊目錄才需使用，路徑必須符合 Windows 格式，如 `C:\\....`。
- `--chrome-arg=--bridge-remote-debugging-port=9222` : 用於設定 Chrome 開啟時提供的遠端連線 port，這是可選參數，若不指定，預設會是 9222，此參數為本程式額外 hack 的，並不是真的 Chrome 參數。
- `--chrome-arg=--bridge-debug-file=/tmp/xxx.log` : 用於 debug 用，會將 debug 訊息寫入指定的 WSL 環境下的檔案，可選參數。

### 已確認無法使用的參數

以下列表為搭配本程式確定無法使用 `chrome-devtools-mcp` 原始的參數

- `--user-data-dir` : 因 `chrome-devtools-mcp` 內部目前寫法可能會將預期的 Windows 路徑格式轉成 Linux 路徑格式，所以會被本程式過濾掉而無作用，因此不建議使用此參數來設定 Chrome Profile Path。
- `--browser-url` : 這是遠端連線的設定，如果設定此參數，會變成 `chrome-devtools-mcp` 走遠端連線模式而非 Pipe，這樣就無法與 `wsl-chrome-bridge` 連線，須改用 `--chrome-arg=--bridge-remote-debugging-port...`。


> 其他 `chrome-devtools-mcp` 提供的原始參數未必全部能使用，本程式尚在開發中，也沒有完全測試過所有原始參數，故只列出目前已經測試過的。

