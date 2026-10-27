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
  | "menuActions"
  /** The app reports a new version it found, and installs it on request. */
  | "updates"
  /** Record the audio other apps play (a meeting's other participants) as its own track. */
  | "systemAudio"
  /** Notice when a call app starts using the microphone, and offer to record the meeting. */
  | "meetingDetection"
  /** What Opengeni may do on this computer: switches the app enforces, and the microphone. */
  | "computerCapabilities"
  /** A still of the window's page, taken without a prompt (for feedback reports). */
  | "captureWindow";

export type DesktopSystemAudioErrorCode =
  /** This computer, its OS version or this app build can't record other apps' audio. */
  | "unavailable"
  /** The person hasn't allowed recording other apps' audio. */
  | "permission_denied"
  /** Linux: no PulseAudio or PipeWire sound server to record from. */
  | "sound_server_unavailable"
  /** The capture failed to start or stopped unexpectedly. */
  | "capture_failed";

export interface DesktopSystemAudioError {
  code: DesktopSystemAudioErrorCode;
  /** A plain English sentence for people. */
  message: string;
  /** Technical detail for logs. */
  detail?: string;
}

/** Call detection as the web app shows it in settings. */
export interface DesktopMeetingDetectionStatus {
  /** The person's switch: offer to record when a call starts. */
  enabled: boolean;
  /** This computer, its OS version and this app build can tell when a call starts. */
  available: boolean;
  /** Why detection isn't working right now, in a sentence for its row. */
  problem?: string;
}

/**
 * What the person chose on one of the app's meeting notifications: record the
 * call an app just started, or stop recording because the call ended. `app`
 * is the call app's name ("Zoom", "Google Chrome"); `title` suggests a name
 * for the meeting.
 */
export type DesktopMeetingRequest =
  | { kind: "record"; app: string; title: string }
  | { kind: "stop"; app: string };

/**
 * The app's own updates as the web app shows them. `downloading` means a new
 * version was found and is on its way; `ready` means it is downloaded and
 * installs on restart. `restartWhenReady` is set once the person asked to
 * update, so the app restarts by itself when the download ends.
 */
export type DesktopUpdateState =
  | { kind: "none" }
  | {
      kind: "downloading";
      version: string;
      /** 0 to 100, or null before the download reports progress. */
      percent: number | null;
      restartWhenReady: boolean;
    }
  | { kind: "ready"; version: string; restartWhenReady: boolean };

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

/**
 * What the person lets Opengeni do on this computer, kept by the desktop app
 * and enforced there: a switch that is off stops the use, not only its
 * display. Each is on until the person turns it off, so nothing that worked
 * before stops; the system permission each needs is asked for only when the
 * person turns it on or first uses it.
 */
export interface DesktopComputerSettings {
  /**
   * Agents may see and control the screen of this computer (computer use).
   * Off: the app's agent shows no screen and sends no input.
   */
  screenControl: boolean;
  /**
   * The Opengeni Browser extension in Chrome may reach this computer's agent,
   * so agents can work in the person's own Chrome. Off: the agent removes its
   * bridge, and the extension can't reach it.
   */
  browserExtension: boolean;
  /** Dictation and voice chats may use the microphone. Off: the app refuses it. */
  microphone: boolean;
}

/** The system's answer about a permission; `unknown` where the system has no such question. */
export type DesktopSystemPermission = "granted" | "denied" | "notDetermined" | "unknown";

export interface DesktopComputerCapabilities {
  settings: DesktopComputerSettings;
  /** The system's answer about the microphone for this app. */
  microphone: DesktopSystemPermission;
  /**
   * This computer was connected with screen control, so turning
   * `screenControl` on needs nothing more than the system's permissions.
   * False: turning it on connects again with screen control.
   */
  screenControlConnected: boolean;
  /**
   * Switches the app can't enforce here, e.g. when a separately installed agent
   * service serves this computer rather than the app's own agent, or an older
   * agent that doesn't honour the switch.
   */
  unavailable: (keyof DesktopComputerSettings)[];
  /**
   * What went wrong with a switch, in a sentence for its row: a change that
   * couldn't be saved or applied, settings that couldn't be read, or an agent
   * too old to honour it. Absent from older apps.
   */
  problems?: Partial<Record<keyof DesktopComputerSettings, string>>;
}

/** A still of the desktop window's page: PNG bytes, base64-encoded. */
export interface DesktopWindowCapture {
  contentType: "image/png";
  base64: string;
  width: number;
  height: number;
}

/**
 * Other apps' audio, as mono float samples; the app leaves its own sounds out.
 * Part of the desktop bridge, or on its own as `window.opengeniSystemAudio` in
 * any app that hosts Opengeni pages (see {@link getDesktopSystemAudio}).
 */
export interface DesktopSystemAudio {
  /**
   * Start recording. Resolves once audio flows; rejects with a
   * {@link DesktopSystemAudioError}. Starting again ends the page's previous
   * capture.
   */
  start(): Promise<{ captureId: string; sampleRate: number }>;
  stop(captureId: string): Promise<void>;
  /** Samples arrive about ten times a second, silence included. */
  onSamples(listener: (captureId: string, samples: Float32Array) => void): Unsubscribe;
  /** The capture ended: stopped (error null) or failed. */
  onEnded(
    listener: (captureId: string, error: DesktopSystemAudioError | null) => void,
  ): Unsubscribe;
}

