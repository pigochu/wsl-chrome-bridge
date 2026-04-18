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
import { dirname } from "node:path";
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

const LAUNCH_CHROME_PS = `
param(
  [string]$ChromePath,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ChromeArgs
)
$ErrorActionPreference = 'Stop'
$ChromeArgs = $ChromeArgs | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_) }
$userDataArg = $ChromeArgs | Where-Object { $_ -like "--user-data-dir=*" } | Select-Object -First 1
if ($null -ne $userDataArg) {
  $userDataDir = $userDataArg.Substring(16)
  $escaped = [Regex]::Escape($userDataDir)
  $existing = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
    $null -ne $_.CommandLine -and $_.CommandLine -match ("--user-data-dir(=|\\s+)" + $escaped)
  }
  foreach ($proc in $existing) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
$proc = Start-Process -FilePath $ChromePath -ArgumentList $ChromeArgs -PassThru
Write-Output $proc.Id
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

const STOP_PROCESS_PS = `
param([int]$Pid)
$ErrorActionPreference = 'SilentlyContinue'
Stop-Process -Id $Pid -Force
`;

const RELAY_CSHARP = String.raw`
using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public class CDPRelay
{
    public static void Run(string wsUrl)
    {
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
                            if (recv.MessageType == WebSocketMessageType.Close) return;
                            sb.Append(Encoding.UTF8.GetString(buf, 0, recv.Count));
                        } while (!recv.EndOfMessage);

                        Console.Out.WriteLine(sb.ToString());
                        Console.Out.Flush();
                    }
                }
                catch (OperationCanceledException) { }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("READER_ERROR:" + ex.Message);
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
            Console.Error.WriteLine("FATAL:" + ex.Message);
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
    const debug = env.WSL_CHROME_BRIDGE_DEBUG === "1" || Boolean(activeDebugFile);

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

    writeDebug(`argv=${JSON.stringify(chromeArgs)}`);
    writeDebug(`launchPlan=${JSON.stringify({
      bridgeDebugFile: plan.bridgeDebugFile,
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
    const getVersionScript = writePowerShellScript(powerShell, "get-version.ps1", GET_VERSION_PS);
    const resolvePortScript = writePowerShellScript(powerShell, "resolve-port.ps1", RESOLVE_PORT_PS);
    const stopProcessScript = writePowerShellScript(powerShell, "stop-process.ps1", STOP_PROCESS_PS);
    const relayScript = writePowerShellScript(powerShell, "relay.ps1", RELAY_PS);
    writeDebug(
      `scripts={launch:${launchScript.windowsPath},version:${getVersionScript.windowsPath},resolvePort:${resolvePortScript.windowsPath},stop:${stopProcessScript.windowsPath},relay:${relayScript.windowsPath}}`
    );

    const resolvePortMode = plan.windowsDebugPortSource === "auto-random" ? "random" : "fixed";
    const resolvePortResult = await runPowerShellFile(
      powerShell,
      resolvePortScript.windowsPath,
      [String(plan.windowsDebugPort), resolvePortMode],
      { timeoutMs: 8_000 }
    );

    if (resolvePortResult.code !== 0) {
      writeDebug(
        `resolvePortFailed mode=${resolvePortMode} requested=${plan.windowsDebugPort} code=${resolvePortResult.code} stdout=${resolvePortResult.stdout.trim()} stderr=${resolvePortResult.stderr.trim()}`
      );
      process.stderr.write(
        "[wsl-chrome-bridge] failed to resolve an available Windows debug port: " +
          `${resolvePortResult.stderr || resolvePortResult.stdout}\n`
      );
      destroyPowerShellContext(powerShell);
      cleanupUserDataDirOnExit("resolvePortFailed");
      return 1;
    }

    const resolvedWindowsDebugPort = Number.parseInt(resolvePortResult.stdout.trim(), 10);
    if (!Number.isFinite(resolvedWindowsDebugPort)) {
      writeDebug(
        `resolvePortParseFailed raw=${resolvePortResult.stdout.trim()} stderr=${resolvePortResult.stderr.trim()}`
      );
      process.stderr.write(
        "[wsl-chrome-bridge] failed to parse resolved Windows debug port from PowerShell output.\n"
      );
      destroyPowerShellContext(powerShell);
      cleanupUserDataDirOnExit("resolvePortParseFailed");
      return 1;
    }
    writeDebug(
      `resolvedWindowsDebugPort=${resolvedWindowsDebugPort} source=${plan.windowsDebugPortSource} mode=${resolvePortMode}`
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
    writeDebug(`chromePath=${chromePath}`);
    writeDebug(`windowsArgs=${JSON.stringify(windowsArgs)}`);

    const launchResult = await runPowerShellFile(
      powerShell,
      launchScript.windowsPath,
      [chromePath, ...windowsArgs],
      { timeoutMs: 15_000 }
    );

    if (launchResult.code !== 0) {
      writeDebug(`launchFailed code=${launchResult.code} stdout=${launchResult.stdout} stderr=${launchResult.stderr}`);
      process.stderr.write(
        `[wsl-chrome-bridge] failed to launch Windows Chrome: ${launchResult.stderr || launchResult.stdout}\n`
      );
      destroyPowerShellContext(powerShell);
      cleanupUserDataDirOnExit("launchFailed");
      return 1;
    }
    writeDebug(
      `launchResult code=${launchResult.code} stdout=${launchResult.stdout.trim()} stderr=${launchResult.stderr.trim()}`
    );

    const chromePid = Number.parseInt(launchResult.stdout.trim(), 10);
    if (!Number.isFinite(chromePid)) {
      writeDebug(`invalidChromePid output=${launchResult.stdout}`);
      process.stderr.write(
        `[wsl-chrome-bridge] failed to parse Chrome PID from PowerShell output: ${launchResult.stdout}\n`
      );
      destroyPowerShellContext(powerShell);
      cleanupUserDataDirOnExit("invalidChromePid");
      return 1;
    }

    let remoteVersion: Record<string, unknown> | null = null;
    const startAt = Date.now();
    while (Date.now() - startAt < CHROME_READY_TIMEOUT_MS) {
      const result = await runPowerShellFile(
        powerShell,
        getVersionScript.windowsPath,
        [String(planWithResolvedPort.windowsDebugPort)],
        { timeoutMs: 4_000 }
      );

      if (result.code === 0 && result.stdout.trim()) {
        try {
          remoteVersion = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
          writeDebug(`remoteVersion=${JSON.stringify(remoteVersion)}`);
          break;
        } catch {
          writeDebug(`remoteVersionParseFailed raw=${result.stdout.trim()}`);
          // ignore malformed JSON and retry
        }
      } else if (debug) {
        writeDebug(
          `waitVersion retry code=${result.code} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }

    if (!remoteVersion || typeof remoteVersion.webSocketDebuggerUrl !== "string") {
      writeDebug("chromeDebugWsNotReady");
      process.stderr.write("[wsl-chrome-bridge] Chrome debug websocket was not ready in time.\n");
      await runPowerShellFile(powerShell, stopProcessScript.windowsPath, [String(chromePid)], {
        timeoutMs: 3_000
      });
      destroyPowerShellContext(powerShell);
      cleanupUserDataDirOnExit("chromeDebugWsNotReady");
      return 1;
    }

    const remoteBrowserWsUrl = remoteVersion.webSocketDebuggerUrl;
    writeDebug(`remoteBrowserWsUrl=${remoteBrowserWsUrl}`);

    const relayChild = spawn(
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

    relayChild.stdout.setEncoding("utf8");
    relayChild.stderr.setEncoding("utf8");

    const usePipeTransport = plan.usePipeTransport && hasPipeFds();
    const useLocalProxyTransport = plan.localProxyPort !== null;
    writeDebug(
      `transportMode requestedPipe=${plan.usePipeTransport} pipe=${usePipeTransport} localProxy=${useLocalProxyTransport} localProxyPort=${plan.localProxyPort ?? "none"}`
    );

    if (plan.usePipeTransport && !usePipeTransport) {
      process.stderr.write(
        "[wsl-chrome-bridge] --remote-debugging-pipe was requested but OS pipe fds (3/4) are missing.\n"
      );
      await runPowerShellFile(powerShell, stopProcessScript.windowsPath, [String(chromePid)], {
        timeoutMs: 3_000
      });
      destroyPowerShellContext(powerShell);
      cleanupUserDataDirOnExit("pipeFdsMissing");
      return 1;
    }

    if (!usePipeTransport && !useLocalProxyTransport) {
      process.stderr.write(
        "[wsl-chrome-bridge] missing transport channel. " +
          "Provide --remote-debugging-port (Playwright mode) or launch with OS pipes fd3/fd4.\n"
      );
      await runPowerShellFile(powerShell, stopProcessScript.windowsPath, [String(chromePid)], {
        timeoutMs: 3_000
      });
      destroyPowerShellContext(powerShell);
      cleanupUserDataDirOnExit("missingTransportChannel");
      return 1;
    }

    let pipeIn: ReturnType<typeof createReadStream> | null = null;
    let pipeOut: ReturnType<typeof createWriteStream> | null = null;
    if (usePipeTransport) {
      pipeIn = createReadStream("", { fd: 3, autoClose: false });
      pipeOut = createWriteStream("", { fd: 4, autoClose: false });
    }

    const remoteBrowserPath = parseBrowserPathFromWsUrl(remoteBrowserWsUrl);
    const localBrowserWsUrl =
      plan.localProxyPort === null
        ? null
        : `ws://127.0.0.1:${plan.localProxyPort}${remoteBrowserPath}`;

    let localProxy: LocalDebugProxyContext | null = null;
    if (plan.localProxyPort !== null && localBrowserWsUrl) {
      const localVersionPayload: Record<string, unknown> = {
        ...remoteVersion,
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
            if (relayConnected) {
              relayChild.stdin.write(`${message}\n`);
            } else {
              queuedForRelay.push(message);
            }
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
        try {
          relayChild.kill("SIGTERM");
        } catch {
          // ignore
        }
        await runPowerShellFile(powerShell, stopProcessScript.windowsPath, [String(chromePid)], {
          timeoutMs: 3_000
        });
        destroyPowerShellContext(powerShell);
        cleanupUserDataDirOnExit("localProxyStartFailed");
        return 1;
      }
    }

    let relayConnected = false;
    let relayStdoutBuffer = "";
    let relayStderrBuffer = "";
    let pendingFromPipe = Buffer.alloc(0);
    const queuedForRelay: string[] = [];

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

      try {
        relayChild.stdin.end();
      } catch {
        // ignore
      }
      try {
        relayChild.kill("SIGTERM");
      } catch {
        // ignore
      }
      await Promise.race([once(relayChild, "exit"), sleep(1_000)]);

      await runPowerShellFile(powerShell, stopProcessScript.windowsPath, [String(chromePid)], {
        timeoutMs: 3_000
      });
      writeDebug("cleanup stopProcess done");

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
        clear();
        void cleanup(code).then(resolvePromise);
      };

      for (const signal of signals) {
        const handler = () => finalize(0);
        signalHandlers.set(signal, handler);
        process.on(signal, handler);
      }

      relayChild.stderr.on("data", (chunk: string) => {
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
          if (line.includes("CONNECTED")) {
            relayConnected = true;
            for (const queued of queuedForRelay) {
              relayChild.stdin.write(`${queued}\n`);
            }
            queuedForRelay.length = 0;
            continue;
          }
          if (line.startsWith("FATAL:")) {
            finalize(1);
            return;
          }
        }
      });

      relayChild.stdout.on("data", (chunk: string) => {
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
          if (pipeOut) {
            pipeOut.write(line);
            pipeOut.write("\0");
          }
          if (localProxy) {
            localProxy.broadcast(line);
          }
        }
      });

      relayChild.once("error", () => finalize(1));
      relayChild.once("exit", (code) => finalize(code === 0 ? 0 : 1));

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
            if (relayConnected) {
              relayChild.stdin.write(`${message}\n`);
            } else {
              queuedForRelay.push(message);
            }
          }
        });

        pipeIn.once("end", () => finalize(0));
        pipeIn.once("error", () => finalize(1));
      }
      pipeOut?.once("error", () => finalize(1));
    });
  };
}
