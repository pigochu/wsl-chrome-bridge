import { existsSync } from "node:fs";
import { toWindowsPathIfNeeded } from "./path-utils.js";

// Default candidate executable paths searched in order.
// The bridge checks whether each path exists and picks the first match.
export const DEFAULT_SEARCH_CHROME_PATHS = [
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
];

export interface ChromeCommandOptions {
  env?: NodeJS.ProcessEnv;
  pathExists?: (path: string) => boolean;
  bridgeChromeExecutablePath?: string | null;
}

export function resolveChromeCommand(options: ChromeCommandOptions = {}): string {
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? existsSync;
  const distroName = env.WSL_DISTRO_NAME;

  const configuredPath =
    options.bridgeChromeExecutablePath?.trim() ??
    env.WSL_CHROME_BRIDGE_EXECUTABLE_PATH?.trim();
  if (configuredPath) {
    return (
      toWindowsPathIfNeeded(configuredPath, {
        distroName
      }) ?? configuredPath
    );
  }

  for (const candidate of DEFAULT_SEARCH_CHROME_PATHS) {
    if (pathExists(candidate)) {
      return toWindowsPathIfNeeded(candidate, { distroName }) ?? candidate;
    }
  }

  return "chrome.exe";
}
