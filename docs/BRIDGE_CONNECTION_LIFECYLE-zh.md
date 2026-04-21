# Bridge Connection Lifecycle (Draft)

## 目的

這份文件定義 `wsl-chrome-bridge` 在啟動後如何維持與 Windows Chrome 的生命週期，特別針對：

- 同一個 `--user-data-dir` 的 Chrome 複用策略
- `pipe`（chrome-devtools-mcp）與 `ws`（playwright-mcp）模式在 Chrome 關閉時的不同行為
- Chrome 被手動關閉後，再收到 upstream request 的恢復策略

## 核心原則

1. 以 `windowsUserDataDir` 為實例識別鍵，優先複用既有 Chrome。
2. 能複用既有 Chrome 時，沿用既有 `remote-debugging-port`，不強制重啟。
3. 無可複用實例時，才用 upstream/bridge 指定 port 啟新 Chrome。
4. `pipe` 模式：Chrome 斷線時允許 bridge 結束（讓 upstream 下次重啟）。
5. `ws` 模式：Chrome 斷線時 bridge 不主動結束，改進入待恢復狀態並在下一次 request 嘗試恢復。
6. `pipe + headless` 模式需特別處理 bridge 結束時的 Chrome 收尾：
   - 正常結束：bridge cleanup 主動 stop headless Chrome。
   - 非正常結束（例如 bridge 被 `SIGKILL`）：由 detached Node watchdog 偵測 bridge PID 消失後再 stop。

## 名詞

- `TransportMode`
  - `pipe`: upstream 透過 fd3/fd4 傳 CDP
  - `ws`: upstream 透過本機 websocket proxy 傳 CDP
- `Ownership`
  - `attached`: bridge 附著到既有 Chrome（非本次啟動）
  - `launched`: bridge 本次啟動的 Chrome
- `BridgeRuntimeState`
  - `starting`
  - `connected`
  - `degraded`（Chrome 不可用，但 bridge 仍存活）
  - `closing`

## 啟動生命週期

### Phase 1: 啟動與參數決策

1. 解析 args/env，得到：
   - `windowsUserDataDir`
   - `requestedLocalDebugPort`（Playwright 常帶）
   - `windowsDebugPort`（預設候選）
   - 傳輸模式（`pipe` / `ws` / mixed）
2. 決定 `TransportMode`：
   - 有 fd3/fd4 且要求 pipe -> `pipe`
   - 有 localProxyPort -> `ws`（或 mixed）

### Phase 2: 探測與複用

1. 查詢 Windows 端所有 `chrome.exe` process。
2. 篩選 command line 中 `--user-data-dir` 與 `windowsUserDataDir` 等價者。
3. 從命中的 process 擷取 `--remote-debugging-port`：
   - 若擷取成功，設定 `resolvedWindowsDebugPort = existingPort`，`ownership = attached`。
   - 若未命中或無有效 port，進入 Phase 3。

### Phase 3: 新啟動（fallback）

1. 以既有規則決定要使用的 port：
   - bridge-arg / env / upstream-port / auto-random
2. 啟動 Windows Chrome，`ownership = launched`。
3. 輪詢 `/json/version` 取得 `webSocketDebuggerUrl`。

### Phase 4: Relay 與對上游通道建立

1. 建立 CDP relay 到 `remoteBrowserWsUrl`。
2. 若 `ws` 模式，建立 local debug proxy（Playwright 連這裡）。
3. 若符合 `pipe + headless + ownership=launched + chromePid 可用`，啟動 detached Node watchdog：
   - 傳入 `bridgePid`、`chromePid`、`powershellPath`、`expectedExecutablePath`。
   - watchdog 只監看 bridge 存活，不參與 CDP 轉發。
4. 狀態進入 `connected`。

## 運行中事件處理

### Event A: 用戶手動關閉 Chrome（relay 斷線）

#### A1. `pipe` 模式

