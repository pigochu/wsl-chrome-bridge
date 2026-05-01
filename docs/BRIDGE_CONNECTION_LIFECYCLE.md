# Bridge Connection Lifecycle (Draft)

## Purpose

This document defines how `wsl-chrome-bridge` manages lifecycle and recovery with Windows Chrome, especially for:

- shared `--user-data-dir` reuse behavior
- different behavior between `pipe` (`chrome-devtools-mcp`) and `ws` (`playwright-mcp`) transport modes
- recovery behavior after Chrome is manually closed and a new upstream request arrives

## Core Principles

1. Use `windowsUserDataDir` as the primary instance identity key and prefer reusing an existing Chrome instance.
2. If reuse is possible, keep the existing `remote-debugging-port` and do not force a restart.
3. Only launch a new Chrome instance when no reusable instance is available.
4. In `pipe` mode, bridge is allowed to exit when downstream Chrome disconnects (so upstream can restart on next operation).
5. In `ws` mode, bridge should not exit on Chrome disconnect; it enters a recoverable state and retries on the next upstream request.
6. `pipe + headless` requires explicit exit handling:
   - normal exit: bridge cleanup actively stops headless Chrome
   - abnormal exit (for example `SIGKILL`): a detached Node watchdog observes bridge PID death and then stops Chrome

## Terms

- `TransportMode`
  - `pipe`: upstream uses fd3/fd4 CDP pipe
  - `ws`: upstream uses local websocket proxy
- `Ownership`
  - `attached`: bridge attached to an existing Chrome (not launched in this run)
  - `launched`: bridge launched Chrome in this run
- `BridgeRuntimeState`
  - `starting`
  - `connected`
  - `degraded` (Chrome unavailable but bridge still alive)
  - `closing`

## Startup Lifecycle

### Phase 1: Plan and argument resolution

1. Parse args/env and determine:
   - `windowsUserDataDir`
   - `requestedLocalDebugPort` (commonly provided by Playwright)
   - `windowsDebugPort` (candidate port)
   - transport mode (`pipe` / `ws` / mixed)
2. Determine effective `TransportMode`:
   - fd3/fd4 present and pipe requested -> `pipe`
   - localProxyPort present -> `ws` (or mixed)

### Phase 2: Detect and reuse

1. Query all Windows `chrome.exe` processes.
2. Filter instances whose `--user-data-dir` is equivalent to `windowsUserDataDir`.
3. Extract `--remote-debugging-port` from matched process:
   - if valid, use it as `resolvedWindowsDebugPort` and mark `ownership = attached`
   - otherwise continue to Phase 3

### Phase 3: Launch fallback

1. Resolve launch port using current precedence:
   - bridge arg / env / upstream port / auto-random
2. Launch Windows Chrome and mark `ownership = launched`.
3. Poll `/json/version` until `webSocketDebuggerUrl` is available.

### Phase 4: Relay and upstream channel setup

1. Start CDP relay to `remoteBrowserWsUrl`.
2. In `ws` mode, start local debug proxy (for Playwright).
3. If `pipe + headless + ownership=launched + chromePid available`, start detached Node watchdog:
   - pass `bridgePid`, `chromePid`, `powershellPath`, and `expectedExecutablePath`
   - watchdog only monitors process lifetime; it does not relay CDP traffic
4. Transition state to `connected`.

## Runtime Event Handling

### Event A: User manually closes Chrome (relay disconnect)

#### A1. `pipe` mode

1. Bridge logs disconnect reason.
2. Bridge runs cleanup and exits (non-zero or current policy).
3. If this run is `pipe + headless`, cleanup stops the matching browser root process using `user-data-dir + active remote-debugging-port` (PowerShell `Stop-Process`).
4. Upstream (`chrome-devtools-mcp`) restarts on next operation.

#### A2. `ws` mode

1. Bridge stays alive and keeps local proxy listener open.
2. When strong signal is observed (for example `ConnectionClosedPrematurely` / `READER_CLOSE`), bridge enters `degraded` immediately (without waiting relay process exit).
3. Forwarding to Chrome is paused.
4. Recovery is triggered by the next upstream CDP request (Event B).

### Chrome-close detection rules (runtime heuristics)

To avoid false positives from a single event (for example `Inspector.detached`), runtime uses a signal combination:

1. Weak signals (not enough by themselves to conclude browser shutdown):
   - `Inspector.detached` (any reason)
   - `Target.detachedFromTarget`
2. Strong signals (browser-level connection failure):
   - relay receives `READER_ERROR` with `webSocketErrorCode=ConnectionClosedPrematurely`
   - relay receives `READER_CLOSE` and then can no longer exchange CDP traffic
3. Recommended decision rule:
   - cache weak events from `chrome -> relay` with full JSON (ring buffer up to 10)
   - on websocket interruption (`relayFatal` / `relayError` / `relayExit`), compare interruption timestamp with cached weak events
   - if weak signal exists within 2 seconds and strong signal is also present, treat as browser disconnected and enter `degraded` (`ws`) or `closing` (`pipe`)
   - weak-only signals are treated as target/session-level issues, not full browser shutdown
4. Notes:
   - reason strings (for example `Render process gone.`) are observational only and not a single source of truth
   - distinguishing user-close vs crash/system-kill requires extra process/port probes; recovery flow does not depend on this distinction

