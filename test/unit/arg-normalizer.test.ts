import { describe, expect, it } from "vitest";
import { normalizeChromeArgs } from "../../src/arg-normalizer.js";

describe("normalizeChromeArgs", () => {
  it("normalizes --crash-dumps-dir in --flag=value form", () => {
    expect(
      normalizeChromeArgs(["--headless=new", "--crash-dumps-dir=/tmp/profile"], {
        distroName: "Ubuntu",
        preferWslpath: false
      })
    ).toEqual(["--headless=new", "--crash-dumps-dir=\\\\wsl$\\Ubuntu\\tmp\\profile"]);
  });

  it("normalizes --disk-cache-dir in separated argument form", () => {
    expect(
      normalizeChromeArgs(["--disk-cache-dir", "/mnt/c/temp/chrome"], {
        distroName: "Ubuntu",
        preferWslpath: false
      })
    ).toEqual(["--disk-cache-dir", "C:\\temp\\chrome"]);
  });

  it("prefers wslpath conversion when available", () => {
    expect(
      normalizeChromeArgs(["--crash-dumps-dir=/tmp/profile"], {
        distroName: "Ubuntu",
        wslpathConverter: () => "\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\profile"
      })
    ).toEqual(["--crash-dumps-dir=\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\profile"]);
  });
});
