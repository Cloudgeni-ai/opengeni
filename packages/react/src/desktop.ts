import type { DesktopRfbFactory, DesktopRfbLike } from "@opengeni/sdk";
import { registerDesktopViewer } from "./lib/workbench-peers";

export { DesktopViewer } from "./components/desktop-viewer";
export type { DesktopViewerProps } from "./components/desktop-viewer";
export { useDesktopStream } from "./hooks/use-desktop-stream";
export type { UseDesktopStreamOptions, UseDesktopStreamResult } from "./hooks/use-desktop-stream";
export { registerDesktopViewer } from "./lib/workbench-peers";

async function loadDesktop(): Promise<DesktopRfbFactory> {
  const mod = (await import("@novnc/novnc")) as unknown as {
    default: new (
      target: HTMLElement,
      url: string,
      options: Parameters<DesktopRfbFactory>[2],
    ) => DesktopRfbLike;
  };
  return (target, url, options) => new mod.default(target, url, options);
}

/** Opt in once on a VNC route; relay-frame viewers need no noVNC peer. */
export function enableDesktopViewer(): void {
  registerDesktopViewer(loadDesktop);
}