### Event B: upstream request arrives during `ws` `degraded`

0. Special short-circuit (avoid relaunch-on-exit loop):
   - if bridge has `chromeDisconnectedLikely=true` and current request is `Browser.close`
   - return synthetic success response (`{ id: <same>, result: {} }`) immediately
   - do not trigger recovery and do not queue this request

0.5. Delayed `Browser.close(id=-9999)` forwarding in `pipe + non-headless` (Playwright exit normalization):
   - Trigger conditions:
     - transport mode is `pipe`
     - non-headless
     - request method is `Browser.close`
     - request id is `-9999` (currently observable in Playwright MCP close flow)
   - Behavior:
     - bridge first returns a synthetic success response to upstream (same id / same sessionId)
     - bridge does not forward this request to Chrome immediately; it delays forwarding by 200ms
     - if bridge is still alive when the 200ms timer fires, it forwards the original `Browser.close` request to relay
     - after delayed forward, the matching Chrome `Browser.close` response is consumed inside bridge and not forwarded upstream (to avoid duplicate responses)
   - Purpose:
     - use a short timing window to split behavior between "MCP exit" and "user intentionally closes browser", so non-headless MCP exit does not immediately close foreground Windows Chrome
   - Limits and boundaries:
     - this strategy does not apply to headless
     - 200ms is a policy parameter (not a protocol guarantee) and should be tuned by integration tests
     - if upstream changes close id semantics or close flow, this condition must be updated
1. Bridge runs `recoverChromeForCurrentUserDataDir()`:
   - first try attach to existing same-profile Chrome
   - if attach succeeds: refresh `remoteBrowserWsUrl`, rebuild relay, transition to `connected`
   - if attach fails: relaunch Chrome using normal launch policy, wait for `/json/version`, rebuild relay, transition to `connected`
2. On recovery relay rebuild, run bootstrap before queue flush:
   - send internal root-session request:
     - `Target.setAutoAttach { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }`
   - do not flush queued requests before bootstrap response success
   - flush queue only after bootstrap success
3. Internal request protocol boundaries:
   - internal requests use bridge-owned id space, separate from upstream ids
   - internal responses are consumed inside bridge and never forwarded upstream
   - `Target.attachedToTarget` / `Target.detachedFromTarget` events are still forwarded so upstream gets new `sessionId`
4. On success:
   - forward current request (queue -> bootstrap -> flush)
5. On failure:
   - throw and terminate bridge process

#### Why bootstrap is required

- `Target.createTarget` returns `targetId`, not `sessionId`
- `sessionId` comes from attach flow (`Target.attachToTarget` or auto-attach events)
- flushing `Target.createTarget` too early (before auto-attach restore) can produce upstream page/session mismatches (for example `undefined (_page)` style failures)

## Cleanup Rules

1. Default case (not `pipe + headless`):
   - bridge does not actively stop Windows Chrome
2. `pipe + headless`:
   - bridge cleanup performs stop with `windowsUserDataDir + activeWindowsDebugPort` filtering
   - this prevents orphaned background headless processes
3. In `pipe + headless + ownership=launched + chromePid available`, detached Node watchdog is started as abnormal-exit safety:
   - watchdog polls `kill -0 <bridgePid>` in Linux/WSL
   - after bridge PID disappears, watchdog invokes PowerShell stop for target `chromePid`
   - pre-stop validation:
     - target PID command line must contain `--headless`
     - if `expectedExecutablePath` is provided, executable path must match
4. `ws + degraded` should not auto-destroy process; terminate only when:
   - upstream connection is intentionally closed and service is no longer needed
   - bridge receives SIGINT/SIGTERM
   - fatal error (for example proxy cannot listen)

### Definition of `stop-process`

- `stop-process` means bridge uses PowerShell `Stop-Process -Id <pid> -Force` to terminate Windows Chrome.
- in `pipe + headless`, this is used in cleanup after profile+port filtering
- on abnormal bridge exit, detached Node watchdog can trigger equivalent stop via PID validation flow

## State Machine Summary

- `starting` -> `connected`
  - condition: successful attach or launch and relay connection
- `connected` -> `degraded`
  - condition: relay disconnect in `ws` mode
- `degraded` -> `connected`
  - condition: next upstream request triggers successful recovery
- `connected` -> `closing`
  - condition: downstream disconnect in `pipe`, signal, or fatal error
- `degraded` -> `closing`
  - condition: signal, fatal error, or policy-driven termination

## Observability Recommendations

Debug log fields should include:

- `transportMode=pipe|ws`
- `runtimeState=starting|connected|degraded|closing`
- `ownership=attached|launched`
- `windowsUserDataDir=...`
- `resolvedWindowsDebugPort=...`
- `recoveryAttempt=<n>`
- `recoveryResult=attached|relaunched|failed`
- `recoveryBootstrap=started|acknowledged|failed`
- `shortCircuitBrowserClose=true|false`
- `disconnectSignals=...` (for example `Inspector.detached,Target.detachedFromTarget,ConnectionClosedPrematurely`)

## Confirmed Policies

1. On `ws` recovery failure: throw and terminate bridge process.
2. `ws` degraded waiting window: no timeout.
3. `pipe + headless` termination policy:
   - normal cleanup: actively stop matching headless Chrome
   - abnormal exit (including `SIGKILL`): detached Node watchdog performs fallback stop
