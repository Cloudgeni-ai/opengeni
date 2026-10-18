// "Use this computer": a desktop app runs the connected-machine agent so the
// person's agents can work on the computer the app runs on. These are the
// shapes the app (host) and the web app's screens share. Pure types and small
// helpers, so a desktop shell, a web app and a native app can all import them.

import type { OpenGeniDocumentAuthorityClient } from "./document-authority-client";
import type { UserResourceAuthoritySummary } from "./types";

export type ThisComputerPlatform = "macos" | "windows" | "linux";

/**
 * Where this computer stands for one workspace.
 *
 * - `unavailable`: the app can't connect computers on this platform.
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

/**
 * A system permission agents need on this computer (macOS asks for these).
 * `files` is opening files in the Desktop, Documents and Downloads folders,
 * which macOS asks about in a message of its own the first time.
 */
export type ThisComputerPermissionId =
  | "screenRecording"
  | "accessibility"
  | "inputMonitoring"
  | "files";

export interface ThisComputerPermission {
  id: ThisComputerPermissionId;
  granted: boolean;
}

/**
 * What the system itself calls the things a person looks for while allowing
 * permissions, in the system's own language (which can differ from the app's).
 * Screens quote these so they match what's on screen.
 */
export interface ThisComputerSystemNames {
  /** Each permission's list in System Settings. */
  permissionList: Record<ThisComputerPermissionId, string>;
  /** On the system's own permission question: the button that opens System Settings. */
  openSettings: string;
  /** On that question: the button that refuses. */
  deny: string;
  /**
   * The system's question about the Desktop folder, with `{app}` where the
   * app's name goes.
   */
  folderQuestion: string;
  /** On the system's question about a folder: the button that allows it. */
  allow: string;
  /** On that question: the button that refuses. */
  dontAllow: string;
  /** On the system's offer to quit the app after a change: the button that quits. */
  quit: string;
  /** On that offer: the button that keeps the app running. */
  later: string;
}

/** What macOS calls things on screen when it's in English. */
export const ENGLISH_MAC_SYSTEM_NAMES: ThisComputerSystemNames = {
  permissionList: {
    screenRecording: "Screen & System Audio Recording",
    accessibility: "Accessibility",
    inputMonitoring: "Input Monitoring",
    files: "Files & Folders",
  },
  openSettings: "Open System Settings",
  deny: "Deny",
  folderQuestion: "“{app}” would like to access files in your Desktop folder.",
  allow: "Allow",
  dontAllow: "Don't Allow",
  quit: "Quit & Reopen",
  later: "Later",
};

/**
 * macOS's own names in the languages an app translates for, keyed by language
 * tag in lower case: a full tag (`"pt-br"`) or just its language (`"pt"`).
 */
export type MacSystemNameCatalog = Readonly<Record<string, ThisComputerSystemNames>>;

/**
 * macOS's own names for the permission lists and buttons, for a Mac whose
 * preferred languages are `systemLanguages` (most preferred first, e.g.
 * Electron's `app.getPreferredSystemLanguages()`). The Mac shows its first
 * language, so that one is looked up in `catalog`: its full tag, then its
 * language alone. English when the catalog doesn't have it.
 */
export function macSystemNames(
  systemLanguages: readonly string[],
  catalog: MacSystemNameCatalog = {},
): ThisComputerSystemNames {
  const tag = (systemLanguages[0] ?? "").toLowerCase().replaceAll("_", "-");
  const language = tag.split("-")[0] ?? "";
  return catalog[tag] ?? catalog[language] ?? ENGLISH_MAC_SYSTEM_NAMES;
}

/**
 * Why the last action failed, so screens can explain it in their own words
 * and language. `error` still carries a plain English sentence.
 */
export type ThisComputerErrorCode =
  /** The agent couldn't be downloaded or its signature didn't check out. */
  | "download_failed"
  /** The server didn't accept this computer (expired setup, no access). */
  | "connect_failed"
  /** The server or the network couldn't be reached. */
  | "offline"
  /** This kind of computer can't be used yet. */
  | "unsupported"
  /** Another agent already serves this computer and couldn't be taken over. */
  | "takeover_failed"
  /** Setting up, pausing or resuming is already in progress. */
  | "busy"
  | "unknown";

export interface ThisComputerStatus {
  state: ThisComputerState;
  /** A connect, pause or resume is in progress. */
  busy: boolean;
  /** The last failure, in plain words, until the next successful action. */
  error: string | null;
  /** What kind of failure `error` is. Absent from older apps. */
  errorCode?: ThisComputerErrorCode;
  /** The computer's name as agents see it. */
  machineName: string;
  /** While the agent downloads during setup, how much has arrived, from 0 to 1. */
  setupProgress?: number;
  /**
   * When connected with screen control on a system that asks for permissions
   * (macOS), each one in the order to ask for it. Absent elsewhere.
   */
  permissions?: ThisComputerPermission[];
  /**
   * The person started setting up and hasn't allowed every permission yet.
   * Screens reopen the steps, e.g. after macOS restarted the app for a grant.
   */
  setupPending?: boolean;
  /**
   * Connected and not paused, but the app's agent isn't running right now and
   * is starting again, so agents can't use this computer until it is back.
   * Absent from older apps.
   */
  reconnecting?: boolean;
  /**
   * Where the system asks for permissions, what it calls the lists and
   * buttons the person looks for, in its own language. Absent elsewhere and
   * from older apps.
   */
  systemNames?: ThisComputerSystemNames;
}

