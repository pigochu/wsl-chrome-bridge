import { normalizeChromeArgs } from "./arg-normalizer.js";

export interface BridgeLaunchPlan {
  /** Raw arguments received from the upstream MCP process. */
  originalArgs: string[];
  /** Arguments that should continue through normalization and Windows launch. */
  passthroughArgs: string[];
  /** Whether upstream explicitly requested Chrome DevTools pipe transport. */
  usePipeTransport: boolean;
  /** Optional bridge debug log file path in WSL. */
  bridgeDebugFile: string | null;
  /** Optional Chrome executable override from environment variable. */
  bridgeChromeExecutablePath: string | null;
  /** User-data-dir value as seen by the bridge (WSL side). */
  userDataDir: string | null;
  /** User-data-dir value rewritten for Windows Chrome. */
  windowsUserDataDir: string | null;
  /** Source of the Windows user-data-dir decision. */
  windowsUserDataDirSource: "arg" | "env" | "default";
  /** Local proxy port requested by upstream (for example Playwright's random port). */
  requestedLocalDebugPort: number | null;
  /** Local websocket proxy port exposed by the bridge in WSL. */
  localProxyPort: number | null;
  /** Remote debugging port used to launch Windows Chrome. */
  windowsDebugPort: number;
  /** Source of the Windows debugging port decision. */
  windowsDebugPortSource: "bridge-arg" | "env" | "upstream-port" | "auto-random";
  /** Whether bridge created a temporary WSL profile directory and must clean it up. */
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
const LOCAL_REMOTE_DEBUGGING_PORT_FLAGS = [
  "--remote-debugging-port",
  "--remote-debug-port"
];
const RANDOM_DEBUG_PORT_MIN = 10000;
const RANDOM_DEBUG_PORT_MAX = 65535;
/** Default Windows profile directory used when upstream does not provide a usable user-data-dir. */
export const DEFAULT_WINDOWS_USER_DATA_DIR = "%TEMP%\\wsl-chrome-bridge\\profile-default";

function isWindowsPath(value: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("\\") ||
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

function selectRandomDebugPort(): number {
  return (
    Math.floor(Math.random() * (RANDOM_DEBUG_PORT_MAX - RANDOM_DEBUG_PORT_MIN + 1)) +
    RANDOM_DEBUG_PORT_MIN
  );
}

function normalizeWindowsUserDataDir(value: string): string {
  return value.replaceAll("/", "\\");
}

function restoreWindowsPathFromResolvedLinuxPath(value: string): string | null {
  if (!value.startsWith("/")) {
    return null;
  }

  const tail = value.slice(value.lastIndexOf("/") + 1);
  if (!tail || !isWindowsPath(tail)) {
    return null;
  }

  return normalizeWindowsUserDataDir(tail);
}

function toWindowsUserDataDir(value: string): string | null {
  if (isWindowsPath(value)) {
    return normalizeWindowsUserDataDir(value);
  }

  const restored = restoreWindowsPathFromResolvedLinuxPath(value);
  if (restored) {
    return restored;
  }

  return null;
}

/**
 * Parse and normalize launch arguments into a concrete bridge launch plan.
 */
export function planBridgeLaunch(
  chromeArgs: string[],
  env: NodeJS.ProcessEnv = {}
): BridgeLaunchPlan {
  const passthroughArgs: string[] = [];
  let userDataDir: string | null = null;
  let windowsUserDataDir: string | null = null;
  let bridgeDebugFile: string | null = null;
  let bridgeChromeExecutablePath: string | null = null;
  let bridgeRemoteDebugPort: number | null = null;
  let requestedLocalDebugPort: number | null = null;
  let envRemoteDebugPort: number | null = null;
  let envWindowsUserDataDir: string | null = null;
  let usePipeTransport = false;

  const envRemoteDebugPortRaw = env.WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT?.trim();
  if (envRemoteDebugPortRaw) {
    envRemoteDebugPort = parsePortOrThrow(
      envRemoteDebugPortRaw,
      "WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT"
    );
  }

  const envChromeExecutablePathRaw = env.WSL_CHROME_BRIDGE_EXECUTABLE_PATH?.trim();
  if (envChromeExecutablePathRaw) {
    bridgeChromeExecutablePath = envChromeExecutablePathRaw;
  }

  const envUserDataDirRaw = env.WSL_CHROME_BRIDGE_USER_DATA_DIR?.trim();
  if (envUserDataDirRaw) {
    if (!isWindowsPath(envUserDataDirRaw)) {
      throw new Error(
        `[wsl-chrome-bridge] invalid WSL_CHROME_BRIDGE_USER_DATA_DIR: "${envUserDataDirRaw}". ` +
          "Value must be a Windows-style path."
      );
    }
    envWindowsUserDataDir = normalizeWindowsUserDataDir(envUserDataDirRaw);
  }

  for (let i = 0; i < chromeArgs.length; i += 1) {
    const arg = chromeArgs[i];

    if (arg === "--remote-debugging-pipe") {
      usePipeTransport = true;
      continue;
    }

    const localRemoteDebugPortFlag = LOCAL_REMOTE_DEBUGGING_PORT_FLAGS.find(
      (flag) => arg === flag || arg.startsWith(`${flag}=`)
    );

    if (localRemoteDebugPortFlag) {
      if (arg === localRemoteDebugPortFlag) {
        requestedLocalDebugPort = parsePortOrThrow(
          readFlagValue(chromeArgs, i),
          localRemoteDebugPortFlag
        );
        i += 1;
      } else {
        requestedLocalDebugPort = parsePortOrThrow(
          arg.split("=").slice(1).join("="),
          localRemoteDebugPortFlag
        );
      }
      continue;
    }

    if (
      arg.startsWith("--remote-debugging-address=") ||
      arg.startsWith("--remote-debug-address=") ||
      arg === "--remote-debugging-address" ||
      arg === "--remote-debug-address"
    ) {
      if (arg === "--remote-debugging-address" || arg === "--remote-debug-address") {
        i += 1;
      }
      continue;
    }

    if (arg.startsWith("--bridge-debug-file=")) {
      throw new Error(
        "[wsl-chrome-bridge] --bridge-debug-file is deprecated. " +
          "Use WSL_CHROME_BRIDGE_DEBUG_FILE instead."
      );
    }

    if (arg === "--bridge-debug-file") {
      throw new Error(
        "[wsl-chrome-bridge] --bridge-debug-file is deprecated. " +
          "Use WSL_CHROME_BRIDGE_DEBUG_FILE instead."
      );
    }

    const bridgeChromeExecutableFlag = BRIDGE_CHROME_EXECUTABLE_FLAGS.find(
      (flag) => arg === flag || arg.startsWith(`${flag}=`)
    );

    if (bridgeChromeExecutableFlag) {
      throw new Error(
        `[wsl-chrome-bridge] ${bridgeChromeExecutableFlag} is deprecated. ` +
          "Use WSL_CHROME_BRIDGE_EXECUTABLE_PATH instead."
      );
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
      userDataDir = value;
      const resolvedWindowsUserDataDir = toWindowsUserDataDir(value);
      if (resolvedWindowsUserDataDir) {
        windowsUserDataDir = resolvedWindowsUserDataDir;
        passthroughArgs.push(arg);
      }
      continue;
    }

    if (arg === "--user-data-dir") {
      const value = readFlagValue(chromeArgs, i);
      if (value) {
        userDataDir = value;
        const resolvedWindowsUserDataDir = toWindowsUserDataDir(value);
        if (resolvedWindowsUserDataDir) {
          windowsUserDataDir = resolvedWindowsUserDataDir;
          passthroughArgs.push(arg, value);
        }
        i += 1;
      }
      continue;
    }

    if (arg.startsWith("--userDataDir=")) {
      const value = arg.split("=").slice(1).join("=");
      userDataDir = value;
      const resolvedWindowsUserDataDir = toWindowsUserDataDir(value);
      if (resolvedWindowsUserDataDir) {
        windowsUserDataDir = resolvedWindowsUserDataDir;
        passthroughArgs.push(arg);
      }
      continue;
    }

    if (arg === "--userDataDir") {
      const value = readFlagValue(chromeArgs, i);
      if (value) {
        userDataDir = value;
        const resolvedWindowsUserDataDir = toWindowsUserDataDir(value);
        if (resolvedWindowsUserDataDir) {
          windowsUserDataDir = resolvedWindowsUserDataDir;
          passthroughArgs.push(arg, value);
        }
        i += 1;
      }
      continue;
    }

    passthroughArgs.push(arg);
  }

  const createdUserDataDir = false;

  if (!bridgeDebugFile) {
    const envDebugFile = env.WSL_CHROME_BRIDGE_DEBUG_FILE?.trim();
    if (envDebugFile) {
      // Keep CLI behavior as highest priority and only use env as a fallback.
      bridgeDebugFile = envDebugFile;
    }
  }

  const localProxyPort = requestedLocalDebugPort;
  let windowsDebugPortSource: BridgeLaunchPlan["windowsDebugPortSource"] = "auto-random";
  let windowsDebugPort = selectRandomDebugPort();
  let windowsUserDataDirSource: BridgeLaunchPlan["windowsUserDataDirSource"] = "default";

  if (bridgeRemoteDebugPort !== null) {
    windowsDebugPort = bridgeRemoteDebugPort;
    windowsDebugPortSource = "bridge-arg";
  } else if (envRemoteDebugPort !== null) {
    windowsDebugPort = envRemoteDebugPort;
    windowsDebugPortSource = "env";
  } else if (requestedLocalDebugPort !== null) {
    windowsDebugPort = requestedLocalDebugPort;
    windowsDebugPortSource = "upstream-port";
  }

  if (envWindowsUserDataDir) {
    windowsUserDataDir = envWindowsUserDataDir;
    windowsUserDataDirSource = "env";
  } else if (windowsUserDataDir) {
    windowsUserDataDirSource = "arg";
  } else {
    windowsUserDataDir = DEFAULT_WINDOWS_USER_DATA_DIR;
  }

  return {
    originalArgs: [...chromeArgs],
    passthroughArgs,
    usePipeTransport,
    bridgeDebugFile,
    bridgeChromeExecutablePath,
    userDataDir,
    windowsUserDataDir,
    windowsUserDataDirSource,
    requestedLocalDebugPort,
    localProxyPort,
    windowsDebugPort,
    windowsDebugPortSource,
    createdUserDataDir
  };
}

/**
 * Build final Chrome arguments used to launch Windows Chrome.
 */
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

  const launchArgs = [
    `--remote-debugging-port=${plan.windowsDebugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    ...withoutRemoteAllowOrigins
  ];

  if (plan.windowsUserDataDir) {
    launchArgs.unshift(`--user-data-dir=${plan.windowsUserDataDir}`);
  }

  return launchArgs;
}

/**
 * Parse browser websocket path from a full websocket URL.
 */
export function parseBrowserPathFromWsUrl(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  return parsed.pathname + parsed.search;
}
