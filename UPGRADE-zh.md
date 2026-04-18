# Upgrade Guide: 0.1.0 -> 0.2.0

本文件說明從 `wsl-chrome-bridge` `0.1.0` 升級到 `0.2.0` 需要調整的設定。

## 1. 必做變更

### 1.1 改用環境變數設定 debug log

`0.2.0` 開始，以下舊寫法已棄用且會報錯：

- `--chrome-arg=--bridge-debug-file=/tmp/xxx.log`

請改為 MCP `env`：

```toml
WSL_CHROME_BRIDGE_DEBUG_FILE = "/tmp/debug-bridge.log"
```

### 1.2 改用環境變數設定 Chrome 執行檔路徑

`0.2.0` 開始，以下舊寫法已棄用且會報錯：

```text
--bridge-chrome-executablePath=C:\Custom\Chrome\chrome.exe
```

若你是透過 `chrome-devtools-mcp` 包一層傳入，常見會是：

```text
--chrome-arg=--bridge-chrome-executablePath=C:\Custom\Chrome\chrome.exe
```

請改為 MCP `env`：

```toml
WSL_CHROME_BRIDGE_EXECUTABLE_PATH = "C:\\Custom\\Chrome\\chrome.exe"
```

### 1.3 正式支援 `--user-data-dir`，並新增建議環境變數

`0.2.0` 會只把「Windows 風格」路徑帶給 Windows Chrome。  
像 `/cwd/%TEMP%\\...` 這種被 resolve 過的形式會嘗試還原回 Windows 路徑。

另外，Playwright 可能先建立本地端目錄（Linux 路徑）再交給 bridge。  
bridge 現在會檢查該路徑，若是空目錄就安全刪除；非空目錄則保留。  
`chrome-devtools-mcp` 一般不會有這個空目錄副作用。

因此，雖然 `--user-data-dir` 仍可用，仍建議優先在 MCP `env` 設定：

```toml
WSL_CHROME_BRIDGE_USER_DATA_DIR = "%TEMP%\\wsl-chrome-bridge\\chrome-profile-xxx"
```

`--user-data-dir` 仍可使用，但建議作為次要方式，並以 `WSL_CHROME_BRIDGE_USER_DATA_DIR` 統一兩種 MCP 的設定風格。

若你原本使用舊寫法：

```text
--chrome-arg=--user-data-dir=%TEMP%\wsl-chrome-bridge\chrome-profile-xxx
```

升級到 `0.2.0` 建議改成上方 `WSL_CHROME_BRIDGE_USER_DATA_DIR`。

## 2. 建議變更

### 2.1 以環境變數指定固定 debug port（可選）

若你需要固定 port（例如防火牆、除錯工具綁定），可設定：

```toml
WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT = "9222"
```

若你原本使用舊寫法：

```text
--chrome-arg=--bridge-remote-debugging-port=9222
```

升級到 `0.2.0` 建議改成 MCP `env` 的 `WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT`。  
建議統一用環境變數管理，避免不同 MCP 設定方式造成混用。

若未指定，`0.2.0` 預設改為「隨機可用 port」，不再固定 `9222`。

### 2.2 chrome-devtools 與 playwright 請用不同 profile（可選但強烈建議）

若兩者共用同一個 profile（不論是 `--user-data-dir` 或 `WSL_CHROME_BRIDGE_USER_DATA_DIR`），可能互相影響同一個 Windows Chrome 實例。  
建議各自指定不同 profile 目錄。

### 2.3 Playwright 建議加上 `--browser chrome`

在 bridge + Windows Chrome 情境下，`playwright-mcp` 若未明確指定 browser channel，可能出現上游傳入 `--no-sandbox`，並在 Chrome 顯示警告列。

建議於 Playwright MCP args 額外加入：

```text
--browser chrome
```

這是設定層級的建議，不影響 bridge 功能，但可避免常見的 `--no-sandbox` UI 警告。

## 3. 驗證清單

升級後可用以下方式快速驗證：

1. 啟動 `chrome-devtools-mcp`，確認 bridge 可正常開頁。
2. 啟動 `playwright-mcp`，確認可正常導頁（例如 `https://www.google.com`）。
3. 檢查 debug log（`WSL_CHROME_BRIDGE_DEBUG_FILE`）：
   - 有 `launchPlan` / `windowsArgs` 記錄
   - `windowsUserDataDir` 或 `windowsArgs` 中的 `--user-data-dir` 為預期 Windows 路徑

## 4. 範例（MCP env）

```toml
env = {
  WSL_CHROME_BRIDGE_DEBUG_FILE = "/tmp/debug-bridge.log",
  WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT = "9222",
  WSL_CHROME_BRIDGE_USER_DATA_DIR = "%TEMP%\\wsl-chrome-bridge\\chrome-profile-bridge"
}
```

`WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT` 可省略；省略時 bridge 會自動使用隨機可用 port。
