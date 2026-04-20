import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOWS_USER_DATA_DIR,
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
    expect(plan.localProxyPort).toBe(9222);
    expect(plan.usePipeTransport).toBe(false);
    expect(plan.userDataDir).toBe("%TEMP%\\wsl-chrome-bridge-profile");
    expect(plan.windowsUserDataDir).toBe("%TEMP%\\wsl-chrome-bridge-profile");
    expect(plan.windowsUserDataDirSource).toBe("arg");
    expect(plan.windowsDebugPort).toBe(9222);
    expect(plan.windowsDebugPortSource).toBe("upstream-port");
    expect(plan.passthroughArgs).toContain("--no-first-run");
    expect(plan.passthroughArgs.find((x) => x.startsWith("--remote-debugging-port"))).toBeUndefined();
  });

  it("rejects remote-debugging-port=0", () => {
    expect(() => planBridgeLaunch(["--remote-debugging-port=0"])).toThrow(
      /invalid --remote-debugging-port/
    );
  });

  it("marks pipe transport when remote-debugging-pipe is requested", () => {
    const plan = planBridgeLaunch(["--remote-debugging-pipe", "--disable-gpu"]);
    expect(plan.usePipeTransport).toBe(true);
    expect(plan.passthroughArgs).toContain("--disable-gpu");
    expect(plan.passthroughArgs).not.toContain("--remote-debugging-pipe");
  });

  it("respects user-defined remote debugging port", () => {
    const plan = planBridgeLaunch(["--remote-debugging-port=14444"]);
    expect(plan.requestedLocalDebugPort).toBe(14444);
    expect(plan.localProxyPort).toBe(14444);
    expect(plan.windowsDebugPort).toBe(14444);
    expect(plan.windowsDebugPortSource).toBe("upstream-port");
  });

  it("prefers bridge remote debugging port over remote-debugging-port", () => {
    const plan = planBridgeLaunch([
      "--remote-debugging-port=14444",
      "--bridge-remote-debugging-port=9222"
    ]);

    expect(plan.requestedLocalDebugPort).toBe(14444);
    expect(plan.localProxyPort).toBe(14444);
    expect(plan.windowsDebugPort).toBe(9222);
    expect(plan.windowsDebugPortSource).toBe("bridge-arg");
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
    expect(plan.windowsDebugPortSource).toBe("bridge-arg");
    expect(plan.passthroughArgs).toContain("--disable-gpu");
  });

  it("rejects bridge-remote-debugging-port=0", () => {
    expect(() => planBridgeLaunch(["--bridge-remote-debugging-port=0"])).toThrow(
      /invalid --bridge-remote-debugging-port/
    );
  });

  it("uses random Windows debug port when no debug port is specified", () => {
    const plan = planBridgeLaunch(["--disable-gpu"]);
    expect(plan.requestedLocalDebugPort).toBeNull();
    expect(plan.localProxyPort).toBeNull();
    expect(plan.userDataDir).toBeNull();
    expect(plan.windowsUserDataDir).toBe(DEFAULT_WINDOWS_USER_DATA_DIR);
    expect(plan.windowsUserDataDirSource).toBe("default");
    expect(plan.createdUserDataDir).toBe(false);
    expect(plan.windowsDebugPortSource).toBe("auto-random");
    expect(plan.windowsDebugPort).toBeGreaterThanOrEqual(10000);
    expect(plan.windowsDebugPort).toBeLessThanOrEqual(65535);
  });

  it("uses WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT when no explicit bridge port is provided", () => {
    const plan = planBridgeLaunch(["--disable-gpu"], {
      WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT: "9333"
    });
    expect(plan.windowsDebugPort).toBe(9333);
    expect(plan.windowsDebugPortSource).toBe("env");
  });

  it("prefers bridge remote debugging port over WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT", () => {
    const plan = planBridgeLaunch(
      ["--bridge-remote-debugging-port=9444"],
      { WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT: "9333" }
    );
    expect(plan.windowsDebugPort).toBe(9444);
    expect(plan.windowsDebugPortSource).toBe("bridge-arg");
  });

  it("rejects invalid WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT values", () => {
    expect(() =>
      planBridgeLaunch(["--disable-gpu"], { WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT: "0" })
    ).toThrow(/invalid WSL_CHROME_BRIDGE_REMOTE_DEBUG_PORT/);
  });

  it("rejects deprecated --bridge-debug-file flag", () => {
    expect(() => planBridgeLaunch(["--bridge-debug-file=/tmp/old.log"])).toThrow(
      /--bridge-debug-file is deprecated/
    );
  });

  it("uses WSL_CHROME_BRIDGE_DEBUG_FILE when bridge-debug-file arg is not provided", () => {
    const plan = planBridgeLaunch(
      ["--disable-gpu"],
      { WSL_CHROME_BRIDGE_DEBUG_FILE: "/tmp/env-debug.log" }
    );

    expect(plan.bridgeDebugFile).toBe("/tmp/env-debug.log");
  });

  it("ignores empty WSL_CHROME_BRIDGE_DEBUG_FILE values", () => {
    const plan = planBridgeLaunch(
      ["--disable-gpu"],
      { WSL_CHROME_BRIDGE_DEBUG_FILE: "   " }
    );

    expect(plan.bridgeDebugFile).toBeNull();
  });

  it("uses WSL_CHROME_BRIDGE_DEBUG_RAW_DIR when provided", () => {
    const plan = planBridgeLaunch(
      ["--disable-gpu"],
      { WSL_CHROME_BRIDGE_DEBUG_RAW_DIR: "/tmp/bridge-raw-logs" }
    );

    expect(plan.bridgeDebugRawDir).toBe("/tmp/bridge-raw-logs");
  });

  it("ignores empty WSL_CHROME_BRIDGE_DEBUG_RAW_DIR values", () => {
    const plan = planBridgeLaunch(
      ["--disable-gpu"],
      { WSL_CHROME_BRIDGE_DEBUG_RAW_DIR: "   " }
    );

    expect(plan.bridgeDebugRawDir).toBeNull();
  });

  it("rejects deprecated --bridge-chrome-executablePath flag", () => {
    expect(() =>
      planBridgeLaunch(["--bridge-chrome-executablePath=C:\\Custom\\Chrome\\chrome.exe"])
    ).toThrow(/--bridge-chrome-executablePath is deprecated/);
  });

  it("rejects deprecated --bridge-chrome-executable-path flag", () => {
    expect(() =>
      planBridgeLaunch(["--bridge-chrome-executable-path", "C:\\Another Chrome\\chrome.exe"])
    ).toThrow(/--bridge-chrome-executable-path is deprecated/);
  });

  it("uses WSL_CHROME_BRIDGE_EXECUTABLE_PATH when provided", () => {
    const plan = planBridgeLaunch(["--disable-gpu"], {
      WSL_CHROME_BRIDGE_EXECUTABLE_PATH: "C:\\Custom\\Chrome\\chrome.exe"
    });

    expect(plan.bridgeChromeExecutablePath).toBe("C:\\Custom\\Chrome\\chrome.exe");
    expect(plan.passthroughArgs).toContain("--disable-gpu");
  });

  it("uses WSL_CHROME_BRIDGE_USER_DATA_DIR when provided", () => {
    const plan = planBridgeLaunch(["--disable-gpu"], {
      WSL_CHROME_BRIDGE_USER_DATA_DIR: "%TEMP%\\wsl-chrome-bridge\\chrome-profile-env"
    });

    expect(plan.userDataDir).toBeNull();
    expect(plan.windowsUserDataDir).toBe("%TEMP%\\wsl-chrome-bridge\\chrome-profile-env");
    expect(plan.windowsUserDataDirSource).toBe("env");
  });

  it("prefers WSL_CHROME_BRIDGE_USER_DATA_DIR over --user-data-dir", () => {
    const plan = planBridgeLaunch(
      ["--user-data-dir=%TEMP%\\wsl-chrome-bridge\\chrome-profile-arg"],
      { WSL_CHROME_BRIDGE_USER_DATA_DIR: "%TEMP%\\wsl-chrome-bridge\\chrome-profile-env" }
    );

    expect(plan.userDataDir).toBe("%TEMP%\\wsl-chrome-bridge\\chrome-profile-arg");
    expect(plan.windowsUserDataDir).toBe("%TEMP%\\wsl-chrome-bridge\\chrome-profile-env");
    expect(plan.windowsUserDataDirSource).toBe("env");
  });

  it("rejects invalid WSL_CHROME_BRIDGE_USER_DATA_DIR values", () => {
    expect(() =>
      planBridgeLaunch(["--disable-gpu"], { WSL_CHROME_BRIDGE_USER_DATA_DIR: "/tmp/not-windows" })
    ).toThrow(/invalid WSL_CHROME_BRIDGE_USER_DATA_DIR/);
  });

  it("ignores empty WSL_CHROME_BRIDGE_EXECUTABLE_PATH values", () => {
    const plan = planBridgeLaunch(["--disable-gpu"], {
      WSL_CHROME_BRIDGE_EXECUTABLE_PATH: "   "
    });

    expect(plan.bridgeChromeExecutablePath).toBeNull();
  });

  it("accepts camelCase --userDataDir and does not auto-create extra profile dir", () => {
    const plan = planBridgeLaunch(["--userDataDir", "%TEMP%\\wsl-chrome-bridge-profile"]);

    expect(plan.createdUserDataDir).toBe(false);
    expect(plan.userDataDir).toBe("%TEMP%\\wsl-chrome-bridge-profile");
    expect(plan.windowsUserDataDir).toBe("%TEMP%\\wsl-chrome-bridge-profile");
    expect(plan.windowsUserDataDirSource).toBe("arg");
  });

  it("does not use linux-style --user-data-dir for Windows Chrome launch", () => {
    const plan = planBridgeLaunch(
      ["--user-data-dir=/home/user/chrome-profile", "--disable-gpu"]
    );

    expect(plan.createdUserDataDir).toBe(false);
    expect(plan.userDataDir).toBe("/home/user/chrome-profile");
    expect(plan.windowsUserDataDir).toBe(DEFAULT_WINDOWS_USER_DATA_DIR);
    expect(plan.windowsUserDataDirSource).toBe("default");
    expect(plan.passthroughArgs).toContain("--disable-gpu");
  });

  it("does not use linux-style --userDataDir for Windows Chrome launch", () => {
    const plan = planBridgeLaunch(
      ["--userDataDir", "/tmp/chrome-profile", "--disable-gpu"]
    );

    expect(plan.createdUserDataDir).toBe(false);
    expect(plan.userDataDir).toBe("/tmp/chrome-profile");
    expect(plan.windowsUserDataDir).toBe(DEFAULT_WINDOWS_USER_DATA_DIR);
    expect(plan.windowsUserDataDirSource).toBe("default");
    expect(plan.passthroughArgs).toContain("--disable-gpu");
  });

  it("does not use chrome-devtools-mcp default linux cache profile path", () => {
    const plan = planBridgeLaunch(
      ["--user-data-dir=/home/user/.cache/chrome-devtools-mcp/chrome-profile"]
    );

    expect(plan.createdUserDataDir).toBe(false);
    expect(plan.userDataDir).toBe("/home/user/.cache/chrome-devtools-mcp/chrome-profile");
    expect(plan.windowsUserDataDir).toBe(DEFAULT_WINDOWS_USER_DATA_DIR);
    expect(plan.windowsUserDataDirSource).toBe("default");
  });

  it("restores path-resolved %TEMP% windows path from linux absolute prefix", () => {
    const plan = planBridgeLaunch(["--user-data-dir=/work/%TEMP%\\abc\\def"]);
    expect(plan.createdUserDataDir).toBe(false);
    expect(plan.windowsUserDataDir).toBe("%TEMP%\\abc\\def");
    expect(plan.windowsUserDataDirSource).toBe("arg");
  });

  it("restores path-resolved root-style windows path from linux absolute prefix", () => {
    const plan = planBridgeLaunch([`--user-data-dir=${String.raw`/work/\abc\def`}`]);
    expect(plan.createdUserDataDir).toBe(false);
    expect(plan.windowsUserDataDir).toBe(String.raw`\abc\def`);
    expect(plan.windowsUserDataDirSource).toBe("arg");
  });

  it("restores path-resolved drive windows path from linux absolute prefix", () => {
    const plan = planBridgeLaunch(["--user-data-dir=/work/c:\\abc\\def"]);
    expect(plan.createdUserDataDir).toBe(false);
    expect(plan.windowsUserDataDir).toBe("c:\\abc\\def");
    expect(plan.windowsUserDataDirSource).toBe("arg");
  });
});