/** `window.opengeniDesktop` inside a desktop app. */
export interface DesktopBridge {
  readonly version: number;
  readonly platform: DesktopPlatform;
  readonly capabilities: readonly DesktopCapability[];
  /** The shell's product name, e.g. "Opengeni". */
  readonly productName: string;
  /** The app's own version, e.g. "0.1.29". Absent from older apps. */
  readonly appVersion?: string;
  /**
   * A PNG of the page in the window as it is now, at the screen's pixel
   * density, or null when nothing is shown. With the `captureWindow` capability.
   */
  captureWindow?(): Promise<DesktopWindowCapture | null>;
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
  /** The app's own updates. With the `updates` capability. */
  readonly updates?: {
    state(): Promise<DesktopUpdateState>;
    /**
     * Install the update the app found: restart into it now when it is
     * downloaded, otherwise finish the download and then restart.
     */
    install(): Promise<void>;
    onChange(listener: (state: DesktopUpdateState) => void): Unsubscribe;
  };
  /**
   * Other apps' audio, as mono float samples. With the `systemAudio`
   * capability. The app leaves its own sounds out.
   */
  readonly systemAudio?: DesktopSystemAudio;
  /**
   * Call detection. With the `meetingDetection` capability. While on, the
   * app shows a notification when a call app (Zoom, Teams, Slack, Meet in a
   * browser) starts using the microphone, and another when the call it is
   * recording ends.
   */
  readonly meetingDetection?: {
    status(): Promise<DesktopMeetingDetectionStatus>;
    update(change: { enabled?: boolean }): Promise<DesktopMeetingDetectionStatus>;
    /**
     * Tell the app whether this page is recording a meeting, so it doesn't
     * offer to record another and can offer to stop when the call ends.
     */
    setRecording(recording: boolean): void;
    /**
     * The person chose a notification's action. The window comes to the
     * front first. Only the newest listener receives them.
     */
    onRequest(listener: (request: DesktopMeetingRequest) => void): Unsubscribe;
    /** The switch or its state changed. */
    onChange(listener: () => void): Unsubscribe;
  };
  /** What Opengeni may do on this computer. With the `computerCapabilities` capability. */
  readonly computerCapabilities?: {
    status(): Promise<DesktopComputerCapabilities>;
    /** Turn switches on or off; the app applies them at once (restarting its agent if needed). */
    update(change: Partial<DesktopComputerSettings>): Promise<DesktopComputerCapabilities>;
    /**
     * Ask for the microphone: the system's question while it hasn't been
     * answered, otherwise the system's settings page for it.
     */
    requestMicrophone(): Promise<DesktopComputerCapabilities>;
    /** Switches or the system's answers changed. */
    onChange(listener: () => void): Unsubscribe;
  };
}

/**
 * The global an app's preload defines when it records other apps' audio for
 * the Opengeni pages it shows, without being an Opengeni desktop shell: an
 * Electron app that embeds Opengeni's meetings. `@opengeni/desktop` has the
 * main-process side and the preload helper that defines it.
 */
export const DESKTOP_SYSTEM_AUDIO_GLOBAL = "opengeniSystemAudio";

/** Other apps' audio from the app this page runs in, or null outside one that can record it. */
export function getDesktopSystemAudio(
  bridge: DesktopBridge | null = getDesktopBridge(),
): DesktopSystemAudio | null {
  if (bridge?.capabilities.includes("systemAudio") && bridge.systemAudio) return bridge.systemAudio;
  const candidate = (globalThis as Record<string, unknown>)[DESKTOP_SYSTEM_AUDIO_GLOBAL];
  if (!candidate || typeof candidate !== "object") return null;
  const audio = candidate as Partial<DesktopSystemAudio>;
  return typeof audio.start === "function" &&
    typeof audio.stop === "function" &&
    typeof audio.onSamples === "function" &&
    typeof audio.onEnded === "function"
    ? (audio as DesktopSystemAudio)
    : null;
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
  captureWindow: "og:capture-window",
  command: "og:command",
  menuActionsSet: "og:menu-actions:set",
  menuAction: "og:menu-action",
  appearanceSet: "og:appearance:set",
  appShotsStatus: "og:app-shots:status",
  appShotsUpdate: "og:app-shots:update",
  appShotsRequestPermission: "og:app-shots:request-permission",
  appShotsCaptured: "og:app-shots:captured",
  appShotsChanged: "og:app-shots:changed",
  updatesState: "og:updates:state",
  updatesInstall: "og:updates:install",
  updatesChanged: "og:updates:changed",
  systemAudioStart: "og:system-audio:start",
  systemAudioStop: "og:system-audio:stop",
  systemAudioSamples: "og:system-audio:samples",
  systemAudioEnded: "og:system-audio:ended",
  meetingDetectionStatus: "og:meeting-detection:status",
  meetingDetectionUpdate: "og:meeting-detection:update",
  meetingDetectionRecording: "og:meeting-detection:recording",
  meetingDetectionRequest: "og:meeting-detection:request",
  meetingDetectionChanged: "og:meeting-detection:changed",
  capabilitiesStatus: "og:capabilities:status",
  capabilitiesUpdate: "og:capabilities:update",
  capabilitiesRequestMicrophone: "og:capabilities:request-microphone",
  capabilitiesChanged: "og:capabilities:changed",
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
  /** The page offers "Use another server"; an app made for one server doesn't. */
  otherServers?: boolean;
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
