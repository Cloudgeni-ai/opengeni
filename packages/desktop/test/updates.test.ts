import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import { electronStub } from "./electron-stub";

const calls: string[] = [];

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  latest = "9.9.9";
  setFeedURL() {}
  async checkForUpdates() {
    const version = this.latest;
    queueMicrotask(() => this.emit("update-downloaded", { version }));
    return { isUpdateAvailable: true, updateInfo: { version } };
  }
  quitAndInstall() {
    calls.push("quitAndInstall");
  }
}
const autoUpdater = new FakeUpdater();

mock.module("electron", () => electronStub);
mock.module("electron-updater", () => ({ autoUpdater }));

const { AppUpdates, updateNeedsPassword } = await import("../src/main/updates");

/** The periodic check the app runs in the background. */
function backgroundCheck(updates: InstanceType<typeof AppUpdates>): Promise<void> {
  return (updates as unknown as { check(interactive: boolean): Promise<void> }).check(false);
}

describe("app updates", () => {
  test("restarting into an update lets the shell quit first", async () => {
    let changed = 0;
    const updates = new AppUpdates(
      "Product",
      { url: "https://updates.example.com/" },
      "1.0.0",
      () => changed++,
      () => calls.push("beforeRestart"),
    );
    updates.menuAction();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates.menuState).toEqual({ kind: "ready", version: "9.9.9" });
    expect(changed).toBeGreaterThan(0);

    updates.menuAction();
    expect(calls).toEqual(["beforeRestart", "quitAndInstall"]);
  });

  test("a ready update keeps checking and moves on to a newer release", async () => {
    autoUpdater.latest = "9.9.9";
    const updates = new AppUpdates(
      "Product",
      { url: "https://updates.example.com/" },
      "1.0.0",
      () => {},
      () => {},
    );
    await backgroundCheck(updates);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates.menuState).toEqual({ kind: "ready", version: "9.9.9" });

    autoUpdater.latest = "9.9.10";
    const checking = backgroundCheck(updates);
    // The downloaded update stays ready while the newer one downloads.
    expect(updates.menuState).toEqual({ kind: "ready", version: "9.9.9" });
    await checking;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates.menuState).toEqual({ kind: "ready", version: "9.9.10" });
  });
});

describe("update installs", () => {
  test("deb and rpm installs need a password; AppImage and other platforms don't", () => {
    expect(updateNeedsPassword("linux", () => "deb\n")).toBe(true);
    expect(updateNeedsPassword("linux", () => "rpm")).toBe(true);
    expect(updateNeedsPassword("darwin", () => "deb")).toBe(false);
    expect(
      updateNeedsPassword("linux", () => {
        throw new Error("no package-type file");
      }),
    ).toBe(false);
    process.env.APPIMAGE = "/opt/Opengeni.AppImage";
    try {
      expect(updateNeedsPassword("linux", () => "deb")).toBe(false);
    } finally {
      delete process.env.APPIMAGE;
    }
  });
});
