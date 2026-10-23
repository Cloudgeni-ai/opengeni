// What the Mac app's main process and its window share: the IPC channel names
// and the bridge the window's page sees as `window.opengeniSimple`. Pure, so
// the preload, the main process and the web app can all import it.

import type { ThisComputerHost } from "@opengeni/sdk/this-computer";

/** The page's global: `window.opengeniSimple`. */
export const SIMPLE_BRIDGE_GLOBAL = "opengeniSimple";

/** The preload's argument naming the only origin that gets the bridge. */
export const SIMPLE_ORIGIN_ARGUMENT = "opengeni-simple-origin";

export const SIMPLE_IPC = {
  computerStatus: "opengeni-simple:computer:status",
  computerConnect: "opengeni-simple:computer:connect",
  computerPause: "opengeni-simple:computer:pause",
  computerResume: "opengeni-simple:computer:resume",
  computerRequestPermission: "opengeni-simple:computer:request-permission",
  computerDisconnect: "opengeni-simple:computer:disconnect",
  /** Main to page: something about this computer changed; read its status again. */
  computerChanged: "opengeni-simple:computer:changed",
} as const;

/** What the Mac app offers its page, as `window.opengeniSimple`. */
export interface OpengeniSimpleBridge {
  /** The app's name as macOS shows it, e.g. in System Settings. */
  readonly productName: string;
  /** This Mac as a place the person's agents can work. */
  readonly thisComputer: ThisComputerHost;
}
