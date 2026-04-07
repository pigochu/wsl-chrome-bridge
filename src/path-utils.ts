import { execFileSync } from "node:child_process";

export interface PathConversionOptions {
  distroName?: string;
  preferWslpath?: boolean;
  wslpathConverter?: (inputPath: string) => string | undefined;
}

function convertWithWslpath(inputPath: string): string | undefined {
  if (!inputPath.startsWith("/")) {
    return undefined;
  }

  try {
    const output = execFileSync("wslpath", ["-w", inputPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

export function toWindowsPathIfNeeded(
  inputPath: string | undefined,
  options: PathConversionOptions = {}
): string | undefined {
  if (!inputPath) {
    return inputPath;
  }

  const preferWslpath = options.preferWslpath ?? true;
  if (preferWslpath) {
    const converter = options.wslpathConverter ?? convertWithWslpath;
    const converted = converter(inputPath);
    if (converted) {
      return converted;
    }
  }

  const drivePath = inputPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (drivePath) {
    const [, drive, tail] = drivePath;
    return `${drive.toUpperCase()}:\\${tail.replaceAll("/", "\\")}`;
  }

  if (inputPath.startsWith("/") && options.distroName) {
    return `\\\\wsl$\\${options.distroName}${inputPath.replaceAll("/", "\\")}`;
  }

  return inputPath;
}