1. bridge 記錄斷線原因。
2. bridge 走 cleanup 並結束行程（exit non-zero 或依目前策略）。
3. 若本次是 `pipe + headless`，cleanup 會用 `user-data-dir + active remote-debugging-port` 來 stop 對應 browser root process（PowerShell `Stop-Process`）。
4. 讓 upstream（chrome-devtools-mcp）在下一次互動自行重啟流程。

#### A2. `ws` 模式

1. bridge 不結束行程，不關 local proxy listener。
2. 一旦收到強訊號（例如 `ConnectionClosedPrematurely` / `READER_CLOSE`），bridge 立即切 `degraded`（不等待 relay process `exit`）。
3. 暫停轉發到 Chrome（因下游已斷）。
4. 等待下一個 upstream CDP request 觸發恢復流程（Event B）。

### Chrome 關閉判斷條件（Runtime Heuristics）

為避免只依賴單一 CDP event（例如 `Inspector.detached`）造成誤判，runtime 以「事件組合」判斷下游 Chrome 是否已失聯：

1. 弱訊號（不可單獨判定整個 Chrome 關閉）：
   - `Inspector.detached`（任何 reason）
   - `Target.detachedFromTarget`
2. 強訊號（可判定 browser-level 連線失效）：
   - relay 收到 `READER_ERROR` 且 `webSocketErrorCode=ConnectionClosedPrematurely`
   - relay 收到 `READER_CLOSE` 後緊接 relay 結束，且無法再收發 CDP
3. 推薦判定規則：
   - bridge 僅攔截 `chrome -> relay` 的弱訊號 event，並緩存完整 JSON（ring buffer，最多 10 筆）。
   - 當發生 ws 中斷（`relayFatal` / `relayError` / `relayExit`）時，以「中斷時間」回看緩存 event。
   - 若存在弱訊號 event 與中斷時間差在 2 秒內，且同時看到強訊號，視為「Chrome 端已失聯」，進入 `degraded`（`ws`）或 `closing`（`pipe`）。
   - 若只有弱訊號，先視為 target/session 層級異常，不直接判定整個 Chrome 關閉。
4. 補充：
   - `reason` 字串（如 `Render process gone.`）僅作觀測，不作唯一決策條件，避免跨版本字串變動影響行為。
   - 若需區分「使用者手動關閉」與「crash/被系統終止」，需額外搭配 process/port 探測；本文件定義的恢復流程不依賴此細分。

### Event B: `ws` 模式下，`degraded` 期間收到新 request

0. 例外短路（避免退出時誤重啟 Chrome）：
   - 若 bridge 已有 `chromeDisconnectedLikely=true` 判定，且當前 request 為 `Browser.close`，
   - bridge 直接回傳成功 response（`{ id: <same>, result: {} }`），不觸發 recovery、不進 queue。
   - 目的：避免 Playwright/Codex 結束流程送出 `Browser.close` 時，把已關閉的 Chrome 又拉起來再關一次。

1. bridge 先嘗試 `recoverChromeForCurrentUserDataDir()`：
   - 先探測是否已有同 `user-data-dir` Chrome 可附著。
   - 若可附著：更新 `remoteBrowserWsUrl` 並重建 relay，狀態回 `connected`。
   - 若不可附著：以既有啟動規則重新啟動 Chrome，待 `/json/version` 成功後重建 relay，狀態回 `connected`。
2. 恢復成功後，若本次是 `recovery` 重建 relay，必須先做 bootstrap：
   - bridge 先送一筆 internal CDP request（root session）：
     - `Target.setAutoAttach { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }`
   - 在 internal request 回應成功前，`queuedForRelay` 不可 flush。
   - internal request 回應成功後，才 flush queue 並恢復一般轉發。
3. internal request 的協議邊界：
   - internal request 使用 bridge 自己的 request id 空間，不與 upstream id 混用。
   - internal request 的 response 只在 bridge 內部消化，不轉發給 upstream。
   - `Target.attachedToTarget`/`Target.detachedFromTarget` 等 event 仍正常轉發 upstream，讓 upstream 取得新 `sessionId`。
