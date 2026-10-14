import { Menu, nativeImage, Tray } from "electron";

import type { DesktopAppConfig } from "./config";

export interface TrayActions {
  open(): void;
  pause(): void;
  resume(): void;
  quit(): void;
}

export interface TraySummary {
  installed: boolean;
  connected: boolean;
  running: boolean;
}

/**
 * The menu bar (macOS) or tray item: whether this computer is available to
 * agents, a pause control, and a way back to the window.
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
    const computer = !summary.connected
      ? []
      : [
          {
            label: summary.running ? "This computer: available to agents" : "This computer: paused",
            enabled: false,
          },
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
