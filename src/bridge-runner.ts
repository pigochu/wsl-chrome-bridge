import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import {
  buildWindowsChromeArgs,
  parseBrowserPathFromWsUrl,
  planBridgeLaunch
} from "./bridge-options.js";
import { resolveChromeCommand } from "./chrome-command.js";
import {
  createPowerShellContext,
  destroyPowerShellContext,
  runPowerShellFile,
  writePowerShellScript
} from "./powershell.js";

const POLL_INTERVAL_MS = 400;
const CHROME_READY_TIMEOUT_MS = 30_000;
const LARGE_CDP_STRING_BYTES = 16 * 1024;
const MAX_TRACKED_REQUEST_METHODS = 100;
const INTERNAL_CDP_REQUEST_ID_START = 900_000_000;
const DISCONNECT_EVENT_BUFFER_LIMIT = 10;
const DISCONNECT_EVENT_TIME_WINDOW_MS = 2_000;
type BridgeDebugLevel = "all" | "important";

const IMPORTANT_CDP_METHODS = new Set<string>([
  // Target/session lifecycle (most common failure points for attach/detach/disconnect)
  "Target.setDiscoverTargets",
  "Target.getTargets",
  "Target.getTargetInfo",
  "Target.getDevToolsTarget",
  "Target.setAutoAttach",
  "Target.autoAttachRelated",
  "Target.attachToTarget",
  "Target.attachedToTarget",
  "Target.detachFromTarget",
  "Target.detachedFromTarget",
  "Target.targetCreated",
  "Target.targetInfoChanged",
  "Target.targetDestroyed",
  "Target.activateTarget",
  "Target.createTarget",
  "Target.closeTarget",
  // Browser/page open-close lifecycle
  "Browser.getVersion",
  "Browser.close",
  "Page.navigate",
  "Page.frameStartedLoading",
  // Disconnection/error signals
  "Inspector.detached",
  "Runtime.exceptionThrown",
  "Network.loadingFailed"
]);

const IMPORTANT_EXCLUDED_METHODS = new Set<string>([
  // Common benign error during early-frame phases; noisy but usually not a disconnect root cause.
  "Storage.getStorageKey"
]);

const LAUNCH_CHROME_PS = `
param(
  [string]$ChromePath,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ChromeArgs
)
$ErrorActionPreference = 'Stop'
$ChromeArgs = $ChromeArgs | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_) }
$proc = Start-Process -FilePath $ChromePath -ArgumentList $ChromeArgs -PassThru
Write-Output $proc.Id
`;

const FIND_EXISTING_CHROME_PS = `
param([string]$UserDataDir)
$ErrorActionPreference = 'Stop'

function Normalize-UserDataDir {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  $trimmed = $Value.Trim('"')
  $expanded = [Environment]::ExpandEnvironmentVariables($trimmed)
  try {
    $resolved = (Resolve-Path -LiteralPath $expanded -ErrorAction Stop).Path
  } catch {
    $resolved = $expanded
  }
  return $resolved.ToLowerInvariant()
}

$target = Normalize-UserDataDir -Value $UserDataDir
if ([string]::IsNullOrWhiteSpace($target)) {
  Write-Output '{"found":false}'
  exit 0
}

$matchUserDataPattern = '(?i)--user-data-dir(?:=|\\s+)(?:"([^"]+)"|([^\\s"]+))'
$matchPortPattern = '(?i)--remote-debugging-port(?:=|\\s+)(\\d{1,5})'
$candidates = @()

$processes = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"
foreach ($proc in $processes) {
  $line = $proc.CommandLine
  if ([string]::IsNullOrWhiteSpace($line)) {
    continue
  }

  $userDataMatch = [Regex]::Match($line, $matchUserDataPattern)
  if (-not $userDataMatch.Success) {
    continue
  }

  $capturedUserDataDir = if ($userDataMatch.Groups[1].Success) {
    $userDataMatch.Groups[1].Value
  } else {
    $userDataMatch.Groups[2].Value
  }

  $normalizedUserDataDir = Normalize-UserDataDir -Value $capturedUserDataDir
  if ([string]::IsNullOrWhiteSpace($normalizedUserDataDir) -or $normalizedUserDataDir -ne $target) {
    continue
  }

  $portMatch = [Regex]::Match($line, $matchPortPattern)
  if (-not $portMatch.Success) {
    continue
  }

  $parsedPort = [int]$portMatch.Groups[1].Value
  if ($parsedPort -lt 1 -or $parsedPort -gt 65535) {
    continue
  }

  $candidates += [PSCustomObject]@{
    pid = [int]$proc.ProcessId
    port = $parsedPort
  }
}

if ($candidates.Count -eq 0) {
  Write-Output '{"found":false}'
  exit 0
}

$selected = $candidates | Sort-Object -Property pid -Descending | Select-Object -First 1
Write-Output ($selected | ConvertTo-Json -Compress -Depth 4)
`;

const GET_VERSION_PS = `
param([int]$Port)
$ErrorActionPreference = 'Stop'
$uri = "http://127.0.0.1:$Port/json/version"
try {
  $json = Invoke-RestMethod -UseBasicParsing -Uri $uri -TimeoutSec 2
  if ($null -eq $json) { exit 1 }
  $raw = $json | ConvertTo-Json -Compress -Depth 12
  Write-Output $raw
  exit 0
} catch {
  exit 1
}
`;

const RESOLVE_PORT_PS = `
param(
  [int]$RequestedPort,
  [string]$Mode
)
$ErrorActionPreference = 'Stop'

function Test-PortAvailable {
  param([int]$Port)
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch {
    return $false
  }
}

function Get-RandomFreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $allocated = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  return $allocated
}

if ($Mode -eq "fixed") {
  if (-not (Test-PortAvailable -Port $RequestedPort)) {
    Write-Error "Port $RequestedPort is already in use on Windows."
    exit 2
  }
  Write-Output $RequestedPort
  exit 0
}

if ($Mode -eq "random") {
  if ($RequestedPort -gt 0 -and (Test-PortAvailable -Port $RequestedPort)) {
    Write-Output $RequestedPort
    exit 0
  }

  for ($i = 0; $i -lt 50; $i++) {
    $candidate = Get-RandomFreePort
    if (Test-PortAvailable -Port $candidate) {
      Write-Output $candidate
      exit 0
    }
  }

  Write-Error "Failed to allocate an available Windows debug port."
  exit 3
}

Write-Error "Unsupported mode: $Mode"
exit 4
`;

