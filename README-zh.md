# wsl-chrome-bridge

本專案主要提供一支 CLI `wsl-chrome-bridge`。

在 [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) 眼中，`wsl-chrome-bridge` 將會是一個可執行的 Chrome。
`wsl-chrome-bridge` 會在 WSL 端提供 DevTools 連線入口，並把 CDP 訊息橋接到 Windows Chrome。

原有 `chrome-devtools-mcp` 的設定方式，只需調整 `--executablePath` 並增加特定參數，即可讓 WSL 下的 Agent 調用 Windows Chrome，且無須做任何系統層級的設定(如 portproxy 轉發 , WSL2 Mirrored Mode)。

此構想是看到 [wsl-chrome-mcp](https://github.com/477174/wsl-chrome-mcp) 實作方式是利用 `powershell` 繞過限制，但由於此專案是以 MCP Server 方式提供服務，但我想繼續使用比較多人維護的 `chrome-devtools-mcp`，所以才寫了本專案作為橋接手段。

## 0.2.0 重大變更（支援 Playwright）

`0.2.0` 新增對 `playwright-mcp` 的支援，並且調整多項 bridge 參數行為與設定方式。

若你是從 `0.1.0` 升級，請先閱讀升級說明文件：[UPGRADE-zh.md](./UPGRADE-zh.md)。

## 基本運作方式

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

wsl-chrome-bridge 會：

- 接收 `chrome-devtools-mcp` 與 `playwright-mcp` 傳入的 Chrome 啟動參數
- 啟動 Windows Chrome（透過PowerShell）
- 在 `chrome-devtools-mcp` 模式下，透過 stdio pipe（OS pipe）接收/回傳 CDP 訊息
- 在 `playwright-mcp` 模式下，於本機建立對應 port 的 WebSocket proxy 後轉發 CDP 訊息
- 透過 PowerShell WebSocket relay 雙向轉發 CDP 訊息到 Windows Chrome


## 使用環境需求
- Windows 11 安裝最新版 chrome。
- Windows 11 需要有 powershell.exe 可供 WSL2 執行。
- WSL2 需要有 Node 20+


## 安裝與使用方式

### 安裝方式

於 WSL 環境下用以下方式擇一安裝 :

1. 透過 `npm install -g wsl-chrome-bridge` 安裝。
2. 下載原始碼後自行編譯，再以 `npm link` 安裝：

```bash
git clone https://github.com/pigochu/wsl-chrome-bridge.git
cd wsl-chrome-bridge
npm install
npm run build
npm link
```

### 使用方式 (以 codex 為例子)

1. 找出 wsl-chrome-bridge 實際位置 , 假設是 `/home/pigochu/.local/share/mise/shims/wsl-chrome-bridge`。
2. 設定檔撰寫，如以下範例 `.codex/config.toml`。

`chrome-devtools-mcp` 最小可運作設定：

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

這是最小可運作設定。`wsl-chrome-bridge` 會啟動 Windows Chrome，並為 `chrome-devtools-mcp` 橋接 CDP 流量，不需要額外 bridge 專用參數。

`playwright-mcp` 最小可運作設定（含 sandbox）：

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

在 bridge + Windows 系統 Chrome 的情境下，加上 `--browser chrome` 可避免常見的上游 `--no-sandbox` 警告行為，並維持 Playwright 啟動行為穩定。

> [!NOTE]
> FAQ 章節有介紹 `--executablePath` 的路徑尋找的方式。
> 其他設定寫法可參考 `agent-config-sample/.codex/`。


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

若你使用 [mise](https://mise.jdx.dev/) 且可能切換多個 Node 版本，不建議把 `command -v` 找到的版本化路徑（例如 `.../installs/node/<version>/bin/...`）直接寫死在設定檔。

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

### 為什麼 Playwright 需要設定 `DISPLAY`

在 WSL/Linux 環境下，`playwright-mcp` 啟動瀏覽器時會先判斷圖形顯示環境。  
若 `DISPLAY` 沒有設定，Playwright 通常會改成 headless 行為（即使你沒有手動指定 `--headless`）。

而這個判斷是在 bridge 之前就完成，所以 `wsl-chrome-bridge` 無法在後段覆蓋該決策。  
如果你希望在 Windows 看到實際 Chrome 視窗，請於 MCP `env` 額外設定 `DISPLAY`（例如 `DISPLAY=:999`）。

### 為什麼 Playwright 可能出現 `--no-sandbox` 警告

`playwright-mcp` 若未明確指定 browser channel，可能會產生含 `--no-sandbox` 的啟動參數。  
在有視窗的 Chrome 中，會看到這類警告列：
`你正在使用不受支援的命令列標幟: --no-sandbox`

建議在 Playwright MCP args 明確加入：

```text
--browser chrome
```

這樣在常見 bridge 設定下可避免上游傳入 `--no-sandbox`。


### `--user-data-dir` 說明

`wsl-chrome-bridge` 現在支援上游 MCP 直接傳入 `--user-data-dir` / `--userDataDir`。

Playwright 可能會把原本的 Windows 風格路徑先 resolve 成 Linux 路徑，並在本地先建立一個空目錄再交給 bridge。  
bridge 目前會檢查該路徑，且僅在「空目錄」時才會安全刪除；非空目錄不會刪除。

`chrome-devtools-mcp` 一般不會有這個本地空目錄副作用。

另外，bridge 只會把「Windows 風格」的 user-data-dir 傳給 Windows Chrome。像 `/cwd/%TEMP%\\...` 這種被 resolve 過的形式會先嘗試還原。

若上游沒有送出 `--user-data-dir`，或送出的值最後無法還原為 Windows 風格路徑（被過濾），bridge 會自動使用預設值：

```text
%TEMP%\wsl-chrome-bridge\profile-default
```

這可確保 Windows Chrome 啟動時一律有可用的 profile 目錄，避免因未帶 profile 導致的啟動行為差異。

為了避免 Playwright 差異，並統一 `chrome-devtools-mcp` / `playwright-mcp` 的設定風格，建議優先使用：

```toml
WSL_CHROME_BRIDGE_USER_DATA_DIR = "%TEMP%\\wsl-chrome-bridge\\chrome-profile-xxx"
```

`--user-data-dir` 仍可使用，但建議把 `WSL_CHROME_BRIDGE_USER_DATA_DIR` 當成預設寫法。


## 設定參數重要說明

- `--user-data-dir` / `--userDataDir` : 僅當最終值為 Windows 風格（包含 `%TEMP%\\...` 還原成功）才會帶入啟動參數。
- 若 `--user-data-dir` 未提供，或被過濾（非 Windows 風格），bridge 會回退到 `%TEMP%\\wsl-chrome-bridge\\profile-default`。
- `playwright-mcp --browser chrome` : 建議搭配 bridge 使用，可避免上游送出 `--no-sandbox` 警告列。

## 環境變數重要說明

- `WSL_CHROME_BRIDGE_USER_DATA_DIR=%TEMP%\\...` : 建議預設使用。可固定指定 Windows Chrome profile 路徑，且優先於上游 `--user-data-dir`，可避開 Playwright 本地空目錄副作用，並統一兩種 MCP 設定風格。
- `WSL_CHROME_BRIDGE_EXECUTABLE_PATH=C:\\...` : 可選環境變數，用於覆蓋 Windows Chrome 的執行檔路徑。
- `WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT=9222` : 以環境變數指定 Windows Chrome debug port。若都沒指定，bridge 改為隨機 port，不再固定 9222。
- bridge 會在 Windows 端先探測 port 可用性。若是固定 port 模式且該 port 已被占用，會在啟動前直接報錯。
- `WSL_CHROME_BRIDGE_DEBUG_FILE=/tmp/xxx.log` : 以環境變數指定 bridge debug log 輸出路徑。
- `WSL_CHROME_BRIDGE_DEBUG_LEVEL=all|important` : 可選 debug 詳細度。`important`（預設）只記錄 session / 開頁導覽 / 斷線相關的重要 method 與錯誤回應；`all` 會記錄全部 CDP relay 訊息。
- `WSL_CHROME_BRIDGE_DEBUG_RAW_DIR=/tmp/wsl-chrome-bridge-raw` : 以環境變數指定 raw CDP 內容輸出目錄。每筆 request/response/event 會獨立寫入一個 `raw-<timestamp>.log` 檔案，且 `WSL_CHROME_BRIDGE_DEBUG_FILE` 的 relay log 會包含對應的 `rawPath`。

### 已確認無法使用的參數

以下列表為搭配本程式確定無法使用 `chrome-devtools-mcp` 原始參數

- `--browser-url` : 這是遠端連線設定，一旦啟用就會讓 `chrome-devtools-mcp` 走 remote mode 而非 pipe mode，無法與 `wsl-chrome-bridge` 配合。


> 其他 `chrome-devtools-mcp` 提供的原始參數未必全部能使用，本程式尚在開發中，也沒有完全測試過所有原始參數，故只列出目前已經測試過的。
