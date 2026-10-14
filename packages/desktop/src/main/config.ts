/** How a product configures the desktop kit. Everything product-specific lives here. */
export interface DesktopAppConfig {
  /** The product's name in menus, notifications and the first-run page. */
  productName: string;
  /**
   * The packaged app's identifier (electron-builder's `appId`). Windows
   * attributes notifications to the Start menu shortcut with this ID.
   */
  appId: string;
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
  /**
   * The app icon as a PNG (512 px works well). Linux shows it for the window
   * and in the AppImage's desktop entry; other platforms use the packaged icon.
   */
  appIconPath: string;
  /** Window background before the web app paints, per appearance. */
  background: { light: string; dark: string };
  /** Connect this computer through the server's agent installer. */
  thisComputer: boolean;
  /** Where packaged builds look for app updates, or false for none. */
  updates: DesktopUpdateFeed | false;
}

/** Where the app finds its update files (`latest-mac.yml` and the like). */
export type DesktopUpdateFeed =
  /** A fixed directory URL that always holds the newest update files. */
  | { url: string }
  /**
   * The newest stable release of a public GitHub repository whose tag starts
   * with `tagPrefix`, e.g. `desktop-v1.2.3`. Suits repositories whose
   * releases are immutable, where no fixed feed release can be refreshed.
   */
  | { githubRepository: string; tagPrefix: string };