const RELAY_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public class CDPRelay
{
    private static string EscapeForLog(string value)
    {
        return (value ?? string.Empty).Replace("\r", "\\r").Replace("\n", "\\n");
    }

    private static void AppendField(StringBuilder sb, string key, string value)
    {
        if (sb.Length > 0)
        {
            sb.Append(";");
        }
        sb.Append(key);
        sb.Append("=");
        sb.Append(EscapeForLog(value ?? string.Empty));
    }

    private static string BuildInnerChain(Exception ex)
    {
        if (ex == null)
        {
            return string.Empty;
        }

        var parts = new List<string>();
        var current = ex;
        var depth = 0;
        while (current != null && depth < 5)
        {
            var type = current.GetType().FullName ?? current.GetType().Name;
            var hresult = "0x" + current.HResult.ToString("X8");
            var message = EscapeForLog(current.Message ?? string.Empty);
            parts.Add(type + "|" + hresult + "|" + message);
            current = current.InnerException;
            depth += 1;
        }

        if (current != null)
        {
            parts.Add("truncated");
        }

        return string.Join(" -> ", parts.ToArray());
    }

    private static string StackTop(string stackTrace)
    {
        if (string.IsNullOrEmpty(stackTrace))
        {
            return string.Empty;
        }

        var normalized = stackTrace.Replace("\r", string.Empty);
        var lines = normalized.Split('\n');
        if (lines.Length == 0)
        {
            return string.Empty;
        }
        return lines[0].Trim();
    }

    private static string FormatSocketState(ClientWebSocket ws)
    {
        var sb = new StringBuilder();
        AppendField(sb, "wsState", ws != null ? ws.State.ToString() : string.Empty);
        if (ws != null)
        {
            AppendField(
                sb,
                "wsCloseStatus",
                ws.CloseStatus.HasValue ? ws.CloseStatus.Value.ToString() : string.Empty
            );
            AppendField(sb, "wsCloseDescription", ws.CloseStatusDescription ?? string.Empty);
        }
        return sb.ToString();
    }

    private static string FormatException(Exception ex, ClientWebSocket ws)
    {
        var sb = new StringBuilder();
        var type = ex.GetType().FullName ?? ex.GetType().Name;
        AppendField(sb, "type", type);
        AppendField(sb, "hresult", "0x" + ex.HResult.ToString("X8"));
        AppendField(sb, "message", ex.Message ?? string.Empty);

        var webSocketException = ex as WebSocketException;
        if (webSocketException != null)
        {
            AppendField(sb, "webSocketErrorCode", webSocketException.WebSocketErrorCode.ToString());
        }

        var socketException = ex as SocketException;
        if (socketException == null && ex.InnerException != null)
        {
            socketException = ex.InnerException as SocketException;
        }
        if (socketException != null)
        {
            AppendField(sb, "socketErrorCode", socketException.ErrorCode.ToString());
            AppendField(sb, "socketError", socketException.SocketErrorCode.ToString());
        }

        AppendField(sb, "innerChain", BuildInnerChain(ex.InnerException));
        AppendField(sb, "stackTop", StackTop(ex.StackTrace));
        AppendField(sb, "socketContext", FormatSocketState(ws));
        return sb.ToString();
    }

    public static void Run(string wsUrl)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);

        var ws = new ClientWebSocket();
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);
        var cts = new CancellationTokenSource();
        var token = cts.Token;

        try
        {
            ws.ConnectAsync(new Uri(wsUrl), token).GetAwaiter().GetResult();
            Console.Error.WriteLine("CONNECTED");
            Console.Error.Flush();

            var reader = Task.Run(() =>
            {
                var buf = new byte[4 * 1024 * 1024];
                try
                {
                    while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                    {
                        var sb = new StringBuilder();
                        WebSocketReceiveResult recv;
                        do
                        {
                            var seg = new ArraySegment<byte>(buf);
                            recv = ws.ReceiveAsync(seg, token).GetAwaiter().GetResult();
                            if (recv.MessageType == WebSocketMessageType.Close)
                            {
                                Console.Error.WriteLine("READER_CLOSE:" + FormatSocketState(ws));
                                Console.Error.Flush();
                                return;
                            }
                            sb.Append(Encoding.UTF8.GetString(buf, 0, recv.Count));
                        } while (!recv.EndOfMessage);

                        Console.Out.WriteLine(sb.ToString());
                        Console.Out.Flush();
                    }
                }
                catch (OperationCanceledException) { }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("READER_ERROR:" + FormatException(ex, ws));
                    Console.Error.Flush();
                }
            }, token);

            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (ws.State != WebSocketState.Open) break;
                var bytes = Encoding.UTF8.GetBytes(line);
                var seg = new ArraySegment<byte>(bytes);
                ws.SendAsync(seg, WebSocketMessageType.Text, true, token).GetAwaiter().GetResult();
            }

            cts.Cancel();
            reader.Wait(TimeSpan.FromSeconds(2));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("FATAL:" + FormatException(ex, ws));
            Console.Error.Flush();
        }
        finally
        {
            if (ws.State == WebSocketState.Open)
            {
                try
                {
                    ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None).GetAwaiter().GetResult();
                }
                catch { }
            }
            ws.Dispose();
        }
    }
}
`;

const RELAY_PS = `
param([string]$WsUrl)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
${RELAY_CSHARP}
'@
[CDPRelay]::Run($WsUrl)
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LocalDebugProxyContext {
  close: () => Promise<void>;
  broadcast: (message: string) => void;
}

interface StartLocalDebugProxyOptions {
  port: number;
  browserPath: string;
  localBrowserWsUrl: string;
  localVersionPayload: Record<string, unknown>;
  writeDebug: (message: string) => void;
  onClientMessage: (message: string) => void;
}

type RelayMessageKind = "request" | "response" | "event" | "invalid-json" | "unknown";

interface ParsedRelayMessage {
  kind: RelayMessageKind;
  id: string | number | null;
  method: string | null;
  hasError: boolean;
  targetId: string | null;
  browserContextId: string | null;
  sessionId: string | null;
}

interface RenderedCdpMessage {
  title: string;
  payload: unknown;
  parsed: ParsedRelayMessage;
  canonicalMethod: string | null;
}

interface ExistingChromeMatch {
  port: number;
  pid: number | null;
}

type WeakDisconnectSignal = "Inspector.detached" | "Target.detachedFromTarget";
type StrongDisconnectSignal = "ConnectionClosedPrematurely" | "READER_CLOSE";
type DisconnectSignal = WeakDisconnectSignal | StrongDisconnectSignal;

interface CachedDisconnectEvent {
  signal: WeakDisconnectSignal;
  observedAtMs: number;
  rawJson: string;
}

interface NearbyDisconnectEvent {
  signal: WeakDisconnectSignal;
  deltaMs: number;
  rawJson: string;
}

interface DisconnectAssessment {
  weakSignalSeen: boolean;
  strongSignalSeen: boolean;
  weakSignalWithinWindow: boolean;
  chromeDisconnectedLikely: boolean;
  summary: string;
  nearbyWeakEventCount: number;
  nearbyWeakEvents: NearbyDisconnectEvent[];
}

interface PendingInternalCdpRequest {
  generation: number;
  method: string;
  purpose: "recovery-auto-attach";
}

const WEAK_DISCONNECT_SIGNALS = new Set<WeakDisconnectSignal>([
  "Inspector.detached",
  "Target.detachedFromTarget"
]);
const STRONG_DISCONNECT_SIGNALS = new Set<StrongDisconnectSignal>([
  "ConnectionClosedPrematurely",
  "READER_CLOSE"
]);

function isWeakDisconnectSignal(signal: DisconnectSignal): signal is WeakDisconnectSignal {
  return signal === "Inspector.detached" || signal === "Target.detachedFromTarget";
}

function isStrongDisconnectSignal(signal: DisconnectSignal): signal is StrongDisconnectSignal {
  return signal === "ConnectionClosedPrematurely" || signal === "READER_CLOSE";
}

function cdpKindLabel(kind: RelayMessageKind): string {
  switch (kind) {
    case "request":
      return "Request";
    case "response":
      return "Response";
    case "event":
      return "Event";
    case "invalid-json":
      return "InvalidJson";
    case "unknown":
      return "Unknown";
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function parseRelayMessage(payload: string): ParsedRelayMessage {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const id =
      typeof parsed.id === "number" || typeof parsed.id === "string" ? parsed.id : null;
    const method = typeof parsed.method === "string" ? parsed.method : null;
    const hasResult = Object.prototype.hasOwnProperty.call(parsed, "result");
    const hasError = Object.prototype.hasOwnProperty.call(parsed, "error");
    const paramsObj = asObject(parsed.params);
    const resultObj = asObject(parsed.result);
    const paramsTargetInfoObj = asObject(paramsObj?.targetInfo);
    const resultTargetInfoObj = asObject(resultObj?.targetInfo);

    const targetId = pickFirstString(
      parsed.targetId,
      paramsObj?.targetId,
      paramsTargetInfoObj?.targetId,
      resultObj?.targetId,
      resultTargetInfoObj?.targetId
    );
    const browserContextId = pickFirstString(
      parsed.browserContextId,
      paramsObj?.browserContextId,
      paramsTargetInfoObj?.browserContextId,
      resultObj?.browserContextId,
      resultTargetInfoObj?.browserContextId
    );
    const sessionId = pickFirstString(parsed.sessionId, paramsObj?.sessionId, resultObj?.sessionId);

    if (method && id !== null) {
      return { kind: "request", id, method, hasError: false, targetId, browserContextId, sessionId };
    }
    if (id !== null && (hasResult || hasError || !method)) {
      return { kind: "response", id, method, hasError, targetId, browserContextId, sessionId };
    }
    if (method) {
      return { kind: "event", id: null, method, hasError: false, targetId, browserContextId, sessionId };
    }
    return { kind: "unknown", id, method, hasError, targetId, browserContextId, sessionId };
  } catch {
    return {
      kind: "invalid-json",
      id: null,
      method: null,
      hasError: false,
      targetId: null,
      browserContextId: null,
      sessionId: null
    };
  }
}

function toSafeRawTimestamp(iso: string): string {
  return iso.replaceAll(":", "-").replaceAll(".", "-");
}

function normalizeDebugLevel(raw: string | undefined): BridgeDebugLevel {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "important" || value === "important-only") {
    return "important";
  }
  if (value === "all" || value === "full") {
    return "all";
  }
  return "important";
}

