import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";

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
  /** On, but its agent is starting again. Absent means no. */
  reconnecting?: boolean;
  /** On, but the server stopped signing it in: it must be connected again. Absent means no. */
  needsReconnect?: boolean;
  /** Screen-control permissions still to allow, in order. */
  missingPermissions?: readonly ThisComputerPermissionId[];
}

const PERMISSION_LABELS: Record<ThisComputerPermissionId, string> = {
  screenRecording: "Allow Screen Recording…",
  accessibility: "Allow Accessibility…",
  inputMonitoring: "Allow Input Monitoring…",
  files: "Allow Desktop, Documents and Downloads…",
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
    const { toolTip, template } = trayMenu(summary, this.config.productName, this.actions);
    this.tray.setToolTip(toolTip);
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy(): void {
    this.tray.destroy();
  }
}

/** The tray's tooltip and menu for a summary of this computer. */
export function trayMenu(
  summary: TraySummary,
  productName: string,
  actions: TrayActions,
): { toolTip: string; template: MenuItemConstructorOptions[] } {
  const missing = summary.running ? (summary.missingPermissions ?? []) : [];
  const status = !summary.running
    ? "paused"
    : summary.needsReconnect
      ? "needs reconnecting"
      : missing.length > 0
        ? "screen control needs permission"
        : summary.reconnecting
          ? "connecting…"
          : "available to agents";
  const toolTip = !summary.connected
    ? productName
    : `${productName}: ${
        !summary.running
          ? "this computer is paused"
          : summary.needsReconnect
            ? "this computer needs reconnecting"
            : summary.reconnecting
              ? "connecting this computer…"
              : "this computer is available to agents"
      }`;
  const computer: MenuItemConstructorOptions[] = !summary.connected
    ? []
    : [
        { label: `This computer: ${status}`, enabled: false },
        // Reconnecting needs the account and workspace, which the window has.
        ...(summary.running && summary.needsReconnect
          ? [{ label: "Reconnect This Computer…", click: () => actions.open() }]
          : missing.map((permission) => ({
              label: PERMISSION_LABELS[permission],
              click: () => actions.allow(permission),
            }))),
        summary.running
          ? { label: "Pause This Computer", click: () => actions.pause() }
          : { label: "Resume This Computer", click: () => actions.resume() },
        { type: "separator" },
      ];
  return {
    toolTip,
    template: [
      ...computer,
      { label: `Open ${productName}`, click: () => actions.open() },
      { type: "separator" },
      { label: `Quit ${productName}`, click: () => actions.quit() },
    ],
  };
}
