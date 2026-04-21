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
$matchHeadlessPattern = '(?i)(?:^|\\s)--headless(?:=(?:"[^"]+"|[^\\s"]+))?(?=\\s|$)'
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
    headless = [Regex]::IsMatch($line, $matchHeadlessPattern)
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

const STOP_CHROME_BY_PROFILE_AND_PORT_PS = `
param(
  [string]$UserDataDir,
  [int]$RemoteDebugPort
)
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

$targetUserDataDir = Normalize-UserDataDir -Value $UserDataDir
if ([string]::IsNullOrWhiteSpace($targetUserDataDir) -or $RemoteDebugPort -lt 1 -or $RemoteDebugPort -gt 65535) {
  Write-Output '{"killed":false,"pid":null,"reason":"invalid-input"}'
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

  # Only target the browser root process (renderer/gpu/etc carry --type=...).
  if ($line -match '(?i)--type=') {
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
  if ([string]::IsNullOrWhiteSpace($normalizedUserDataDir) -or $normalizedUserDataDir -ne $targetUserDataDir) {
    continue
  }

  $portMatch = [Regex]::Match($line, $matchPortPattern)
  if (-not $portMatch.Success) {
    continue
  }

  $parsedPort = [int]$portMatch.Groups[1].Value
  if ($parsedPort -ne $RemoteDebugPort) {
    continue
  }

  $candidates += [PSCustomObject]@{
    pid = [int]$proc.ProcessId
  }
}

if ($candidates.Count -eq 0) {
  Write-Output '{"killed":false,"pid":null,"reason":"not-found"}'
  exit 0
}

$selected = $candidates | Sort-Object -Property pid -Descending | Select-Object -First 1
Stop-Process -Id $selected.pid -Force -ErrorAction SilentlyContinue
Write-Output ('{"killed":true,"pid":' + $selected.pid + ',"reason":"killed"}')
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

function createRelayPowerShellScript(csharpSource: string): string {
  return `
param([string]$WsUrl)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
${csharpSource}
'@
[CDPRelay]::Run($WsUrl)
`;
}

/**
 * Returns all PowerShell script sources used by the bridge runner.
 */
export function getBridgePowerShellScripts(): {
  launchChrome: string;
  findExistingChrome: string;
  getVersion: string;
  resolvePort: string;
  stopChromeByProfilePort: string;
  relay: string;
} {
  return {
    launchChrome: LAUNCH_CHROME_PS,
    findExistingChrome: FIND_EXISTING_CHROME_PS,
    getVersion: GET_VERSION_PS,
    resolvePort: RESOLVE_PORT_PS,
    stopChromeByProfilePort: STOP_CHROME_BY_PROFILE_AND_PORT_PS,
    relay: createRelayPowerShellScript(RELAY_CSHARP)
  };
}