4. 恢復成功：
   - 轉發當前 request（實作上是 queue -> bootstrap -> flush）。
5. 恢復失敗：
   - 直接拋錯並結束 bridge 行程（依已確認策略）。

#### 為何需要上述 bootstrap

- `Target.createTarget` 回傳的是 `targetId`，不是 `sessionId`。
- `sessionId` 來自 attach 流程（`Target.attachToTarget` 或 `Target.setAutoAttach` 觸發的 `Target.attachedToTarget` event）。
- 若 recovery 後直接 flush `Target.createTarget`，但尚未恢復 auto-attach，可能導致上游在建立 page 對應時拿不到新 session，出現 `undefined (_page)` 類型錯誤。

## Cleanup 規則

1. 預設情況（非 `pipe + headless`）：
   - bridge 不主動 stop Windows Chrome。
2. `pipe + headless`：
   - bridge 在 cleanup 期間會執行 stop（依 `windowsUserDataDir + activeWindowsDebugPort` 篩選）。
   - 這是為了避免 headless 背景殘留進程。
3. `pipe + headless + ownership=launched + chromePid 可用` 時會啟動 detached Node watchdog 作為非正常退出保險：
   - watchdog 輪詢 `kill -0 <bridgePid>`（Linux/WSL 端）。
   - bridge PID 消失後，才呼叫 PowerShell stop 指定 `chromePid`。
   - stop 前驗證：
     - 目標 PID command line 必須包含 `--headless`。
     - 若有 `expectedExecutablePath`，其 executable path 必須匹配才允許 stop。
4. `ws` + `degraded` 狀態不應自動 destroy 進程，只在以下情境結束：
   - 上游主動關閉連線且無需持續服務
   - bridge 收到 SIGINT/SIGTERM
   - 明確致命錯誤（例如 proxy 無法 listen）

### `stop-process` 定義

- `stop-process` 指的是 bridge 目前透過 PowerShell 執行 `Stop-Process -Id <pid> -Force` 來關閉 Windows Chrome。
- `pipe + headless` 會在 cleanup 階段執行 profile+port 篩選後 stop。
- detached Node watchdog 在 bridge 非正常退出時，也會以 PID 驗證流程觸發同類 stop。

## 狀態機摘要

- `starting` -> `connected`
  - 條件：成功附著或成功啟動並連上 Chrome
- `connected` -> `degraded`
  - 條件：Chrome relay 斷線（僅 `ws` 模式）
- `degraded` -> `connected`
  - 條件：下一次 request 觸發恢復成功
- `connected` -> `closing`
  - 條件：`pipe` 下游斷線、收到 signal、致命錯誤
- `degraded` -> `closing`
  - 條件：收到 signal、致命錯誤、策略性終止

## 失敗可觀測性（建議）

Debug log 需標記以下欄位，便於定位：

- `transportMode=pipe|ws`
- `runtimeState=starting|connected|degraded|closing`
- `ownership=attached|launched`
- `windowsUserDataDir=...`
- `resolvedWindowsDebugPort=...`
- `recoveryAttempt=<n>`
- `recoveryResult=attached|relaunched|failed`
- `recoveryBootstrap=started|acknowledged|failed`
- `shortCircuitBrowserClose=true|false`
- `disconnectSignals=...`（例如 `Inspector.detached,Target.detachedFromTarget,ConnectionClosedPrematurely`）

## 已確認策略

1. `ws` 恢復失敗時：拋錯並結束 bridge 行程。
2. `ws` 在 `degraded` 可等待時間：不設 timeout。
3. `pipe + headless` 時 bridge 結束策略：
   - 正常 cleanup：主動 stop 對應 headless Chrome。
   - 非正常退出（含 `SIGKILL`）：由 detached Node watchdog 代為 stop。
