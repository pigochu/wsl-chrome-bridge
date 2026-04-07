import { toWindowsPathIfNeeded } from "./path-utils.js";

const PATH_FLAGS = new Set([
  "--crash-dumps-dir",
  "--disk-cache-dir"
]);

export interface ArgNormalizationOptions {
  distroName?: string;
  preferWslpath?: boolean;
  wslpathConverter?: (inputPath: string) => string | undefined;
}

export function normalizeChromeArgs(
  args: string[],
  options: ArgNormalizationOptions = {}
): string[] {
  const normalized: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equalIndex = arg.indexOf("=");

    if (equalIndex > -1) {
      const flag = arg.slice(0, equalIndex);
      const value = arg.slice(equalIndex + 1);
      if (PATH_FLAGS.has(flag)) {
        normalized.push(
          `${flag}=${toWindowsPathIfNeeded(value, {
            distroName: options.distroName,
            preferWslpath: options.preferWslpath,
            wslpathConverter: options.wslpathConverter
          })}`
        );
        continue;
      }
    }

    if (PATH_FLAGS.has(arg) && index + 1 < args.length) {
      normalized.push(arg);
      normalized.push(
        toWindowsPathIfNeeded(args[index + 1], {
          distroName: options.distroName,
          preferWslpath: options.preferWslpath,
          wslpathConverter: options.wslpathConverter
        }) ?? ""
      );
      index += 1;
      continue;
    }

    normalized.push(arg);
  }

  return normalized;
}
