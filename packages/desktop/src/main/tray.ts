import { Menu, nativeImage, Tray } from "electron";

import type { ThisComputerPermissionId } from "../contract";
import type { DesktopAppConfig } from "./config";

export interface TrayActions {
  open(): void;
  pause(): void;
  resume(): void;
  allow(permission: ThisComputerPermissionId): void;
  quit(): void;
}

export interface TraySummary {
  installed: boolean;
  connected: boolean;
  running: boolean;
  /** Screen-control permissions still to allow, in order. */
  missingPermissions?: readonly ThisComputerPermissionId[];
}

const PERMISSION_LABELS: Record<ThisComputerPermissionId, string> = {
  screenRecording: "Allow Screen Recording…",
  accessibility: "Allow Accessibility…",
  inputMonitoring: "Allow Input Monitoring…",
};

/**
 * The menu bar (macOS) or tray item: whether this computer is available to
 * agents, a pause control, any permission still to allow, and a way back to
 * the window.
 */
export class AppTray {
  private readonly tray: Tray;

  constructor(
    private readonly config: DesktopAppConfig,
    private readonly actions: TrayActions,
  ) {
    const image = nativeImage.createFromPath(config.trayIconPath);
    if (process.platform === "darwin") image.setTemplateImage(true);
    this.tray = new Tray(image);
    this.tray.setToolTip(config.productName);
    if (process.platform !== "darwin") this.tray.on("click", () => actions.open());
  }

  update(summary: TraySummary): void {
    const missing = summary.running ? (summary.missingPermissions ?? []) : [];
    this.tray.setToolTip(
      !summary.connected
        ? this.config.productName
        : `${this.config.productName}: ${summary.running ? "this computer is available to agents" : "this computer is paused"}`,
    );
    const computer = !summary.connected
      ? []
      : [
          {
            label: statusText(summary.running, missing.length > 0),
            enabled: false,
          },
          ...missing.map((permission) => ({
            label: PERMISSION_LABELS[permission],
            click: () => this.actions.allow(permission),
          })),
          summary.running
            ? { label: "Pause This Computer", click: () => this.actions.pause() }
            : { label: "Resume This Computer", click: () => this.actions.resume() },
          { type: "separator" as const },
        ];
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        ...computer,
        { label: `Open ${this.config.productName}`, click: () => this.actions.open() },
        { type: "separator" },
        { label: `Quit ${this.config.productName}`, click: () => this.actions.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray.destroy();
  }
}

function statusText(running: boolean, needsPermissions: boolean): string {
  if (!running) return "This computer: paused";
  return needsPermissions
    ? "This computer: screen control needs permission"
    : "This computer: available to agents";
}
