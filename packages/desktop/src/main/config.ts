/** How a product configures the desktop kit. Everything product-specific lives here. */
export interface DesktopAppConfig {
  /** The product's name in menus, notifications and the first-run page. */
  productName: string;
  /** The custom URL scheme the app registers, e.g. "opengeni". */
  scheme: string;
  /** The server the first-run page suggests, e.g. https://app.opengeni.ai. */
  defaultServerUrl: string;
  /** Absolute paths to the bundled preload scripts and the first-run page. */
  preloadPath: string;
  welcomePreloadPath: string;
  welcomePagePath: string;
  /**
   * The menu bar or tray icon: a template image on macOS (black with alpha,
   * `name@2x.png` next to it), a colored icon elsewhere.
   */
  trayIconPath: string;
  /** Window background before the web app paints, per appearance. */
  background: { light: string; dark: string };
  /** Connect this computer through the server's agent installer. */
  thisComputer: boolean;
  /** Check for and install app updates (packaged builds only). */
  updates: boolean;
}
