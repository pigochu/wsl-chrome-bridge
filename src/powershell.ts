import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWindowsPathIfNeeded } from "./path-utils.js";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PowerShellRunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface PowerShellContext {
  powershellPath: string;
  env: NodeJS.ProcessEnv;
  scriptDir: string;
  scriptDirWindows: string;
}

export function createPowerShellContext(env: NodeJS.ProcessEnv = process.env): PowerShellContext {
  const scriptDir = mkdtempSync(join(tmpdir(), "wsl-chrome-bridge-ps-"));
  const scriptDirWindows =
    toWindowsPathIfNeeded(scriptDir, { distroName: env.WSL_DISTRO_NAME }) ?? scriptDir;

  return {
    powershellPath: env.WSL_CHROME_BRIDGE_POWERSHELL || "powershell.exe",
    env,
    scriptDir,
    scriptDirWindows
  };
}

export function destroyPowerShellContext(context: PowerShellContext): void {
  rmSync(context.scriptDir, { recursive: true, force: true });
}

export function writePowerShellScript(
  context: PowerShellContext,
  name: string,
  content: string
): { linuxPath: string; windowsPath: string } {
  const linuxPath = join(context.scriptDir, name);
  writeFileSync(linuxPath, content, "utf8");
  const windowsPath =
    toWindowsPathIfNeeded(linuxPath, { distroName: context.env.WSL_DISTRO_NAME }) ?? linuxPath;
  return { linuxPath, windowsPath };
}

export async function runPowerShellFile(
  context: PowerShellContext,
  scriptWindowsPath: string,
  args: string[],
  options: PowerShellRunOptions = {}
): Promise<ProcessResult> {
  const psArgs = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptWindowsPath,
    ...args
  ];

  const child = spawn(context.powershellPath, psArgs, {
    env: options.env ?? context.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let timeoutHandle: NodeJS.Timeout | undefined;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);
  }

  const settled = await Promise.race([
    once(child, "close").then((value) => ({ type: "close" as const, value })),
    once(child, "error").then((value) => ({ type: "error" as const, value }))
  ]);

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  if (settled.type === "error") {
    const [error] = settled.value as [Error];
    return {
      code: 1,
      stdout,
      stderr: `${stderr}${error.message}`
    };
  }

  const [code] = settled.value as [number | null, NodeJS.Signals | null];

  return {
    code: typeof code === "number" ? code : 1,
    stdout,
    stderr
  };
}
