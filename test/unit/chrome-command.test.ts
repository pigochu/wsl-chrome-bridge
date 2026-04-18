import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_CHROME_PATHS,
  resolveChromeCommand
} from "../../src/chrome-command.js";

describe("resolveChromeCommand", () => {
  it("uses explicit bridge chrome executable path when provided", () => {
    const command = resolveChromeCommand({
      bridgeChromeExecutablePath: "/mnt/c/Custom/Chrome/chrome.exe",
      env: {
        WSL_DISTRO_NAME: "Ubuntu"
      }
    });

    expect(command).toBe("C:\\Custom\\Chrome\\chrome.exe");
  });

  it("uses WSL_CHROME_BRIDGE_EXECUTABLE_PATH when provided", () => {
    const command = resolveChromeCommand({
      env: {
        WSL_DISTRO_NAME: "Ubuntu",
        WSL_CHROME_BRIDGE_EXECUTABLE_PATH: "/mnt/c/Custom/Chrome/chrome.exe"
      }
    });

    expect(command).toBe("C:\\Custom\\Chrome\\chrome.exe");
  });

  it("ignores CHROME_PATH-like environment variables", () => {
    const command = resolveChromeCommand({
      env: {
        WSL_DISTRO_NAME: "Ubuntu",
        WSL_CHROME_BRIDGE_CHROME_PATH: "/mnt/c/Env/Chrome/chrome.exe",
        CHROME_PATH: "/mnt/c/Other/Chrome/chrome.exe"
      },
      pathExists: () => false
    });

    expect(command).toBe("chrome.exe");
  });

  it("uses detected default search chrome path when available", () => {
    const command = resolveChromeCommand({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      pathExists: (path) => path === DEFAULT_SEARCH_CHROME_PATHS[1]
    });

    expect(command).toBe("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
  });

  it("falls back to chrome.exe when no configured or detected path exists", () => {
    const command = resolveChromeCommand({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      pathExists: () => false
    });

    expect(command).toBe("chrome.exe");
  });
});
