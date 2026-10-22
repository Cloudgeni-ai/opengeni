// The contract between an Opengeni desktop shell and the web app it shows. Pure types and
// constants: the web app imports this without Electron, and the preload script
// implements it. The shell and the server update independently, so the web app
// reads `version` and `capabilities` and degrades when something is missing.
import type {
  ThisComputerConnectOptions,
  ThisComputerPermissionId,
  ThisComputerStatus,
} from "./this-computer";

/** Bumped only for incompatible changes; additions are new capabilities. */
export const DESKTOP_BRIDGE_VERSION = 1;

/** The global the preload script defines in the web app's main frame. */
export const DESKTOP_BRIDGE_GLOBAL = "opengeniDesktop";

export type DesktopPlatform = "macos" | "windows" | "linux";

export type DesktopCapability =
  /** Several accounts; list, switch, add and sign out. */
  | "accounts"
  /** Connect this computer to a workspace, pause and resume it. */
  | "thisComputer"
  /** Report and ask for the system permissions screen control needs. */
  | "thisComputerPermissions"
  /** Disconnect this computer from a workspace. */
  | "thisComputerDisconnect"
  /** Open a URL in the default browser. */
  | "openExternal"
  /** Menu bar and keyboard commands for the web app to carry out. */
  | "commands"
  /** A shortcut sends the window the person is looking at into the composer. */
  | "appShots"
  /** The web app lists its actions and keys; the shell builds the menu bar from them. */
  | "menuActions";

/** Which menu bar section shows an action. */
export type DesktopMenuSection = "file" | "view" | "go" | "chat" | "help";

/** One web app action as the desktop menu bar shows it. */
export interface DesktopMenuAction {
  /** Sent back through `menuActions.onAction` when the item or its key is used. */
  id: string;
  label: string;
  section: DesktopMenuSection;
  /**
   * The key the item shows and owns, in Electron accelerator syntax
   * ("CmdOrCtrl+Shift+O"). Other keys for the same action stay with the page.
   */
  accelerator: string | null;
  enabled: boolean;
}

/**
 * What the app's menus and shortcuts ask the web app to do. A page that does
 * not listen still gets the navigation ones (the bridge falls back to loading
 * the workspace's page), so older servers keep working.
 */
export type DesktopCommand = "newSession" | "searchSessions" | "toggleSidebar" | "openInbox";

/** One signed-in account as the web app sees it. Never carries a credential. */
export interface DesktopAccount {
  id: string;
  /** The server's web origin, e.g. https://app.opengeni.ai. */
  baseUrl: string;
  /** The host a person recognizes, e.g. app.opengeni.ai. */
  serverLabel: string;
  email: string;
  /** The workspace last used with this account. */
  workspaceId: string | null;
  /** The server rejected the credential; the person has to sign in again. */
  signedOut: boolean;
}

export interface DesktopAccountsSnapshot {
  accounts: DesktopAccount[];
  /** The account the window shows. */
  activeId: string | null;
}

export type {
  ThisComputerConnectOptions,
  ThisComputerErrorCode,
  ThisComputerPermission,
  ThisComputerPermissionId,
  ThisComputerState,
  ThisComputerStatus,
} from "./this-computer";

export type Unsubscribe = () => void;

/** A modifier key pressed on both sides of the keyboard at once. */
export type DesktopAppShotModifier = "command" | "option" | "control" | "shift";

/**
 * What triggers an app-shot: both keys of a modifier pair (both Command keys
 * by default on macOS), or an ordinary key combination in Electron's
 * accelerator syntax, e.g. "CommandOrControl+Shift+2".
 */
export type DesktopAppShotShortcut =
  | { kind: "modifierPair"; modifier: DesktopAppShotModifier }
  | { kind: "accelerator"; accelerator: string };

export interface DesktopAppShotSettings {
  /** Off until the person turns it on. */
  enabled: boolean;
  shortcut: DesktopAppShotShortcut;
}

/** The system permissions an app-shot needs, where the system asks for them. */
export type DesktopAppShotPermissionId = "screenRecording" | "accessibility";

