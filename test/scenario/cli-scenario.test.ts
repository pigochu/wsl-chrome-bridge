import { describe, expect, it, vi } from "vitest";

const runBridgeMock = vi.fn(async () => 0);

vi.mock("../../src/bridge-runner.js", () => {
  return {
    createBridgeRunner: () => runBridgeMock
  };
});

describe("CLI scenario", () => {
  it("forwards unknown chrome args to bridge runner", async () => {
    const { main } = await import("../../src/cli.js");

    const code = await main([
      "node",
      "wsl-chrome-bridge",
      "--user-data-dir=%TEMP%\\wsl-chrome-bridge-profile",
      "--remote-debugging-port=9222",
      "--disable-gpu"
    ]);

    expect(code).toBe(0);
    expect(runBridgeMock).toHaveBeenCalledOnce();
    expect(runBridgeMock).toHaveBeenCalledWith([
      "--user-data-dir=%TEMP%\\wsl-chrome-bridge-profile",
      "--remote-debugging-port=9222",
      "--disable-gpu"
    ]);
  });
});
