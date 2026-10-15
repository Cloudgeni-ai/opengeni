import { describe, expect, test } from "bun:test";

import {
  desktopDownloadsFor,
  desktopDownloadUrl,
  desktopInstallCommand,
  desktopReleasePageUrl,
} from "@/lib/desktop-download";

const LINUX_X64 = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";
const LINUX_ARM = "Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Gecko/20100101 Firefox/131.0";

describe("desktop downloads", () => {
  test("Mac and Windows get their one installer", () => {
    expect(desktopDownloadsFor("macos", undefined)).toEqual([
      { label: "Download for Mac", asset: "Opengeni-mac.dmg" },
    ]);
    expect(desktopDownloadsFor("windows", undefined)).toEqual([
      { label: "Download for Windows", asset: "Opengeni-windows.exe" },
    ]);
  });

  test("Linux gets every package format for its architecture", () => {
    expect(desktopDownloadsFor("linux", LINUX_X64).map((download) => download.asset)).toEqual([
      "Opengeni-linux-amd64.deb",
      "Opengeni-linux-x86_64.rpm",
      "Opengeni-linux-x86_64.AppImage",
    ]);
    expect(desktopDownloadsFor("linux", LINUX_ARM).map((download) => download.asset)).toEqual([
      "Opengeni-linux-arm64.deb",
      "Opengeni-linux-aarch64.rpm",
      "Opengeni-linux-arm64.AppImage",
    ]);
  });

  test("links and the install command point at this server", () => {
    expect(desktopDownloadUrl("https://cp.example.com/", "Opengeni-mac.dmg")).toBe(
      "https://cp.example.com/desktop/latest/Opengeni-mac.dmg",
    );
    expect(desktopReleasePageUrl("https://cp.example.com")).toBe(
      "https://cp.example.com/desktop/latest",
    );
    expect(desktopInstallCommand("https://cp.example.com/")).toBe(
      "curl -fsSL https://cp.example.com/desktop/install.sh | sh",
    );
  });
});