function requestKey(id: string | number, sessionId: string | null): string {
  return `${sessionId ?? "root"}::${String(id)}`;
}

function detectUpstreamHint(chromeArgs: string[]): "chrome-devtools-mcp" | "playwright-mcp" | "unknown" {
  const hasPipeMode = chromeArgs.includes("--remote-debugging-pipe");
  const hasRemoteDebugPort =
    chromeArgs.some((arg) => arg.startsWith("--remote-debugging-port=")) ||
    chromeArgs.some((arg) => arg.startsWith("--remote-debug-port=")) ||
    chromeArgs.includes("--remote-debugging-port") ||
    chromeArgs.includes("--remote-debug-port");

  if (hasPipeMode && !hasRemoteDebugPort) {
    return "chrome-devtools-mcp";
  }
  if (!hasPipeMode && hasRemoteDebugPort) {
    return "playwright-mcp";
  }
  return "unknown";
}

function collectBridgeEnvSnapshot(env: NodeJS.ProcessEnv): Record<string, string | null> {
  return {
    WSL_CHROME_BRIDGE_DEBUG: env.WSL_CHROME_BRIDGE_DEBUG ?? null,
    WSL_CHROME_BRIDGE_DEBUG_FILE: env.WSL_CHROME_BRIDGE_DEBUG_FILE ?? null,
    WSL_CHROME_BRIDGE_DEBUG_LEVEL: env.WSL_CHROME_BRIDGE_DEBUG_LEVEL ?? null,
    WSL_CHROME_BRIDGE_DEBUG_RAW_DIR: env.WSL_CHROME_BRIDGE_DEBUG_RAW_DIR ?? null,
    WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT: env.WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT ?? null,
    WSL_CHROME_BRIDGE_EXECUTABLE_PATH: env.WSL_CHROME_BRIDGE_EXECUTABLE_PATH ?? null,
    WSL_CHROME_BRIDGE_USER_DATA_DIR: env.WSL_CHROME_BRIDGE_USER_DATA_DIR ?? null,
    DISPLAY: env.DISPLAY ?? null
  };
}

