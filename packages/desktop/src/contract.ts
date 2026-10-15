// The contract between a desktop shell and the web app it shows. Pure types and
// constants: the web app imports this without Electron, and the preload script
// implements it. The shell and the server update independently, so the web app
// reads `version` and `capabilities` and degrades when something is missing.

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
  /** Open a URL in the default browser. */
  | "openExternal"
  /** Menu bar and keyboard commands for the web app to carry out. */
  | "commands";

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

/**
 * Where this computer stands for one workspace.
 *
 * - `unavailable`: the shell can't connect computers on this platform.
 * - `not_installed`: the agent isn't on this computer yet.
 * - `not_connected`: the agent is installed but not linked to this workspace.
 * - `connected`: linked to this workspace and running.
 * - `paused`: linked, but the agent is stopped.
 */
export type ThisComputerState =
  | "unavailable"
  | "not_installed"
  | "not_connected"
  | "connected"
  | "paused";

/** A system permission screen control needs on this computer. */
export type ThisComputerPermissionId = "screenRecording" | "accessibility" | "inputMonitoring";

export interface ThisComputerPermission {
  id: ThisComputerPermissionId;
  granted: boolean;
}

export interface ThisComputerStatus {
  state: ThisComputerState;
  /** A connect, pause or resume is in progress. */
  busy: boolean;
  /** The last failure, in plain words, until the next successful action. */
  error: string | null;
  /** The computer's name as agents see it. */
  machineName: string;
  /** While the agent downloads during setup, how much has arrived, from 0 to 1. */
  setupProgress?: number;
  /**
   * When connected with screen control on a system that asks for permissions
   * (macOS), each one in the order to ask for it. Absent elsewhere.
   */
  permissions?: ThisComputerPermission[];
}

export interface ThisComputerConnectOptions {
  /** Let agents see and control the screen, not only run commands. */
  screenControl: boolean;
}

export type Unsubscribe = () => void;

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
    onChange(listener: () => void): Unsubscribe;
  };
  /** Open a page in the default browser. Only http(s) URLs are accepted. */
  openExternal(url: string): Promise<void>;
  readonly commands: {
    /** Carry out menu and shortcut commands; only the newest listener receives them. */
    onCommand(listener: (command: DesktopCommand) => void): Unsubscribe;
  };
  /** Follow the web app's appearance, so window materials and controls match it. */
  setAppearance(appearance: "light" | "dark" | "system"): void;
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
  computerChanged: "og:computer:changed",
  openExternal: "og:open-external",
  command: "og:command",
  appearanceSet: "og:appearance:set",
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
