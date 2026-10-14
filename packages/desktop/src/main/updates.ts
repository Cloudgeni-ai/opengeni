import { dialog, Notification } from "electron";
import type { AppUpdater } from "electron-updater";

import type { DesktopUpdateFeed } from "./config";
import { resolveUpdateFeedUrl } from "./update-feed";

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15_000;

/** What the menu shows for updates. */
export type UpdateMenuState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; version: string }
  | { kind: "ready"; version: string };

/**
 * App updates from the product's feed. Downloads happen in the background; the
 * update installs on the next quit, or right away from its notification or the
 * menu. The updater loads after startup, so it never slows launch.
 */
export class AppUpdates {
  private updater: AppUpdater | null = null;
  private loading: Promise<AppUpdater | null> | null = null;
  private lastUrl: string | null = null;
  private state: UpdateMenuState = { kind: "idle" };
  private announced = false;

  constructor(
    private readonly productName: string,
    private readonly feed: DesktopUpdateFeed,
    private readonly currentVersion: string,
    private readonly onChange: () => void,
    /**
     * Called just before restarting into an update. On macOS the restart
     * closes every window before `before-quit`, so a shell that hides its
     * window on close has to know the quit is real.
     */
    private readonly beforeRestart: () => void,
  ) {}

  start(): void {
    setTimeout(() => {
      void this.check(false);
      setInterval(() => void this.check(false), CHECK_EVERY_MS).unref();
    }, FIRST_CHECK_DELAY_MS).unref();
  }

  get menuState(): UpdateMenuState {
    return this.state;
  }

  /** The menu action: restart into a downloaded update, or check now and say what happened. */
  menuAction(): void {
    if (this.state.kind === "ready") {
      this.restart();
      return;
    }
    if (this.state.kind === "idle") void this.check(true);
  }

  private async check(interactive: boolean): Promise<void> {
    if (this.kind() !== "idle") return;
    this.setState({ kind: "checking" });
    try {
      const updater = await this.load();
      const url = await resolveUpdateFeedUrl(this.feed);
      if (!updater || !url) {
        this.setState({ kind: "idle" });
        if (interactive) this.upToDate();
        return;
      }
      if (url !== this.lastUrl) updater.setFeedURL({ provider: "generic", url });
      this.lastUrl = url;
      const result = await updater.checkForUpdates();
      const version = result?.isUpdateAvailable ? result.updateInfo.version : null;
      if (!version) {
        this.setState({ kind: "idle" });
        if (interactive) this.upToDate();
        return;
      }
      // A downloaded update stays ready; otherwise the download is under way.
      if (this.kind() === "checking") this.setState({ kind: "downloading", version });
      if (interactive && this.kind() === "downloading") {
        void dialog.showMessageBox({
          type: "info",
          message: `${this.productName} ${version} is downloading`,
          detail: "You can keep working. It installs when you restart.",
        });
      }
    } catch (error) {
      this.setState({ kind: "idle" });
      if (interactive) {
        void dialog.showMessageBox({
          type: "warning",
          message: "Couldn't check for updates",
          detail: `Check your connection and try again.${error instanceof Error && error.message ? `\n\n${error.message.split("\n")[0]}` : ""}`,
        });
      }
    }
  }

  private upToDate(): void {
    void dialog.showMessageBox({
      type: "info",
      message: `You're up to date`,
      detail: `${this.productName} ${this.currentVersion} is the newest version.`,
    });
  }

  private load(): Promise<AppUpdater | null> {
    this.loading ??= import("electron-updater")
      .then(({ autoUpdater }) => {
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.on("update-downloaded", (info) => {
          this.setState({ kind: "ready", version: info.version });
          this.announce(info.version);
        });
        autoUpdater.on("error", () => {
          // A failed download returns to idle so the next check can retry it.
          if (this.state.kind === "downloading") this.setState({ kind: "idle" });
        });
        this.updater = autoUpdater;
        return autoUpdater;
      })
      .catch(() => null);
    return this.loading;
  }

  private announce(version: string): void {
    if (this.announced || !Notification.isSupported()) return;
    this.announced = true;
    const notification = new Notification({
      title: `${this.productName} ${version} is ready`,
      body: "Restart to update. It also installs the next time you quit.",
    });
    notification.on("click", () => this.restart());
    notification.show();
  }

  private restart(): void {
    if (!this.updater) return;
    this.beforeRestart();
    this.updater.quitAndInstall();
  }

  /** Read through a call: events change the state while a check awaits. */
  private kind(): UpdateMenuState["kind"] {
    return this.state.kind;
  }

  private setState(state: UpdateMenuState): void {
    this.state = state;
    this.onChange();
  }
}
