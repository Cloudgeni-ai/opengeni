import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dialog, Notification } from "electron";
import type { AppUpdater } from "electron-updater";

import type { DesktopUpdateState } from "../contract";
import type { DesktopUpdateFeed } from "./config";
import { resolveUpdateFeedUrl } from "./update-feed";

const CHECK_EVERY_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15_000;
const RESTART_GRACE_MS = 20_000;

/**
 * Whether installing an update needs the person's password: Linux deb and rpm
 * installs update through the package manager (electron-builder records the
 * package type next to the app). AppImage, macOS and Windows don't.
 */
export function updateNeedsPassword(
  platform: NodeJS.Platform = process.platform,
  readPackageType: () => string = () =>
    readFileSync(join(process.resourcesPath, "package-type"), "utf8"),
): boolean {
  if (platform !== "linux" || process.env.APPIMAGE) return false;
  try {
    return ["deb", "rpm", "pacman"].includes(readPackageType().trim());
  } catch {
    return false;
  }
}

/** What the menu shows for updates. */
export type UpdateMenuState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; version: string }
  | { kind: "ready"; version: string };

/**
 * App updates from the product's feed. Downloads happen in the background; the
 * update installs on the next quit, or right away from the app's Update button,
 * its notification or the menu. Asking to update while the download is still
 * running restarts as soon as it finishes. The updater loads after startup, so
 * it never slows launch.
 */
export class AppUpdates {
  private updater: AppUpdater | null = null;
  private loading: Promise<AppUpdater | null> | null = null;
  private lastUrl: string | null = null;
  private state: UpdateMenuState = { kind: "idle" };
  private announcedVersion: string | null = null;
  /** Download progress, 0 to 100, while downloading. */
  private percent: number | null = null;
  /** The person asked to update: restart once the download is done. */
  private restartWhenReady = false;
  private readonly needsPassword = updateNeedsPassword();

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

  /** What the web app's Update button shows. */
  get pageState(): DesktopUpdateState {
    const { state } = this;
    if (state.kind === "downloading") {
      return {
        kind: "downloading",
        version: state.version,
        percent: this.percent,
        restartWhenReady: this.restartWhenReady,
      };
    }
    if (state.kind === "ready") {
      return { kind: "ready", version: state.version, restartWhenReady: this.restartWhenReady };
    }
    return { kind: "none" };
  }

  /**
   * The Update button: restart into a downloaded update now, or finish the
   * download first and then restart without asking again.
   */
  install(): void {
    this.restartWhenReady = true;
    if (this.state.kind === "ready") {
      this.onChange();
      this.restart();
      return;
    }
    this.onChange();
    if (this.state.kind === "idle") void this.check(false);
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
    // A check or a download is already under way.
    if (this.kind() === "checking" || this.kind() === "downloading") return;
    // A downloaded update stays ready while the app keeps checking, so an app
    // that is rarely quit still moves on to the newest release.
    if (this.kind() === "idle") this.setState({ kind: "checking" });
    try {
      const updater = await this.load();
      const url = await resolveUpdateFeedUrl(this.feed);
      if (!updater || !url) {
        this.noUpdate(interactive);
        return;
      }
      if (url !== this.lastUrl) updater.setFeedURL({ provider: "generic", url });
      this.lastUrl = url;
      const result = await updater.checkForUpdates();
      const version = result?.isUpdateAvailable ? result.updateInfo.version : null;
      if (!version) {
        this.noUpdate(interactive);
        return;
      }
      // A downloaded update stays ready; otherwise the download is under way.
      if (this.kind() === "checking") {
        this.percent = null;
        this.setState({ kind: "downloading", version });
      }
      if (interactive && this.kind() === "downloading") {
        void dialog.showMessageBox({
          type: "info",
          message: `${this.productName} ${version} is downloading`,
          detail: "You can keep working. It installs when you restart.",
        });
      }
    } catch (error) {
      if (this.kind() !== "ready") this.setState({ kind: "idle" });
      if (interactive) {
        void dialog.showMessageBox({
          type: "warning",
          message: "Couldn't check for updates",
          detail: `Check your connection and try again.${error instanceof Error && error.message ? `\n\n${error.message.split("\n")[0]}` : ""}`,
        });
      }
    }
  }

  private noUpdate(interactive: boolean): void {
    if (this.kind() === "checking") {
      this.restartWhenReady = false;
      this.setState({ kind: "idle" });
    }
    if (interactive) this.upToDate();
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
        // Quitting never asks for a password; those updates wait for Restart.
        autoUpdater.autoInstallOnAppQuit = !this.needsPassword;
        autoUpdater.on("download-progress", (progress: { percent?: number }) => {
          if (this.state.kind !== "downloading" || typeof progress?.percent !== "number") return;
          // Whole steps of five keep the button moving without flooding the pages.
          const percent = Math.min(100, Math.max(0, Math.floor(progress.percent / 5) * 5));
          if (percent === this.percent) return;
          this.percent = percent;
          this.onChange();
        });
        autoUpdater.on("update-downloaded", (info) => {
          this.percent = null;
          this.setState({ kind: "ready", version: info.version });
          if (this.restartWhenReady) {
            this.restart();
            return;
          }
          this.announce(info.version);
        });
        autoUpdater.on("error", () => {
          // A failed download returns to idle so the next check can retry it.
          if (this.state.kind !== "downloading") return;
          const asked = this.restartWhenReady;
          this.restartWhenReady = false;
          this.percent = null;
          this.setState({ kind: "idle" });
          if (asked) {
            void dialog.showMessageBox({
              type: "warning",
              message: "Couldn't download the update",
              detail: "Check your connection. The app tries again in a while.",
            });
          }
        });
        this.updater = autoUpdater;
        return autoUpdater;
      })
      .catch(() => null);
    return this.loading;
  }

  private announce(version: string): void {
    if (this.announcedVersion === version || !Notification.isSupported()) return;
    this.announcedVersion = version;
    const notification = new Notification({
      title: `${this.productName} ${version} is ready`,
      body: this.needsPassword
        ? "Restart to install it. You'll be asked for your password."
        : "Restart to update. It also installs the next time you quit.",
    });
    notification.on("click", () => this.restart());
    notification.show();
  }

  private restart(): void {
    if (!this.updater) return;
    this.beforeRestart();
    this.updater.quitAndInstall();
    // Still running a while later: the restart didn't happen, so the button
    // offers it again instead of saying "Restarting…" forever.
    setTimeout(() => {
      if (!this.restartWhenReady) return;
      this.restartWhenReady = false;
      this.onChange();
    }, RESTART_GRACE_MS).unref();
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
