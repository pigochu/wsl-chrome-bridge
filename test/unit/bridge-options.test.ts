import { describe, expect, it } from "vitest";
import {
  buildWindowsChromeArgs,
  parseBrowserPathFromWsUrl,
  planBridgeLaunch
} from "../../src/bridge-options.js";

describe("planBridgeLaunch", () => {
  it("extracts local debug port and user-data-dir from args", () => {
    const plan = planBridgeLaunch(
      [
        "--remote-debugging-port=9222",
        "--user-data-dir=%TEMP%\\wsl-chrome-bridge-profile",
        "--no-first-run",
        "--remote-debugging-address=0.0.0.0"
      ]
    );

    expect(plan.requestedLocalDebugPort).toBe(9222);
    expect(plan.userDataDir).toBe("%TEMP%\\wsl-chrome-bridge-profile");
    expect(plan.windowsDebugPort).toBe(9222);
    expect(plan.passthroughArgs).toContain("--no-first-run");
    expect(plan.passthroughArgs.find((x) => x.startsWith("--remote-debugging-port"))).toBeUndefined();
  });

  it("rejects remote-debugging-port=0", () => {
    expect(() => planBridgeLaunch(["--remote-debugging-port=0"])).toThrow(
      /invalid --remote-debugging-port/
    );
  });

  it("respects user-defined remote debugging port", () => {
    const plan = planBridgeLaunch(["--remote-debugging-port=14444"]);
    expect(plan.requestedLocalDebugPort).toBe(14444);
    expect(plan.windowsDebugPort).toBe(14444);
  });

  it("prefers bridge remote debugging port over remote-debugging-port", () => {
    const plan = planBridgeLaunch([
      "--remote-debugging-port=14444",
      "--bridge-remote-debugging-port=9222"
    ]);

    expect(plan.requestedLocalDebugPort).toBe(14444);
    expect(plan.windowsDebugPort).toBe(9222);
    expect(
      plan.passthroughArgs.find((x) => x.startsWith("--bridge-remote-debugging-port"))
    ).toBeUndefined();
  });

  it("accepts separated bridge remote debugging port arg form", () => {
    const plan = planBridgeLaunch([
      "--bridge-remote-debugging-port",
      "9333",
      "--disable-gpu"
    ]);

    expect(plan.windowsDebugPort).toBe(9333);
    expect(plan.passthroughArgs).toContain("--disable-gpu");
  });

  it("rejects bridge-remote-debugging-port=0", () => {
    expect(() => planBridgeLaunch(["--bridge-remote-debugging-port=0"])).toThrow(
      /invalid --bridge-remote-debugging-port/
    );
  });

  it("defaults remote debugging port to 9222 when not specified", () => {
    const plan = planBridgeLaunch(["--disable-gpu"]);
    expect(plan.requestedLocalDebugPort).toBe(9222);
    expect(plan.windowsDebugPort).toBe(9222);
  });

  it("captures bridge-only debug file and removes it from passthrough args", () => {
    const plan = planBridgeLaunch(
      ["--bridge-debug-file=/tmp/wsl-chrome-bridge-debug.log", "--disable-gpu"]
    );

    expect(plan.bridgeDebugFile).toBe("/tmp/wsl-chrome-bridge-debug.log");
    expect(plan.passthroughArgs).toContain("--disable-gpu");
    expect(plan.passthroughArgs.find((x) => x.startsWith("--bridge-debug-file"))).toBeUndefined();
  });

  it("captures bridge-only chrome executable path and removes it from passthrough args", () => {
    const plan = planBridgeLaunch(
      [
        "--bridge-chrome-executablePath=C:\\Custom\\Chrome\\chrome.exe",
        "--disable-gpu"
      ]
    );

    expect(plan.bridgeChromeExecutablePath).toBe("C:\\Custom\\Chrome\\chrome.exe");
    expect(plan.passthroughArgs).toContain("--disable-gpu");
    expect(
      plan.passthroughArgs.find((x) => x.startsWith("--bridge-chrome-executablePath"))
    ).toBeUndefined();
  });

  it("accepts separated bridge chrome executable arg form", () => {
    const plan = planBridgeLaunch(
      [
        "--bridge-chrome-executablePath",
        "C:\\Another Chrome\\chrome.exe",
        "--disable-gpu"
      ]
    );

    expect(plan.bridgeChromeExecutablePath).toBe("C:\\Another Chrome\\chrome.exe");
    expect(plan.passthroughArgs).toContain("--disable-gpu");
  });

  it("accepts camelCase --userDataDir and does not auto-create extra profile dir", () => {
    const plan = planBridgeLaunch(["--userDataDir", "%TEMP%\\wsl-chrome-bridge-profile"]);

    expect(plan.createdUserDataDir).toBe(false);
    expect(plan.userDataDir).toBe("%TEMP%\\wsl-chrome-bridge-profile");
    expect(plan.windowsUserDataDir).toBe("%TEMP%\\wsl-chrome-bridge-profile");
  });

  it("ignores linux-style --user-data-dir path and falls back to default windows profile", () => {
    const plan = planBridgeLaunch(["--user-data-dir=/home/user/chrome-profile", "--disable-gpu"]);

    expect(plan.createdUserDataDir).toBe(true);
    expect(plan.windowsUserDataDir).toBe("%TEMP%\\wsl-chrome-bridge\\chrome-profile");
    expect(plan.passthroughArgs).toContain("--disable-gpu");
    expect(plan.passthroughArgs).not.toContain("--user-data-dir=/home/user/chrome-profile");
  });

  it("ignores linux-style --userDataDir path and falls back to default windows profile", () => {
    const plan = planBridgeLaunch(["--userDataDir", "/tmp/chrome-profile", "--disable-gpu"]);

    expect(plan.createdUserDataDir).toBe(true);
    expect(plan.windowsUserDataDir).toBe("%TEMP%\\wsl-chrome-bridge\\chrome-profile");
    expect(plan.passthroughArgs).toContain("--disable-gpu");
    expect(plan.passthroughArgs).not.toContain("--userDataDir");
    expect(plan.passthroughArgs).not.toContain("/tmp/chrome-profile");
  });

  it("ignores chrome-devtools-mcp default linux cache profile path", () => {
    const plan = planBridgeLaunch(
      ["--user-data-dir=/home/user/.cache/chrome-devtools-mcp/chrome-profile"]
    );

    expect(plan.createdUserDataDir).toBe(true);
    expect(plan.windowsUserDataDir).toBe("%TEMP%\\wsl-chrome-bridge\\chrome-profile");
  });
});

describe("buildWindowsChromeArgs", () => {
  it("injects windows debug flags and preserves configured user-data-dir", () => {
    const plan = planBridgeLaunch(["--user-data-dir=%TEMP%\\foo"]);

    const windowsArgs = buildWindowsChromeArgs(plan, {
      WSL_DISTRO_NAME: "Ubuntu"
    });

    expect(windowsArgs).toContain("--user-data-dir=%TEMP%\\foo");
    expect(windowsArgs).toContain("--remote-debugging-port=9222");
    expect(windowsArgs).toContain("--remote-debugging-address=127.0.0.1");
    expect(windowsArgs).toContain("--remote-allow-origins=*");
  });
});

describe("parseBrowserPathFromWsUrl", () => {
  it("returns browser websocket path", () => {
    expect(
      parseBrowserPathFromWsUrl("ws://127.0.0.1:9222/devtools/browser/abc-123?foo=bar")
    ).toBe("/devtools/browser/abc-123?foo=bar");
  });
});
