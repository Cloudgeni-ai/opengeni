// The window bar's geometry, shared by the window and its tests. No Electron
// imports here.
import { DESKTOP_MAC_TRAFFIC_LIGHT_SIZE } from "@opengeni/sdk/desktop-bridge";

/**
 * The height of the bar across the top of the window that holds the window
 * controls (the web app draws it, in the app's colour). On macOS the traffic
 * lights, and the wider sharing badge macOS swaps in while the window is
 * shared or recorded, are centred on it; on Windows the caption buttons fill
 * it. The page is told the height (the bridge's `windowBarHeight`), so it
 * centres its own bar controls on the same line.
 */
export const WINDOW_BAR_HEIGHT = 44;

/** Where the macOS traffic lights go: centred on the window bar. */
export const MAC_TRAFFIC_LIGHT_POSITION = {
  x: 18,
  y: (WINDOW_BAR_HEIGHT - DESKTOP_MAC_TRAFFIC_LIGHT_SIZE) / 2,
};
