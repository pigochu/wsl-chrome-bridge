import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { once } from "node:events";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { buildWindowsChromeArgs, planBridgeLaunch } from "./bridge-options.js";
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

export function createBridgeRunner() {
  return async function runBridge(chromeArgs: string[]): Promise<number> {
    const env = process.env;
    const plan = planBridgeLaunch(chromeArgs);
    const debug = env.WSL_CHROME_BRIDGE_DEBUG === "1" || Boolean(plan.bridgeDebugFile);

    const writeDebug = (message: string): void => {
      if (!debug) {
        return;
      }
      const line = `[${new Date().toISOString()}] ${message}\n`;
      process.stderr.write(`[wsl-chrome-bridge][debug] ${message}\n`);
      if (plan.bridgeDebugFile) {
        try {
          mkdirSync(dirname(plan.bridgeDebugFile), { recursive: true });
          appendFileSync(plan.bridgeDebugFile, line, "utf8");
        } catch {
          // keep running even if debug file write fails
        }
      }
    };

    if (plan.bridgeDebugFile) {
      try {
        mkdirSync(dirname(plan.bridgeDebugFile), { recursive: true });
        writeFileSync(
          plan.bridgeDebugFile,
          `[${new Date().toISOString()}] bridge debug file created\n`,
          "utf8"
        );
      } catch {
        process.stderr.write(
          `[wsl-chrome-bridge] failed to create debug file: ${plan.bridgeDebugFile}\n`
        );
      }
    }

    writeDebug(`argv=${JSON.stringify(chromeArgs)}`);
    writeDebug(`launchPlan=${JSON.stringify({
      bridgeDebugFile: plan.bridgeDebugFile,
      bridgeChromeExecutablePath: plan.bridgeChromeExecutablePath,
      userDataDir: plan.userDataDir,
      windowsUserDataDir: plan.windowsUserDataDir,
      requestedLocalDebugPort: plan.requestedLocalDebugPort,
      windowsDebugPort: plan.windowsDebugPort,
      passthroughArgs: plan.passthroughArgs
    })}`);

    const powerShell = createPowerShellContext(env);
    writeDebug(`powershellPath=${powerShell.powershellPath}`);

    const launchScript = writePowerShellScript(powerShell, "launch-chrome.ps1", LAUNCH_CHROME_PS);
    const getVersionScript = writePowerShellScript(powerShell, "get-version.ps1", GET_VERSION_PS);
    const stopProcessScript = writePowerShellScript(powerShell, "stop-process.ps1", STOP_PROCESS_PS);
    const relayScript = writePowerShellScript(powerShell, "relay.ps1", RELAY_PS);
    writeDebug(
      `scripts={launch:${launchScript.windowsPath},version:${getVersionScript.windowsPath},stop:${stopProcessScript.windowsPath},relay:${relayScript.windowsPath}}`
    );

    const chromePath = resolveChromeCommand({
      env,
      bridgeChromeExecutablePath: plan.bridgeChromeExecutablePath
    });
    const windowsArgs = buildWindowsChromeArgs(plan, env);
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
      if (plan.createdUserDataDir) {
        rmSync(plan.userDataDir, { recursive: true, force: true });
      }
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
      if (plan.createdUserDataDir) {
        rmSync(plan.userDataDir, { recursive: true, force: true });
      }
      return 1;
    }

    let remoteVersion: Record<string, unknown> | null = null;
    const startAt = Date.now();
    while (Date.now() - startAt < CHROME_READY_TIMEOUT_MS) {
      const result = await runPowerShellFile(
        powerShell,
        getVersionScript.windowsPath,
        [String(plan.windowsDebugPort)],
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
      if (plan.createdUserDataDir) {
        rmSync(plan.userDataDir, { recursive: true, force: true });
      }
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

    // chrome-devtools-mcp pipe mode uses fd3 (read by bridge) and fd4 (write by bridge).
    try {
      fstatSync(3);
      fstatSync(4);
    } catch {
      process.stderr.write(
        "[wsl-chrome-bridge] missing OS pipe fds (3/4). " +
          "This bridge must be launched via chrome-devtools-mcp pipe mode.\n"
      );
      await runPowerShellFile(powerShell, stopProcessScript.windowsPath, [String(chromePid)], {
        timeoutMs: 3_000
      });
      destroyPowerShellContext(powerShell);
      if (plan.createdUserDataDir) {
        rmSync(plan.userDataDir, { recursive: true, force: true });
      }
      return 1;
    }

    const pipeIn = createReadStream("", { fd: 3, autoClose: false });
    const pipeOut = createWriteStream("", { fd: 4, autoClose: false });

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

      pipeIn.destroy();
      pipeOut.destroy();

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

      if (plan.createdUserDataDir) {
        rmSync(plan.userDataDir, { recursive: true, force: true });
        writeDebug("cleanup temp userDataDir removed");
      }
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
          pipeOut.write(line);
          pipeOut.write("\0");
        }
      });

      relayChild.once("error", () => finalize(1));
      relayChild.once("exit", (code) => finalize(code === 0 ? 0 : 1));

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
      pipeOut.once("error", () => finalize(1));
    });
  };
}