export interface ThisComputerConnectOptions {
  /** Let agents see and control the screen, not only run commands. */
  screenControl: boolean;
}

export type ThisComputerUnsubscribe = () => void;

/**
 * What a desktop app offers its web content for this computer. A web app
 * renders the setup screens against it; outside a desktop app there is none.
 */
export interface ThisComputerHost {
  readonly platform: ThisComputerPlatform;
  /** The app's name as the system shows it, e.g. in System Settings. */
  readonly productName: string;
  status(workspaceId: string): Promise<ThisComputerStatus>;
  connect(workspaceId: string, options: ThisComputerConnectOptions): Promise<ThisComputerStatus>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /**
   * Ask for one permission: the system prompt the first time, then its list
   * in System Settings, with the app's guide beside it when it has one.
   */
  requestPermission?(id: ThisComputerPermissionId): Promise<void>;
  /** Stop letting agents use this computer in this workspace. */
  disconnect?(workspaceId: string): Promise<void>;
  onChange(listener: () => void): ThisComputerUnsubscribe;
}

/** The order macOS permissions are asked for. */
export const THIS_COMPUTER_PERMISSION_ORDER: readonly ThisComputerPermissionId[] = [
  "screenRecording",
  "accessibility",
  "inputMonitoring",
  "files",
];

/** Connected, but screen control still waits on a system permission. */
export function thisComputerNeedsPermissions(status: ThisComputerStatus | null): boolean {
  return (
    status?.state === "connected" &&
    Boolean(status.permissions?.some((permission) => !permission.granted))
  );
}

/**
 * The permission steps a person walks through, in order. On macOS, allowing
 * Accessibility also lets an app notice keyboard and mouse use, so Input
 * Monitoring is a step of its own only when it's still missing after that.
 */
export function thisComputerPermissionSteps(
  status: ThisComputerStatus | null,
): ThisComputerPermission[] {
  const permissions = status?.permissions ?? [];
  const accessibility = permissions.find((permission) => permission.id === "accessibility");
  return permissions.filter(
    (permission) =>
      permission.id !== "inputMonitoring" ||
      (accessibility?.granted === true && !permission.granted),
  );
}

/** The next permission to ask for, or null when none is missing. */
export function nextMissingPermission(
  status: ThisComputerStatus | null,
): ThisComputerPermissionId | null {
  return status?.permissions?.find((permission) => !permission.granted)?.id ?? null;
}

/** Agents can work on this computer now. */
export function thisComputerReady(status: ThisComputerStatus | null): boolean {
  return status?.state === "connected" && !thisComputerNeedsPermissions(status);
}

/** The part of the API client that lets the person's agents use their computer. */
export type ComputerGrantClient = Pick<
  OpenGeniDocumentAuthorityClient,
  "listUserResourceAuthorities" | "issueUserResourceGrant"
>;

/** Chats are private to the person or shared with the workspace. */
const CHAT_CONTEXTS = ["user_private", "workspace_shared"] as const;

/**
 * Connecting this computer is the person's consent for their agents to use
 * it. A personal machine otherwise needs that consent again in every chat,
 * so standing permission is given for the person's private and shared chats
 * in this workspace. The server still admits only turns the owner started,
 * so no one else can use the computer. Permission that already stands is
 * left alone. Call it as the person: from their app, or from a server
 * acting as them.
 */
export async function allowAgentsOnComputer(
  client: ComputerGrantClient,
  workspaceId: string,
  enrollmentId: string,
  now: () => number = Date.now,
): Promise<void> {
  const authority = await findAuthority(client, workspaceId, enrollmentId);
  if (!authority) throw new Error("This computer isn't listed as yours yet. Try again.");
  for (const context of CHAT_CONTEXTS) {
    if (hasStandingGrant(authority, workspaceId, context, now())) continue;
    await client.issueUserResourceGrant(workspaceId, authority.authorityId, {
      scope: "user",
      resourceKind: "connected_machine",
      mode: "always",
      context,
      ...(context === "workspace_shared" ? { workspaceSharedAcknowledged: true } : {}),
    });
  }
}

async function findAuthority(
  client: ComputerGrantClient,
  workspaceId: string,
  enrollmentId: string,
): Promise<UserResourceAuthoritySummary | null> {
  let cursor: string | undefined;
  // Bounded: a person has few machines, and a broken cursor must not loop.
  for (let page = 0; page < 20; page += 1) {
    const listed = await client.listUserResourceAuthorities(workspaceId, {
      resourceKind: "connected_machine",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const found = listed.authorities.find(
      (authority) => authority.resourceId === enrollmentId && authority.status === "active",
    );
    if (found) return found;
    if (!listed.nextCursor) return null;
    cursor = listed.nextCursor;
  }
  return null;
}

function hasStandingGrant(
  authority: UserResourceAuthoritySummary,
  workspaceId: string,
  context: (typeof CHAT_CONTEXTS)[number],
  now: number,
): boolean {
  return authority.grants.some(
    (grant) =>
      grant.status === "active" &&
      grant.mode === "always" &&
      grant.action === "connected_machine.use" &&
      grant.context === context &&
      grant.targetWorkspaceId === workspaceId &&
      grant.targetSessionId === null &&
      (grant.expiresAt === null || Date.parse(grant.expiresAt) > now),
  );
}