function cleanupEmptyLocalUserDataDirArtifact(
  userDataDir: string | null,
  writeDebug: (message: string) => void
): void {
  if (!userDataDir) {
    return;
  }

  // Playwright can resolve Windows-like profile paths into a Linux absolute path
  // and pre-create that directory. It is safe to clean it up only when still empty.
  if (!userDataDir.startsWith("/")) {
    writeDebug(`cleanup userDataDirArtifact skipped reason=non-linux-path path=${userDataDir}`);
    return;
  }

  try {
    const stats = lstatSync(userDataDir);
    if (stats.isSymbolicLink()) {
      writeDebug(`cleanup userDataDirArtifact skipped reason=symlink path=${userDataDir}`);
      return;
    }
    if (!stats.isDirectory()) {
      writeDebug(`cleanup userDataDirArtifact skipped reason=not-directory path=${userDataDir}`);
      return;
    }

    const entries = readdirSync(userDataDir);
    if (entries.length > 0) {
      writeDebug(
        `cleanup userDataDirArtifact skipped reason=not-empty path=${userDataDir} entries=${entries.length}`
      );
      return;
    }

    // Remove only an empty directory. This never removes non-empty paths.
    rmdirSync(userDataDir);
    writeDebug(`cleanup userDataDirArtifact removed path=${userDataDir}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeDebug(`cleanup userDataDirArtifact skipped reason=error path=${userDataDir} error=${message}`);
  }
}

function hasPipeFds(): boolean {
  try {
    fstatSync(3);
    fstatSync(4);
    return true;
  } catch {
    return false;
  }
}

function parseExistingChromeMatch(raw: string): ExistingChromeMatch | null {
  try {
    const value = JSON.parse(raw.trim()) as Record<string, unknown>;
    if (
      value &&
      Object.prototype.hasOwnProperty.call(value, "found") &&
      value.found === false
    ) {
      return null;
    }

    const port = Number.parseInt(String(value.port), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return null;
    }

    const pidRaw = value.pid;
    const pid =
      typeof pidRaw === "number" && Number.isFinite(pidRaw)
        ? Math.trunc(pidRaw)
        : Number.parseInt(String(pidRaw), 10);

    return {
      port,
      pid: Number.isFinite(pid) ? pid : null
    };
  } catch {
    return null;
  }
}

function parseRelayField(line: string, field: string): string | null {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|;)${escapedField}=([^;]*)`);
  const match = line.match(pattern);
  if (!match) {
    return null;
  }
  return match[1] ?? null;
}

function detectStrongDisconnectSignalFromRelayLog(line: string): StrongDisconnectSignal | null {
  if (line.startsWith("READER_CLOSE:")) {
    return "READER_CLOSE";
  }
  if (!line.startsWith("READER_ERROR:")) {
    return null;
  }
  const payload = line.slice("READER_ERROR:".length);
  const webSocketErrorCode = parseRelayField(payload, "webSocketErrorCode");
  if (webSocketErrorCode === "ConnectionClosedPrematurely") {
    return "ConnectionClosedPrematurely";
  }
  return null;
}

function detectWeakDisconnectSignalFromCdp(rendered: RenderedCdpMessage): WeakDisconnectSignal | null {
  if (rendered.parsed.kind !== "event" || !rendered.canonicalMethod) {
    return null;
  }
  if (rendered.canonicalMethod === "Inspector.detached") {
    return "Inspector.detached";
  }
  if (rendered.canonicalMethod === "Target.detachedFromTarget") {
    return "Target.detachedFromTarget";
  }
  return null;
}

function assessDisconnectSignals(
  signals: Set<DisconnectSignal>,
  recentWeakEvents: CachedDisconnectEvent[],
  disconnectAtMs: number,
  windowMs: number
): DisconnectAssessment {
  let weakSignalSeen = false;
  let strongSignalSeen = false;
  for (const signal of signals) {
    if (isWeakDisconnectSignal(signal) && WEAK_DISCONNECT_SIGNALS.has(signal)) {
      weakSignalSeen = true;
    }
    if (isStrongDisconnectSignal(signal) && STRONG_DISCONNECT_SIGNALS.has(signal)) {
      strongSignalSeen = true;
    }
  }

  // We only treat weak disconnect events as actionable when they happen
  // immediately before websocket interruption. This avoids stale-detach false positives.
  const nearbyWeakEvents: NearbyDisconnectEvent[] = [];
  for (const event of recentWeakEvents) {
    const deltaMs = disconnectAtMs - event.observedAtMs;
    if (deltaMs < 0 || deltaMs > windowMs) {
      continue;
    }
    nearbyWeakEvents.push({
      signal: event.signal,
      deltaMs,
      rawJson: event.rawJson
    });
  }

  const weakSignalWithinWindow = nearbyWeakEvents.length > 0;
  return {
    weakSignalSeen,
    strongSignalSeen,
    weakSignalWithinWindow,
    chromeDisconnectedLikely: weakSignalWithinWindow && strongSignalSeen,
    summary: Array.from(signals).join(",") || "none",
    nearbyWeakEventCount: nearbyWeakEvents.length,
    nearbyWeakEvents
  };
}

async function startLocalDebugProxy(
  options: StartLocalDebugProxyOptions
): Promise<LocalDebugProxyContext> {
  const clients = new Set<WebSocket>();
  const wsServer = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    const reqUrl = req.url ?? "/";
    if (reqUrl === "/json/version") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(options.localVersionPayload));
      return;
    }
    if (reqUrl === "/json" || reqUrl === "/json/list") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify([
          {
            id: "wsl-chrome-bridge-browser",
            type: "browser",
            webSocketDebuggerUrl: options.localBrowserWsUrl
          }
        ])
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const reqUrl = req.url ?? "";
    if (reqUrl !== options.browserPath) {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (client) => {
      wsServer.emit("connection", client, req);
    });
  });

  wsServer.on("connection", (client) => {
    clients.add(client);
    options.writeDebug("localProxy client connected");
    client.on("message", (data) => {
      const message = typeof data === "string" ? data : data.toString("utf8");
      if (!message) {
        return;
      }
      options.onClientMessage(message);
    });
    client.on("close", () => {
      clients.delete(client);
      options.writeDebug("localProxy client disconnected");
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  return {
    close: async () => {
      for (const client of clients) {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    broadcast: (message: string) => {
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    }
  };
}

export function createBridgeRunner() {
  return async function runBridge(chromeArgs: string[]): Promise<number> {
    const env = process.env;
    const debugFileFromEnv = env.WSL_CHROME_BRIDGE_DEBUG_FILE?.trim() || null;
    let activeDebugFile = debugFileFromEnv;
    let activeRawDebugDir = env.WSL_CHROME_BRIDGE_DEBUG_RAW_DIR?.trim() || null;
    const debugLevel = normalizeDebugLevel(env.WSL_CHROME_BRIDGE_DEBUG_LEVEL);
    const debug = env.WSL_CHROME_BRIDGE_DEBUG === "1" || Boolean(activeDebugFile);
    const requestMethodById = new Map<string, string>();
    let internalCdpRequestId = INTERNAL_CDP_REQUEST_ID_START;
    const pendingInternalCdpRequests = new Map<string, PendingInternalCdpRequest>();
    let lastRawTimestamp = "";
    let sameTimestampSequence = 0;

    const writeDebug = (message: string): void => {
      if (!debug) {
        return;
      }
      const line = `[${new Date().toISOString()}] ${message}\n`;
      process.stderr.write(`[wsl-chrome-bridge][debug] ${message}\n`);
      if (activeDebugFile) {
        try {
          mkdirSync(dirname(activeDebugFile), { recursive: true });
          appendFileSync(activeDebugFile, line, "utf8");
        } catch {
          // keep running even if debug file write fails
        }
      }
    };

    const writeRawPayload = (payload: string): string | null => {
      if (!activeRawDebugDir) {
        return null;
      }
      try {
        mkdirSync(activeRawDebugDir, { recursive: true });
        const now = new Date();
        const safeTimestamp = toSafeRawTimestamp(now.toISOString());
        if (safeTimestamp === lastRawTimestamp) {
          sameTimestampSequence += 1;
        } else {
          lastRawTimestamp = safeTimestamp;
          sameTimestampSequence = 0;
        }
        const suffix =
          sameTimestampSequence === 0 ? "" : `-${String(sameTimestampSequence).padStart(4, "0")}`;
        const fileName = `raw-${safeTimestamp}${suffix}.log`;
        const path = join(activeRawDebugDir, fileName);
        writeFileSync(path, payload, "utf8");
        return path;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeDebug(`rawPayloadWriteFailed dir=${activeRawDebugDir} error=${message}`);
        return null;
      }
    };

    const writeDebugBlock = (header: string, jsonPayload: unknown): void => {
      if (!debug) {
        return;
      }
      const timestamp = new Date().toISOString();
      const body =
        typeof jsonPayload === "string" ? jsonPayload : JSON.stringify(jsonPayload);
      const block = `[${timestamp}] ${header}\n${body}\n\n`;
      process.stderr.write(`[wsl-chrome-bridge][debug] ${header}\n${body}\n`);
      if (activeDebugFile) {
        try {
          mkdirSync(dirname(activeDebugFile), { recursive: true });
          appendFileSync(activeDebugFile, block, "utf8");
        } catch {
          // keep running even if debug file write fails
        }
      }
    };

    const replaceLargeStringFields = (value: unknown, path: string): unknown => {
      if (typeof value === "string") {
        if (Buffer.byteLength(value, "utf8") < LARGE_CDP_STRING_BYTES) {
          return value;
        }
        const rawPath = writeRawPayload(value);
        if (!rawPath) {
          return value;
        }
        return {
          __rawDataPath: rawPath,
          __rawDataBytes: Buffer.byteLength(value, "utf8"),
          __replacedField: path
        };
      }

      if (Array.isArray(value)) {
        return value.map((item, index) => replaceLargeStringFields(item, `${path}[${index}]`));
      }

      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const replaced: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(record)) {
          replaced[key] = replaceLargeStringFields(child, `${path}.${key}`);
        }
        return replaced;
      }

      return value;
    };

    const hopLabel = (hop: "upstream=>relay" | "relay=>chrome" | "chrome=>relay" | "relay=>upstream"): string => {
      switch (hop) {
        case "upstream=>relay":
          return "upstream -> relay";
        case "relay=>chrome":
          return "relay -> chrome";
        case "chrome=>relay":
          return "chrome -> relay";
        case "relay=>upstream":
          return "relay -> upstream";
      }
    };

    const renderCdpMessage = (payload: string): RenderedCdpMessage => {
      const parsed = parseRelayMessage(payload);
      let canonicalMethod = parsed.method;

      if (parsed.kind === "request" && parsed.id !== null && parsed.method) {
        if (requestMethodById.size >= MAX_TRACKED_REQUEST_METHODS) {
          const oldest = requestMethodById.keys().next().value;
          if (oldest) {
            requestMethodById.delete(oldest);
          }
        }
        requestMethodById.set(requestKey(parsed.id, parsed.sessionId), parsed.method);
      }

      if (!canonicalMethod && parsed.kind === "response" && parsed.id !== null) {
        const key = requestKey(parsed.id, parsed.sessionId);
        canonicalMethod = requestMethodById.get(key) ?? null;
        requestMethodById.delete(key);
      }

      const title =
        canonicalMethod ??
        (parsed.kind === "response" && parsed.id !== null
          ? `id=${parsed.id}`
          : parsed.kind === "invalid-json"
            ? "InvalidJSON"
            : "UnknownMessage");

      try {
        const json = JSON.parse(payload) as unknown;
        const replaced = replaceLargeStringFields(json, "$");
        if (replaced && typeof replaced === "object" && !Array.isArray(replaced)) {
          const asRecord = { ...(replaced as Record<string, unknown>) };
          delete asRecord.method;
          return { title, payload: asRecord, parsed, canonicalMethod };
        }
        return { title, payload: replaced, parsed, canonicalMethod };
      } catch {
        return { title, payload, parsed, canonicalMethod };
      }
    };

    const isImportantRenderedMessage = (rendered: RenderedCdpMessage): boolean => {
      const method = rendered.canonicalMethod;
      if (method && IMPORTANT_EXCLUDED_METHODS.has(method)) {
        return false;
      }
      if (rendered.parsed.hasError) {
        return true;
      }
      return method !== null && IMPORTANT_CDP_METHODS.has(method);
    };

    const writeCdpHopLog = (
      hop: "upstream=>relay" | "relay=>chrome" | "chrome=>relay" | "relay=>upstream",
      rendered: RenderedCdpMessage
    ): void => {
      if (debugLevel === "important" && !isImportantRenderedMessage(rendered)) {
        return;
      }
      const kind = cdpKindLabel(rendered.parsed.kind);
      writeDebugBlock(`CDP(${hopLabel(hop)}) ${kind} ${rendered.title}`, rendered.payload);
    };

    if (activeDebugFile) {
      try {
        mkdirSync(dirname(activeDebugFile), { recursive: true });
        writeFileSync(
          activeDebugFile,
          `[${new Date().toISOString()}] bridge debug file created\n`,
          "utf8"
        );
      } catch {
        process.stderr.write(
          `[wsl-chrome-bridge] failed to create debug file: ${activeDebugFile}\n`
        );
      }
    }

    writeDebug(`startupContext=${JSON.stringify({
      upstreamHint: detectUpstreamHint(chromeArgs),
      argv: chromeArgs,
      env: collectBridgeEnvSnapshot(env)
    })}`);

    let plan: ReturnType<typeof planBridgeLaunch>;
    try {
      plan = planBridgeLaunch(chromeArgs, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeDebug(`planBridgeLaunchFailed message=${message}`);
      throw error;
    }

    if (!activeDebugFile && plan.bridgeDebugFile) {
      activeDebugFile = plan.bridgeDebugFile;
      try {
        mkdirSync(dirname(activeDebugFile), { recursive: true });
        writeFileSync(
          activeDebugFile,
          `[${new Date().toISOString()}] bridge debug file created\n`,
          "utf8"
        );
      } catch {
        process.stderr.write(
          `[wsl-chrome-bridge] failed to create debug file: ${activeDebugFile}\n`
        );
      }
    }

    if (!activeRawDebugDir && plan.bridgeDebugRawDir) {
      activeRawDebugDir = plan.bridgeDebugRawDir;
    }

    if (activeRawDebugDir) {
      try {
        mkdirSync(activeRawDebugDir, { recursive: true });
        writeDebug(`rawDebugDir enabled path=${activeRawDebugDir}`);
      } catch {
        process.stderr.write(
          `[wsl-chrome-bridge] failed to create raw debug dir: ${activeRawDebugDir}\n`
        );
        activeRawDebugDir = null;
      }
    } else {
      writeDebug("rawDebugDir disabled");
    }
    writeDebug(`debugLevel=${debugLevel}`);

    writeDebug(`argv=${JSON.stringify(chromeArgs)}`);
    writeDebug(`launchPlan=${JSON.stringify({
      bridgeDebugFile: plan.bridgeDebugFile,
      bridgeDebugRawDir: plan.bridgeDebugRawDir,
      bridgeChromeExecutablePath: plan.bridgeChromeExecutablePath,
      usePipeTransport: plan.usePipeTransport,
      userDataDir: plan.userDataDir,
      windowsUserDataDir: plan.windowsUserDataDir,
      windowsUserDataDirSource: plan.windowsUserDataDirSource,
      requestedLocalDebugPort: plan.requestedLocalDebugPort,
      localProxyPort: plan.localProxyPort,
      windowsDebugPort: plan.windowsDebugPort,
      windowsDebugPortSource: plan.windowsDebugPortSource,
      passthroughArgs: plan.passthroughArgs
    })}`);

    cleanupEmptyLocalUserDataDirArtifact(plan.userDataDir, writeDebug);

    const cleanupUserDataDirOnExit = (reason: string): void => {
      if (!(plan.createdUserDataDir && plan.userDataDir)) {
        return;
      }
      rmSync(plan.userDataDir, { recursive: true, force: true });
      writeDebug(`cleanup userDataDir removed reason=${reason} path=${plan.userDataDir}`);
    };

    const powerShell = createPowerShellContext(env);
    writeDebug(`powershellPath=${powerShell.powershellPath}`);

    const launchScript = writePowerShellScript(powerShell, "launch-chrome.ps1", LAUNCH_CHROME_PS);
    const findExistingChromeScript = writePowerShellScript(
      powerShell,
      "find-existing-chrome.ps1",
      FIND_EXISTING_CHROME_PS
    );
    const getVersionScript = writePowerShellScript(powerShell, "get-version.ps1", GET_VERSION_PS);
    const resolvePortScript = writePowerShellScript(powerShell, "resolve-port.ps1", RESOLVE_PORT_PS);
    const relayScript = writePowerShellScript(powerShell, "relay.ps1", RELAY_PS);
    writeDebug(
      `scripts={launch:${launchScript.windowsPath},findExisting:${findExistingChromeScript.windowsPath},version:${getVersionScript.windowsPath},resolvePort:${resolvePortScript.windowsPath},relay:${relayScript.windowsPath}}`
    );

    const usePipeTransport = plan.usePipeTransport && hasPipeFds();
    const useLocalProxyTransport = plan.localProxyPort !== null;
    writeDebug(
      `transportMode requestedPipe=${plan.usePipeTransport} pipe=${usePipeTransport} localProxy=${useLocalProxyTransport} localProxyPort=${plan.localProxyPort ?? "none"}`
    );

    if (plan.usePipeTransport && !usePipeTransport) {
      process.stderr.write(
        "[wsl-chrome-bridge] --remote-debugging-pipe was requested but OS pipe fds (3/4) are missing.\n"
      );
      destroyPowerShellContext(powerShell);
      cleanupUserDataDirOnExit("pipeFdsMissing");
      return 1;
    }

    if (!usePipeTransport && !useLocalProxyTransport) {
      process.stderr.write(
        "[wsl-chrome-bridge] missing transport channel. " +
          "Provide --remote-debugging-port (Playwright mode) or launch with OS pipes fd3/fd4.\n"
      );
      destroyPowerShellContext(powerShell);
      cleanupUserDataDirOnExit("missingTransportChannel");
      return 1;
    }

    interface ChromeSession {
      windowsDebugPort: number;
      remoteVersion: Record<string, unknown>;
      remoteBrowserWsUrl: string;
      ownership: "attached" | "launched";
    }

    const waitForRemoteVersion = async (
      windowsDebugPort: number,
      phase: "startup" | "recovery"
    ): Promise<Record<string, unknown> | null> => {
      const startAt = Date.now();
      while (Date.now() - startAt < CHROME_READY_TIMEOUT_MS) {
        const result = await runPowerShellFile(
          powerShell,
          getVersionScript.windowsPath,
          [String(windowsDebugPort)],
          { timeoutMs: 4_000 }
        );

        if (result.code === 0 && result.stdout.trim()) {
          try {
            const version = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
            if (typeof version.webSocketDebuggerUrl === "string") {
              writeDebug(
                `remoteVersion phase=${phase} port=${windowsDebugPort} payload=${JSON.stringify(version)}`
              );
              return version;
            }
            writeDebug(
              `remoteVersionMissingWs phase=${phase} port=${windowsDebugPort} payload=${result.stdout.trim()}`
            );
          } catch {
            writeDebug(
              `remoteVersionParseFailed phase=${phase} port=${windowsDebugPort} raw=${result.stdout.trim()}`
            );
          }
        } else if (debug) {
          writeDebug(
            `waitVersion retry phase=${phase} port=${windowsDebugPort} code=${result.code} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`
          );
        }
        await sleep(POLL_INTERVAL_MS);
      }
      return null;
    };

    const tryReuseExistingChromeSession = async (
      phase: "startup" | "recovery"
    ): Promise<ChromeSession | null> => {
      if (!plan.windowsUserDataDir) {
        writeDebug(`existingChrome skip phase=${phase} reason=no-windows-user-data-dir`);
        return null;
      }

      const existingResult = await runPowerShellFile(
        powerShell,
        findExistingChromeScript.windowsPath,
        [plan.windowsUserDataDir],
        { timeoutMs: 8_000 }
      );

      if (existingResult.code !== 0) {
        writeDebug(
          `existingChrome query failed phase=${phase} code=${existingResult.code} stdout=${existingResult.stdout.trim()} stderr=${existingResult.stderr.trim()}`
        );
        return null;
      }

      const existingMatch = parseExistingChromeMatch(existingResult.stdout);
      if (!existingMatch) {
        writeDebug(`existingChrome miss phase=${phase}`);
        return null;
      }

      writeDebug(
        `existingChrome hit phase=${phase} port=${existingMatch.port} pid=${existingMatch.pid ?? "unknown"}`
      );
      const version = await waitForRemoteVersion(existingMatch.port, phase);
      if (!version || typeof version.webSocketDebuggerUrl !== "string") {
        writeDebug(
          `existingChrome stale phase=${phase} port=${existingMatch.port} pid=${existingMatch.pid ?? "unknown"}`
        );
        return null;
      }

      return {
        windowsDebugPort: existingMatch.port,
        remoteVersion: version,
        remoteBrowserWsUrl: version.webSocketDebuggerUrl,
        ownership: "attached"
      };
    };

    const launchChromeSession = async (phase: "startup" | "recovery"): Promise<ChromeSession> => {
      const resolvePortMode = plan.windowsDebugPortSource === "auto-random" ? "random" : "fixed";
      const resolvePortResult = await runPowerShellFile(
        powerShell,
        resolvePortScript.windowsPath,
        [String(plan.windowsDebugPort), resolvePortMode],
        { timeoutMs: 8_000 }
      );

      if (resolvePortResult.code !== 0) {
        throw new Error(
          `failed to resolve an available Windows debug port: ${resolvePortResult.stderr || resolvePortResult.stdout}`
        );
      }

      const resolvedWindowsDebugPort = Number.parseInt(resolvePortResult.stdout.trim(), 10);
      if (!Number.isFinite(resolvedWindowsDebugPort)) {
        throw new Error("failed to parse resolved Windows debug port from PowerShell output.");
      }
      writeDebug(
        `resolvedWindowsDebugPort phase=${phase} port=${resolvedWindowsDebugPort} source=${plan.windowsDebugPortSource} mode=${resolvePortMode}`
      );

      const planWithResolvedPort = {
        ...plan,
        windowsDebugPort: resolvedWindowsDebugPort
      };

      const chromePath = resolveChromeCommand({
        env,
        bridgeChromeExecutablePath: plan.bridgeChromeExecutablePath
      });
      const windowsArgs = buildWindowsChromeArgs(planWithResolvedPort, env);
      writeDebug(`chromePath phase=${phase} path=${chromePath}`);
      writeDebug(`windowsArgs phase=${phase} args=${JSON.stringify(windowsArgs)}`);

      const launchResult = await runPowerShellFile(
        powerShell,
        launchScript.windowsPath,
        [chromePath, ...windowsArgs],
        { timeoutMs: 15_000 }
      );

      if (launchResult.code !== 0) {
        throw new Error(
          `failed to launch Windows Chrome: ${launchResult.stderr || launchResult.stdout}`
        );
      }
      writeDebug(
        `launchResult phase=${phase} code=${launchResult.code} stdout=${launchResult.stdout.trim()} stderr=${launchResult.stderr.trim()}`
      );

      const launchedPid = Number.parseInt(launchResult.stdout.trim(), 10);
      if (Number.isFinite(launchedPid)) {
        writeDebug(`launchResult phase=${phase} pid=${launchedPid}`);
      } else {
        writeDebug(`launchResult phase=${phase} pid=unknown raw=${launchResult.stdout.trim()}`);
      }

      const version = await waitForRemoteVersion(resolvedWindowsDebugPort, phase);
      if (!version || typeof version.webSocketDebuggerUrl !== "string") {
        throw new Error("Chrome debug websocket was not ready in time.");
      }

      return {
        windowsDebugPort: resolvedWindowsDebugPort,
        remoteVersion: version,
        remoteBrowserWsUrl: version.webSocketDebuggerUrl,
        ownership: "launched"
      };
    };

    const establishChromeSession = async (
      phase: "startup" | "recovery"
    ): Promise<ChromeSession> => {
      const existing = await tryReuseExistingChromeSession(phase);
      if (existing) {
        return existing;
      }
      return await launchChromeSession(phase);
    };

    let startupSession: ChromeSession;
    try {
      startupSession = await establishChromeSession("startup");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeDebug(`startupSession failed message=${message}`);
      process.stderr.write(`[wsl-chrome-bridge] ${message}\n`);
      destroyPowerShellContext(powerShell);
      cleanupUserDataDirOnExit("startupSessionFailed");
      return 1;
    }

    let activeRemoteBrowserWsUrl = startupSession.remoteBrowserWsUrl;
    let activeWindowsDebugPort = startupSession.windowsDebugPort;
    let activeOwnership: "attached" | "launched" = startupSession.ownership;
    const startupRemoteVersion = startupSession.remoteVersion;
    writeDebug(
      `startupSession established ownership=${activeOwnership} port=${activeWindowsDebugPort} ws=${activeRemoteBrowserWsUrl}`
    );

    let pipeIn: ReturnType<typeof createReadStream> | null = null;
    let pipeOut: ReturnType<typeof createWriteStream> | null = null;
    if (usePipeTransport) {
      pipeIn = createReadStream("", { fd: 3, autoClose: false });
      pipeOut = createWriteStream("", { fd: 4, autoClose: false });
    }

    const remoteBrowserPath = parseBrowserPathFromWsUrl(activeRemoteBrowserWsUrl);
    const localBrowserWsUrl =
      plan.localProxyPort === null
        ? null
        : `ws://127.0.0.1:${plan.localProxyPort}${remoteBrowserPath}`;

    let localProxy: LocalDebugProxyContext | null = null;
    const earlyWsMessages: string[] = [];
    let handleLocalProxyMessage: (message: string) => void = (message) => {
      earlyWsMessages.push(message);
    };
    if (plan.localProxyPort !== null && localBrowserWsUrl) {
      const localVersionPayload: Record<string, unknown> = {
        ...startupRemoteVersion,
        webSocketDebuggerUrl: localBrowserWsUrl
      };
      try {
        localProxy = await startLocalDebugProxy({
          port: plan.localProxyPort,
          browserPath: remoteBrowserPath,
          localBrowserWsUrl,
          localVersionPayload,
          writeDebug,
          onClientMessage: (message) => {
            handleLocalProxyMessage(message);
          }
        });
        writeDebug(`localProxy listening ws=${localBrowserWsUrl}`);
        // Playwright's chromium launcher waits for this exact startup line when
        // --remote-debugging-port mode is used. Emitting it here makes the bridge
        // behave like a native Chromium process from Playwright's perspective.
        process.stderr.write(`DevTools listening on ${localBrowserWsUrl}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeDebug(`localProxy start failed: ${message}`);
        process.stderr.write(
          `[wsl-chrome-bridge] failed to start local websocket proxy on 127.0.0.1:${plan.localProxyPort}: ${message}\n`
        );
        pipeIn?.destroy();
        pipeOut?.destroy();
        destroyPowerShellContext(powerShell);
        cleanupUserDataDirOnExit("localProxyStartFailed");
        return 1;
      }
    }

    type RelayState = "connecting" | "connected" | "degraded";
    let relayState: RelayState = "connecting";
    let relayConnected = false;
    let relayStdoutBuffer = "";
    let relayStderrBuffer = "";
    let relayGeneration = 0;
    let relayChild: ReturnType<typeof spawn> | null = null;
    let pendingFromPipe = Buffer.alloc(0);
    const queuedForRelay: Array<{
      message: string;
      rendered: RenderedCdpMessage;
    }> = [];
    let relayBootstrapPending = false;
    let recoveryPromise: Promise<void> | null = null;
    const disconnectSignals = new Set<DisconnectSignal>();
    const recentWeakDisconnectEvents: CachedDisconnectEvent[] = [];
    let strongDisconnectAtMs: number | null = null;
    let latestDisconnectAssessment: DisconnectAssessment | null = null;

    let closed = false;
    const cleanup = async (code: number): Promise<number> => {
      if (closed) {
        return code;
      }
      closed = true;
      writeDebug(`cleanup start code=${code}`);

      pipeIn?.destroy();
      pipeOut?.destroy();

      if (localProxy) {
        await localProxy.close();
        writeDebug("cleanup localProxy closed");
      }

      const child = relayChild;
      relayChild = null;
      if (child) {
        try {
          child.stdin?.end();
        } catch {
          // ignore
        }
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        await Promise.race([once(child, "exit"), sleep(1_000)]);
      }

      destroyPowerShellContext(powerShell);
      writeDebug("cleanup powershell context destroyed");

      cleanupUserDataDirOnExit("cleanup");
      writeDebug(`cleanup complete code=${code}`);
      return code;
    };

    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const signalHandlers = new Map<NodeJS.Signals, () => void>();

    return await new Promise<number>((resolvePromise) => {
      let resolving = false;
      let shuttingDown = false;

      const clear = () => {
        for (const [signal, handler] of signalHandlers) {
          process.off(signal, handler);
        }
      };

      const finalize = (code: number): void => {
        if (resolving) {
          return;
        }
        resolving = true;
        shuttingDown = true;
        clear();
        void cleanup(code).then(resolvePromise);
      };

      const noteDisconnectSignal = (signal: DisconnectSignal, source: string): void => {
        if (disconnectSignals.has(signal)) {
          return;
        }
        disconnectSignals.add(signal);
        writeDebug(`disconnectSignal observed signal=${signal} source=${source}`);
      };

      const rememberWeakDisconnectEvent = (
        signal: WeakDisconnectSignal,
        rawJson: string,
        observedAtMs: number
      ): void => {
        recentWeakDisconnectEvents.push({ signal, rawJson, observedAtMs });
        if (recentWeakDisconnectEvents.length > DISCONNECT_EVENT_BUFFER_LIMIT) {
          recentWeakDisconnectEvents.splice(
            0,
            recentWeakDisconnectEvents.length - DISCONNECT_EVENT_BUFFER_LIMIT
          );
        }
        writeDebug(
          `disconnectEvent cached signal=${signal} cacheSize=${recentWeakDisconnectEvents.length}`
        );
      };

      const writeDisconnectAssessment = (
        trigger: string,
        disconnectAtMs?: number
      ): DisconnectAssessment => {
        const effectiveDisconnectAtMs =
          strongDisconnectAtMs ?? disconnectAtMs ?? Date.now();
        const assessment = assessDisconnectSignals(
          disconnectSignals,
          recentWeakDisconnectEvents,
          effectiveDisconnectAtMs,
          DISCONNECT_EVENT_TIME_WINDOW_MS
        );
        writeDebug(
          `disconnectAssessment trigger=${trigger} weakSignalSeen=${assessment.weakSignalSeen} strongSignalSeen=${assessment.strongSignalSeen} weakSignalWithinWindow=${assessment.weakSignalWithinWindow} windowMs=${DISCONNECT_EVENT_TIME_WINDOW_MS} disconnectAtMs=${effectiveDisconnectAtMs} chromeDisconnectedLikely=${assessment.chromeDisconnectedLikely} nearbyWeakEventCount=${assessment.nearbyWeakEventCount} disconnectSignals=${assessment.summary}`
        );
        if (assessment.nearbyWeakEvents.length > 0) {
          writeDebugBlock(
            `disconnectAssessment nearbyWeakEvents trigger=${trigger}`,
            assessment.nearbyWeakEvents
          );
        }
        return assessment;
      };

      const markRelayState = (
        nextState: RelayState,
        reason: string,
        disconnectAssessment: DisconnectAssessment | null = null
      ): void => {
        if (nextState !== "degraded") {
          latestDisconnectAssessment = null;
        } else if (disconnectAssessment) {
          latestDisconnectAssessment = disconnectAssessment;
        }
        if (relayState === nextState) {
          writeDebug(`relayState unchanged state=${nextState} reason=${reason}`);
          return;
        }
        relayState = nextState;
        const assessmentSuffix = disconnectAssessment
          ? ` disconnectSignals=${disconnectAssessment.summary} weakSignalWithinWindow=${disconnectAssessment.weakSignalWithinWindow} nearbyWeakEventCount=${disconnectAssessment.nearbyWeakEventCount} chromeDisconnectedLikely=${disconnectAssessment.chromeDisconnectedLikely}`
          : "";
	        writeDebug(
	          `relayState changed state=${relayState} reason=${reason} port=${activeWindowsDebugPort} ownership=${activeOwnership}${assessmentSuffix}`
	        );
	      };

	      const nextInternalCdpRequestId = (): number => {
	        internalCdpRequestId += 1;
	        return internalCdpRequestId;
	      };

	      const sendRecoveryAutoAttachBootstrap = (
	        child: ReturnType<typeof spawn>,
	        generation: number
	      ): boolean => {
	        if (!child.stdin) {
	          return false;
	        }
	        const payload = {
	          id: nextInternalCdpRequestId(),
	          method: "Target.setAutoAttach",
	          params: {
	            autoAttach: true,
	            waitForDebuggerOnStart: true,
	            flatten: true
	          }
	        };
	        const message = JSON.stringify(payload);
	        const rendered = renderCdpMessage(message);
	        pendingInternalCdpRequests.set(requestKey(payload.id, null), {
	          generation,
	          method: payload.method,
	          purpose: "recovery-auto-attach"
	        });
	        writeDebugBlock("CDP(bridge-internal -> chrome) Request Target.setAutoAttach", rendered.payload);
	        child.stdin.write(`${message}\n`);
	        return true;
	      };

	      const tryHandleInternalCdpResponse = (
	        generation: number,
	        rendered: RenderedCdpMessage,
	        child: ReturnType<typeof spawn>
	      ): boolean => {
	        if (rendered.parsed.kind !== "response" || rendered.parsed.id === null) {
	          return false;
	        }
	        const key = requestKey(rendered.parsed.id, rendered.parsed.sessionId);
	        const pending = pendingInternalCdpRequests.get(key);
	        if (!pending) {
	          return false;
	        }
	        pendingInternalCdpRequests.delete(key);
	        writeDebugBlock(
	          `CDP(chrome -> bridge-internal) Response ${pending.method}`,
	          rendered.payload
	        );
	        if (pending.generation !== generation) {
	          return true;
	        }
	        if (pending.purpose === "recovery-auto-attach") {
	          relayBootstrapPending = false;
	          if (rendered.parsed.hasError) {
	            relayConnected = false;
	            const assessment = writeDisconnectAssessment("recoveryBootstrapAutoAttachError");
	            markRelayState("degraded", "recoveryBootstrapAutoAttachError", assessment);
	            try {
	              child.kill("SIGTERM");
	            } catch {
	              // ignore
	            }
	            maybeRecoverRelayForWs();
	            return true;
	          }
	          writeDebug("recoveryBootstrap autoAttach acknowledged");
	          flushQueuedForRelay();
	        }
	        return true;
	      };

      const flushQueuedForRelay = (): void => {
        if (!relayChild || !relayConnected || !relayChild.stdin || relayBootstrapPending) {
          return;
        }
        const relayStdin = relayChild.stdin;
        while (queuedForRelay.length > 0) {
          const queued = queuedForRelay.shift();
          if (!queued) {
            break;
          }
          relayStdin.write(`${queued.message}\n`);
          writeCdpHopLog("relay=>chrome", queued.rendered);
        }
      };

      const forwardToUpstream = (message: string, rendered: RenderedCdpMessage): void => {
        if (pipeOut) {
          pipeOut.write(message);
          pipeOut.write("\0");
          writeCdpHopLog("relay=>upstream", rendered);
        }
        if (localProxy) {
          localProxy.broadcast(message);
          writeCdpHopLog("relay=>upstream", rendered);
        }
      };

      const sendToRelayOrQueue = (message: string, rendered: RenderedCdpMessage): void => {
        if (
          relayState === "connected" &&
          relayChild &&
          relayConnected &&
	          relayChild.stdin &&
	          !relayBootstrapPending
	        ) {
	          relayChild.stdin.write(`${message}\n`);
	          writeCdpHopLog("relay=>chrome", rendered);
	          return;
        }
        queuedForRelay.push({ message, rendered });
      };

      const startRelay = (remoteBrowserWsUrl: string, reason: string): void => {
        if (shuttingDown) {
          writeDebug(`startRelay skipped reason=shuttingDown trigger=${reason}`);
          return;
        }
        disconnectSignals.clear();
	        recentWeakDisconnectEvents.length = 0;
	        strongDisconnectAtMs = null;
	        relayBootstrapPending = false;
	        pendingInternalCdpRequests.clear();
	        relayGeneration += 1;
	        const generation = relayGeneration;
	        markRelayState("connecting", reason);
        relayConnected = false;
        relayStdoutBuffer = "";
        relayStderrBuffer = "";

        const previousRelayChild = relayChild;
        const child = spawn(
          powerShell.powershellPath,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            relayScript.windowsPath,
            remoteBrowserWsUrl
          ],
          {
            env,
            stdio: ["pipe", "pipe", "pipe"]
          }
        );
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        relayChild = child;

        if (previousRelayChild) {
          try {
            previousRelayChild.stdin?.end();
          } catch {
            // ignore
          }
          try {
            previousRelayChild.kill("SIGTERM");
          } catch {
            // ignore
          }
        }

        child.stderr.on("data", (chunk: string) => {
          if (generation !== relayGeneration) {
            return;
          }
          relayStderrBuffer += chunk;
          while (true) {
            const newlineIndex = relayStderrBuffer.indexOf("\n");
            if (newlineIndex === -1) {
              break;
            }
            const rawLine = relayStderrBuffer.slice(0, newlineIndex);
            relayStderrBuffer = relayStderrBuffer.slice(newlineIndex + 1);
            const line = rawLine.replace(/\r$/, "");
            if (!line) {
              continue;
            }
            writeDebug(`relayStderr ${line}`);
            const strongDisconnectSignal = detectStrongDisconnectSignalFromRelayLog(line);
            if (strongDisconnectSignal) {
              noteDisconnectSignal(strongDisconnectSignal, "relayStderr");
              const observedAtMs = Date.now();
              strongDisconnectAtMs = observedAtMs;
              relayConnected = false;
              const assessment = writeDisconnectAssessment(
                `relayStrongDisconnect:${strongDisconnectSignal}`,
                observedAtMs
              );
	              if (usePipeTransport) {
	                finalize(1);
	              } else {
	                relayBootstrapPending = false;
	                markRelayState(
	                  "degraded",
	                  `relayStrongDisconnect:${strongDisconnectSignal}`,
                  assessment
                );
                try {
                  child.kill("SIGTERM");
                } catch {
                  // ignore
                }
              }
              return;
            }
	            if (line.includes("CONNECTED")) {
	              relayConnected = true;
	              markRelayState("connected", "relayConnected");
	              if (!usePipeTransport && reason === "recovery") {
	                relayBootstrapPending = true;
	                const sent = sendRecoveryAutoAttachBootstrap(child, generation);
	                if (!sent) {
	                  relayBootstrapPending = false;
	                  relayConnected = false;
	                  const assessment = writeDisconnectAssessment("recoveryBootstrapSendFailed");
	                  markRelayState("degraded", "recoveryBootstrapSendFailed", assessment);
	                  try {
	                    child.kill("SIGTERM");
	                  } catch {
	                    // ignore
	                  }
	                  maybeRecoverRelayForWs();
	                  return;
	                }
	                continue;
	              }
	              flushQueuedForRelay();
	              continue;
	            }
	            if (line.startsWith("FATAL:")) {
	              const assessment = writeDisconnectAssessment(`relayFatal:${line}`);
	              if (usePipeTransport) {
	                finalize(1);
	              } else {
	                relayConnected = false;
	                relayBootstrapPending = false;
	                markRelayState("degraded", `relayFatal:${line}`, assessment);
	              }
	              return;
            }
          }
        });

        child.stdout.on("data", (chunk: string) => {
          if (generation !== relayGeneration) {
            return;
          }
          relayStdoutBuffer += chunk;
          while (true) {
            const newlineIndex = relayStdoutBuffer.indexOf("\n");
            if (newlineIndex === -1) {
              break;
            }
            const rawLine = relayStdoutBuffer.slice(0, newlineIndex);
            relayStdoutBuffer = relayStdoutBuffer.slice(newlineIndex + 1);
	            const line = rawLine.replace(/\r$/, "");
	            if (!line) {
	              continue;
	            }
	            const rendered = renderCdpMessage(line);
	            if (tryHandleInternalCdpResponse(generation, rendered, child)) {
	              continue;
	            }
	            const weakDisconnectSignal = detectWeakDisconnectSignalFromCdp(rendered);
	            if (weakDisconnectSignal) {
	              noteDisconnectSignal(weakDisconnectSignal, "chromeEvent");
              rememberWeakDisconnectEvent(weakDisconnectSignal, line, Date.now());
            }
            writeCdpHopLog("chrome=>relay", rendered);
            forwardToUpstream(line, rendered);
          }
        });

        child.once("error", () => {
	          if (generation !== relayGeneration) {
	            return;
	          }
	          relayConnected = false;
	          relayBootstrapPending = false;
	          const assessment = writeDisconnectAssessment("relayError");
	          if (usePipeTransport) {
	            finalize(1);
          } else {
            markRelayState("degraded", "relayError", assessment);
          }
        });

        child.once("exit", (code) => {
	          if (generation !== relayGeneration) {
	            return;
	          }
	          relayConnected = false;
	          relayBootstrapPending = false;
	          relayChild = null;
	          const assessment = writeDisconnectAssessment(`relayExit:${code ?? "null"}`);
          if (usePipeTransport) {
            finalize(code === 0 ? 0 : 1);
            return;
          }
          markRelayState("degraded", `relayExit:${code ?? "null"}`, assessment);
        });
      };

      const maybeRecoverRelayForWs = (): void => {
        if (usePipeTransport || relayState !== "degraded") {
          return;
        }
        if (shuttingDown || closed || resolving) {
          writeDebug("recovery skipped reason=shuttingDown");
          return;
        }
        if (recoveryPromise) {
          return;
        }

        recoveryPromise = (async () => {
          writeDebug("recovery start trigger=upstreamRequest");
          const recoverySession = await establishChromeSession("recovery");
          activeRemoteBrowserWsUrl = recoverySession.remoteBrowserWsUrl;
          activeWindowsDebugPort = recoverySession.windowsDebugPort;
          activeOwnership = recoverySession.ownership;
          writeDebug(
            `recovery success ownership=${activeOwnership} port=${activeWindowsDebugPort} ws=${activeRemoteBrowserWsUrl}`
          );
          startRelay(activeRemoteBrowserWsUrl, "recovery");
        })()
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            writeDebug(`recovery failed message=${message}`);
            process.stderr.write(`[wsl-chrome-bridge] recovery failed: ${message}\n`);
            finalize(1);
          })
          .finally(() => {
            recoveryPromise = null;
          });
      };

      const processUpstreamMessage = (message: string): void => {
        if (shuttingDown || closed || resolving) {
          writeDebug("upstream message ignored reason=shuttingDown");
          return;
        }
        const rendered = renderCdpMessage(message);
        writeCdpHopLog("upstream=>relay", rendered);
        const shouldShortCircuitKnownClosedBrowserClose =
          !usePipeTransport &&
          relayState !== "connected" &&
          rendered.parsed.kind === "request" &&
          rendered.canonicalMethod === "Browser.close" &&
          rendered.parsed.id !== null &&
          Boolean(latestDisconnectAssessment?.chromeDisconnectedLikely);
        if (shouldShortCircuitKnownClosedBrowserClose) {
          const syntheticResponse: Record<string, unknown> = {
            id: rendered.parsed.id,
            result: {}
          };
          if (rendered.parsed.sessionId) {
            syntheticResponse.sessionId = rendered.parsed.sessionId;
          }
          const syntheticMessage = JSON.stringify(syntheticResponse);
          const syntheticRendered = renderCdpMessage(syntheticMessage);
          writeDebug(
            `shortCircuit Browser.close reason=chromeAlreadyClosed relayState=${relayState} id=${String(rendered.parsed.id)} session=${rendered.parsed.sessionId ?? "root"}`
          );
          forwardToUpstream(syntheticMessage, syntheticRendered);
          return;
        }
        if (!usePipeTransport && relayState === "degraded") {
          maybeRecoverRelayForWs();
          sendToRelayOrQueue(message, rendered);
          return;
        }
        if (!usePipeTransport && relayState === "connecting") {
          sendToRelayOrQueue(message, rendered);
          return;
        }
        if (!usePipeTransport && (!relayConnected || relayState !== "connected")) {
          const assessment = writeDisconnectAssessment("upstreamWhileRelayUnavailable");
          markRelayState("degraded", "upstreamWhileRelayUnavailable", assessment);
          maybeRecoverRelayForWs();
          sendToRelayOrQueue(message, rendered);
          return;
        }
        sendToRelayOrQueue(message, rendered);
      };

      handleLocalProxyMessage = (message: string) => {
        processUpstreamMessage(message);
      };
      for (const earlyMessage of earlyWsMessages) {
        processUpstreamMessage(earlyMessage);
      }
      earlyWsMessages.length = 0;

      for (const signal of signals) {
        const handler = () => finalize(0);
        signalHandlers.set(signal, handler);
        process.on(signal, handler);
      }

      startRelay(activeRemoteBrowserWsUrl, "initial");

      if (pipeIn) {
        pipeIn.on("data", (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
          pendingFromPipe = Buffer.concat([pendingFromPipe, buf]);
          while (true) {
            const nullIndex = pendingFromPipe.indexOf(0);
            if (nullIndex === -1) {
              break;
            }
            const message = pendingFromPipe.subarray(0, nullIndex).toString("utf8");
            pendingFromPipe = pendingFromPipe.subarray(nullIndex + 1);
            if (!message) {
              continue;
            }
            processUpstreamMessage(message);
          }
        });

        pipeIn.once("end", () => finalize(0));
        pipeIn.once("error", () => finalize(1));
      }
      pipeOut?.once("error", () => finalize(1));
    });
  };
}