export interface DesktopAppShotStatus {
  settings: DesktopAppShotSettings;
  /** App-shots work on this computer. */
  supported: boolean;
  /** The modifier pairs this computer can watch for. */
  modifierPairs: DesktopAppShotModifier[];
  /** Where the system asks (macOS): whether each permission is allowed. */
  permissions: { id: DesktopAppShotPermissionId; granted: boolean }[];
  /** On, but the shortcut could not be set up (e.g. another app owns it). */
  shortcutError: string | null;
}

/** The page in a captured web browser window. */
export interface DesktopAppShotBrowser {
  /** The page's address (http or https). */
  url: string;
  /** A Chromium-based browser, which can carry the Opengeni browser extension. */
  chromium: boolean;
}

/** A window captured by the shortcut, for the web app to attach. */
export interface DesktopAppShot {
  /** PNG bytes of the window. */
  image: Uint8Array;
  mimeType: "image/png";
  app: string;
  bundleId?: string;
  title: string;
  /** ISO timestamp. */
  capturedAt: string;
  platform: DesktopPlatform;
  /** The window's accessibility text, when it could be read. */
  text?: string;
  /** Not all of the text was kept. */
  textTruncated?: boolean;
  /** The window as the system identifies it. */
  window?: { processId: number; windowId: number };
  /** When the window is a web browser's, the page it shows. */
  browser?: DesktopAppShotBrowser;
}

/** Why a capture produced nothing to attach. */
export type DesktopAppShotErrorCode =
  /** A system permission is missing; `permission` names it. */
  | "permission"
  /** No other app's window was on screen. */
  | "no_window"
  | "failed";

export type DesktopAppShotResult =
  | { ok: true; shot: DesktopAppShot }
  | {
      ok: false;
      code: DesktopAppShotErrorCode;
      permission?: DesktopAppShotPermissionId;
      /** A plain English sentence. */
      message: string;
    };

/** `window.opengeniDesktop` inside a desktop app. */
export interface DesktopBridge {
  readonly version: number;
  readonly platform: DesktopPlatform;
  readonly capabilities: readonly DesktopCapability[];
  /** The shell's product name, e.g. "Opengeni". */
  readonly productName: string;
  readonly accounts: {
    list(): Promise<DesktopAccountsSnapshot>;
    /** Show another account in the window. */
    switchTo(accountId: string): Promise<void>;
    /** Start signing in another account in the browser. */
    add(): Promise<void>;
    signOut(accountId: string): Promise<void>;
    /** Tell the shell which workspace the window shows, so links and notifications follow it. */
    setWorkspace(workspaceId: string): void;
    /**
     * The web app found itself signed out. The shell renews the window's web
     * sign-in from the app's own credential; true when the page should reload.
     */
    restoreWebSession(): Promise<boolean>;
    onChange(listener: (snapshot: DesktopAccountsSnapshot) => void): Unsubscribe;
  };
  readonly thisComputer: {
    status(workspaceId: string): Promise<ThisComputerStatus>;
    connect(workspaceId: string, options: ThisComputerConnectOptions): Promise<ThisComputerStatus>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    /**
     * Ask for one permission: the system prompt the first time, then its list
     * in System Settings. With the `thisComputerPermissions` capability.
     */
    requestPermission?(id: ThisComputerPermissionId): Promise<void>;
    /** Stop agents using this computer in the workspace. With the `thisComputerDisconnect` capability. */
    disconnect?(workspaceId: string): Promise<void>;
    onChange(listener: () => void): Unsubscribe;
  };
  /** Open a page in the default browser. Only http(s) URLs are accepted. */
  openExternal(url: string): Promise<void>;
  readonly commands: {
    /** Carry out menu and shortcut commands; only the newest listener receives them. */
    onCommand(listener: (command: DesktopCommand) => void): Unsubscribe;
  };
  /** The menu bar's web app actions. With the `menuActions` capability. */
  readonly menuActions?: {
    /** Replace the actions the menu bar shows. The shell keeps its own items (accounts, zoom, quit). */
    set(actions: DesktopMenuAction[]): void;
    /** Carry out an action chosen from the menu or by its key; only the newest listener receives them. */
    onAction(listener: (id: string) => void): Unsubscribe;
  };
  /** Follow the web app's appearance, so window materials and controls match it. */
  setAppearance(appearance: "light" | "dark" | "system"): void;
  /** App-shots. With the `appShots` capability. */
  readonly appShots?: {
    status(): Promise<DesktopAppShotStatus>;
    /** Change the settings; the shortcut follows at once. */
    update(settings: Partial<DesktopAppShotSettings>): Promise<DesktopAppShotStatus>;
    /**
     * Ask for one permission: the system prompt the first time, then its list
     * in System Settings with the app's guide beside it.
     */
    requestPermission(id: DesktopAppShotPermissionId): Promise<void>;
    /**
     * Captures from the shortcut (the window then comes to the front), and
     * their failures. Only the newest listener receives them.
     */
    onCapture(listener: (result: DesktopAppShotResult) => void): Unsubscribe;
    /** Settings, permissions or the shortcut's state changed. */
    onChange(listener: () => void): Unsubscribe;
  };
}

