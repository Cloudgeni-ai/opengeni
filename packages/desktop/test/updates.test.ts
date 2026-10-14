import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

const calls: string[] = [];

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  setFeedURL() {}
  async checkForUpdates() {
    queueMicrotask(() => this.emit("update-downloaded", { version: "9.9.9" }));
    return { isUpdateAvailable: true, updateInfo: { version: "9.9.9" } };
  }
  quitAndInstall() {
    calls.push("quitAndInstall");
  }
}
const autoUpdater = new FakeUpdater();

class FakeNotification extends EventEmitter {
  static isSupported() {
    return false;
  }
}

// Bun's module mocks are shared across test files: keep what menu.test needs too.
mock.module("electron", () => ({
  app: { isPackaged: true },
  Menu: { buildFromTemplate: (template: unknown) => template },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  Notification: FakeNotification,
}));
mock.module("electron-updater", () => ({ autoUpdater }));

const { AppUpdates } = await import("../src/main/updates");

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
});
