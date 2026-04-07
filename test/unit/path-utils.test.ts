import { describe, expect, it } from "vitest";
import { toWindowsPathIfNeeded } from "../../src/path-utils.js";

describe("toWindowsPathIfNeeded", () => {
  it("converts /mnt drive paths to Windows drive paths", () => {
    expect(
      toWindowsPathIfNeeded("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe", {
        preferWslpath: false
      })
    ).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  });

  it("converts generic linux absolute path to UNC when distro is known", () => {
    expect(
      toWindowsPathIfNeeded("/tmp/profile", {
        distroName: "Ubuntu",
        preferWslpath: false
      })
    ).toBe("\\\\wsl$\\Ubuntu\\tmp\\profile");
  });

  it("returns original value when path is already windows-like", () => {
    expect(toWindowsPathIfNeeded("C:\\Chrome\\chrome.exe")).toBe("C:\\Chrome\\chrome.exe");
  });

  it("prefers wslpath conversion result when available", () => {
    const converted = toWindowsPathIfNeeded("/tmp/profile", {
      distroName: "Ubuntu",
      wslpathConverter: () => "\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\profile"
    });

    expect(converted).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\profile");
  });
});