/** The bridge when the page runs inside a desktop app, else null. */
export function getDesktopBridge(): DesktopBridge | null {
  const candidate = (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL];
  if (!candidate || typeof candidate !== "object") return null;
  const bridge = candidate as Partial<DesktopBridge>;
  return bridge.version === DESKTOP_BRIDGE_VERSION ? (bridge as DesktopBridge) : null;
}

export function hasDesktopCapability(
  bridge: DesktopBridge | null,
  capability: DesktopCapability,
): boolean {
  return Boolean(bridge?.capabilities.includes(capability));
}

/** IPC channels between the preload scripts and the main process. */
export const DESKTOP_IPC = {
  accountsList: "og:accounts:list",
  accountsSwitch: "og:accounts:switch",
  accountsAdd: "og:accounts:add",
  accountsSignOut: "og:accounts:sign-out",
  accountsSetWorkspace: "og:accounts:set-workspace",
  accountsRestoreWebSession: "og:accounts:restore-web-session",
  accountsChanged: "og:accounts:changed",
  computerStatus: "og:computer:status",
  computerConnect: "og:computer:connect",
  computerPause: "og:computer:pause",
  computerResume: "og:computer:resume",
  computerRequestPermission: "og:computer:request-permission",
  computerDisconnect: "og:computer:disconnect",
  computerChanged: "og:computer:changed",
  openExternal: "og:open-external",
  command: "og:command",
  menuActionsSet: "og:menu-actions:set",
  menuAction: "og:menu-action",
  appearanceSet: "og:appearance:set",
  appShotsStatus: "og:app-shots:status",
  appShotsUpdate: "og:app-shots:update",
  appShotsRequestPermission: "og:app-shots:request-permission",
  appShotsCaptured: "og:app-shots:captured",
  appShotsChanged: "og:app-shots:changed",
  welcomeState: "og:welcome:state",
  welcomeSignIn: "og:welcome:sign-in",
  welcomeCancel: "og:welcome:cancel",
  welcomeRetry: "og:welcome:retry",
  welcomeChanged: "og:welcome:changed",
} as const;

/** The account the window should show, while its server can't be reached. */
export interface WelcomeUnreachable {
  /** The host a person recognizes, e.g. app.opengeni.ai. */
  server: string;
  /** A try is in progress. */
  retrying: boolean;
}

/** What the first-run page shows while there is no account to show. */
export interface WelcomeState {
  productName: string;
  defaultServerUrl: string;
  /** The server a browser sign-in is waiting on. */
  pendingServer: string | null;
  error: string | null;
  /** An account is signed in, so the page can go back to it. */
  canCancel: boolean;
  /** The page stands in for an account whose server is out of reach; it keeps trying. */
  unreachable: WelcomeUnreachable | null;
}

/** The first-run page's bridge (`window.opengeniDesktopWelcome`). */
export interface DesktopWelcomeBridge {
  state(): Promise<WelcomeState>;
  signIn(serverUrl: string): Promise<void>;
  cancel(): Promise<void>;
  /** Try the unreachable account's server again now. */
  retry(): Promise<void>;
  onChange(listener: (state: WelcomeState) => void): Unsubscribe;
}

export const DESKTOP_WELCOME_GLOBAL = "opengeniDesktopWelcome";
