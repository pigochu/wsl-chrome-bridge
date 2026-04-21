import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_POLL_INTERVAL_MS = 1_500;

interface WatchdogOptions {
  bridgePid: number;
  chromePid: number;
  powershellPath: string;
  expectedExecutablePath: string | null;
  pollIntervalMs: number;
  debugFile: string | null;
}

function parseInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 1) {
    return null;
  }
  return parsed;
}

function parseArgs(argv: string[]): WatchdogOptions | null {
  let bridgePid: number | null = null;
  let chromePid: number | null = null;
  let powershellPath = "powershell.exe";
  let expectedExecutablePath: string | null = null;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  let debugFile: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--bridge-pid") {
      bridgePid = parseInteger(next);
      index += 1;
      continue;
    }
    if (arg === "--chrome-pid") {
      chromePid = parseInteger(next);
      index += 1;
      continue;
    }
    if (arg === "--powershell-path" && next) {
      powershellPath = next;
      index += 1;
      continue;
    }
    if (arg === "--expected-executable-path") {
      expectedExecutablePath = next?.trim() ? next.trim() : null;
      index += 1;
      continue;
    }
    if (arg === "--poll-interval-ms") {
      const parsed = parseInteger(next);
      if (parsed !== null) {
        pollIntervalMs = parsed;
      }
      index += 1;
      continue;
    }
    if (arg === "--debug-file") {
      debugFile = next?.trim() ? next.trim() : null;
      index += 1;
      continue;
    }
  }

  if (bridgePid === null || chromePid === null) {
    return null;
  }

  return {
    bridgePid,
    chromePid,
    powershellPath,
    expectedExecutablePath,
    pollIntervalMs,
    debugFile
  };
}

function writeDebug(debugFile: string | null, message: string): void {
  if (!debugFile) {
    return;
  }
  try {
    mkdirSync(dirname(debugFile), { recursive: true });
    appendFileSync(debugFile, `[${new Date().toISOString()}] watchdog ${message}\n`, "utf8");
  } catch {
    // watchdog must remain best-effort and never crash on debug logging failure
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killChromeViaPowerShell(options: WatchdogOptions): Promise<void> {
  const escapedExpectedPath = (options.expectedExecutablePath ?? "").replaceAll("'", "''");
  const command = `
$targetPid = ${options.chromePid}
$matchHeadlessPattern = '(?i)(?:^|\\s)--headless(?:=(?:"[^"]+"|[^\\s"]+))?(?=\\s|$)'
$expectedExecutablePath = '${escapedExpectedPath}'

function Normalize-Path {
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

$expectedNormalized = Normalize-Path -Value $expectedExecutablePath
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue
if ($null -eq $proc) {
  Write-Output 'skip:not-found'
  exit 0
}
$line = [string]$proc.CommandLine
if ([string]::IsNullOrWhiteSpace($line)) {
  Write-Output 'skip:missing-commandline'
  exit 0
}
if (-not [string]::IsNullOrWhiteSpace($expectedNormalized)) {
  $exeMatch = [Regex]::Match($line, '^\\s*(?:"([^"]+)"|([^\\s"]+))')
  if (-not $exeMatch.Success) {
    Write-Output 'skip:cannot-parse-executable'
    exit 0
  }
  $actualExecutable = if ($exeMatch.Groups[1].Success) { $exeMatch.Groups[1].Value } else { $exeMatch.Groups[2].Value }
  $actualNormalized = Normalize-Path -Value $actualExecutable
  if ([string]::IsNullOrWhiteSpace($actualNormalized) -or $actualNormalized -ne $expectedNormalized) {
    Write-Output ('skip:executable-mismatch actual=' + $actualExecutable)
    exit 0
  }
}
if (-not [Regex]::IsMatch($line, $matchHeadlessPattern)) {
  Write-Output 'skip:not-headless'
  exit 0
}
Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
Write-Output 'killed'
`;
  const child = spawn(
    options.powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command
    ],
    { stdio: ["ignore", "pipe", "ignore"] }
  );

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  await new Promise<void>((resolve) => {
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });

  const outcome = stdout.trim() || "unknown";
  writeDebug(
    options.debugFile,
    `killAttempt chromePid=${options.chromePid} outcome=${outcome}`
  );
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }

  writeDebug(
    options.debugFile,
    `start bridgePid=${options.bridgePid} chromePid=${options.chromePid} pollMs=${options.pollIntervalMs}`
  );

  while (isProcessAlive(options.bridgePid)) {
    await sleep(options.pollIntervalMs);
  }

  writeDebug(options.debugFile, `bridgeDead bridgePid=${options.bridgePid} beginKill`);
  await killChromeViaPowerShell(options);
  writeDebug(options.debugFile, `killSent chromePid=${options.chromePid}`);
}

void run().finally(() => {
  process.exit(0);
});
