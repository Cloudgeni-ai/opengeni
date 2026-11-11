import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import { electronStub } from "./electron-stub";

const calls: string[] = [];

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  latest = "9.9.9";
  /** Keep the download running until the test finishes it. */
  hold = false;
  finish: (() => void) | null = null;
  setFeedURL() {}
  async checkForUpdates() {
    const version = this.latest;
    const done = () => this.emit("update-downloaded", { version });
    if (this.hold) this.finish = done;
    else queueMicrotask(done);
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

describe("the Update button", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  test("asking while the download runs restarts once it finishes, with progress", async () => {
    calls.length = 0;
    autoUpdater.latest = "9.9.11";
    autoUpdater.hold = true;
    let changed = 0;
    const updates = new AppUpdates(
      "Product",
      { url: "https://updates.example.com/" },
      "1.0.0",
      () => changed++,
      () => calls.push("beforeRestart"),
    );
    try {
      expect(updates.pageState).toEqual({ kind: "none" });
      await backgroundCheck(updates);
      expect(updates.pageState).toEqual({
        kind: "downloading",
        version: "9.9.11",
        percent: null,
        restartWhenReady: false,
      });
      autoUpdater.emit("download-progress", { percent: 42.7 });
      expect(updates.pageState).toMatchObject({ percent: 40 });
      const before = changed;
      autoUpdater.emit("download-progress", { percent: 43.9 });
      expect(changed).toBe(before);

      updates.install();
      expect(updates.pageState).toMatchObject({ kind: "downloading", restartWhenReady: true });
      expect(calls).toEqual([]);

      autoUpdater.finish?.();
      expect(calls).toEqual(["beforeRestart", "quitAndInstall"]);
    } finally {
      autoUpdater.hold = false;
      autoUpdater.finish = null;
    }
  });

  test("a downloaded update restarts at once", async () => {
    calls.length = 0;
    autoUpdater.latest = "9.9.12";
    const updates = new AppUpdates(
      "Product",
      { url: "https://updates.example.com/" },
      "1.0.0",
      () => {},
      () => calls.push("beforeRestart"),
    );
    await backgroundCheck(updates);
    await settle();
    expect(updates.pageState).toEqual({
      kind: "ready",
      version: "9.9.12",
      restartWhenReady: false,
    });
    calls.length = 0;
    updates.install();
    expect(calls).toEqual(["beforeRestart", "quitAndInstall"]);
  });

  test("a failed download after asking clears the request so the button comes back", async () => {
    calls.length = 0;
    autoUpdater.latest = "9.9.13";
    autoUpdater.hold = true;
    const updates = new AppUpdates(
      "Product",
      { url: "https://updates.example.com/" },
      "1.0.0",
      () => {},
      () => calls.push("beforeRestart"),
    );
    try {
      await backgroundCheck(updates);
      updates.install();
      autoUpdater.emit("error", new Error("offline"));
      expect(updates.pageState).toEqual({ kind: "none" });
      expect(calls).toEqual([]);
    } finally {
      autoUpdater.hold = false;
      autoUpdater.finish = null;
    }
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