describe("buildWindowsChromeArgs", () => {
  it("injects windows debug flags and preserves configured user-data-dir", () => {
    const plan = planBridgeLaunch([
      "--user-data-dir=%TEMP%\\foo",
      "--remote-debugging-port=24444"
    ]);

    const windowsArgs = buildWindowsChromeArgs(plan, {
      WSL_DISTRO_NAME: "Ubuntu"
    });

    expect(windowsArgs).toContain("--user-data-dir=%TEMP%\\foo");
    expect(windowsArgs).toContain("--remote-debugging-port=24444");
    expect(windowsArgs).toContain("--remote-debugging-address=127.0.0.1");
    expect(windowsArgs).toContain("--remote-allow-origins=*");
  });

  it("injects default user-data-dir when resolved path is still linux-style", () => {
    const plan = planBridgeLaunch([
      "--user-data-dir=/home/user/chrome-profile",
      "--remote-debugging-port=24444"
    ]);

    const windowsArgs = buildWindowsChromeArgs(plan, {
      WSL_DISTRO_NAME: "Ubuntu"
    });

    expect(windowsArgs).toContain(`--user-data-dir=${DEFAULT_WINDOWS_USER_DATA_DIR}`);
    expect(windowsArgs).toContain("--remote-debugging-port=24444");
  });

  it("injects env user-data-dir even when upstream sends linux-style path", () => {
    const plan = planBridgeLaunch(
      [
        "--user-data-dir=/home/user/chrome-profile",
        "--remote-debugging-port=24444"
      ],
      {
        WSL_CHROME_BRIDGE_USER_DATA_DIR: "%TEMP%\\wsl-chrome-bridge\\chrome-profile-env"
      }
    );

    const windowsArgs = buildWindowsChromeArgs(plan, {
      WSL_DISTRO_NAME: "Ubuntu"
    });

    expect(windowsArgs).toContain("--user-data-dir=%TEMP%\\wsl-chrome-bridge\\chrome-profile-env");
    expect(windowsArgs).toContain("--remote-debugging-port=24444");
  });
});

describe("parseBrowserPathFromWsUrl", () => {
  it("returns browser websocket path", () => {
    expect(
      parseBrowserPathFromWsUrl("ws://127.0.0.1:9222/devtools/browser/abc-123?foo=bar")
    ).toBe("/devtools/browser/abc-123?foo=bar");
  });
});
