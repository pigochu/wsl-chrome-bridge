import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeChromeArgs } from "./arg-normalizer.js";

export interface BridgeLaunchPlan {
  originalArgs: string[];
  passthroughArgs: string[];
  bridgeDebugFile: string | null;
  bridgeChromeExecutablePath: string | null;
  userDataDir: string;
  windowsUserDataDir: string;
  requestedLocalDebugPort: number;
  windowsDebugPort: number;
  createdUserDataDir: boolean;
}

const BRIDGE_CHROME_EXECUTABLE_FLAGS = [
  "--bridge-chrome-executablePath",
  "--bridge-chrome-executable-path"
];
const BRIDGE_REMOTE_DEBUGGING_PORT_FLAGS = [
  "--bridge-remote-debugging-port",
  "--bridge-remote-debuggingPort"
];
const DEFAULT_WINDOWS_USER_DATA_DIR = "%TEMP%\\wsl-chrome-bridge\\chrome-profile";

function isWindowsPath(value: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("%")
  );
}

function readFlagValue(args: string[], index: number): string | undefined {
  if (index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function parsePortOrThrow(
  value: string | undefined,
  source: string,
  allowMissing = false
): number | null {
  if (value === undefined || value.trim() === "") {
    if (allowMissing) {
      return null;
    }
    throw new Error(
      `[wsl-chrome-bridge] missing value for ${source}. Please provide a port between 1 and 65535.`
    );
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `[wsl-chrome-bridge] invalid ${source}: "${value}". Port must be between 1 and 65535.`
    );
  }

  return parsed;
}

function normalizeWindowsUserDataDir(value: string): string {
  if (value.startsWith("/")) {
    return value;
  }
  return value.replaceAll("/", "\\");
}

export function planBridgeLaunch(
  chromeArgs: string[]
): BridgeLaunchPlan {
  const passthroughArgs: string[] = [];
  let userDataDir: string | null = null;
  let windowsUserDataDir: string | null = null;
  let bridgeDebugFile: string | null = null;
  let bridgeChromeExecutablePath: string | null = null;
  let bridgeRemoteDebugPort: number | null = null;
  let requestedLocalDebugPort: number | null = null;

  for (let i = 0; i < chromeArgs.length; i += 1) {
    const arg = chromeArgs[i];

    if (arg === "--remote-debugging-pipe") {
      continue;
    }

    if (arg.startsWith("--remote-debugging-port=")) {
      requestedLocalDebugPort = parsePortOrThrow(
        arg.split("=").slice(1).join("="),
        "--remote-debugging-port"
      );
      continue;
    }

    if (arg === "--remote-debugging-port") {
      requestedLocalDebugPort = parsePortOrThrow(
        readFlagValue(chromeArgs, i),
        "--remote-debugging-port"
      );
      i += 1;
      continue;
    }

    if (arg.startsWith("--remote-debugging-address=") || arg === "--remote-debugging-address") {
      if (arg === "--remote-debugging-address") {
        i += 1;
      }
      continue;
    }

    if (arg.startsWith("--bridge-debug-file=")) {
      bridgeDebugFile = arg.split("=").slice(1).join("=");
      continue;
    }

    if (arg === "--bridge-debug-file") {
      const value = readFlagValue(chromeArgs, i);
      if (value) {
        bridgeDebugFile = value;
        i += 1;
      }
      continue;
    }

    const bridgeChromeExecutableFlag = BRIDGE_CHROME_EXECUTABLE_FLAGS.find(
      (flag) => arg === flag || arg.startsWith(`${flag}=`)
    );

    if (bridgeChromeExecutableFlag) {
      if (arg === bridgeChromeExecutableFlag) {
        const value = readFlagValue(chromeArgs, i);
        if (value) {
          bridgeChromeExecutablePath = value;
          i += 1;
        }
      } else {
        bridgeChromeExecutablePath = arg.split("=").slice(1).join("=");
      }
      continue;
    }

    const bridgeRemoteDebugPortFlag = BRIDGE_REMOTE_DEBUGGING_PORT_FLAGS.find(
      (flag) => arg === flag || arg.startsWith(`${flag}=`)
    );

    if (bridgeRemoteDebugPortFlag) {
      if (arg === bridgeRemoteDebugPortFlag) {
        bridgeRemoteDebugPort = parsePortOrThrow(
          readFlagValue(chromeArgs, i),
          bridgeRemoteDebugPortFlag
        );
        i += 1;
      } else {
        bridgeRemoteDebugPort = parsePortOrThrow(
          arg.split("=").slice(1).join("="),
          bridgeRemoteDebugPortFlag
        );
      }
      continue;
    }

    if (arg.startsWith("--user-data-dir=")) {
      const value = arg.split("=").slice(1).join("=");
      if (isWindowsPath(value)) {
        userDataDir = value;
        windowsUserDataDir = value;
        passthroughArgs.push(arg);
      }
      continue;
    }

    if (arg === "--user-data-dir") {
      const value = readFlagValue(chromeArgs, i);
      if (value) {
        if (isWindowsPath(value)) {
          userDataDir = value;
          windowsUserDataDir = value;
          passthroughArgs.push(arg, value);
        }
        i += 1;
      }
      continue;
    }

    if (arg.startsWith("--userDataDir=")) {
      const value = arg.split("=").slice(1).join("=");
      if (isWindowsPath(value)) {
        userDataDir = value;
        windowsUserDataDir = value;
        passthroughArgs.push(arg);
      }
      continue;
    }

    if (arg === "--userDataDir") {
      const value = readFlagValue(chromeArgs, i);
      if (value) {
        if (isWindowsPath(value)) {
          userDataDir = value;
          windowsUserDataDir = value;
          passthroughArgs.push(arg, value);
        }
        i += 1;
      }
      continue;
    }

    passthroughArgs.push(arg);
  }

  let createdUserDataDir = false;
  if (!userDataDir) {
    userDataDir = mkdtempSync(join(tmpdir(), "wsl-chrome-bridge-profile-"));
    createdUserDataDir = true;
    passthroughArgs.push(`--user-data-dir=${userDataDir}`);
  }
  if (!windowsUserDataDir) {
    windowsUserDataDir = DEFAULT_WINDOWS_USER_DATA_DIR;
  } else {
    windowsUserDataDir = normalizeWindowsUserDataDir(windowsUserDataDir);
  }

  if (requestedLocalDebugPort === null) {
    requestedLocalDebugPort = 9222;
  }

  const windowsDebugPort = bridgeRemoteDebugPort ?? requestedLocalDebugPort;

  return {
    originalArgs: [...chromeArgs],
    passthroughArgs,
    bridgeDebugFile,
    bridgeChromeExecutablePath,
    userDataDir,
    windowsUserDataDir,
    requestedLocalDebugPort,
    windowsDebugPort,
    createdUserDataDir
  };
}

export function buildWindowsChromeArgs(
  plan: BridgeLaunchPlan,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const withoutUserDataDir = plan.passthroughArgs.filter((arg, index, args) => {
    if (arg === "--user-data-dir" || arg === "--userDataDir") {
      return false;
    }
    if (index > 0 && (args[index - 1] === "--user-data-dir" || args[index - 1] === "--userDataDir")) {
      return false;
    }
    if (arg.startsWith("--user-data-dir=") || arg.startsWith("--userDataDir=")) {
      return false;
    }
    return true;
  });

  const normalized = normalizeChromeArgs(withoutUserDataDir, {
    distroName: env.WSL_DISTRO_NAME
  });

  const withoutRemoteAllowOrigins = normalized.filter(
    (arg) => !arg.startsWith("--remote-allow-origins")
  );

  return [
    `--user-data-dir=${plan.windowsUserDataDir}`,
    `--remote-debugging-port=${plan.windowsDebugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    ...withoutRemoteAllowOrigins
  ];
}

export function parseBrowserPathFromWsUrl(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  return parsed.pathname + parsed.search;
}
