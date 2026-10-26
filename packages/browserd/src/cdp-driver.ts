import { AsyncLocalStorage } from "node:async_hooks";
import {
  navigateBrowserMetadataDocument,
  navigateToInterceptedMetadataDocument,
} from "./browser-metadata";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve as resolvePath } from "node:path";
import {
  BROWSER_ACTION_NAVIGATION_SETTLE_MS,
  BROWSER_ACTION_REQUEST_SETTLE_MS,
  BROWSER_ANIMATION_SETTLE_MS,
  BROWSER_DEFAULT_WAIT_MS,
  BROWSER_LOCATOR_WAIT_MS,
  BROWSER_NAVIGATION_COMMIT_TIMEOUT_MS,
  BrowserActionCommand,
  BrowserClipboard,
  BrowserDiagnosticBatch,
  BrowserDiagnosticEntry,
  BrowserDialog,
  InteractionSecretValueError,
  materializeBrowserActionSecrets,
  redactInteractionSecretValues,
  BrowserDomReadResponse,
  BrowserTargetState,
  BrowserExternalAuthCommand,
  BrowserExternalAuthResult,
  BrowserObservation,
  BrowserTarget,
  INTERACTION_MAX_DIAGNOSTIC_ENTRIES,
  INTERACTION_MAX_CLIPBOARD_BYTES,
  INTERACTION_PROTOCOL_VERSION,
  type BrowserAction,
  type BrowserActionCommand as BrowserActionCommandValue,
  type BrowserClipboard as BrowserClipboardValue,
  type BrowserDiagnosticBatch as BrowserDiagnosticBatchValue,
  type BrowserDiagnosticKind,
  type BrowserExternalAuthCommand as BrowserExternalAuthCommandValue,
  type BrowserExternalAuthResult as BrowserExternalAuthResultValue,
  type BrowserLocator,
  type BrowserDomReadRequest as BrowserDomReadRequestValue,
  type BrowserDomReadResponse as BrowserDomReadResponseValue,
  type BrowserTargetState as BrowserTargetStateValue,
  type BrowserObservation as BrowserObservationValue,
  type BrowserTarget as BrowserTargetValue,
  type BrowserActionNote as BrowserActionNoteValue,
  type BrowserActionResolvedTarget as BrowserActionResolvedTargetValue,
  type InteractionSemanticNodeValue,
  INTERACTION_MAX_RESOLVED_TARGET_TEXT,
  redactInteractionDriverMessage,
} from "@opengeni/contracts";
import {
  InteractionControllerError,
  InteractionDefiniteDriverError,
  InteractionOutcomeUnknownDriverError,
  type BrowserInteractionDriver,
  type InteractionDispatchTrace,
} from "@opengeni/interaction";
import {
  NETWORK_BODY_STALL_MS,
  NETWORK_LONG_POLL_MS,
  requestIgnoredForIdle,
  requestLoad,
  type TrackedRequest,
} from "./network-idle";
import {
  accessibilityContainer,
  namespaceCdpAccessibilityFrame,
  normalizeCdpAccessibilityTree,
  type CdpAccessibilityEntry,
  type CdpAccessibilitySnapshot,
  type CdpAxNode,
} from "./cdp-accessibility";
import {
  CdpCommandTimeoutError,
  CdpConnection,
  CdpProtocolError,
  CdpSessionDetachedError,
  CdpTransportError,
  type CdpEvent,
} from "./cdp";
import {
  LatestBrowserFrameSubscription,
  assertImageDimensions,
  decodeBoundedBase64Image,
  imageDimensions,
  normalizeFrameStreamOptions,
  normalizeScreenshotOptions,
  type BrowserFrameStreamOptions,
  type BrowserFrameSubscription,
  type BrowserImageFrame,
  type BrowserScreenshotOptions,
  type NormalizedBrowserFrameStreamOptions,
} from "./media";
import type {
  BrowserDownloadBeginEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadProgressResult,
} from "./downloads";
import type { AgentBrowserJsonCommand, OwnedManagedBrowserProcess } from "./runner";
import type { BrowserPasskeyManager } from "./passkeys";
import { TypedSecretMemory } from "./typed-secrets";
import { reportUnexpectedDispatchError } from "./controller-diagnostics";
import {
  completeClientHints,
  hasEmptiedHighEntropyHints,
  hostClientHints,
  type ClientHintsMetadata,
} from "./client-hints";
import {
  captureHeadlessSessionCookies,
  restoreHeadlessSessionCookies,
  validateHeadlessSessionCookies,
  type HeadlessSessionCookies,
} from "./headless-session-cookies";
import { BrowserWindowParking } from "./window-parking";
import { MAX_CLOSED_BLANK_TABS, type OwnedTabsState } from "./attached-tab-ledger";
import type { BrowserRelaunchedTabs, BrowserRelaunchReason } from "./stopped-browser-tabs";

/** The request deadline that carries an action is derived from this bound and
 * the other declared waits (see browserActionDeadlineMs). */
const DEFAULT_ACTION_TIMEOUT_MS = BROWSER_DEFAULT_WAIT_MS;
// Attached Chrome without file access receives upload bytes over its
// one-megabyte command channel: 384 KiB per chunk is 512 KiB of base64.
const ATTACHED_TRANSFER_CHUNK_BYTES = 384 * 1024;
const ATTACHED_TRANSFER_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;
const TRANSFER_UPLOAD_FILES_FUNCTION = `function (parts, files) {
  if (!(this instanceof HTMLInputElement) || this.type !== 'file' || this.disabled) {
    return 'not_file_input';
  }
  const transfer = new DataTransfer();
  files.forEach((file, index) => {
    const chunks = (parts[index] || []).map((data) => {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    });
    transfer.items.add(new File(chunks, file.name, { type: file.type, lastModified: file.lastModified }));
  });
  this.files = transfer.files;
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return this.files.length;
}`;
// Chrome derives an uploaded file's type from its extension; mirror the
// common ones so pages that check File.type accept the transferred file.
const UPLOAD_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

function uploadMediaType(path: string): string {
  return UPLOAD_MEDIA_TYPES[extname(path).toLowerCase()] ?? "";
}

function formatMegabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}
const BROWSER_START_TIMEOUT_MS = 30_000;
const TARGET_CREATION_SETTLE_TIMEOUT_MS = 5_000;
const TARGET_CLOSE_SETTLE_TIMEOUT_MS = 2_000;
// A screenshot stream is the compatibility floor for every Chromium build.
// Keep it interactive even when Page.startScreencast is unavailable or a
// background target never produces screencast events.
const FRAME_FALLBACK_INTERVAL_MS = 100;
/** Recordings: at most about ten frames a second, at the live view's size. */
const RECORDING_FRAME_ACK_DELAY_MS = 100;
const RECORDING_FRAME_QUALITY = 70;
const RECORDING_FRAME_MAX_WIDTH = 1_280;
const RECORDING_FRAME_MAX_HEIGHT = 800;
const FRAME_CAPTURE_TIMEOUT_MS = 2_000;
// Still captures share the target/input queue. Bound the whole read phase so
// a renderer that stops producing pixels cannot hold it for successive CDP deadlines.
const SCREENSHOT_CAPTURE_TIMEOUT_MS = 10_000;
/** A person's own Chrome cannot take the managed launch switch that copies a
 * fresh surface, so a capture of a tab another tab covers in its window waits
 * for a redraw Chrome never shows. Viewport captures there give up after this
 * long with a plain reason instead of the whole capture deadline. */
const CONNECTED_CHROME_CAPTURE_STALL_MS = 3_000;
const CONNECTED_CHROME_CAPTURE_STALLED =
  "browser screenshot stalled: Chrome did not draw this tab within 3 s, which happens while another tab is in front of it in its window; select it with browser_tabs to capture it, or read it with browser_observe";
/** Longest a viewport capture waits for the compositor to present a just
 * changed emulated viewport before publishing what it has. */
const STALE_SURFACE_SETTLE_MS = 1_500;
const FRAME_CAPTURE_FAILURE_LIMIT = 3;
const MAX_FRAME_PROFILES_PER_TARGET = 4;
const MAX_FRAME_SUBSCRIPTIONS_PER_TARGET = 32;
const GRACEFUL_BROWSER_CLOSE_TIMEOUT_MS = 30_000;
/** How long the controller's own close request may take to be acknowledged. */
const BROWSER_CLOSE_REQUEST_TIMEOUT_MS = 5_000;
const NETWORK_IDLE_MS = 500;
/** How long an action's locator waits for its element to appear or enable. */
const LOCATOR_WAIT_MS = BROWSER_LOCATOR_WAIT_MS;
/** Response types that stay open for the life of the page by design. */
const STREAMING_MIME_TYPES = new Set(["text/event-stream", "multipart/x-mixed-replace"]);
/** How long a navigation may wait for its server to answer before the tab
 * stops loading. Chromium itself waits for the operating system's connect
 * timeout, which outlives every caller's deadline. */
const NAVIGATION_COMMIT_TIMEOUT_MS = BROWSER_NAVIGATION_COMMIT_TIMEOUT_MS;
/** The least time a navigation's commit may take after Chromium answered it,
 * even when the server used up most of NAVIGATION_COMMIT_TIMEOUT_MS. */
const NAVIGATION_COMMIT_GRACE_MS = 2_000;
const NAVIGATION_COMMIT_POLL_MS = 25;
/** Chromium's load error for an HTTP error status whose response had no body. */
const HTTP_ERROR_STATUS_LOAD_ERROR = "net::ERR_HTTP_RESPONSE_CODE_FAILURE";
/** Recent main-frame loaders remembered per tab, to recognize a navigation's
 * commit even after a later document (a client redirect) replaced it. */
const COMMITTED_LOADER_HISTORY = 16;
/** Captures of a tab that keeps committing new documents before giving up. */
const SCREENSHOT_DOCUMENT_ATTEMPTS = 3;
const MAX_FRAME_TREES = 512;
const ACCESSIBILITY_FRAME_CONCURRENCY = 16;
const ACCESSIBILITY_SNAPSHOT_ATTEMPTS = 3;
/** Pages whose last accessibility read had at most this many nodes count as
 * cheap to rebuild (about 25 ms for a rebuilt read of 1,000 nodes). */
export const ACCESSIBILITY_CHEAP_REBUILD_NODES = 1_000;
/** How often a polling read on a cheap page rebuilds the tree. */
export const ACCESSIBILITY_REBUILD_INTERVAL_MS = 1_000;

/** Why the driver reads a tab's accessibility tree: for an outline the model
 * sees, for a locator or wait ("read", which may be a poll), right after a
 * locator or wait first missed in an action ("miss"), or for the last look
 * before reporting that a locator found nothing. */
export type AccessibilityRead = "outline" | "read" | "miss" | "final";

/**
 * Whether to rebuild Chromium's accessibility tree before a read (see
 * rebuildAccessibility for the staleness it repairs). A rebuild makes Chromium
 * build the whole tree again; on large pages (mail, consoles, long documents)
 * that costs hundreds of milliseconds and renderer CPU per action, which every
 * user would pay for a rare pattern. So only the look before a failure always
 * rebuilds: a locator never reports
 * "not found", and a wait never times out, from a stale tree. Routine reads
 * rebuild only on cheap pages: every outline, the first read of each call or
 * batch action, and polls about once a second. A tab not read yet rebuilds
 * once. Larger pages also rebuild once when an action's locator or wait first
 * misses, so a stale tree costs one rebuild there rather than the whole wait.
 * The cost is judged by the node count of the tab's last read rather
 * than by timing a rebuild: a count does not swing with host load, and every
 * read refreshes it, so a page that grows or shrinks is re-judged at once.
 */
export function accessibilityRebuildWanted(input: {
  read: AccessibilityRead;
  lastNodeCount: number | null;
  firstReadOfCall: boolean;
  msSinceRebuild: number;
}): boolean {
  if (input.read === "final" || input.lastNodeCount === null) return true;
  if (input.lastNodeCount > ACCESSIBILITY_CHEAP_REBUILD_NODES) return input.read === "miss";
  return (
    input.read === "outline" ||
    input.firstReadOfCall ||
    input.msSinceRebuild >= ACCESSIBILITY_REBUILD_INTERVAL_MS
  );
}
type BrowserPermissionAction = Extract<BrowserAction, { type: "permission" }>;
const CDP_PERMISSION_NAMES: Record<BrowserPermissionAction["permission"], string> = {
  geolocation: "geolocation",
  notifications: "notifications",
  camera: "videoCapture",
  microphone: "audioCapture",
  midi: "midi",
  midi_sysex: "midiSysex",
  sensors: "sensors",
  idle_detection: "idleDetection",
  local_fonts: "localFonts",
  window_management: "windowManagement",
};
const USER_AGENT_METADATA_EXPRESSION = `(async () => {
  const data = navigator.userAgentData;
  if (!data || typeof data.getHighEntropyValues !== "function") return null;
  const high = await data.getHighEntropyValues([
    "architecture", "bitness", "formFactors", "fullVersionList", "model",
    "platformVersion", "wow64"
  ]);
  return {
    brands: data.brands,
    mobile: data.mobile,
    platform: data.platform,
    ...high,
  };
})()`;

class DialogOpenedSignal extends Error {}

/** Whether an error is about the browser's transport rather than the page:
 * the browser or the connection to it or to the tab is gone, or a command
 * deadline passed (which the unresponsive-tab path reports). */
function browserTransportFailure(error: unknown): boolean {
  return error instanceof CdpTransportError || error instanceof CdpSessionDetachedError;
}

/**
 * The failure of one action of a dispatch. An error no step classified (a
 * protocol error the page caused, say) on a live browser becomes a definite
 * driver_failed, which the batch then reports as failed or, once input was
 * sent, as an unknown outcome. Typed errors, dialogs and transport failures
 * pass through unchanged.
 */
function classifyActionFailure(error: unknown, command: BrowserActionCommandValue): unknown {
  if (
    error instanceof InteractionControllerError ||
    error instanceof InteractionDefiniteDriverError ||
    error instanceof InteractionOutcomeUnknownDriverError ||
    error instanceof DialogOpenedSignal ||
    browserTransportFailure(error)
  )
    return error;
  reportUnexpectedDispatchError("browser", error, command);
  return new InteractionDefiniteDriverError(
    "driver_failed",
    `the browser could not perform this action (${
      error instanceof Error ? redactInteractionDriverMessage(error.message) : "unknown error"
    })`,
  );
}

/** The definite refusal for an element Chromium would not scroll into view,
 * by its reply: one removed from the page is stale, and one the page does not
 * render (hidden, or drawn by the browser rather than the page) has no box to
 * scroll to or point at. Null for any other reply. */
export function scrollRefusal(message: string): InteractionDefiniteDriverError | null {
  if (/no node with given id|node is detached/iu.test(message))
    return new InteractionDefiniteDriverError(
      "locator_not_found",
      "browser element is no longer present",
    );
  if (/does not have a layout object/iu.test(message))
    return new InteractionDefiniteDriverError(
      "invalid_action",
      "browser element has no box on the page to act on; it is hidden or not rendered",
    );
  return null;
}

/** Page reads cannot complete while a JavaScript dialog is open: the page's
 * renderer is blocked until the dialog is answered. */
class DialogBlockedError extends InteractionControllerError {
  constructor(readonly dialog: BrowserDialog | null) {
    super("invalid_action", `${dialogSummary(dialog)} ${DIALOG_GUIDANCE}`, false);
    this.name = "DialogBlockedError";
  }
}

/** Page work a dialog cut short. Once abandoned, nothing it still runs may
 * reach the browser: the caller was already told it did not happen. */
type DialogWorkScope = { abandoned: boolean };
const dialogWork = new AsyncLocalStorage<DialogWorkScope>();

function dialogScopedConnection(
  connection: BrowserCdpConnection,
  scope: DialogWorkScope,
): BrowserCdpConnection {
  return new Proxy(connection, {
    get(target, property) {
      if (property === "send") {
        return async (...args: Parameters<BrowserCdpConnection["send"]>) => {
          if (scope.abandoned) throw new DialogBlockedError(null);
          return await target.send(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** How long work that noticed a dialog itself gets to report it. */
const DIALOG_WORK_SETTLE_MS = 250;

const DIALOG_GUIDANCE =
  'Accept or dismiss it with browser_act action {type:"handle_dialog"} before anything else in this tab.';

/** Dialog text is page content: it can echo a secret the action typed, so
 * it is redacted before it is shortened. */
function dialogSummary(
  dialog: BrowserDialog | null,
  secretValues?: BrowserActionCommandValue["secretValues"],
): string {
  if (!dialog) return "A JavaScript dialog is open in this tab.";
  const message = redactInteractionSecretValues(dialog.message, secretValues)
    .replace(/\s+/gu, " ")
    .trim();
  const shown = message.length > 300 ? `${message.slice(0, 300)}…` : message;
  return `A JavaScript ${dialog.type} dialog is open in this tab${shown ? `: "${shown}"` : ""}.`;
}

export type BrowserCommandRunner = {
  run: AgentBrowserJsonCommand;
  terminate?: () => Promise<void>;
  ownedProcessIdentity?: (
    cdpEndpoint: string,
    cdpBrowserPid?: number,
  ) => Promise<OwnedManagedBrowserProcess | null>;
  readonly reattachedOwnedProcess?: OwnedManagedBrowserProcess | null;
  /** A plain line for the agent about how this browser was launched. */
  readonly networkNotice?: string | null;
  /** Credentials for the launch's proxy. They never reach the browser's
   * argv or environment; the driver answers the proxy's challenges. */
  readonly proxyCredentials?: { username: string; password: string } | null;
  externalAuth?: (
    command: BrowserExternalAuthCommand,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<BrowserExternalAuthDispatchResult>;
};

export type BrowserExternalAuthDispatchResult = {
  result: BrowserExternalAuthResultValue;
  /** The provider changed the physical browser behind its stable session. */
  browserReconfigured: boolean;
};

export type BrowserCdpConnection = {
  onDisconnect?: (listener: () => void) => () => void;
  /** Throws a definite error for a page this transport can never control. */
  assertNavigable?: (url: string) => void;
  send<T = Record<string, unknown>>(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T>;
  on(method: string, listener: (event: CdpEvent) => void, sessionId?: string): () => void;
  /**
   * Resolves once events the browser sent before this call have reached
   * listeners. Omitted by transports that deliver events in order with
   * command replies, where a reply already proves it.
   */
  flushEvents?: () => Promise<void>;
  waitForEvent(
    method: string,
    options?: {
      sessionId?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      predicate?: (params: Record<string, unknown>) => boolean;
    },
  ): Promise<CdpEvent>;
  close(): void;
};

type TargetInfo = {
  browserContextId: string | null;
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  openerId: string | null;
};

type MainFrame = {
  id: string;
  loaderId: string;
  url: string;
};

type PageFrameTree = {
  frame: MainFrame;
  childFrames: PageFrameTree[];
};

type Diagnostics = {
  consoleErrorCount: number;
  failedRequestCount: number;
  downloadCount: number;
  pageErrorCount: number;
};

type TargetScreencast = {
  key: string;
  options: NormalizedBrowserFrameStreamOptions;
  sequence: number;
  lastFrameAt: number;
  captureScale: { width: number; height: number; scale: number } | null;
  fallbackAbort: AbortController;
  capturePromise: Promise<void> | null;
  subscriptions: Map<string, LatestBrowserFrameSubscription>;
  unsubscribe: () => void;
};

/** What a target had seen before an action, so settling waits only for the
 * requests and navigation the action itself started. */
type ActionSettleBaseline = {
  open: ReadonlySet<string>;
  activity: number;
  navigation: number;
};

type TargetState = {
  targetId: string;
  sessionId: string;
  authorityGeneration: string;
  actionEffectCount: number;
  createdAt: string;
  frame: MainFrame;
  documentGeneration: string;
  frameGeneration: string;
  /** Main-frame documents (loader ids) this attachment saw commit, oldest
   * first and bounded. A navigation is complete only once its own loader
   * appears here: Chromium answers Page.navigate before the renderer commits. */
  committedLoaders: string[];
  /** Main-frame document requests the browser cancelled (bounded): a
   * navigation whose loader is here will not commit. */
  abandonedLoaders: string[];
  /** Counts main-frame commits, cross- and same-document alike, so a history
   * traversal can wait for the entry it asked for to commit. */
  mainFrameCommits: number;
  /** The document an input action resolved its element in. The action's first
   * input event goes out only while that document is still the current one. */
  inputFence: string | null;
  /** When set, the current action's locator waits end here instead of
   * LOCATOR_WAIT_MS after they start: a re-find keeps the action's deadline. */
  locatorDeadline?: number | null;
  accessibility: CdpAccessibilitySnapshot | null;
  /** When Chromium's accessibility tree for this tab was last rebuilt, how
   * many nodes its last read had, and whether the next read is the first of a
   * call or batch action (see accessibilityRebuildWanted). */
  accessibilityRebuiltAt: number;
  accessibilityNodeCount: number | null;
  accessibilityRebuildDue: boolean;
  dialog: BrowserDialog | null;
  /** Hit-target guards a JavaScript dialog kept from being read back. Page
   * scripts are paused under the dialog, so they are removed once it closes. */
  unsettledHitTargetGuards: HitTargetGuard[];
  diagnostics: Diagnostics;
  diagnosticEntries: BrowserDiagnosticEntry[];
  diagnosticSequence: number;
  /** Chrome's buffered console messages and exceptions already reported for
   * this tab, so each on-demand replay appends only what is new. */
  runtimeDiagnosticKeys: Set<string>;
  inflightRequests: Set<string>;
  networkTrackingOverflow: boolean;
  failedRequests: Set<string>;
  requests: Map<string, TrackedRequest>;
  /** When a request that counts as page loading (see requestLoading) last
   * started or ended. Requests that never count do not move it. */
  lastNetworkActivityAt: number;
  networkActivitySequence: number;
  /** Counts cross-document navigations the page started in its main frame. */
  navigationSequence: number;
  /** A main-frame cross-document navigation has started but not yet committed
   * or stopped. */
  navigationPending: boolean;
  screencasts: Map<string, TargetScreencast>;
  tail: Promise<void>;
  unsubscribe: Array<() => void>;
  /** Set only while dispatching one action of a traced command. */
  actionTrace?: { actionIndex: number; trace: InteractionDispatchTrace } | undefined;
  /** Set only while dispatching a later action of a batch without
   * fenceEachAction: its locator wait may follow the page to a new document.
   * Every other action acts only on the document it was checked against. */
  locatorFollowsNavigation?: boolean;
  /** Cross-origin iframes (out-of-process frames) by frame id. Each has its own
   * flattened CDP session, auto-attached from this page session. */
  oopifs: Map<string, OopifSession>;
  /** Dedicated workers of the page, its cross-origin iframes and other
   * workers, by session id, each with the session it was attached from and
   * the listeners that feed its requests into the ledger. */
  workers: Map<string, { parentSessionId: string; unsubscribe: Array<() => void> }>;
  /** Node-level CDP calls go to this OOPIF session while one operation acts on
   * a node inside it. Input always goes to the page session. */
  nodeRoute: OopifSession | null;
  /** Device size this controller emulates on the page, in CSS pixels. A
   * viewport screenshot of it is exactly this size times its scale factor. */
  emulatedViewport?: { width: number; height: number; deviceScaleFactor: number } | undefined;
};

/** A page size the agent set with the viewport action. */
type ViewportEmulation = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
};

type OopifSession = {
  frameId: string;
  sessionId: string;
  /** Session that owns the frame's `<iframe>` element: the page, or an outer OOPIF. */
  parentSessionId: string;
  /** Frame ids rendered by this session (the OOPIF and its same-process children). */
  frameIds: Set<string>;
  /** Stops this session's network and load listeners when it detaches. */
  unsubscribe: Array<() => void>;
};

export type AgentBrowserDriverOptions = {
  browserSessionId: string;
  controllerGeneration: string;
  runner: BrowserCommandRunner;
  now?: () => Date;
  createId?: () => string;
  resolveWorkspaceFiles?: (
    operationId: string,
    workspaceFileIds: readonly string[],
  ) => Promise<readonly string[]>;
  downloadDirectory?: string;
  downloadEvents?: {
    begin(event: BrowserDownloadBeginEvent): Promise<unknown>;
    progress(event: BrowserDownloadProgressEvent): Promise<BrowserDownloadProgressResult>;
    reject(
      guid: string,
      failureCode: string,
      cancellation: "confirmed" | "uncertain",
    ): Promise<void>;
  };
  /** Downloads are saved by the person's own browser (attached Chrome) in
   * their own downloads folder: completed events carry that file's path, the
   * store copies it, and the person's download is never cancelled. */
  downloadsSavedByPerson?: boolean;
  connect?: (endpoint: string) => Promise<BrowserCdpConnection>;
  engine?: "chromium" | "chrome" | "lightpanda";
  /** Whether the lifecycle runner or this controller-owned CDP connection
   * creates page targets. Remote and non-Chromium CDP engines commonly scope
   * targets to the connection that created them, so they require `cdp`. */
  targetLifecycle?: "runner" | "cdp";
  /** The browser belongs to the person (attached Chrome). The driver tracks
   * the tabs this session opens there, and closing the driver (however the
   * session's runtime goes away) closes the ones still blank. A runtime that
   * continues a session continues in the tab the earlier one was using. */
  ownedTabs?: {
    /** What an earlier runtime of this session left in the browser. */
    previous?: OwnedTabsState | null;
    /** Called whenever the tracked tabs change, before anything else can. */
    onChange?: (tabs: OwnedTabsState) => void;
    /** Called once the driver closed; `tabsSettled` is false when a blank
     * tab it opened could not be closed (or is still in use elsewhere). */
    onClosed?: (tabsSettled: boolean) => void | Promise<void>;
    /** A blank tab this session opened that another session is using now
     * stays open; whoever cleans up later closes it once it is free. */
    inUseElsewhere?: (targetId: string) => boolean;
    /** How long a continuing runtime waits for the earlier tab to answer
     * before it opens a new one instead. */
    rebindTimeoutMs?: number;
  };
  tabControl?: boolean;
  /** Keep owned Chromium pages active without changing the foreground tab. */
  focusEmulation?: boolean;
  frameStreaming?: boolean;
  emulation?: BrowserSessionEmulation;
  permissionControl?: boolean;
  /** Experimental ephemeral context lease. Never a durable browser profile. */
  browserContextId?: string;
  /** Headless shell has no chrome://version page. Read its real Client Hints
   * from a controller-intercepted secure-origin document instead. */
  userAgentMetadataSource?: "chrome_internal" | "intercepted_local";
  /** The browser runs on this machine. When its User-Agent switch has emptied
   * the high-entropy Client Hints, present this machine's real values on
   * every page, frame and worker, as an ordinary Chrome would. */
  completeClientHints?: boolean;
  /** Set only by the verified, dedicated managed headless-shell launcher. */
  preserveHeadlessSessionCookies?: boolean;
  headlessSessionCookies?: HeadlessSessionCookies;
  /** Attach every page target (popups included) at the browser level as it is
   * created, paused until set up. Defaults to on for managed Chromium. */
  targetAutoAttach?: boolean;
  /** Install a virtual WebAuthn authenticator into every page target. Acting
   * on a tab then brings it to the front first: WebAuthn needs page focus. */
  passkeys?: BrowserPasskeyManager;
  /** Test seam for the navigation commit deadline. */
  navigationCommitTimeoutMs?: number;
  /** Windowed browser on a display without occlusion tracking: minimize its
   * windows after this long without any use, so idle pages stop rendering,
   * and present them again before the next use. */
  parkIdleWindowsAfterMs?: number;
};

export type BrowserSessionEmulation = {
  locale: string | null;
  timezone: string | null;
  geolocation: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
  } | null;
};

type BrowserUserAgentMetadata = ClientHintsMetadata;

/** The User-Agent this controller presents on every scope it can reach. */
type PresentedUserAgent = { userAgent: string; userAgentMetadata: BrowserUserAgentMetadata };

/** How a tab's navigation treats a page that fails to load. */
export type BrowserTabNavigationOptions = {
  /** Reopening a saved tab: when its page can't load (the host is unreachable
   * or no longer resolves), keep the tab open on the browser's error page with
   * its URL, as the browser's own session restore does, instead of failing.
   * Navigation policy refusals and invalid URLs still fail. */
  keepTabOnLoadError?: boolean;
};

export type BrowserRuntimeSnapshot = {
  engine: "chromium" | "chrome" | "lightpanda";
  engineVersion: string | null;
  tabs: Array<{ url: string; selected: boolean }>;
};

/** How many vanished tabs the driver remembers, to say why each is gone. */
const MAX_GONE_TARGETS = 64;

/** What the driver knows about a tab that no longer exists. */
export type GoneBrowserTarget =
  | { kind: "closed"; at: string; byCloseCall: boolean }
  | {
      kind: "relaunched";
      reason: BrowserRelaunchReason;
      idleReleaseMinutes?: number;
      replacementId: string | null;
    };

const LIST_CURRENT_TABS = "list the current tabs and use one of their IDs";

/** The answer for a tab ID that names no open tab: why it is gone when the
 * driver knows, and how to carry on. Always starts "browser target does not
 * exist", which callers match. */
export function goneBrowserTargetMessage(gone: GoneBrowserTarget | null): string {
  if (!gone) {
    return `browser target does not exist: this ID is not one of this browser's tabs; ${LIST_CURRENT_TABS}`;
  }
  if (gone.kind === "closed") {
    const by = gone.byCloseCall
      ? "by a close-tab call"
      : "by its page, or by a person or agent using this browser";
    return `browser target does not exist: this tab was closed at ${gone.at} ${by}; ${LIST_CURRENT_TABS}`;
  }
  const minutes = gone.idleReleaseMinutes;
  const why =
    gone.reason === "idle_release"
      ? `this browser was stopped after going unused${minutes ? ` for ${minutes} minute${minutes === 1 ? "" : "s"}` : ""} and relaunched on its next call`
      : gone.reason === "controller_restart"
        ? "this browser stopped when its controller restarted (or while unused afterwards) and was relaunched on its next call"
        : gone.reason === "browser_lost"
          ? "this browser's process ended unexpectedly (a crash, or the system or a person ended it) and was relaunched"
          : "this browser restarted to save its profile state";
  const next = gone.replacementId
    ? `this tab's page is now tab ${gone.replacementId}`
    : LIST_CURRENT_TABS;
  return `browser target does not exist: ${why}, so its tabs reopened with new IDs and unsaved page input may be lost; ${next}`;
}

function hasBrowserEmulation(
  value: BrowserSessionEmulation | undefined,
): value is BrowserSessionEmulation {
  return Boolean(
    value && (value.locale !== null || value.timezone !== null || value.geolocation !== null),
  );
}

/**
 * Target-scoped browser authority. The runner owns the browser process and
 * its private profile; Opengeni talks to that browser through one local CDP
 * connection and keeps an independent causal queue for every target.
 */
export class AgentBrowserDriver implements BrowserInteractionDriver {
  readonly fencedInputBatches = true;
  get focusedInputObservations(): boolean {
    return this.engine !== "lightpanda";
  }
  get networkNotice(): string | null {
    return this.runner.networkNotice ?? null;
  }
  /** The load error of the page start() opened and kept on the browser's
   * error page (keepTabOnLoadError), such as net::ERR_CONNECTION_REFUSED. */
  startLoadError: string | null = null;
  private readonly browserSessionId: string;
  private readonly controllerGeneration: string;
  private readonly runner: BrowserCommandRunner;
  private connectionEndpoint: string | null = null;
  private readonly now: () => Date;
  private readonly createId: () => string;
  /** Private physical-process fence. Provider target/loader ids are not
   * required to be globally unique and may repeat after crash recovery. */
  private physicalGeneration: string;
  private readonly engine: "chromium" | "chrome" | "lightpanda";
  private readonly targetLifecycle: "runner" | "cdp";
  private readonly ownedTabs: AgentBrowserDriverOptions["ownedTabs"] | null;
  private readonly navigationCommitTimeoutMs: number;
  /** Tabs this session created, in a browser it does not own. */
  private readonly createdTargetIds = new Set<string>();
  /** Blank tabs this session closed itself, most recent last. */
  private readonly closedBlankTargetIds = new Set<string>();
  /** Tabs that vanished while this driver knew them, or that a relaunch
   * replaced, most recent last: a later call naming one learns why. */
  private readonly goneTargets = new Map<string, GoneBrowserTarget>();
  /** Tabs a close-tab call of this driver is closing. */
  private readonly closingTargetIds = new Set<string>();
  /** The tab an earlier runtime of this session was using; start continues
   * in it rather than opening another. */
  private rebindTargetId: string | null = null;
  private reportedOwnedTabs = "";
  private readonly tabControl: boolean;
  /** Cleared once the browser refuses focus emulation, so later targets keep
   * working without it instead of each paying the refusal. */
  private focusEmulation: boolean;
  private readonly frameStreaming: boolean;
  private readonly emulation: BrowserSessionEmulation | null;
  private readonly permissionControl: boolean;
  private readonly browserContextId: string | undefined;
  private readonly ownedDownloads = new Set<string>();
  private readonly userAgentMetadataSource: "chrome_internal" | "intercepted_local";
  private userAgentMetadataPromise: Promise<BrowserUserAgentMetadata> | null = null;
  private readonly completeClientHints: boolean;
  /** Completed Client Hints for this browser connection; null when Chrome's
   * own hints are already complete. */
  private presentedUserAgent: PresentedUserAgent | null = null;
  /** Auto-attached page and frame sessions that hold the presented User-Agent,
   * with the listeners that extend it to their child frames. */
  private readonly presentationSessions = new Map<
    string,
    { parent: string | null; stop: Array<() => void> }
  >();
  private readonly resolveWorkspaceFiles:
    | ((operationId: string, workspaceFileIds: readonly string[]) => Promise<readonly string[]>)
    | undefined;
  private readonly downloadDirectory: string | null;
  private readonly downloadEvents: AgentBrowserDriverOptions["downloadEvents"];
  private readonly downloadsSavedByPerson: boolean;
  private readonly connect: (endpoint: string) => Promise<BrowserCdpConnection>;
  private readonly states = new Map<string, TargetState>();
  /** The size the agent last set. Tabs that open afterwards get it too, as
   * they would from a resized window; tabs that already existed keep theirs. */
  private sessionViewport: { viewport: ViewportEmulation; preexisting: Set<string> } | null = null;
  /** Each tab's own emulated size, re-applied when the tab is attached again
   * (Chromium drops the override with the attachment). */
  private readonly targetViewports = new Map<string, ViewportEmulation>();
  private readonly firstSeenAt = new Map<string, string>();
  private readonly attaching = new Map<string, Promise<TargetState>>();
  private readonly attachingSessions = new Map<string, string>();
  /** Tabs whose renderer process died. Cleared when the tab attaches healthily again. */
  private readonly crashedTargets = new Set<string>();
  private readonly targetPhysicalGenerations = new Map<string, string>();
  private connection: BrowserCdpConnection | null = null;
  private connectionPromise: Promise<BrowserCdpConnection> | null = null;
  private selectedTargetId: string | null = null;
  private userAgent = "";
  private browserProduct = "";
  private browserUnsubscribe: Array<() => void> = [];
  private clipboardRevision = 0;
  private clipboardText = "";
  private clipboardSource: BrowserClipboardValue["source"] = "empty";
  private clipboardSourceTargetId: string | null = null;
  private clipboardUpdatedAt: string | null = null;
  private readonly externalAuthResults = new Map<
    string,
    { digest: string; result: BrowserExternalAuthResultValue }
  >();
  private started = false;
  private readonly preserveHeadlessSessionCookies: boolean;
  private headlessSessionCookies: HeadlessSessionCookies | null;
  private readonly targetAutoAttach: boolean;
  private readonly passkeys: BrowserPasskeyManager | null;
  /** Browser-level auto-attached session per page target (never the state session). */
  private readonly autoSessions = new Map<string, string>();
  /** Listeners of each auto-attached shared worker session, by session id. */
  private readonly sharedWorkerSessions = new Map<string, Array<() => void>>();
  /** Page target last brought to the front by this controller, when known. */
  private frontTargetId: string | null = null;
  private readonly windowParking: BrowserWindowParking | null;
  /** Secret values this controller typed; redacted from everything it returns. */
  private readonly typedSecrets: TypedSecretMemory;

  constructor(options: AgentBrowserDriverOptions) {
    if (
      options.browserContextId !== undefined &&
      (!options.browserContextId ||
        options.targetLifecycle !== "cdp" ||
        options.runner.externalAuth ||
        (options.engine !== undefined && options.engine !== "chromium"))
    ) {
      throw new Error("ephemeral contexts require Chromium CDP lifecycle without external auth");
    }
    this.browserContextId = options.browserContextId;
    this.browserSessionId = options.browserSessionId;
    this.typedSecrets = TypedSecretMemory.forSession("browser", options.browserSessionId);
    this.controllerGeneration = options.controllerGeneration;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.physicalGeneration = randomUUID();
    this.engine = options.engine ?? "chromium";
    this.preserveHeadlessSessionCookies = options.preserveHeadlessSessionCookies ?? false;
    if (
      (this.preserveHeadlessSessionCookies || options.headlessSessionCookies) &&
      (this.engine !== "chromium" || (options.targetLifecycle ?? "runner") !== "runner")
    ) {
      throw new Error("Headless cookie state requires its dedicated managed launcher");
    }
    if (options.headlessSessionCookies && !this.preserveHeadlessSessionCookies)
      throw new Error("Headless cookie state requires its verified shell launcher");
    this.headlessSessionCookies = options.headlessSessionCookies
      ? validateHeadlessSessionCookies(options.headlessSessionCookies)
      : null;
    this.targetLifecycle = options.targetLifecycle ?? "runner";
    this.ownedTabs = options.ownedTabs ?? null;
    if (this.ownedTabs?.previous) {
      for (const targetId of this.ownedTabs.previous.created) this.createdTargetIds.add(targetId);
      for (const targetId of this.ownedTabs.previous.closedBlank)
        this.closedBlankTargetIds.add(targetId);
      this.rebindTargetId = this.ownedTabs.previous.selected;
    }
    this.navigationCommitTimeoutMs =
      options.navigationCommitTimeoutMs ?? NAVIGATION_COMMIT_TIMEOUT_MS;
    this.tabControl = options.tabControl ?? true;
    this.focusEmulation = options.focusEmulation ?? false;
    this.frameStreaming = options.frameStreaming ?? true;
    this.emulation = hasBrowserEmulation(options.emulation) ? options.emulation : null;
    this.permissionControl = options.permissionControl ?? true;
    this.targetAutoAttach = options.targetAutoAttach ?? this.engine === "chromium";
    this.passkeys = options.passkeys ?? null;
    this.userAgentMetadataSource = options.userAgentMetadataSource ?? "chrome_internal";
    this.completeClientHints = options.completeClientHints ?? false;
    this.resolveWorkspaceFiles = options.resolveWorkspaceFiles;
    this.downloadDirectory = options.downloadDirectory
      ? resolvePath(options.downloadDirectory)
      : null;
    this.downloadEvents = options.downloadEvents;
    this.downloadsSavedByPerson = options.downloadsSavedByPerson ?? false;
    this.connect = options.connect ?? (async (endpoint) => await CdpConnection.connect(endpoint));
    this.windowParking =
      options.parkIdleWindowsAfterMs === undefined
        ? null
        : new BrowserWindowParking({
            idleMs: options.parkIdleWindowsAfterMs,
            connection: () => this.connection,
            pageTargetIds: async () => {
              const connection = this.connection;
              if (!connection) return [];
              return visiblePageTargets(await this.targetInfos(connection)).map(
                (target) => target.targetId,
              );
            },
            // Focus emulation keeps every tab rendering as if it were being
            // captured; it is only needed while the browser is in use.
            suspendRendering: async () => await this.setTabFocusEmulation(false),
            resumeRendering: async () => await this.setTabFocusEmulation(true),
            onError: (phase, error) =>
              console.info(
                JSON.stringify({
                  event: "browser.window_parking.failed",
                  browserSessionId: this.browserSessionId,
                  phase,
                  error: error instanceof Error ? error.message : String(error),
                  at: new Date().toISOString(),
                }),
              ),
          });
  }

  /** Keeps this browser's windows presented (not parked) until the returned
   * release is called. A no-op for browsers that never park their windows. */
  async acquirePresence(): Promise<() => void> {
    return this.windowParking ? await this.windowParking.acquire() : () => undefined;
  }

  private async setTabFocusEmulation(enabled: boolean): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.focusEmulation) return;
    const results = await Promise.allSettled(
      [...this.states.values()].map(
        async (state) =>
          await connection.send(
            "Emulation.setFocusEmulationEnabled",
            { enabled },
            { sessionId: state.sessionId, timeoutMs: 2_000 },
          ),
      ),
    );
    // A tab that closed meanwhile refuses the command; nothing is left to do.
    const failure = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected" && !(result.reason instanceof CdpProtocolError),
    );
    if (failure) throw failure.reason;
  }

  async start(
    url?: string,
    options: BrowserTabNavigationOptions = {},
  ): Promise<BrowserObservationValue> {
    const deferNavigation = url !== undefined && url !== "about:blank";
    // Resolving the browser's private CDP endpoint is itself the cold-start
    // primitive (it launches the browser when needed). Connect once, reuse the
    // launch-created page, and perform the one intended navigation through our
    // target-scoped CDP authority.
    this.started = true;
    let connection: BrowserCdpConnection;
    let target: TargetInfo;
    if (this.targetLifecycle === "cdp") {
      connection = await this.ensureConnection();
      await this.windowParking?.presentNow();
      if (deferNavigation) connection.assertNavigable?.(url);
      // A session continuing in the person's browser (after an idle release
      // or a controller restart) carries on in the tab it was using.
      const rebound = deferNavigation ? null : await this.rebindPreviousTarget(connection);
      if (rebound) return rebound;
      const created = await connection.send<{ targetId?: unknown }>(
        "Target.createTarget",
        { url: "about:blank", background: true, ...this.contextScope() },
        { timeoutMs: BROWSER_START_TIMEOUT_MS },
      );
      if (typeof created.targetId !== "string" || !created.targetId) {
        throw new Error("browser did not return its initial page target");
      }
      this.recordCreatedTarget(created.targetId);
      // Attached Chrome's tab inventory may lag the creation receipt. Never
      // substitute another tab (even another blank tab) for the exact target
      // we created: the initial navigation would overwrite the user's page.
      try {
        target = await this.waitForCreatedTargetInfo(connection, created.targetId);
        this.selectedTargetId = target.targetId;
        this.ownedTabsChanged();
        if (deferNavigation)
          this.startLoadError = await this.navigate(
            await this.ensureTargetState(target),
            url,
            options,
          );
        this.windowParking?.arm();
        return await this.observe(target.targetId);
      } catch (error) {
        // The session never started, so nothing can use or close this tab.
        await this.discardCreatedTarget(connection, created.targetId);
        throw error;
      }
    } else {
      connection = await this.ensureConnection();
      // A browser reattached after a controller restart may still have the
      // windows its previous controller parked.
      await this.windowParking?.presentNow();
      if (this.headlessSessionCookies) {
        await restoreHeadlessSessionCookies(connection, this.headlessSessionCookies);
        this.headlessSessionCookies = null;
      }
      // A restored profile can reopen a tab whose renderer is already dead.
      // That tab stays in the inventory for the user to close; startup selects
      // the first live tab instead, and only creates one when none is live.
      let page: TargetInfo | undefined;
      const initialTargets = await this.targetInfos(connection);
      for (const candidate of visiblePageTargets(initialTargets)) {
        try {
          await this.ensureTargetState(candidate);
        } catch (error) {
          if (this.crashedTargets.has(candidate.targetId)) continue;
          throw error;
        }
        page = candidate;
        break;
      }
      if (!page) {
        const created = await connection.send<{ targetId?: unknown }>(
          "Target.createTarget",
          { url: "about:blank", background: true, ...this.contextScope() },
          { timeoutMs: BROWSER_START_TIMEOUT_MS },
        );
        if (typeof created.targetId !== "string") {
          throw new Error("managed browser did not return its initial page target");
        }
        page = await this.waitForCreatedTargetInfo(connection, created.targetId);
      }
      target = page;
      this.closeStartupNewTabPages(connection, initialTargets, page.targetId);
    }
    this.selectedTargetId = target.targetId;
    if (deferNavigation) {
      this.startLoadError = await this.navigate(await this.ensureTargetState(target), url, options);
    }
    this.windowParking?.arm();
    return await this.observe(target.targetId);
  }

  /** Bounded browser liveness probe for the supervisor's recovery path.
   * Renderer stalls and command deadlines do not prove browser loss: replacing
   * a live browser would discard document state that URL restoration cannot recover. */
  async isAvailable(): Promise<boolean> {
    if (!this.started || !this.connection) return false;
    try {
      await this.connection.send("Browser.getVersion", {}, { timeoutMs: 2_000 });
      return true;
    } catch (error) {
      return error instanceof CdpCommandTimeoutError || !(error instanceof CdpTransportError);
    }
  }

  /** Whether the browser answered a bounded probe ("connected"), its
   * connection is gone ("lost"), or it did not answer in time
   * ("unresponsive"), which proves neither. */
  async connectionState(): Promise<"connected" | "lost" | "unresponsive"> {
    if (!this.started || !this.connection) return "lost";
    try {
      await this.connection.send("Browser.getVersion", {}, { timeoutMs: 2_000 });
      return "connected";
    } catch (error) {
      if (error instanceof CdpCommandTimeoutError) return "unresponsive";
      return error instanceof CdpTransportError ? "lost" : "connected";
    }
  }

  /** Private launch attestation; never returned in observations or snapshots. */
  async ownedProcessIdentity(): Promise<OwnedManagedBrowserProcess | null> {
    if (!this.connection || !this.connectionEndpoint || !this.runner.ownedProcessIdentity)
      return null;
    const pid = await ownedCdpProcessId(this.connection);
    const process = await this.runner.ownedProcessIdentity(this.connectionEndpoint, pid);
    if (!process) return null;
    await assertOwnedCdpProcess(this.connection, process);
    return process;
  }

  /** Tab inventory with typed secrets hidden in titles and URLs. Saved
   * snapshots take their tabs from here, so they never keep a typed secret
   * either; a tab whose address carried one reopens without it. */
  async listTargets(): Promise<BrowserTargetValue[]> {
    const connection = await this.ensureConnection();
    const infos = visibleTargets(await this.targetInfos(connection));
    return this.typedSecrets.redact(
      infos.map((info) => this.targetFromInfo(info, this.states.get(info.targetId) ?? null)),
    );
  }

  async openTarget(
    url = "about:blank",
    options: BrowserTabNavigationOptions = {},
  ): Promise<BrowserObservationValue> {
    const state = await this.createTarget(url, options);
    return await this.observe(state.targetId);
  }

  /** Open a tab when the caller needs inventory rather than page content. */
  async openTargetWithInventory(url = "about:blank"): Promise<BrowserTargetValue[]> {
    const state = await this.createTarget(url);
    if (!state.dialog) await this.refreshFrame(state);
    const targets = await this.listTargets();
    this.assertCurrentTargetState(state);
    return targets;
  }

  private async createTarget(
    url: string,
    options: BrowserTabNavigationOptions = {},
  ): Promise<TargetState> {
    if (!this.tabControl) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser engine does not support multiple tabs",
      );
    }
    const connection = await this.ensureConnection();
    // Establish the blank document and target policies before remote navigation.
    // A slow response must use the navigation budget, not the target-creation deadline.
    const deferNavigation = url !== "about:blank";
    if (deferNavigation) connection.assertNavigable?.(url);
    const result = await connection.send<{ targetId?: unknown }>("Target.createTarget", {
      ...this.contextScope(),
      url: deferNavigation ? "about:blank" : url,
      background: true,
    });
    if (typeof result.targetId !== "string") throw new Error("CDP did not return a target id");
    this.recordCreatedTarget(result.targetId);
    const previousSelection = this.selectedTargetId;
    const createdTarget = await this.waitForCreatedTargetInfo(connection, result.targetId);
    const createdState = await this.ensureTargetState(createdTarget);
    await this.waitForCreatedTargetFrame(createdState);
    this.selectedTargetId = result.targetId;
    this.ownedTabsChanged();
    if (deferNavigation) {
      try {
        await this.navigate(createdState, url, options);
      } catch (error) {
        // A slow page may still finish loading in a tab the caller can list
        // and select. Any other failure leaves a tab nobody asked for: the
        // blank bootstrap document, or a page the browser will not let us
        // control. The caller was told the open failed, so close it.
        if (!isNavigationTimeout(error)) {
          await this.discardCreatedTarget(connection, result.targetId);
          if (this.selectedTargetId === result.targetId) this.selectedTargetId = previousSelection;
          this.ownedTabsChanged();
        }
        throw error;
      }
    }
    return createdState;
  }

  private async discardCreatedTarget(
    connection: BrowserCdpConnection,
    targetId: string,
  ): Promise<void> {
    this.removeState(targetId);
    if (this.selectedTargetId === targetId) this.selectedTargetId = null;
    try {
      await this.closeTargetAndSettle(connection, targetId);
      this.createdTargetIds.delete(targetId);
    } catch {
      // Best effort: the tab may already be gone, and the original failure
      // is what the caller needs to see. A tab still open stays recorded, so
      // the session's cleanup closes it while it is blank.
    }
    this.ownedTabsChanged();
  }

  /** A managed Chrome opens its own new-tab page at launch beside the page
   * the driver uses. Tab lists hide it, yet it keeps a renderer for the page
   * and another for its embedded Google bar alive for the browser's lifetime.
   * Close it in the background; startup does not wait for the close. */
  private closeStartupNewTabPages(
    connection: BrowserCdpConnection,
    targets: readonly TargetInfo[],
    selectedTargetId: string,
  ): void {
    for (const info of targets) {
      if (info.type !== "page" || info.targetId === selectedTargetId) continue;
      if (info.url !== "chrome://newtab/" && info.url !== "chrome://new-tab-page/") continue;
      this.removeState(info.targetId);
      void connection.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
    }
  }

  /** Target.closeTarget is acknowledged before the browser drops the tab from
   * Target.getTargets, and a cold or loaded browser can keep listing it for a
   * moment. Wait until it is gone, so a tab list returned after a close never
   * shows the closed tab. */
  private async closeTargetAndSettle(
    connection: BrowserCdpConnection,
    targetId: string,
  ): Promise<void> {
    await connection.send("Target.closeTarget", { targetId });
    await this.settleClosedTarget(connection, targetId);
  }

  private async settleClosedTarget(
    connection: BrowserCdpConnection,
    targetId: string,
  ): Promise<void> {
    const deadline = Date.now() + TARGET_CLOSE_SETTLE_TIMEOUT_MS;
    while ((await this.targetInfos(connection)).some((info) => info.targetId === targetId)) {
      if (Date.now() >= deadline) return;
      await delay(25);
    }
  }

  async selectTarget(targetId: string): Promise<BrowserObservationValue> {
    const connection = await this.ensureConnection();
    await this.requireTargetInfo(connection, targetId);
    this.selectedTargetId = targetId;
    this.ownedTabsChanged();
    return await this.observe(targetId);
  }

  async closeTarget(targetId: string): Promise<BrowserTargetValue[]> {
    if (!this.tabControl) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser engine does not support closing individual tabs",
      );
    }
    const connection = await this.ensureConnection();
    await this.requireTargetInfo(connection, targetId);
    this.closingTargetIds.add(targetId);
    try {
      await connection.send("Target.closeTarget", { targetId });
    } catch (error) {
      this.closingTargetIds.delete(targetId);
      throw error;
    }
    // The browser closed the tab. Losing the connection before the tab list
    // is read must not report the close as a failure (attached Chrome can
    // end the connection right after the tab closes).
    let settleFailure: unknown;
    try {
      await this.settleClosedTarget(connection, targetId);
    } catch (error) {
      settleFailure = error;
    }
    this.rememberClosedTarget(targetId, true);
    this.closingTargetIds.delete(targetId);
    this.removeState(targetId);
    this.createdTargetIds.delete(targetId);
    if (this.selectedTargetId === targetId) this.selectedTargetId = null;
    this.ownedTabsChanged();
    try {
      if (settleFailure !== undefined) throw settleFailure;
      return await this.listTargets();
    } catch (error) {
      throw closedTargetListFailure(error);
    }
  }

  /** Close the tabs this session opened in the person's browser that are
   * still blank, so a session never leaves empty tabs behind, however its
   * runtime goes away. Tabs that show a page stay: the person may still want
   * what the agent left there. Never touches a tab the session did not open.
   * Returns whether every such tab is closed. */
  async closeUnusedOwnedTabs(): Promise<boolean> {
    if (!this.ownedTabs || this.createdTargetIds.size === 0) return true;
    const connection = this.connection;
    if (!connection) return false;
    let infos: TargetInfo[];
    try {
      infos = await this.targetInfos(connection);
    } catch {
      return false;
    }
    let settled = true;
    for (const targetId of [...this.createdTargetIds]) {
      const info = infos.find((candidate) => candidate.targetId === targetId);
      if (!info) {
        // Already closed, by the person or by the browser.
        this.createdTargetIds.delete(targetId);
        continue;
      }
      if (!isBlankTabUrl(info.url)) continue;
      if (this.ownedTabs.inUseElsewhere?.(targetId)) {
        settled = false;
        continue;
      }
      try {
        await this.closeTargetAndSettle(connection, targetId);
        this.removeState(targetId);
        this.createdTargetIds.delete(targetId);
        this.closedBlankTargetIds.delete(targetId);
        this.closedBlankTargetIds.add(targetId);
      } catch {
        // Kept, so a later cleanup closes it.
        settled = false;
      }
    }
    while (this.closedBlankTargetIds.size > MAX_CLOSED_BLANK_TABS) {
      this.closedBlankTargetIds.delete(this.closedBlankTargetIds.values().next().value!);
    }
    this.ownedTabsChanged();
    return settled;
  }

  /** Continue in the tab an earlier runtime of this session was using when
   * it is still open and answers promptly; null when a new tab is needed
   * instead. A tab whose page does not answer (a dialog the page opened while
   * no agent held the browser blocks it, and only the person can answer that
   * one) is left as it is, rather than holding the session's return. */
  private async rebindPreviousTarget(
    connection: BrowserCdpConnection,
  ): Promise<BrowserObservationValue | null> {
    const targetId = this.rebindTargetId;
    this.rebindTargetId = null;
    if (!targetId || this.closedBlankTargetIds.has(targetId)) return null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      deadline = setTimeout(
        () => resolve(null),
        this.ownedTabs?.rebindTimeoutMs ?? REBIND_TIMEOUT_MS,
      );
      deadline.unref?.();
    });
    let abandoned = false;
    const rebind = (async () => {
      const info = (await this.targetInfos(connection)).find(
        (candidate) => candidate.targetId === targetId,
      );
      if (abandoned || !info || !isVisibleTarget(info)) return null;
      this.selectedTargetId = targetId;
      return await this.observe(targetId);
    })().catch(() => null);
    try {
      const observation = await Promise.race([rebind, expired]);
      if (observation) {
        this.windowParking?.arm();
        this.ownedTabsChanged();
        return observation;
      }
    } finally {
      clearTimeout(deadline);
    }
    // A tab that cannot be read now (it closed meanwhile, Chrome will no
    // longer let the extension control it, or its page is not answering) is
    // not worth failing the session for: open a new one, as a new session
    // would. A read still waiting on the tab ends by itself.
    abandoned = true;
    if (this.selectedTargetId === targetId) this.selectedTargetId = null;
    if (!this.attaching.has(targetId)) {
      // The tab stays open but unread: detach its session too, so no frame
      // or worker it starts waits for a listener that is gone.
      const sessionId = this.states.get(targetId)?.sessionId;
      this.removeState(targetId);
      if (sessionId)
        void connection
          .send("Target.detachFromTarget", { sessionId }, { timeoutMs: 1_000 })
          .catch(() => undefined);
    }
    return null;
  }

  private recordCreatedTarget(targetId: string): void {
    if (!this.ownedTabs) return;
    this.createdTargetIds.add(targetId);
    this.ownedTabsChanged();
  }

  /** Report the tracked tabs to the owner's ledger when they changed. */
  private ownedTabsChanged(): void {
    const onChange = this.ownedTabs?.onChange;
    if (!onChange) return;
    const tabs: OwnedTabsState = {
      created: [...this.createdTargetIds],
      selected: this.selectedTargetId,
      closedBlank: [...this.closedBlankTargetIds],
    };
    const serialized = JSON.stringify(tabs);
    if (serialized === this.reportedOwnedTabs) return;
    this.reportedOwnedTabs = serialized;
    try {
      onChange(tabs);
    } catch {
      // Recording is the owner's concern; it never fails browser work.
    }
  }

  async close(): Promise<void> {
    // In the person's own browser, the empty tabs this session opened go
    // with it, whatever ends the runtime. Best effort: closing never fails
    // because a tab could not be closed.
    const tabsSettled =
      this.ownedTabs && this.started ? await this.closeUnusedOwnedTabs().catch(() => false) : true;
    try {
      await this.closeDriver();
    } finally {
      await this.ownedTabs?.onClosed?.(tabsSettled);
    }
  }

  private async closeDriver(): Promise<void> {
    this.windowParking?.close();
    for (const unsubscribe of this.browserUnsubscribe.splice(0)) unsubscribe();
    for (const targetId of [...this.states.keys()]) this.removeState(targetId);
    this.firstSeenAt.clear();
    this.attachingSessions.clear();
    this.targetPhysicalGenerations.clear();
    this.forgetAutoAttachments();
    this.ownedDownloads.clear();
    const connection = this.connection;
    this.connection = null;
    this.connectionPromise = null;
    let closeError: unknown = null;
    let terminationError: unknown = null;
    if (this.started && this.targetLifecycle === "runner") {
      // Ask the browser to shut down cleanly over CDP, so it writes its
      // profile state, then wait for the process to exit.
      if (connection) {
        try {
          await connection.send(
            "Browser.close",
            {},
            { timeoutMs: BROWSER_CLOSE_REQUEST_TIMEOUT_MS },
          );
        } catch {
          // Termination below still stops the browser.
        }
      }
      try {
        await this.runner.run(["close"], {
          timeoutMs: GRACEFUL_BROWSER_CLOSE_TIMEOUT_MS,
        });
      } catch (error) {
        closeError = error;
      }
    }
    this.started = false;
    try {
      await this.runner.terminate?.();
    } catch (error) {
      terminationError ??= error;
    } finally {
      connection?.close();
    }
    if (terminationError) {
      if (closeError) {
        throw new AggregateError([closeError, terminationError], "managed browser cleanup failed");
      }
      throw terminationError;
    }
    if (closeError && !this.runner.terminate) throw closeError;
  }

  async detach(): Promise<void> {
    this.windowParking?.close();
    for (const unsubscribe of this.browserUnsubscribe.splice(0)) unsubscribe();
    for (const targetId of [...this.states.keys()]) this.removeState(targetId);
    this.firstSeenAt.clear();
    this.attachingSessions.clear();
    this.targetPhysicalGenerations.clear();
    this.forgetAutoAttachments();
    this.ownedDownloads.clear();
    this.connection?.close();
    this.connection = null;
    this.connectionPromise = null;
    this.connectionEndpoint = null;
    this.started = false;
  }

  async runtimeSnapshot(): Promise<BrowserRuntimeSnapshot> {
    if (this.browserContextId) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "ephemeral browser contexts cannot capture or restore durable profiles",
      );
    }
    const targets = await this.listTargets();
    const tabs: BrowserRuntimeSnapshot["tabs"] = [];
    for (const target of targets) {
      if (target.kind !== "page" && target.kind !== "popup") continue;
      // A tab showing the browser's error page still belongs to the page it
      // failed to load; save that page so a later restore can retry it.
      const url = target.url.toLowerCase().startsWith("chrome-error:")
        ? ((await this.errorPageDestination(target.id)) ?? target.url)
        : target.url;
      tabs.push({ url, selected: target.selected });
    }
    const separator = this.browserProduct.indexOf("/");
    const rawVersion = separator >= 0 ? this.browserProduct.slice(separator + 1) : "";
    const engineVersion =
      rawVersion.length > 0 && Buffer.byteLength(rawVersion) <= 256 ? rawVersion : null;
    return { engine: this.engine, engineVersion, tabs };
  }

  /** The http(s) URL an error page failed to load, read from its current
   * history entry. Null when it can't be read; the caller keeps the error URL. */
  private async errorPageDestination(targetId: string): Promise<string | null> {
    try {
      const connection = await this.ensureConnection();
      const info = (await this.targetInfos(connection)).find(
        (candidate) => candidate.targetId === targetId,
      );
      if (!info) return null;
      const history = await this.sendActionTarget<{ currentIndex?: unknown; entries?: unknown }>(
        await this.ensureTargetState(info),
        "Page.getNavigationHistory",
        {},
      );
      const entries = Array.isArray(history.entries) ? history.entries : [];
      const entry =
        typeof history.currentIndex === "number" ? entries[history.currentIndex] : undefined;
      if (!isRecord(entry) || typeof entry.url !== "string") return null;
      return /^https?:\/\//iu.test(entry.url) ? entry.url : null;
    } catch {
      return null;
    }
  }

  /** Supervisor-only read after both action controllers have quiesced. Never
   * exposed through the public browser observation/tool surface. */
  async captureSessionCookies(): Promise<HeadlessSessionCookies | null> {
    if (!this.preserveHeadlessSessionCookies) return null;
    if (!this.started || !this.connection)
      throw new Error("Headless cookie capture requires its active physical browser");
    return await captureHeadlessSessionCookies(this.connection, {
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
    });
  }

  get requiresExplicitProfileRestore(): boolean {
    return this.preserveHeadlessSessionCookies;
  }

  /** When the most recent JavaScript dialog still waiting for an answer
   * opened (epoch milliseconds), or null when none is. Chrome offers a dialog
   * only to the debugger that was attached when it opened: one attached later
   * can neither see nor answer it, and the page stays blocked. Letting go of
   * the browser now would strand it. */
  openDialogSince(): number | null {
    let newest: number | null = null;
    for (const state of this.states.values()) {
      if (!state.dialog) continue;
      const openedAt = Date.parse(state.dialog.openedAt);
      if (Number.isFinite(openedAt) && (newest === null || openedAt > newest)) newest = openedAt;
    }
    return newest;
  }

  async target(targetId: string): Promise<BrowserTargetValue | null> {
    const connection = await this.ensureConnection();
    const info = (await this.targetInfos(connection)).find(
      (candidate) => candidate.targetId === targetId,
    );
    if (!info && this.closedBlankTargetIds.has(targetId))
      throw this.closedBlankTargetError(targetId);
    if (!info && this.goneTargets.has(targetId)) throw this.missingTargetError(targetId);
    if (!info || !isVisibleTarget(info)) return null;
    const state = await this.ensureTargetState(info);
    // A JavaScript dialog blocks ordinary page-domain inspection. Keep the
    // event-derived target/document/frame generations authoritative until the
    // dialog is handled; otherwise the controller's generic pre-dispatch
    // target validation can fail before `handle_dialog` reaches Chromium.
    // A dialog can open just before its event arrives (the person's own
    // Chrome reports events by polling): a read that meets one reports it.
    if (!state.dialog) {
      try {
        await this.untilDialog(state, async () => await this.refreshFrame(state));
      } catch (error) {
        if (!(error instanceof DialogBlockedError)) throw error;
      }
    }
    return this.typedSecrets.redact(this.targetFromInfo(info, state));
  }

  async observe(targetId: string): Promise<BrowserObservationValue> {
    return this.typedSecrets.redact(await this.observeTarget(targetId));
  }

  private async observeTarget(targetId: string): Promise<BrowserObservationValue> {
    return await this.withTarget(targetId, async (state, info) => {
      if (state.dialog) return await this.observeUnlocked(state, info);
      try {
        return await this.untilDialog(state, async () => await this.observeUnlocked(state, info));
      } catch (error) {
        // A dialog opened while the page was being read: report it.
        if (!(error instanceof DialogBlockedError)) throw error;
        return await this.observeUnlocked(state, info);
      }
    });
  }

  /** Refresh only the main-frame generation. No accessibility tree is read. */
  async targetState(targetId: string): Promise<BrowserTargetStateValue> {
    return await this.withTarget(targetId, async (state) => {
      if (!state.dialog) {
        try {
          await this.untilDialog(state, async () => await this.refreshFrame(state));
        } catch (error) {
          if (!(error instanceof DialogBlockedError)) throw error;
        }
      }
      return this.targetStateFrom(state);
    });
  }

  async readDom(
    targetId: string,
    request: BrowserDomReadRequestValue,
  ): Promise<BrowserDomReadResponseValue> {
    return await this.withTarget(targetId, async (state) => {
      if (request.kind === "count") {
        assertSafeDomReadSelector(request.selector);
      } else if (request.locator.kind === "css") {
        assertSafeDomReadSelector(request.locator.selector);
      }
      if (state.dialog) {
        throw new InteractionDefiniteDriverError(
          "resource_unavailable",
          `${dialogSummary(state.dialog, this.typedSecrets.merged())} Page reads are unavailable until it is handled. ${DIALOG_GUIDANCE}`,
        );
      }
      return this.typedSecrets.redact(
        await this.untilDialog(state, async () => await this.readDomUnlocked(state, request)),
      );
    });
  }

  private async readDomUnlocked(
    state: TargetState,
    request: BrowserDomReadRequestValue,
  ): Promise<BrowserDomReadResponseValue> {
    await this.refreshFrame(state);
    this.assertReadGenerations(request, state);
    let result: Record<string, unknown>;
    if (request.kind === "count") {
      const count = await this.domSelectorCount(state, request.selector);
      result = { kind: "count", count, truncated: false };
    } else {
      const entry = await this.resolveLocator(state, request.locator);
      const value = await this.callOnNode(
        state,
        entry.backendDOMNodeId,
        DOM_READ_FUNCTION,
        [
          { value: request.maxChars ?? 4_096 },
          { value: request.attributes ?? [] },
          { value: false },
          { value: request.offset ?? 0 },
        ],
        { isolatedFrameId: entry.frameId ?? state.frame.id },
      );
      if (!isRecord(value) || value.ok !== true) {
        throw new InteractionDefiniteDriverError(
          "locator_not_found",
          "browser DOM element is no longer available",
        );
      }
      result = {
        kind: "element",
        count: 1,
        text: value.text,
        value: value.value,
        attributes: value.attributes,
        redacted: value.redacted,
        truncated: value.truncated,
      };
    }
    await this.refreshFrame(state);
    this.assertReadGenerations(request, state);
    return BrowserDomReadResponse.parse({ ...this.targetStateFrom(state), ...result });
  }

  private targetStateFrom(state: TargetState): BrowserTargetStateValue {
    return BrowserTargetState.parse({
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
      targetId: state.targetId,
      targetGeneration: this.targetGeneration(state.targetId),
      documentGeneration: state.documentGeneration,
      frameId: state.frameGeneration,
    });
  }

  private assertReadGenerations(request: BrowserDomReadRequestValue, state: TargetState): void {
    if (request.expectedTargetGeneration !== this.targetGeneration(state.targetId)) {
      throw new InteractionDefiniteDriverError(
        "target_stale",
        "browser target changed before DOM read",
      );
    }
    if (request.expectedDocumentGeneration !== state.documentGeneration) {
      throw new InteractionDefiniteDriverError(
        "document_stale",
        "browser document changed before DOM read",
      );
    }
    if (request.expectedFrameId !== state.frameGeneration) {
      throw new InteractionDefiniteDriverError(
        "frame_stale",
        "browser frame changed before DOM read",
      );
    }
  }

  private async domSelectorCount(state: TargetState, selector: string): Promise<number> {
    return (await this.domMatchNodeIds(state, selector)).length;
  }

  async debug(
    targetId: string,
    options: {
      kinds?: readonly BrowserDiagnosticKind[];
      afterSequence?: number;
      limit?: number;
    } = {},
  ): Promise<BrowserDiagnosticBatchValue> {
    const kinds = options.kinds ? new Set(options.kinds) : null;
    const afterSequence = boundedNonnegativeInteger(
      options.afterSequence ?? 0,
      "diagnostic cursor",
    );
    const limit = boundedPositiveInteger(
      options.limit ?? 100,
      INTERACTION_MAX_DIAGNOSTIC_ENTRIES,
      "diagnostic limit",
    );
    return await this.withTarget(targetId, async (state) => {
      if (!kinds || kinds.has("console") || kinds.has("page_error")) {
        await this.harvestRuntimeDiagnostics(state);
      }
      const available = state.diagnosticEntries.filter(
        (entry) => entry.sequence > afterSequence && (!kinds || kinds.has(entry.kind)),
      );
      const entries = available.slice(0, limit);
      const droppedBeforeCursor =
        state.diagnosticEntries.length > 0 &&
        state.diagnosticEntries[0]!.sequence > afterSequence + 1;
      const limited = available.length > entries.length;
      const batch = BrowserDiagnosticBatch.parse({
        browserSessionId: this.browserSessionId,
        controllerGeneration: this.controllerGeneration,
        targetId,
        targetGeneration: this.targetGeneration(targetId),
        entries,
        cursor: limited
          ? entries.at(-1)!.sequence
          : Math.max(afterSequence, state.diagnosticSequence),
        truncated: droppedBeforeCursor || limited,
      });
      return this.typedSecrets.redact(batch);
    });
  }

  async captureScreenshot(
    targetId: string,
    options: BrowserScreenshotOptions = {},
  ): Promise<BrowserImageFrame> {
    // Lightpanda 0.3.5 implements this CDP method with an embedded static PNG,
    // not pixels from the current page. Never publish it as visual evidence.
    if (this.engine === "lightpanda") {
      throw new InteractionControllerError(
        "unsupported",
        "Lightpanda does not render page screenshots; use semantic observation",
      );
    }
    const normalized = normalizeScreenshotOptions(options);
    // A JavaScript dialog blocks capture until it is answered: fail at once,
    // naming it, instead of waiting out the capture deadline.
    return await this.withTarget(
      targetId,
      async (state) =>
        await this.untilDialog(state, async () => {
          const deadline = Date.now() + SCREENSHOT_CAPTURE_TIMEOUT_MS;
          for (let attempt = 0; attempt < SCREENSHOT_DOCUMENT_ATTEMPTS; attempt += 1) {
            await this.screenshotRead(
              "Page.getFrameTree",
              deadline,
              async (timeoutMs) => await this.refreshFrame(state, timeoutMs),
            );
            const metrics = await this.screenshotRead(
              "Page.getLayoutMetrics",
              deadline,
              async (timeoutMs) => await this.layoutMetrics(state, timeoutMs),
            );
            const capture: Record<string, unknown> = {
              format: normalized.format,
              fromSurface: true,
              captureBeyondViewport: normalized.fullPage,
              ...(normalized.format === "jpeg" ? { quality: normalized.quality } : {}),
            };
            let cssWidth = metrics.viewport.width;
            let cssHeight = metrics.viewport.height;
            let scrollX = metrics.viewport.x;
            let scrollY = metrics.viewport.y;
            if (normalized.fullPage) {
              cssWidth = metrics.content.width;
              cssHeight = metrics.content.height;
              scrollX = 0;
              scrollY = 0;
              assertImageDimensions(Math.ceil(cssWidth), Math.ceil(cssHeight));
              capture.clip = {
                x: 0,
                y: 0,
                width: cssWidth,
                height: cssHeight,
                scale: 1,
              };
            }
            const captureOnce = async () => {
              const response = await this.screenshotRead(
                "Page.captureScreenshot",
                deadline,
                async (timeoutMs) => {
                  const stallBound =
                    this.engine === "chrome" && !normalized.fullPage
                      ? Math.min(timeoutMs, CONNECTED_CHROME_CAPTURE_STALL_MS)
                      : timeoutMs;
                  try {
                    return await this.sendTarget<{ data?: unknown }>(
                      state,
                      "Page.captureScreenshot",
                      capture,
                      { timeoutMs: stallBound },
                    );
                  } catch (error) {
                    if (stallBound < timeoutMs && error instanceof CdpCommandTimeoutError) {
                      throw new InteractionControllerError(
                        "timeout",
                        CONNECTED_CHROME_CAPTURE_STALLED,
                        true,
                      );
                    }
                    throw error;
                  }
                },
              );
              const data = decodeBoundedBase64Image(response.data);
              return { data, dimensions: imageDimensions(data, normalized.format) };
            };
            let { data, dimensions } = await captureOnce();
            // Chromium applies a new device-metrics override asynchronously, so a
            // capture right after a viewport change can still return the previous
            // surface. A viewport capture of an emulated device has an exact size;
            // wait briefly for the compositor instead of publishing the stale frame.
            const expected = normalized.fullPage ? undefined : state.emulatedViewport;
            if (expected) {
              const expectedWidth = Math.round(expected.width * expected.deviceScaleFactor);
              const expectedHeight = Math.round(expected.height * expected.deviceScaleFactor);
              const settleDeadline = Math.min(deadline, Date.now() + STALE_SURFACE_SETTLE_MS);
              let pause = 16;
              while (
                (Math.abs(dimensions.width - expectedWidth) > 1 ||
                  Math.abs(dimensions.height - expectedHeight) > 1) &&
                Date.now() + pause < settleDeadline
              ) {
                await delay(pause);
                pause = Math.min(pause * 2, 200);
                const refreshed = await this.screenshotRead(
                  "Page.getLayoutMetrics",
                  deadline,
                  async (timeoutMs) => await this.layoutMetrics(state, timeoutMs),
                );
                cssWidth = refreshed.viewport.width;
                cssHeight = refreshed.viewport.height;
                scrollX = refreshed.viewport.x;
                scrollY = refreshed.viewport.y;
                ({ data, dimensions } = await captureOnce());
              }
            }
            // The image is labeled with the document it shows. A commit while it
            // was captured leaves the label unproven, so capture the new page.
            const shown = state.documentGeneration;
            await this.screenshotRead(
              "Page.getFrameTree",
              deadline,
              async (timeoutMs) => await this.refreshFrame(state, timeoutMs),
            );
            if (state.documentGeneration !== shown) {
              if (attempt + 1 < SCREENSHOT_DOCUMENT_ATTEMPTS) continue;
              throw new InteractionControllerError(
                "resource_unavailable",
                "browser page kept changing to new documents while its screenshot was captured",
                true,
              );
            }
            return this.imageFrame({
              state,
              sequence: 0,
              format: normalized.format,
              data,
              width: dimensions.width,
              height: dimensions.height,
              deviceScaleFactor: finiteScale(dimensions.width / cssWidth),
              scrollX,
              scrollY,
            });
          }
          throw new Error("unreachable screenshot attempt");
        }),
    );
  }

  /**
   * Change-driven JPEG frames of one tab for a recording. Chromium sends a
   * screencast frame only when the page repaints; acknowledging each frame
   * after RECORDING_FRAME_ACK_DELAY_MS caps the rate without losing the
   * page's latest state. Focus emulation keeps background tabs painting.
   */
  async recordFrames(
    targetId: string,
    onFrame: (jpeg: Uint8Array, capturedAtMs: number) => void,
    onEnd: (error: Error | null) => void,
  ): Promise<() => Promise<void>> {
    if (this.engine === "lightpanda") {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser engine cannot record video",
      );
    }
    const connection = await this.ensureConnection();
    const sessionId = await this.withTarget(targetId, async (state) => state.sessionId);
    let ended = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const end = (error: Error | null) => {
      if (ended) return;
      ended = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      stopFrames();
      stopDetach();
      onEnd(error);
    };
    const stopFrames = connection.on(
      "Page.screencastFrame",
      (event) => {
        const params = event.params as {
          data?: unknown;
          sessionId?: unknown;
          metadata?: { timestamp?: unknown };
        };
        if (typeof params.data !== "string" || typeof params.sessionId !== "number") return;
        const frameSession = params.sessionId;
        const at =
          typeof params.metadata?.timestamp === "number"
            ? params.metadata.timestamp * 1_000
            : Date.now();
        try {
          onFrame(Buffer.from(params.data, "base64"), at);
        } finally {
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (ended) return;
            void connection
              .send("Page.screencastFrameAck", { sessionId: frameSession }, { sessionId })
              .catch(() => undefined);
          }, RECORDING_FRAME_ACK_DELAY_MS);
          timers.add(timer);
        }
      },
      sessionId,
    );
    const stopDetach = connection.on("Target.detachedFromTarget", (event) => {
      if ((event.params as { sessionId?: unknown }).sessionId === sessionId) {
        end(new Error("the recorded tab closed"));
      }
    });
    try {
      await connection.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: RECORDING_FRAME_QUALITY,
          maxWidth: RECORDING_FRAME_MAX_WIDTH,
          maxHeight: RECORDING_FRAME_MAX_HEIGHT,
        },
        { sessionId, timeoutMs: 5_000 },
      );
    } catch (error) {
      end(null);
      throw error;
    }
    return async () => {
      if (ended) return;
      end(null);
      await connection
        .send("Page.stopScreencast", {}, { sessionId, timeoutMs: 2_000 })
        .catch(() => undefined);
    };
  }

  async subscribeFrames(
    targetId: string,
    options: BrowserFrameStreamOptions = {},
  ): Promise<BrowserFrameSubscription> {
    frameStreamDiagnostic("browser.frame.subscribe.begin", {
      browserSessionId: this.browserSessionId,
      targetId,
    });
    if (this.engine === "lightpanda" || !this.frameStreaming) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser engine does not support live frame streaming",
      );
    }
    const normalized = normalizeFrameStreamOptions(options);
    const configured = await this.withTarget(targetId, async (state) => {
      const key = frameStreamProfileKey(normalized);
      let screencast = state.screencasts.get(key);
      let created = false;
      if (!screencast) {
        if (state.screencasts.size >= MAX_FRAME_PROFILES_PER_TARGET) {
          throw new Error("browser target frame-profile bound was reached");
        }
        screencast = {
          key,
          options: normalized,
          sequence: 0,
          lastFrameAt: 0,
          captureScale: null,
          fallbackAbort: new AbortController(),
          capturePromise: null,
          subscriptions: new Map(),
          unsubscribe: () => undefined,
        };
        state.screencasts.set(key, screencast);
        created = true;
      }
      const subscriptionCount = [...state.screencasts.values()].reduce(
        (sum, candidate) => sum + candidate.subscriptions.size,
        0,
      );
      if (subscriptionCount >= MAX_FRAME_SUBSCRIPTIONS_PER_TARGET) {
        throw new Error("browser target frame-subscriber bound was reached");
      }
      const subscriptionId = this.createId();
      const subscription = new LatestBrowserFrameSubscription(
        async () => await this.releaseFrameSubscription(targetId, key, subscriptionId),
      );
      screencast.subscriptions.set(subscriptionId, subscription);
      return { state, screencast, subscription, created };
    });
    frameStreamDiagnostic("browser.frame.subscribe.configured", {
      browserSessionId: this.browserSessionId,
      targetId,
      created: configured.created,
    });
    try {
      // Chromium does not emit Page.screencastFrame for a background tab in a
      // headed browser. Seed every subscriber from the same target-scoped CDP
      // surface so attachment readiness never depends on focusing Chrome.
      let seedFailure: unknown;
      for (let attempt = 0; attempt < FRAME_CAPTURE_FAILURE_LIMIT; attempt += 1) {
        try {
          await this.captureFallbackFrame(targetId, configured.screencast);
          seedFailure = undefined;
          break;
        } catch (error) {
          seedFailure = error;
          if (attempt + 1 < FRAME_CAPTURE_FAILURE_LIMIT) await delay(25 * (attempt + 1));
        }
      }
      if (seedFailure !== undefined) throw seedFailure;
      frameStreamDiagnostic("browser.frame.subscribe.seeded", {
        browserSessionId: this.browserSessionId,
        targetId,
        sequence: configured.screencast.sequence,
      });
    } catch (error) {
      await configured.subscription.close().catch(() => undefined);
      throw error;
    }
    if (configured.created) {
      // Page.startScreencast can wedge every later target command when a headed
      // Chromium tab is not foregrounded. A continuously sampled, target-scoped
      // Page.captureScreenshot stream works for background tabs and keeps Browser
      // independent from the shared desktop's focus.
      this.pollFallbackFrames(targetId, configured.screencast);
    }
    return configured.subscription;
  }

  async dispatch(
    commandInput: BrowserActionCommandValue & { observationMode: "none" },
    trace?: InteractionDispatchTrace,
  ): Promise<null>;
  async dispatch(
    commandInput: BrowserActionCommandValue & { observationMode: "input" },
    trace?: InteractionDispatchTrace,
  ): Promise<BrowserObservationValue | null>;
  async dispatch(
    commandInput: BrowserActionCommandValue & { observationMode?: "full" },
    trace?: InteractionDispatchTrace,
  ): Promise<BrowserObservationValue>;
  async dispatch(
    commandInput: BrowserActionCommandValue,
    trace?: InteractionDispatchTrace,
  ): Promise<BrowserObservationValue>;
  async dispatch(
    commandInput: BrowserActionCommandValue,
    trace?: InteractionDispatchTrace,
  ): Promise<BrowserObservationValue | null> {
    const parsed = BrowserActionCommand.parse(commandInput);
    // Remembered before dispatch: a failed action can still leave the value typed.
    this.typedSecrets.remember(parsed.secretValues);
    const secretValues = this.typedSecrets.merged(parsed.secretValues);
    const command = materializeCommandSecrets(parsed);
    // Input counts as sent once an effectful command left browserd, so a later
    // unresponsive-tab deadline must keep the action's outcome uncertain.
    let effects: { state: TargetState; before: number } | undefined;
    const observation = await this.withTarget(command.targetId, async (state, info) => {
      effects = { state, before: state.actionEffectCount };
      if (!state.dialog) await this.refreshFrame(state);
      this.assertExpectedGenerations(command, state);
      const actions = command.action.type === "batch" ? command.action.actions : [command.action];
      if (state.dialog && actions[0]?.type !== "handle_dialog") {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser JavaScript dialog must be handled before another action",
        );
      }
      await this.bringToFrontForAction(state);
      let completedActions = 0;
      // Navigations complete only once their page committed, so a batch that
      // has so far only navigated and waited knows exactly where the tab is.
      let onlyCommittedNavigation = true;
      let committedNavigations = 0;
      const initialEffectCount = state.actionEffectCount;
      const requestsBeforeActions = {
        open: new Set(state.inflightRequests),
        activity: state.networkActivitySequence,
        navigation: state.navigationSequence,
      };
      for (const [actionIndex, action] of actions.entries()) {
        state.actionTrace = trace ? { actionIndex, trace } : undefined;
        state.locatorFollowsNavigation =
          command.action.type === "batch" && !command.action.fenceEachAction && actionIndex > 0;
        state.accessibilityRebuildDue = true;
        const effectsBeforeAction = state.actionEffectCount;
        try {
          if (action.type === "handle_dialog") {
            await this.dispatchAction(state, action, command.operationId);
          } else {
            // A dialog the previous action opened, or one that opens while
            // this action reads the page, ends the batch here: the page
            // cannot answer until the dialog is handled.
            await this.untilDialog(state, async () => {
              await this.settleUnsettledHitTargetGuards(state);
              if (
                completedActions > 0 &&
                command.action.type === "batch" &&
                command.action.fenceEachAction
              ) {
                await this.refreshFrame(state);
                this.assertExpectedGenerations(command, state);
              }
              await this.dispatchAction(state, action, command.operationId, {
                // Only an action whose locators already follow the page to a
                // new document (a later action of a batch without
                // fenceEachAction) may look again there. A single or first
                // action is fenced to the document the caller checked, so a
                // change before its input stays a refusal.
                refindAfterDocumentChange: state.locatorFollowsNavigation === true,
              });
            });
          }
          state.nodeRoute = null;
          state.inputFence = null;
          state.actionTrace = undefined;
          state.locatorFollowsNavigation = false;
          completedActions += 1;
          if (action.type === "navigate" || action.type === "history") committedNavigations += 1;
          else if (action.type !== "wait") onlyCommittedNavigation = false;
          if (state.dialog) {
            if (completedActions < actions.length)
              throw await this.dialogPause(
                state,
                info.targetId,
                secretValues,
                actions.length,
                completedActions,
              );
            break;
          }
        } catch (thrown) {
          state.nodeRoute = null;
          state.inputFence = null;
          state.actionTrace = undefined;
          state.locatorFollowsNavigation = false;
          const error = classifyActionFailure(thrown, command);
          if (error instanceof DialogBlockedError || error instanceof DialogOpenedSignal) {
            // This action counts as run once it sent input: that input is
            // what opened the dialog, or it may have had effects before it.
            if (state.actionEffectCount !== effectsBeforeAction) completedActions += 1;
            if (completedActions < actions.length || state.actionEffectCount === initialEffectCount)
              throw await this.dialogPause(
                state,
                info.targetId,
                secretValues,
                actions.length,
                completedActions,
              );
            break;
          }
          if (
            error instanceof InteractionDefiniteDriverError &&
            completedActions === 0 &&
            state.actionEffectCount === initialEffectCount
          )
            throw await this.withFailureObservation(
              state,
              info.targetId,
              command,
              secretValues,
              error,
              null,
            );
          if (
            error instanceof InteractionDefiniteDriverError &&
            action.type === "wait" &&
            onlyCommittedNavigation &&
            committedNavigations > 0
          )
            throw await this.withFailureObservation(
              state,
              info.targetId,
              command,
              secretValues,
              new InteractionDefiniteDriverError(
                error.code,
                `browser action #${actionIndex} (wait) failed after the preceding navigation committed (${error.code}: ${error.message}); the tab shows the committed page`,
                error.retryable,
              ),
              null,
            );
          throw await this.withFailureObservation(
            state,
            info.targetId,
            command,
            secretValues,
            error instanceof InteractionDefiniteDriverError
              ? new InteractionOutcomeUnknownDriverError(
                  "outcome_unknown",
                  `browser action ${actions.length > 1 ? `#${actionIndex} (${action.type}) ` : ""}failed after it sent input or completed ${completedActions} action(s) (${error.code}: ${error.message}); check the current page before continuing and do not replay the completed actions automatically`,
                )
              : error,
            requestsBeforeActions,
          );
        }
      }
      // An open dialog is the page's state, whatever view was asked for: the
      // caller must handle it before anything else works in this tab. Its
      // observation reads nothing from the blocked page.
      if (state.dialog)
        return await this.observeUnlocked(
          state,
          await this.requireTargetInfo(await this.ensureConnection(), info.targetId),
        );
      if (command.observationMode === "none") return null;
      if (command.observationMode === "input") {
        // A live viewer already has pixels. Only native dropdowns need the
        // semantic options that Chromium's page stream cannot paint. Keep
        // ordinary clicks off the full accessibility/snapshot path.
        if (
          command.action.type !== "pointer" ||
          command.action.action !== "click" ||
          (command.action.button !== undefined && command.action.button !== "left") ||
          state.dialog ||
          !this.focusedInputObservations
        )
          return null;
        try {
          if (!(await this.mayHaveFocusedNativeSelect(state))) return null;
          const currentInfo = await this.requireTargetInfo(
            await this.ensureConnection(),
            info.targetId,
          );
          const observed = await this.observeUnlocked(state, currentInfo);
          // A focused iframe is a hint only. The authoritative AX focus and
          // redacted DOM metadata must actually identify a native select.
          const pending = [
            ...(observed.semantic?.kind === "snapshot" ? observed.semantic.roots : []),
          ];
          while (pending.length) {
            const node = pending.pop()!;
            if (node.children) pending.push(...node.children);
            if (
              node.ref === observed.focusedRef &&
              node.native?.platform === "dom" &&
              isRecord(node.native.data) &&
              node.native.data.kind === "native-select"
            )
              return observed;
          }
        } catch {
          // The click already completed. An optional focus read must never
          // turn it into a failed mutation or invite a duplicate click.
        }
        return null;
      }
      try {
        // Navigation already waits for the new document to load, and an
        // explicit wait has its own condition; only page input settles here.
        const last = actions.at(-1)?.type;
        // The page may open another dialog while it settles (for example the
        // next one in a sequence after handle_dialog): report that one.
        try {
          return await this.untilDialog(state, async () => {
            if (last !== "navigate" && last !== "history" && last !== "wait")
              await this.settleActionRequests(state, requestsBeforeActions);
            // Taken before animations settle: a handler may start its request
            // while a click ripple or transition is still running.
            const late =
              last !== undefined && LATE_REQUEST_ACTIONS.has(last) ? settleBaseline(state) : null;
            await this.settleFiniteAnimations(state);
            if (late) await this.settleLateActionRequests(state, late);
            const currentInfo = await this.requireTargetInfo(
              await this.ensureConnection(),
              info.targetId,
            );
            return await this.observeUnlocked(state, currentInfo);
          });
        } catch (error) {
          if (!(error instanceof DialogBlockedError)) throw error;
          return await this.observeUnlocked(
            state,
            await this.requireTargetInfo(await this.ensureConnection(), info.targetId),
          );
        }
      } catch (error) {
        // Input has already been dispatched. A closing popup or failed
        // follow-up read cannot prove that the mutation itself failed.
        const retiredSession =
          (error instanceof CdpProtocolError &&
            error.code === -32_001 &&
            this.states.get(state.targetId) !== state) ||
          (error instanceof InteractionControllerError &&
            error.cause instanceof CdpSessionDetachedError);
        // A native invalid-session reply after this exact attachment retired
        // is target loss, not loss of the browser transport or healthy peers.
        if (!(error instanceof InteractionDefiniteDriverError) && !retiredSession) {
          if (error instanceof InteractionControllerError || browserTransportFailure(error))
            throw error;
          // Every action ran. Only reading the page after them failed (a page
          // whose frames keep changing, say), and the browser is still there:
          // the actions completed, and the receipt says why it has no outline.
          reportUnexpectedDispatchError("browser", error, command);
          trace?.record({
            actionIndex: actions.length - 1,
            kind: "observation_unavailable",
            message:
              actions.length > 1
                ? `all ${actions.length} actions completed, but the page could not be read after them, so this receipt has no outline; observe the tab to see the page now`
                : "the action completed, but the page could not be read after it, so this receipt has no outline; observe the tab to see the page now",
          } satisfies BrowserActionNoteValue);
          return null;
        }
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "Browser input was sent, but the resulting page could not be observed. Check the current tabs before continuing; do not repeat the action automatically.",
        );
      }
    }).catch((error: unknown) => {
      if (error instanceof InteractionControllerError && error.code === "tab_not_responding") {
        throw effects && effects.state.actionEffectCount !== effects.before
          ? new InteractionOutcomeUnknownDriverError(
              "tab_not_responding",
              `${TAB_NOT_RESPONDING_MESSAGE} Input was already sent: check its effects after recovery and do not repeat the action automatically.`,
            )
          : new InteractionDefiniteDriverError("tab_not_responding", TAB_NOT_RESPONDING_MESSAGE);
      }
      if (error instanceof CdpSessionDetachedError) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "The tab disconnected while browser input was being sent. Check the current tabs before continuing; do not repeat the action automatically.",
        );
      }
      throw error;
    });
    this.refreshSubscribedFrame(command.targetId);
    return redactInteractionSecretValues(observation, secretValues);
  }

  /**
   * Attaches the page as it is after a failed action, so the receipt already
   * shows current elements (for example fresh refs after a stale one) and the
   * caller needs no separate observation. Best effort: the failure itself
   * always stands, and a page that cannot be read leaves it without one.
   * `settleAfter` is set when input may have been sent.
   */
  private async withFailureObservation(
    state: TargetState,
    targetId: string,
    command: BrowserActionCommandValue,
    secretValues: BrowserActionCommandValue["secretValues"],
    error: unknown,
    settleAfter: ActionSettleBaseline | null,
  ): Promise<unknown> {
    if (
      !(
        error instanceof InteractionDefiniteDriverError ||
        error instanceof InteractionOutcomeUnknownDriverError
      )
    )
      return error;
    // An open dialog is shown whatever view was asked for: the caller has to
    // answer it next. Its observation reads nothing from the blocked page.
    if (state.dialog) {
      try {
        const info = await this.requireTargetInfo(await this.ensureConnection(), targetId);
        error.observation = redactInteractionSecretValues(
          await this.observeUnlocked(state, info),
          secretValues,
        );
      } catch {
        // Optional context only.
      }
      return error;
    }
    if (command.observationMode !== undefined && command.observationMode !== "full") return error;
    try {
      if (settleAfter) {
        await this.settleActionRequests(state, settleAfter);
        await this.settleFiniteAnimations(state);
      }
      const info = await this.requireTargetInfo(await this.ensureConnection(), targetId);
      error.observation = redactInteractionSecretValues(
        await this.observeUnlocked(state, info),
        secretValues,
      );
    } catch {
      // Optional context only; never replace the action's own failure.
    }
    return error;
  }

  /** The failure for a batch a JavaScript dialog stopped before its end, or
   * for an action a dialog blocked before it sent any input. It carries the
   * page's observation, with the dialog, so the caller can answer it next. */
  private async dialogPause(
    state: TargetState,
    targetId: string,
    secretValues: BrowserActionCommandValue["secretValues"],
    total: number,
    completed: number,
  ): Promise<Error> {
    const summary = dialogSummary(state.dialog, secretValues);
    const error =
      completed === 0
        ? new InteractionDefiniteDriverError(
            "invalid_action",
            `${summary} ${total > 1 ? "No action in this batch ran." : "The action did not run."} ${DIALOG_GUIDANCE}`,
          )
        : new InteractionOutcomeUnknownDriverError(
            "outcome_unknown",
            `${summary} ${completed} of ${total} actions ran; the last of them opened the dialog or was interrupted by it, and the remaining actions did not run. ${DIALOG_GUIDANCE} Then check the page before continuing; do not replay the actions that ran.`,
          );
    try {
      const info = await this.requireTargetInfo(await this.ensureConnection(), targetId);
      error.observation = redactInteractionSecretValues(
        await this.observeUnlocked(state, info),
        secretValues,
      );
    } catch {
      // Optional context only; the failure itself names the dialog.
    }
    return error;
  }

  readClipboard(): BrowserClipboardValue {
    return this.typedSecrets.redact(this.clipboardValue());
  }

  private clipboardValue(): BrowserClipboardValue {
    return BrowserClipboard.parse({
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
      revision: this.clipboardRevision,
      text: this.clipboardText,
      source: this.clipboardSource,
      sourceTargetId: this.clipboardSourceTargetId,
      updatedAt: this.clipboardUpdatedAt,
    });
  }

  /** Controller-private provider authentication. Provider credentials and
   * hosted-login URLs never enter an ordinary browser action. */
  async externalAuth(
    commandInput: BrowserExternalAuthCommandValue,
  ): Promise<BrowserExternalAuthResultValue> {
    const command = BrowserExternalAuthCommand.parse(commandInput);
    if (
      command.browserSessionId !== this.browserSessionId ||
      command.controllerGeneration !== this.controllerGeneration
    ) {
      throw new InteractionDefiniteDriverError(
        "controller_stale",
        "external authentication targets another browser controller",
      );
    }
    if (!this.runner.externalAuth) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser placement does not support provider-managed authentication",
      );
    }
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          browserSessionId: command.browserSessionId,
          controllerGeneration: command.controllerGeneration,
          authRunId: command.authRunId,
          adapterId: command.adapterId,
          connectionId: command.connectionId,
          action: command.action,
        }),
      )
      .digest("hex");
    const replay = this.externalAuthResults.get(command.operationId);
    if (replay) {
      if (replay.digest !== digest) {
        throw new InteractionDefiniteDriverError(
          "operation_conflict",
          "external-auth operation id was reused with another request",
        );
      }
      return replay.result;
    }
    const dispatched = await this.runner.externalAuth(command);
    const result = BrowserExternalAuthResult.parse(dispatched.result);
    if (dispatched.browserReconfigured) {
      await this.reconnectAfterProviderReconfiguration();
    }
    this.externalAuthResults.set(command.operationId, { digest, result });
    while (this.externalAuthResults.size > 512) {
      this.externalAuthResults.delete(this.externalAuthResults.keys().next().value as string);
    }
    return result;
  }

  private async ensureConnection(): Promise<BrowserCdpConnection> {
    const connection = await this.openConnection();
    const scope = dialogWork.getStore();
    return scope ? dialogScopedConnection(connection, scope) : connection;
  }

  private async openConnection(): Promise<BrowserCdpConnection> {
    if (this.connection) return this.connection;
    if (this.connectionPromise) return await this.connectionPromise;
    this.connectionPromise = (async () => {
      const result = await this.runner.run<{ cdpUrl?: unknown }>(["get", "cdp-url"]);
      if (typeof result.cdpUrl !== "string") {
        throw new Error("managed browser did not expose its private CDP endpoint");
      }
      const connection = await this.connect(result.cdpUrl);
      this.connectionEndpoint = result.cdpUrl;
      if (this.runner.reattachedOwnedProcess) {
        try {
          await assertOwnedCdpProcess(connection, this.runner.reattachedOwnedProcess);
        } catch (error) {
          connection.close();
          throw error;
        }
      }
      const version = await connection.send<{
        product?: unknown;
        userAgent?: unknown;
      }>("Browser.getVersion");
      this.browserProduct = typeof version.product === "string" ? version.product : "";
      this.userAgent = typeof version.userAgent === "string" ? version.userAgent : "";
      if (this.runner.proxyCredentials) {
        this.browserUnsubscribe.push(
          ...(await answerProxyChallenges(connection, this.runner.proxyCredentials)),
        );
      }
      this.presentedUserAgent = this.completeClientHints
        ? await this.loadPresentedUserAgent(connection)
        : null;
      if (this.downloadDirectory) {
        await connection.send("Browser.setDownloadBehavior", {
          ...this.contextScope(),
          // Chromium names each file as in any downloads folder, so its
          // Downloads page shows the real name and opens it by type.
          behavior: "allow",
          downloadPath: this.downloadDirectory,
          eventsEnabled: true,
        });
      }
      if (this.emulation?.geolocation) {
        await connection.send("Browser.grantPermissions", {
          ...this.contextScope(),
          permissions: ["geolocation"],
        });
      }
      await connection.send("Target.setDiscoverTargets", { discover: true });
      this.browserUnsubscribe.push(
        connection.on("Target.targetDestroyed", (event) => {
          if (typeof event.params.targetId !== "string") return;
          this.rememberClosedTarget(event.params.targetId);
          this.removeState(event.params.targetId);
        }),
        connection.on("Target.detachedFromTarget", (event) => {
          const sessionId = event.params.sessionId;
          if (typeof sessionId !== "string") return;
          const targetId =
            typeof event.params.targetId === "string"
              ? event.params.targetId
              : ([...this.states.values()].find((state) => state.sessionId === sessionId)
                  ?.targetId ??
                [...this.attachingSessions].find(([, attached]) => attached === sessionId)?.[0]);
          if (
            !targetId ||
            (this.states.get(targetId)?.sessionId !== sessionId &&
              this.attachingSessions.get(targetId) !== sessionId)
          )
            return;
          // A new attachment must invalidate old controls even when the tab,
          // loader and frame ids are unchanged. Other tabs keep their authority.
          this.targetPhysicalGenerations.set(targetId, randomUUID());
          this.attachingSessions.delete(targetId);
          this.removeState(targetId, true);
        }),
        connection.on("Browser.downloadWillBegin", (event) => {
          const frameId = typeof event.params.frameId === "string" ? event.params.frameId : null;
          const state = [...this.states.values()].find(
            (candidate) => candidate.frame.id === frameId,
          );
          // Browser download events are process-wide. Unknown frames must not
          // become downloads belonging to another context, nor, in the
          // person's own browser, to this session.
          if ((this.browserContextId || this.downloadsSavedByPerson) && !state) return;
          if (this.downloadEvents) {
            const guid = typeof event.params.guid === "string" ? event.params.guid : "";
            if (this.browserContextId || this.downloadsSavedByPerson) this.ownedDownloads.add(guid);
            const suggestedFilename =
              typeof event.params.suggestedFilename === "string"
                ? event.params.suggestedFilename
                : "download";
            void this.downloadEvents
              .begin({
                guid,
                targetId: state?.targetId ?? null,
                suggestedFilename,
              })
              .catch(() => undefined);
          }
          if (state) {
            state.diagnostics.downloadCount += 1;
            this.appendDiagnostic(state, {
              kind: "download",
              level: "info",
              message: "Browser download started",
              url: boundedUrlField(event.params.url),
              method: null,
              status: null,
              filename: boundedTextField(event.params.suggestedFilename, 4_096),
            });
          }
        }),
        connection.on("Browser.downloadProgress", (event) => {
          if (!this.downloadEvents) return;
          const guid = typeof event.params.guid === "string" ? event.params.guid : "";
          if (
            (this.browserContextId || this.downloadsSavedByPerson) &&
            !this.ownedDownloads.has(guid)
          )
            return;
          const state = event.params.state;
          if (state !== "inProgress" && state !== "completed" && state !== "canceled") return;
          const receivedBytes = event.params.receivedBytes;
          const totalBytes = event.params.totalBytes;
          const filePath =
            state === "completed" && typeof event.params.filePath === "string"
              ? event.params.filePath
              : null;
          if (typeof receivedBytes !== "number" || !Number.isSafeInteger(receivedBytes)) return;
          if (
            totalBytes !== undefined &&
            (typeof totalBytes !== "number" || !Number.isSafeInteger(totalBytes))
          ) {
            return;
          }
          void this.downloadEvents
            .progress({
              guid,
              state,
              receivedBytes,
              totalBytes: typeof totalBytes === "number" ? totalBytes : null,
              ...(this.downloadsSavedByPerson
                ? state === "completed"
                  ? { personFilePath: filePath }
                  : {}
                : { filePath }),
              // Browser events and replies share this connection in order, so
              // a reply proves every earlier download event was delivered.
              ...(state === "completed" && !this.downloadsSavedByPerson
                ? {
                    eventBarrier: () => connection.send("Browser.getVersion").then(() => undefined),
                  }
                : {}),
            })
            .then(async ({ cancelReason }) => {
              if (state !== "inProgress") this.ownedDownloads.delete(guid);
              if (!cancelReason) return;
              // The person's download is theirs to keep; only this session's
              // copy is refused, and the store kept none.
              if (this.downloadsSavedByPerson) {
                await this.downloadEvents?.reject(guid, cancelReason, "confirmed");
                return;
              }
              const cancelled = await connection
                .send("Browser.cancelDownload", { guid, ...this.contextScope() })
                .then(
                  () => true,
                  () => false,
                );
              await this.downloadEvents?.reject(
                guid,
                cancelReason,
                cancelled ? "confirmed" : "uncertain",
              );
            })
            .catch(() => undefined);
        }),
      );
      if (this.targetAutoAttach) await this.enableTargetAutoAttach(connection);
      this.connection = connection;
      return connection;
    })();
    try {
      return await this.connectionPromise;
    } catch (error) {
      this.connectionPromise = null;
      throw error;
    }
  }

  /**
   * Attach every page target in this controller's context as Chromium creates
   * it, including window.open popups, while it is paused before its first
   * script. Each gets its passkey authenticator and presented User-Agent, then
   * resumes. These sessions only host per-target setup; actions keep their own
   * lazily attached session. Shared workers always attach the same way, so a
   * page's request for a shared worker's script, which finishes only on the
   * worker's own session, counts as finished. Service workers attach only
   * when the presented User-Agent must reach them.
   */
  private async enableTargetAutoAttach(connection: BrowserCdpConnection): Promise<void> {
    const unsubscribe = [
      connection.on("Target.attachedToTarget", (event) => {
        // Child sessions (cross-origin iframes) belong to their page session.
        if (event.sessionId !== null) return;
        void this.onTargetAutoAttached(connection, event.params);
      }),
      connection.on("Target.detachedFromTarget", (event) => {
        const sessionId = event.params.sessionId;
        if (event.sessionId !== null || typeof sessionId !== "string") return;
        for (const [targetId, autoSession] of this.autoSessions) {
          if (autoSession === sessionId) this.autoSessions.delete(targetId);
        }
        for (const stop of this.sharedWorkerSessions.get(sessionId) ?? []) stop();
        this.sharedWorkerSessions.delete(sessionId);
        this.forgetPresentationSession(sessionId);
        this.passkeys?.detachSession(sessionId);
      }),
      connection.on("Target.targetDestroyed", (event) => {
        if (event.params.targetId === this.frontTargetId) this.frontTargetId = null;
      }),
    ];
    this.browserUnsubscribe.push(...unsubscribe);
    try {
      await connection.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        // Shared and service workers take no User-Agent from any page; they
        // present it only through their own attachment. Shared workers attach
        // in any case: a page's request for one's script finishes only on the
        // worker's own session.
        filter: this.presentedUserAgent
          ? [{ type: "page" }, { type: "shared_worker" }, { type: "service_worker" }]
          : [{ type: "page" }, { type: "shared_worker" }],
      });
    } catch (error) {
      if (error instanceof CdpTransportError) throw error;
      // Engines without browser-level auto-attach keep lazy per-target attachment.
      for (const stop of unsubscribe) stop();
    }
  }

  private async onTargetAutoAttached(
    connection: BrowserCdpConnection,
    params: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string") return;
    let info: TargetInfo;
    try {
      info = normalizeTargetInfo(params.targetInfo);
    } catch {
      return;
    }
    const waiting = params.waitingForDebugger === true;
    const resume = async () => {
      if (!waiting) return;
      await connection
        .send("Runtime.runIfWaitingForDebugger", {}, { sessionId, timeoutMs: 5_000 })
        .catch(() => undefined);
    };
    const worker = info.type === "shared_worker" || info.type === "service_worker";
    // The filter means every other attachment is our own explicit
    // Target.attachToTarget (for example the hidden metadata target, which
    // Chromium reports as "other"). That session belongs to its caller.
    if (info.type !== "page" && !worker) return;
    if (this.browserContextId !== undefined && info.browserContextId !== this.browserContextId) {
      // Another controller's context: never hold it.
      await resume();
      await connection
        .send("Target.detachFromTarget", { sessionId }, { timeoutMs: 5_000 })
        .catch(() => undefined);
      return;
    }
    if (worker) {
      // The worker keeps this session, and with it the override, for its
      // lifetime. Send both at once: a worker waiting for its debugger
      // answers the override only after it resumes.
      const presented = this.presentedUserAgentOverride();
      if (info.type === "shared_worker" && !this.sharedWorkerSessions.has(sessionId))
        this.sharedWorkerSessions.set(sessionId, this.finishPageRequests(connection, sessionId));
      await Promise.all([
        presented
          ? connection
              .send("Network.setUserAgentOverride", presented, { sessionId, timeoutMs: 5_000 })
              .catch(() => undefined)
          : undefined,
        info.type === "shared_worker"
          ? connection
              .send("Network.enable", {}, { sessionId, timeoutMs: 5_000 })
              .catch(() => undefined)
          : undefined,
        resume(),
      ]);
      return;
    }
    // Our own explicit Target.attachToTarget also reports an attachment. The
    // auto-attached session always arrives first; keep exactly one per target
    // (Chromium allows one internal virtual authenticator per target).
    if (this.autoSessions.has(info.targetId)) {
      await resume();
      return;
    }
    this.autoSessions.set(info.targetId, sessionId);
    // A new tab or popup may have taken the front.
    if (waiting) this.frontTargetId = null;
    try {
      await Promise.all([
        this.presentUserAgent(connection, sessionId, null),
        this.passkeys?.attachTarget(connection, { targetId: info.targetId, sessionId }),
      ]);
    } finally {
      await resume();
    }
  }

  /** The User-Agent override every scope gets: the completed Client Hints,
   * with the emulated locale's Accept-Language. */
  private presentedUserAgentOverride(): Record<string, unknown> | null {
    if (!this.presentedUserAgent) return null;
    const locale = this.emulation?.locale;
    return { ...this.presentedUserAgent, ...(locale ? { acceptLanguage: locale } : {}) };
  }

  /**
   * Present the completed User-Agent on an auto-attached page or frame
   * session, and on each cross-origin frame it hosts, nested ones included,
   * before that frame runs its first script. Same-origin frames and dedicated
   * workers inherit it from their document. Never fails the attachment: a
   * target that closed meanwhile simply needs nothing.
   */
  private async presentUserAgent(
    connection: BrowserCdpConnection,
    sessionId: string,
    parent: string | null,
  ): Promise<void> {
    const presented = this.presentedUserAgentOverride();
    if (!presented || this.presentationSessions.has(sessionId)) return;
    this.presentationSessions.set(sessionId, {
      parent,
      stop: [
        connection.on(
          "Target.attachedToTarget",
          (event) => void this.onPresentationFrameAttached(connection, sessionId, event.params),
          sessionId,
        ),
        connection.on(
          "Target.detachedFromTarget",
          (event) => {
            if (typeof event.params.sessionId === "string")
              this.forgetPresentationSession(event.params.sessionId);
          },
          sessionId,
        ),
      ],
    });
    await Promise.all([
      connection
        .send("Emulation.setUserAgentOverride", presented, { sessionId, timeoutMs: 5_000 })
        .catch(() => undefined),
      connection
        .send(
          "Target.setAutoAttach",
          {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
            // Chromium holds this page's dedicated workers before their
            // first script too, filtered or not; attach them only to resume.
            filter: [{ type: "iframe" }, { type: "worker" }],
          },
          { sessionId, timeoutMs: 5_000 },
        )
        .catch(() => undefined),
    ]);
  }

  private async onPresentationFrameAttached(
    connection: BrowserCdpConnection,
    parentSessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string") return;
    try {
      await this.presentUserAgent(connection, sessionId, parentSessionId);
    } finally {
      if (params.waitingForDebugger === true)
        await connection
          .send("Runtime.runIfWaitingForDebugger", {}, { sessionId, timeoutMs: 5_000 })
          .catch(() => undefined);
    }
  }

  private forgetPresentationSession(sessionId: string): void {
    const entry = this.presentationSessions.get(sessionId);
    if (!entry) return;
    this.presentationSessions.delete(sessionId);
    for (const stop of entry.stop) stop();
    // Nested frames went with their parent session.
    for (const [child, nested] of [...this.presentationSessions]) {
      if (nested.parent === sessionId) this.forgetPresentationSession(child);
    }
  }

  private forgetAutoAttachments(): void {
    this.autoSessions.clear();
    for (const stop of [...this.sharedWorkerSessions.values()].flat()) stop();
    this.sharedWorkerSessions.clear();
    for (const sessionId of [...this.presentationSessions.keys()])
      this.forgetPresentationSession(sessionId);
    this.frontTargetId = null;
    if (this.connection) this.passkeys?.detachConnection(this.connection);
  }

  private async reconnectAfterProviderReconfiguration(): Promise<void> {
    for (const unsubscribe of this.browserUnsubscribe.splice(0)) unsubscribe();
    for (const targetId of [...this.states.keys()]) this.removeState(targetId);
    this.firstSeenAt.clear();
    this.attaching.clear();
    this.attachingSessions.clear();
    this.targetPhysicalGenerations.clear();
    this.forgetAutoAttachments();
    this.selectedTargetId = null;
    this.userAgentMetadataPromise = null;
    this.userAgent = "";
    this.presentedUserAgent = null;
    this.browserProduct = "";
    this.physicalGeneration = randomUUID();
    const previous = this.connection;
    this.connection = null;
    this.connectionPromise = null;
    previous?.close();

    const connection = await this.ensureConnection();
    let targets = visiblePageTargets(await this.targetInfos(connection));
    if (targets.length === 0) {
      const created = await connection.send<{ targetId?: unknown }>("Target.createTarget", {
        ...this.contextScope(),
        url: "about:blank",
        background: true,
      });
      if (typeof created.targetId !== "string") {
        throw new Error("reconfigured browser did not return a target id");
      }
      targets = visiblePageTargets(await this.targetInfos(connection));
    }
    const selected = targets[0];
    if (!selected) throw new Error("reconfigured browser has no page target");
    this.selectedTargetId = selected.targetId;
  }

  private async withTarget<T>(
    targetId: string,
    operation: (state: TargetState, info: TargetInfo) => Promise<T>,
  ): Promise<T> {
    const connection = await this.ensureConnection();
    const info = await this.requireTargetInfo(connection, targetId);
    const state = await this.ensureTargetState(info);
    const result = state.tail.then(async () => {
      this.assertCurrentTargetState(state);
      state.nodeRoute = null;
      state.accessibilityRebuildDue = true;
      try {
        return await operation(state, info);
      } finally {
        state.nodeRoute = null;
      }
    });
    state.tail = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } catch (error) {
      // A renderer that died mid-command ends that command through the detach
      // below; report the crash itself rather than the transport symptom.
      if (this.crashedTargets.has(targetId)) throw tabCrashedError();
      if (error instanceof CdpCommandTimeoutError && error.sessionId)
        throw tabNotRespondingError(error);
      throw error;
    }
  }

  private async ensureTargetState(info: TargetInfo): Promise<TargetState> {
    const existing = this.states.get(info.targetId);
    if (existing) return existing;
    const inFlight = this.attaching.get(info.targetId);
    if (inFlight) return await inFlight;
    const promise = this.attachTarget(info);
    this.attaching.set(info.targetId, promise);
    try {
      return await promise;
    } finally {
      this.attaching.delete(info.targetId);
    }
  }

  private async attachTarget(info: TargetInfo): Promise<TargetState> {
    const connection = await this.ensureConnection();
    const authorityGeneration = this.targetPhysicalGeneration(info.targetId);
    const attached = await connection.send<{ sessionId?: unknown }>("Target.attachToTarget", {
      targetId: info.targetId,
      flatten: true,
    });
    if (typeof attached.sessionId !== "string") throw new Error("CDP did not attach the target");
    const sessionId = attached.sessionId;
    this.attachingSessions.set(info.targetId, sessionId);
    // A tab whose renderer already died answers no page command; Chrome says so
    // on Inspector.enable. Watch for it so attachment fails fast instead of
    // hanging every later command until its timeout.
    let signalCrash: () => void = () => undefined;
    const crashed = new Promise<null>((resolve) => {
      signalCrash = () => resolve(null);
    });
    const stopCrashWatch = connection.on("Inspector.targetCrashed", () => signalCrash(), sessionId);
    // Only the crash signal matters here; a slow or unsupported enable must not
    // replace the real initialization outcome.
    void connection.send("Inspector.enable", {}, { sessionId }).catch(() => undefined);
    let frame: MainFrame;
    const viewport = this.viewportFor(info.targetId);
    try {
      const initialized = (async () => {
        await Promise.all([
          // Runtime stays disabled: a page can detect an enabled Runtime
          // domain (it serializes every console argument), the common
          // automation tell. Console messages and exceptions are read on
          // demand instead (harvestRuntimeDiagnostics).
          connection.send("Page.enable", {}, { sessionId }),
          // Lightpanda 0.3.5 does not replay earlier console messages when
          // Runtime is enabled, so an on-demand read would find nothing. It
          // keeps Runtime enabled and reports them as they happen.
          ...(this.engine === "lightpanda"
            ? [connection.send("Runtime.enable", {}, { sessionId })]
            : []),
          connection.send("DOM.enable", {}, { sessionId }),
          connection.send("Accessibility.enable", {}, { sessionId }),
          connection.send("Network.enable", {}, { sessionId }),
          connection.send("Log.enable", {}, { sessionId }),
        ]);
        await this.applyEmulation(connection, sessionId);
        if (viewport) await this.applyViewport(connection, sessionId, viewport);
        return await this.mainFrame(sessionId);
      })();
      const outcome = await Promise.race([initialized, crashed]);
      if (!outcome) {
        // Detaching below ends the enables still waiting on the dead renderer.
        void initialized.catch(() => undefined);
        this.crashedTargets.add(info.targetId);
        throw tabCrashedError();
      }
      frame = outcome;
      if (
        this.attachingSessions.get(info.targetId) !== sessionId ||
        this.targetPhysicalGeneration(info.targetId) !== authorityGeneration
      ) {
        throw new InteractionControllerError(
          "resource_unavailable",
          "Browser tab detached during attachment",
          true,
        );
      }
    } catch (error) {
      // Failed initialization never enters states, so normal target cleanup cannot
      // find it. Release only this CDP attachment; preserve the page and profile.
      await connection
        .send("Target.detachFromTarget", { sessionId }, { timeoutMs: 500 })
        .catch(() => undefined);
      if (error instanceof CdpCommandTimeoutError && error.sessionId)
        throw tabNotRespondingError(error);
      throw error;
    } finally {
      stopCrashWatch();
      if (this.attachingSessions.get(info.targetId) === sessionId)
        this.attachingSessions.delete(info.targetId);
    }
    this.crashedTargets.delete(info.targetId);
    const state: TargetState = {
      targetId: info.targetId,
      sessionId,
      authorityGeneration,
      actionEffectCount: 0,
      unsettledHitTargetGuards: [],
      createdAt: this.firstSeen(info.targetId),
      frame,
      documentGeneration: documentGeneration(
        this.controllerGeneration,
        authorityGeneration,
        info.targetId,
        frame.loaderId,
      ),
      frameGeneration: frameGeneration(
        this.controllerGeneration,
        authorityGeneration,
        info.targetId,
        frame.id,
      ),
      committedLoaders: [frame.loaderId],
      abandonedLoaders: [],
      mainFrameCommits: 0,
      inputFence: null,
      accessibility: null,
      accessibilityRebuiltAt: 0,
      accessibilityNodeCount: null,
      accessibilityRebuildDue: true,
      dialog: null,
      diagnostics: {
        consoleErrorCount: 0,
        failedRequestCount: 0,
        downloadCount: 0,
        pageErrorCount: 0,
      },
      diagnosticEntries: [],
      diagnosticSequence: 0,
      runtimeDiagnosticKeys: new Set(),
      inflightRequests: new Set(),
      networkTrackingOverflow: false,
      failedRequests: new Set(),
      requests: new Map(),
      lastNetworkActivityAt: Date.now(),
      networkActivitySequence: 0,
      navigationSequence: 0,
      navigationPending: false,
      screencasts: new Map(),
      tail: Promise.resolve(),
      unsubscribe: [],
      oopifs: new Map(),
      workers: new Map(),
      nodeRoute: null,
      ...(viewport
        ? {
            emulatedViewport: {
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: viewport.deviceScaleFactor,
            },
          }
        : {}),
    };
    state.unsubscribe.push(
      connection.on("Inspector.targetCrashed", () => this.onTargetCrashed(state), sessionId),
      connection.on(
        "Page.frameNavigated",
        (event) => this.onFrameNavigated(state, event),
        sessionId,
      ),
      // A click that submits a form or follows a link starts a navigation the
      // renderer reports before it answers the click, while the request and the
      // new document come later. These events let an action wait for it.
      connection.on(
        "Page.frameRequestedNavigation",
        (event) => {
          if (event.params.disposition === "currentTab") this.onNavigationStarted(state, event);
        },
        sessionId,
      ),
      connection.on(
        "Page.frameStartedNavigating",
        (event) => {
          const type = event.params.navigationType;
          if (type !== "sameDocument" && type !== "historySameDocument")
            this.onNavigationStarted(state, event);
        },
        sessionId,
      ),
      connection.on(
        "Page.frameStoppedLoading",
        (event) => {
          if (event.params.frameId === state.frame.id) state.navigationPending = false;
        },
        sessionId,
      ),
      // A same-document navigation (a history entry made by pushState, a
      // fragment) commits without a new loader or frameNavigated event.
      connection.on(
        "Page.navigatedWithinDocument",
        (event) => {
          if (event.params.frameId === state.frame.id) state.mainFrameCommits += 1;
        },
        sessionId,
      ),
      ...(this.engine === "lightpanda"
        ? [
            connection.on(
              "Runtime.consoleAPICalled",
              (event) => this.appendRuntimeDiagnostic(state, "console", event.params),
              sessionId,
            ),
            connection.on(
              "Runtime.exceptionThrown",
              (event) => this.appendRuntimeDiagnostic(state, "page_error", event.params),
              sessionId,
            ),
          ]
        : []),
      ...this.trackNetwork(connection, state, sessionId, true),
      connection.on(
        "Page.javascriptDialogOpening",
        (event) => {
          state.dialog = browserDialog(event.params, this.timestamp());
        },
        sessionId,
      ),
      connection.on(
        "Page.javascriptDialogClosed",
        () => {
          state.dialog = null;
        },
        sessionId,
      ),
    );
    this.states.set(info.targetId, state);
    if (this.engine === "chromium") {
      try {
        await this.attachFrameSessions(connection, state, sessionId, state.unsubscribe);
      } catch (error) {
        // Without OOPIF sessions cross-origin frames stay opaque, as before.
        if (error instanceof CdpTransportError) throw error;
      }
    }
    return state;
  }

  /**
   * Keeps the tab's request ledger from one session's Network domain: the
   * page's, or a cross-origin iframe's. Such a frame's document request starts
   * on its parent's session and ends on the frame's own, so every session of
   * a tab shares one ledger keyed by request id. Failed requests are reported
   * from the page session only, as before frames were tracked.
   */
  private trackNetwork(
    connection: BrowserCdpConnection,
    state: TargetState,
    sessionId: string,
    page: boolean,
  ): Array<() => void> {
    const counted = (request: TrackedRequest | undefined) =>
      request === undefined || (!request.ignored && !request.stream);
    return [
      connection.on(
        "Network.requestWillBeSent",
        (event) => {
          const requestId = stringField(event.params, "requestId");
          const now = Date.now();
          let tracked: TrackedRequest | undefined;
          if (requestId) {
            if (state.inflightRequests.size >= 10_000 && !state.inflightRequests.has(requestId)) {
              state.networkTrackingOverflow = true;
            } else {
              state.inflightRequests.add(requestId);
            }
            const request = isRecord(event.params.request) ? event.params.request : {};
            const initiator = isRecord(event.params.initiator) ? event.params.initiator : {};
            const type = stringField(event.params, "type");
            const url = boundedUrlField(request.url) ?? "about:blank";
            // Chrome fetches the page's icon (/favicon.ico or a declared
            // <link rel=icon>) by itself, reported as type Other with an
            // "other" initiator. A missing icon is not a page failure and,
            // being on almost every site, would otherwise show as a failed
            // request in every observation.
            const browserInitiated = type === "Other" && initiator.type === "other";
            tracked = {
              method: boundedMethod(request.method),
              url,
              loaderId: stringField(event.params, "loaderId"),
              browserInitiated,
              stream: type === "EventSource",
              ignored: requestIgnoredForIdle(type, url, browserInitiated),
              type,
              frameId: stringField(event.params, "frameId"),
              sessionId,
              // A redirect is the same request continuing under the same id.
              startedAt: state.requests.get(requestId)?.startedAt ?? now,
              respondedAt: null,
              dataAt: null,
            };
            state.requests.set(requestId, tracked);
            boundMap(state.requests, 10_000);
          }
          state.networkActivitySequence += 1;
          if (counted(tracked)) state.lastNetworkActivityAt = now;
        },
        sessionId,
      ),
      connection.on(
        "Network.loadingFinished",
        (event) => {
          const requestId = stringField(event.params, "requestId");
          const request = requestId ? state.requests.get(requestId) : undefined;
          if (requestId) {
            state.inflightRequests.delete(requestId);
            state.failedRequests.delete(requestId);
            state.requests.delete(requestId);
          }
          state.networkActivitySequence += 1;
          if (counted(request)) state.lastNetworkActivityAt = Date.now();
        },
        sessionId,
      ),
      connection.on(
        "Network.loadingFailed",
        (event) => {
          const requestId = stringField(event.params, "requestId");
          const request = requestId ? state.requests.get(requestId) : undefined;
          if (requestId) {
            state.inflightRequests.delete(requestId);
            // A document request's id is its navigation's loader id. One the
            // browser cancelled (a newer navigation took over) never commits.
            if (
              page &&
              event.params.type === "Document" &&
              (event.params.canceled === true || event.params.errorText === "net::ERR_ABORTED")
            ) {
              state.abandonedLoaders.push(requestId);
              if (state.abandonedLoaders.length > COMMITTED_LOADER_HISTORY)
                state.abandonedLoaders.shift();
            }
            if (
              page &&
              event.params.canceled !== true &&
              event.params.errorText !== "net::ERR_ABORTED"
            ) {
              this.recordFailedRequest(state, requestId, {
                message:
                  boundedTextField(event.params.errorText, 8_192) ?? "Network request failed",
              });
            }
            state.failedRequests.delete(requestId);
            state.requests.delete(requestId);
          }
          state.networkActivitySequence += 1;
          if (counted(request)) state.lastNetworkActivityAt = Date.now();
        },
        sessionId,
      ),
      connection.on(
        "Network.responseReceived",
        (event) => {
          const requestId = stringField(event.params, "requestId");
          const response = isRecord(event.params.response) ? event.params.response : null;
          const request = requestId ? state.requests.get(requestId) : undefined;
          if (request) request.respondedAt = Date.now();
          if (
            request &&
            typeof response?.mimeType === "string" &&
            STREAMING_MIME_TYPES.has(response.mimeType.split(";")[0]!.trim().toLowerCase())
          ) {
            request.stream = true;
          }
          if (page && requestId && typeof response?.status === "number" && response.status >= 400) {
            this.recordFailedRequest(state, requestId, {
              message: `HTTP ${Math.trunc(response.status)}`,
              status: Math.trunc(response.status),
              url: boundedUrlField(response.url),
            });
          }
        },
        sessionId,
      ),
      connection.on(
        "Network.dataReceived",
        (event) => {
          const requestId = stringField(event.params, "requestId");
          const request = requestId ? state.requests.get(requestId) : undefined;
          if (request) request.dataAt = Date.now();
        },
        sessionId,
      ),
    ];
  }

  /**
   * A shared worker belongs to no single tab, yet a page's request for its
   * script starts on the page's session and finishes on the worker's. Settle
   * such requests in whichever tab's ledger holds them; the worker's own
   * requests are not any tab's loading.
   */
  private finishPageRequests(
    connection: BrowserCdpConnection,
    sessionId: string,
  ): Array<() => void> {
    const holders = (event: { params: Record<string, unknown> }) => {
      const requestId = stringField(event.params, "requestId");
      if (!requestId) return [];
      return [...this.states.values()].flatMap((state) => {
        const request = state.requests.get(requestId);
        return request ? [{ state, requestId, request }] : [];
      });
    };
    const finish = (event: { params: Record<string, unknown> }) => {
      for (const { state, requestId, request } of holders(event)) {
        state.inflightRequests.delete(requestId);
        state.failedRequests.delete(requestId);
        state.requests.delete(requestId);
        state.networkActivitySequence += 1;
        if (!request.ignored && !request.stream) state.lastNetworkActivityAt = Date.now();
      }
    };
    return [
      connection.on(
        "Network.responseReceived",
        (event) => {
          for (const { request } of holders(event)) request.respondedAt = Date.now();
        },
        sessionId,
      ),
      connection.on(
        "Network.dataReceived",
        (event) => {
          for (const { request } of holders(event)) request.dataAt = Date.now();
        },
        sessionId,
      ),
      connection.on("Network.loadingFinished", finish, sessionId),
      connection.on("Network.loadingFailed", finish, sessionId),
    ];
  }

  /** A cross-origin iframe's document request started on its parent's session.
   * Once the frame has stopped loading, or is gone, it can no longer be loading
   * however the frame's own session reported it. */
  private finishFrameDocuments(state: TargetState, frameIds: ReadonlySet<string>): void {
    for (const requestId of [...state.inflightRequests]) {
      const request = state.requests.get(requestId);
      if (request?.type !== "Document" || !request.frameId || !frameIds.has(request.frameId))
        continue;
      state.inflightRequests.delete(requestId);
      state.requests.delete(requestId);
      state.lastNetworkActivityAt = Date.now();
    }
  }

  /** Auto-attaches the cross-origin frames and dedicated workers a page,
   * frame or worker session starts. Its listeners join `owner`, the list that
   * session's own teardown runs. */
  private async attachFrameSessions(
    connection: BrowserCdpConnection,
    state: TargetState,
    parentSessionId: string,
    owner: Array<() => void>,
  ): Promise<void> {
    owner.push(
      connection.on(
        "Target.attachedToTarget",
        (event) => void this.onFrameAttached(connection, state, parentSessionId, event.params),
        parentSessionId,
      ),
      connection.on(
        "Target.detachedFromTarget",
        (event) => {
          if (typeof event.params.sessionId === "string")
            this.forgetFrameSession(state, event.params.sessionId);
        },
        parentSessionId,
      ),
    );
    await connection.send(
      "Target.setAutoAttach",
      {
        autoAttach: true,
        // A new frame or dedicated worker waits until its session listens, so
        // the requests its first scripts start are seen. Chromium holds a
        // page's dedicated workers whatever the filter says, so they are
        // attached too; onFrameAttached always resumes what it attached.
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: "iframe" }, { type: "worker" }],
      },
      { sessionId: parentSessionId },
    );
  }

  private async onFrameAttached(
    connection: BrowserCdpConnection,
    state: TargetState,
    parentSessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string") return;
    const waiting = params.waitingForDebugger === true;
    let info: TargetInfo;
    try {
      info = normalizeTargetInfo(params.targetInfo);
    } catch {
      if (waiting)
        await connection
          .send("Runtime.runIfWaitingForDebugger", {}, { sessionId })
          .catch(() => undefined);
      return;
    }
    try {
      if (info.type === "worker" && this.states.get(state.targetId) === state) {
        await this.onWorkerAttached(connection, state, parentSessionId, sessionId);
        return;
      }
      if (info.type !== "iframe" || this.states.get(state.targetId) !== state) {
        if (waiting) await connection.send("Runtime.runIfWaitingForDebugger", {}, { sessionId });
        await connection.send(
          "Target.detachFromTarget",
          { sessionId },
          { sessionId: parentSessionId },
        );
        return;
      }
      // A frame that moved to another process can attach its new session
      // before the old one detaches: retire the old one now.
      const replaced = state.oopifs.get(info.targetId);
      if (replaced && replaced.sessionId !== sessionId)
        this.forgetFrameSession(state, replaced.sessionId);
      // A cross-origin iframe's target id is its frame id.
      const oopif: OopifSession = {
        frameId: info.targetId,
        sessionId,
        parentSessionId,
        frameIds: new Set([info.targetId]),
        unsubscribe: [],
      };
      state.oopifs.set(info.targetId, oopif);
      // The frame's requests count toward the tab's network activity, and its
      // document request, begun on the parent's session, finishes here.
      oopif.unsubscribe.push(
        ...this.trackNetwork(connection, state, sessionId, false),
        connection.on(
          "Page.frameStoppedLoading",
          (event) => {
            const frameId = stringField(event.params, "frameId");
            if (frameId) this.finishFrameDocuments(state, new Set([frameId]));
          },
          sessionId,
        ),
      );
      state.accessibility = null;
      await Promise.all([
        connection.send("DOM.enable", {}, { sessionId }),
        connection.send("Page.enable", {}, { sessionId }),
        connection.send("Accessibility.enable", {}, { sessionId }),
        connection.send("Network.enable", {}, { sessionId }),
      ]);
      // A frame that was already running when its session attached (one the
      // page had before this controller) may have finished loading unheard.
      if (!waiting) {
        const loaded = await connection
          .send<{ result?: { value?: unknown } }>(
            "Runtime.evaluate",
            {
              expression: "location.href !== 'about:blank' && document.readyState === 'complete'",
              returnByValue: true,
            },
            { sessionId, timeoutMs: 5_000 },
          )
          .catch(() => null);
        if (loaded?.result?.value === true)
          this.finishFrameDocuments(state, new Set([info.targetId]));
      }
      await this.attachFrameSessions(connection, state, sessionId, oopif.unsubscribe);
    } catch {
      // A frame that navigated away or closed during setup is simply absent.
    } finally {
      if (waiting)
        await connection
          .send("Runtime.runIfWaitingForDebugger", {}, { sessionId })
          .catch(() => undefined);
    }
  }

  /** A dedicated worker's requests count toward its page's network activity,
   * and its own script request, begun on its parent's session, finishes on the
   * worker's. Workers it starts attach through its session in turn. The
   * caller resumes the worker. */
  private async onWorkerAttached(
    connection: BrowserCdpConnection,
    state: TargetState,
    parentSessionId: string,
    sessionId: string,
  ): Promise<void> {
    const worker = {
      parentSessionId,
      unsubscribe: this.trackNetwork(connection, state, sessionId, false),
    };
    state.workers.set(sessionId, worker);
    await connection.send("Network.enable", {}, { sessionId, timeoutMs: 5_000 });
    await this.attachFrameSessions(connection, state, sessionId, worker.unsubscribe);
  }

  private forgetFrameSession(state: TargetState, sessionId: string): void {
    const worker = state.workers.get(sessionId);
    if (worker) {
      state.workers.delete(sessionId);
      for (const stop of worker.unsubscribe.splice(0)) stop();
      this.forgetSessionRequests(state, sessionId);
      this.forgetChildSessions(state, sessionId);
      return;
    }
    for (const oopif of [...state.oopifs.values()]) {
      if (oopif.sessionId !== sessionId) continue;
      state.oopifs.delete(oopif.frameId);
      if (state.nodeRoute === oopif) state.nodeRoute = null;
      state.accessibility = null;
      for (const stop of oopif.unsubscribe.splice(0)) stop();
      this.forgetSessionRequests(state, sessionId);
      this.finishFrameDocuments(state, oopif.frameIds);
      this.forgetChildSessions(state, sessionId);
    }
  }

  /** Nested frames and workers go with the session that attached them; their
   * own detach is not always reported. */
  private forgetChildSessions(state: TargetState, parentSessionId: string): void {
    for (const nested of [...state.oopifs.values()]) {
      if (nested.parentSessionId === parentSessionId)
        this.forgetFrameSession(state, nested.sessionId);
    }
    for (const [workerSessionId, worker] of [...state.workers]) {
      if (worker.parentSessionId === parentSessionId)
        this.forgetFrameSession(state, workerSessionId);
    }
  }

  /** Nothing reports the requests of a frame or worker that is gone. */
  private forgetSessionRequests(state: TargetState, sessionId: string): void {
    for (const requestId of [...state.inflightRequests]) {
      if (state.requests.get(requestId)?.sessionId !== sessionId) continue;
      state.inflightRequests.delete(requestId);
      state.requests.delete(requestId);
    }
  }

  private oopifForFrame(state: TargetState, frameId: string | null): OopifSession | null {
    if (!frameId) return null;
    for (const oopif of state.oopifs.values()) {
      if (oopif.frameIds.has(frameId)) return oopif;
    }
    return null;
  }

  /**
   * Accessibility nodes of every cross-origin iframe, each document root
   * placed under its `<iframe>` owner and described with the frame's origin.
   * A frame that detaches or navigates mid-read is omitted from this snapshot.
   */
  private async oopifAccessibility(
    state: TargetState,
    pageFrames: readonly MainFrame[],
    pageNodes: readonly CdpAxNode[],
    rebuild: boolean,
  ): Promise<CdpAxNode[]> {
    const connection = await this.ensureConnection();
    const known = [...pageNodes];
    const merged: CdpAxNode[] = [];
    const framesBySession = new Map<string, Set<string>>([
      [state.sessionId, new Set(pageFrames.map((frame) => frame.id))],
    ]);
    // Outer frames first, so a nested frame's owner is already merged.
    const pending = [...state.oopifs.values()];
    for (let round = 0; pending.length > 0 && round < 8; round += 1) {
      for (const oopif of pending.splice(0)) {
        const parentFrames = framesBySession.get(oopif.parentSessionId);
        if (!parentFrames) {
          pending.push(oopif);
          continue;
        }
        try {
          const frames = flattenFrameTree(await this.frameTree(oopif.sessionId));
          oopif.frameIds = new Set(frames.map((frame) => frame.id));
          framesBySession.set(oopif.sessionId, oopif.frameIds);
          const owner = await connection.send<{ backendNodeId?: unknown }>(
            "DOM.getFrameOwner",
            { frameId: oopif.frameId },
            { sessionId: oopif.parentSessionId },
          );
          const ownerNode = known.find(
            (node) =>
              typeof node.frameId === "string" &&
              parentFrames.has(node.frameId) &&
              node.backendDOMNodeId === owner.backendNodeId,
          );
          if (!ownerNode || typeof ownerNode.nodeId !== "string") continue;
          if (rebuild) await this.rebuildAccessibility(oopif.sessionId);
          const nodes = await this.collectAccessibilityFrames(oopif.sessionId, frames);
          const ids = new Set(nodes.map((node) => node.nodeId));
          const origin = frameOrigin(frames[0]?.url);
          for (const node of nodes) {
            if (node.frameId !== oopif.frameId || typeof node.nodeId !== "string") continue;
            if (typeof node.parentId === "string" && ids.has(node.parentId)) continue;
            node.parentId = ownerNode.nodeId;
            ownerNode.childIds = [
              ...(Array.isArray(ownerNode.childIds) ? ownerNode.childIds : []),
              node.nodeId,
            ];
            if (origin) node.description = { value: `Cross-origin frame ${origin}` };
          }
          known.push(...nodes);
          merged.push(...nodes);
        } catch (error) {
          if (error instanceof CdpTransportError) throw error;
        }
      }
    }
    return merged;
  }

  /** Top-left of a cross-origin frame's viewport in page coordinates. */
  private async frameOffset(
    state: TargetState,
    oopif: OopifSession,
  ): Promise<{ x: number; y: number }> {
    const connection = await this.ensureConnection();
    let x = 0;
    let y = 0;
    for (const current of this.frameChain(state, oopif)) {
      const owner = await connection.send<{ backendNodeId?: unknown }>(
        "DOM.getFrameOwner",
        { frameId: current.frameId },
        { sessionId: current.parentSessionId },
      );
      const box = await connection.send<{ model?: unknown }>(
        "DOM.getBoxModel",
        { backendNodeId: owner.backendNodeId },
        { sessionId: current.parentSessionId },
      );
      const content =
        isRecord(box.model) && Array.isArray(box.model.content)
          ? box.model.content.filter(
              (value): value is number => typeof value === "number" && Number.isFinite(value),
            )
          : [];
      if (content.length < 8) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser frame has no visible action point",
          true,
        );
      }
      x += Math.min(content[0]!, content[2]!, content[4]!, content[6]!);
      y += Math.min(content[1]!, content[3]!, content[5]!, content[7]!);
    }
    return { x, y };
  }

  /** The cross-origin frames from the page down to this one, outermost first. */
  private frameChain(state: TargetState, oopif: OopifSession): OopifSession[] {
    const chain: OopifSession[] = [];
    let current: OopifSession | undefined = oopif;
    while (current && chain.length < 8) {
      chain.unshift(current);
      const parentSessionId: string = current.parentSessionId;
      current = [...state.oopifs.values()].find(
        (candidate) => candidate.sessionId === parentSessionId,
      );
    }
    return chain;
  }

  /** Scroll each `<iframe>` holding the routed node into its parent's view. */
  private async scrollFrameOwnersIntoView(state: TargetState, oopif: OopifSession): Promise<void> {
    const connection = await this.ensureConnection();
    for (const frame of this.frameChain(state, oopif)) {
      const owner = await connection.send<{ backendNodeId?: unknown }>(
        "DOM.getFrameOwner",
        { frameId: frame.frameId },
        { sessionId: frame.parentSessionId },
      );
      await connection.send(
        "DOM.scrollIntoViewIfNeeded",
        { backendNodeId: owner.backendNodeId },
        { sessionId: frame.parentSessionId },
      );
    }
  }

  /** Focus each `<iframe>` element on the way to a node in a cross-origin frame,
   * so page-level key input reaches that frame. */
  private async focusFrameOwners(state: TargetState, oopif: OopifSession): Promise<void> {
    const connection = await this.ensureConnection();
    for (const frame of this.frameChain(state, oopif)) {
      const owner = await connection.send<{ backendNodeId?: unknown }>(
        "DOM.getFrameOwner",
        { frameId: frame.frameId },
        { sessionId: frame.parentSessionId },
      );
      await connection.send(
        "DOM.focus",
        { backendNodeId: owner.backendNodeId },
        { sessionId: frame.parentSessionId },
      );
    }
  }

  /** The size a tab being attached should have: its own, or the session's
   * when the tab opened after the agent set one. */
  private viewportFor(targetId: string): ViewportEmulation | null {
    const own = this.targetViewports.get(targetId);
    if (own) return own;
    const session = this.sessionViewport;
    if (!session || session.preexisting.has(targetId)) return null;
    this.targetViewports.set(targetId, session.viewport);
    return session.viewport;
  }

  private async applyViewport(
    connection: BrowserCdpConnection,
    sessionId: string,
    viewport: ViewportEmulation,
  ): Promise<void> {
    await connection.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: viewport.mobile,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
      },
      { sessionId },
    );
    await connection.send(
      "Emulation.setTouchEmulationEnabled",
      { enabled: viewport.mobile, ...(viewport.mobile ? { maxTouchPoints: 1 } : {}) },
      { sessionId },
    );
  }

  private async applyEmulation(connection: BrowserCdpConnection, sessionId: string): Promise<void> {
    if (this.focusEmulation) {
      // Hidden pages otherwise pause animation callbacks when no viewer is
      // capturing them. This target-local DevTools override keeps them active
      // without activating a tab or taking the desktop's foreground seat.
      // Chrome also holds each mouse event sent to a hidden page for about
      // five seconds before acknowledging it.
      // Chromium clears the override when this attachment disconnects.
      try {
        await connection.send(
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
          { sessionId },
        );
      } catch (error) {
        // A connected Chrome extension released before it admitted this
        // method rejects it; the page still works, only slower.
        if (!(error instanceof CdpProtocolError)) throw error;
        this.focusEmulation = false;
      }
    }
    if (this.presentedUserAgent && !this.emulation?.locale) {
      // The auto-attached session already presents it; this attachment holds
      // it too, so a page attached without one still presents it.
      await connection.send("Emulation.setUserAgentOverride", this.presentedUserAgent, {
        sessionId,
      });
    }
    if (!this.emulation) return;
    if (this.emulation.locale) {
      if (!this.userAgent) {
        throw new Error("browser did not expose a user agent for locale emulation");
      }
      const userAgentMetadata = await this.normalUserAgentMetadata(connection, sessionId);
      await this.applyInheritedStringOverride({
        connection,
        sessionId,
        method: "Emulation.setLocaleOverride",
        params: { locale: this.emulation.locale },
        expression: "Intl.DateTimeFormat().resolvedOptions().locale",
        expected: this.emulation.locale,
        normalize: normalizeLocale,
      });
      await connection.send(
        "Emulation.setUserAgentOverride",
        {
          userAgent: this.userAgent,
          acceptLanguage: this.emulation.locale,
          userAgentMetadata,
        },
        { sessionId },
      );
    }
    if (this.emulation.timezone) {
      await this.applyInheritedStringOverride({
        connection,
        sessionId,
        method: "Emulation.setTimezoneOverride",
        params: { timezoneId: this.emulation.timezone },
        expression: "Intl.DateTimeFormat().resolvedOptions().timeZone",
        expected: this.emulation.timezone,
        normalize: (value) => value,
      });
    }
    if (this.emulation.geolocation) {
      await connection.send(
        "Emulation.setGeolocationOverride",
        {
          latitude: this.emulation.geolocation.latitude,
          longitude: this.emulation.geolocation.longitude,
          accuracy: this.emulation.geolocation.accuracyMeters,
        },
        { sessionId },
      );
    }
  }

  private async applyInheritedStringOverride(options: {
    connection: BrowserCdpConnection;
    sessionId: string;
    method: "Emulation.setLocaleOverride" | "Emulation.setTimezoneOverride";
    params: Readonly<Record<string, unknown>>;
    expression: string;
    expected: string;
    normalize: (value: string) => string;
  }): Promise<void> {
    try {
      await options.connection.send(options.method, options.params, {
        sessionId: options.sessionId,
      });
      return;
    } catch (error) {
      if (!(error instanceof CdpProtocolError) || error.method !== options.method) throw error;
      const current = await options.connection.send<{
        result?: unknown;
        exceptionDetails?: unknown;
      }>(
        "Runtime.evaluate",
        { expression: options.expression, returnByValue: true },
        { sessionId: options.sessionId },
      );
      const value = isRecord(current.result) ? current.result.value : null;
      if (
        current.exceptionDetails ||
        typeof value !== "string" ||
        options.normalize(value) !== options.normalize(options.expected)
      ) {
        throw error;
      }
    }
  }

  private async normalUserAgentMetadata(
    connection: BrowserCdpConnection,
    sessionId: string,
  ): Promise<BrowserUserAgentMetadata> {
    if (this.presentedUserAgent) return this.presentedUserAgent.userAgentMetadata;
    if (!this.userAgentMetadataPromise) {
      this.userAgentMetadataPromise = this.loadNormalUserAgentMetadata(connection, sessionId);
    }
    try {
      return await this.userAgentMetadataPromise;
    } catch (error) {
      this.userAgentMetadataPromise = null;
      throw error;
    }
  }

  private async loadNormalUserAgentMetadata(
    connection: BrowserCdpConnection,
    sessionId: string,
  ): Promise<BrowserUserAgentMetadata> {
    let evaluated: { result?: unknown; exceptionDetails?: unknown } | null = null;
    try {
      evaluated = await connection.send<{
        result?: unknown;
        exceptionDetails?: unknown;
      }>(
        "Runtime.evaluate",
        {
          expression: USER_AGENT_METADATA_EXPRESSION,
          awaitPromise: true,
          returnByValue: true,
        },
        { sessionId },
      );
    } catch (error) {
      // A page still loading after a relaunch restored it may have no
      // JavaScript context yet; the hidden target below has its own.
      if (!missingExecutionContext(error)) throw error;
    }
    if (
      evaluated &&
      !evaluated.exceptionDetails &&
      isRecord(evaluated.result) &&
      evaluated.result.value !== null &&
      evaluated.result.value !== undefined
    ) {
      return parseUserAgentMetadata(evaluated.result.value);
    }
    return await this.loadUserAgentMetadataFromHiddenTarget(connection);
  }

  /**
   * The User-Agent to present when Chrome's switch emptied its high-entropy
   * Client Hints: Chrome's own brands and full version with this machine's
   * platform version and architecture. Null when the hints are already
   * complete, or cannot be read or derived; Chrome's own then stay.
   */
  private async loadPresentedUserAgent(
    connection: BrowserCdpConnection,
  ): Promise<PresentedUserAgent | null> {
    const separator = this.browserProduct.indexOf("/");
    const browserVersion = separator >= 0 ? this.browserProduct.slice(separator + 1) : "";
    if (!this.userAgent || !/^\d+(\.\d+){3}$/u.test(browserVersion)) return null;
    let metadata: BrowserUserAgentMetadata;
    try {
      metadata = await this.loadUserAgentMetadataFromHiddenTarget(connection);
    } catch (error) {
      if (error instanceof CdpTransportError) throw error;
      return null;
    }
    if (!hasEmptiedHighEntropyHints(metadata)) return null;
    const host = await hostClientHints().catch(() => null);
    if (!host) return null;
    return {
      userAgent: this.userAgent,
      userAgentMetadata: completeClientHints(metadata, browserVersion, host),
    };
  }

  private async loadUserAgentMetadataFromHiddenTarget(
    connection: BrowserCdpConnection,
  ): Promise<BrowserUserAgentMetadata> {
    const created = await connection.send<{ targetId?: unknown }>("Target.createTarget", {
      ...this.contextScope(),
      url: "about:blank",
      hidden: true,
    });
    if (typeof created.targetId !== "string") {
      throw new Error("browser could not create a hidden metadata target");
    }
    let metadata: BrowserUserAgentMetadata | null = null;
    let metadataError: unknown = null;
    try {
      const attached = await connection.send<{ sessionId?: unknown }>("Target.attachToTarget", {
        targetId: created.targetId,
        flatten: true,
      });
      if (typeof attached.sessionId !== "string") {
        throw new Error("browser could not attach its hidden metadata target");
      }
      await connection.send("Page.enable", {}, { sessionId: attached.sessionId });
      if (this.userAgentMetadataSource === "intercepted_local") {
        await navigateToInterceptedMetadataDocument(connection, attached.sessionId);
      } else {
        await navigateBrowserMetadataDocument(connection, attached.sessionId, "chrome://version/");
      }
      const evaluated = await connection.send<{
        result?: unknown;
        exceptionDetails?: unknown;
      }>(
        "Runtime.evaluate",
        {
          expression: USER_AGENT_METADATA_EXPRESSION,
          awaitPromise: true,
          returnByValue: true,
        },
        { sessionId: attached.sessionId },
      );
      if (evaluated.exceptionDetails || !isRecord(evaluated.result)) {
        throw new Error("browser could not preserve User-Agent metadata for locale emulation");
      }
      metadata = parseUserAgentMetadata(evaluated.result.value);
    } catch (error) {
      metadataError = error;
    }
    let closeError: unknown = null;
    try {
      const closed = await connection.send<{ success?: unknown }>("Target.closeTarget", {
        targetId: created.targetId,
      });
      if (closed.success !== true) {
        throw new Error("browser could not close its hidden metadata target");
      }
    } catch (error) {
      closeError = error;
    }
    if (metadataError && closeError) {
      throw new AggregateError(
        [metadataError, closeError],
        "browser metadata discovery and cleanup both failed",
      );
    }
    if (metadataError) throw metadataError;
    if (closeError) throw closeError;
    if (!metadata) throw new Error("browser returned no User-Agent metadata");
    return metadata;
  }

  private async observeUnlocked(
    state: TargetState,
    info: TargetInfo,
  ): Promise<BrowserObservationValue> {
    if (!state.dialog) await this.refreshFrame(state);
    const viewport = state.dialog ? null : await this.viewport(state);
    let accessibility =
      state.dialog && state.accessibility
        ? state.accessibility
        : state.dialog
          ? emptyAccessibilitySnapshot()
          : await this.refreshAccessibility(state, "outline");
    if (!state.dialog) {
      const panels = await this.scrollPanels(state);
      if (panels.size > 0) accessibility = withScrollPanels(accessibility, state.frame.id, panels);
    }
    const focused = accessibility.focusedRef
      ? accessibility.entriesByRef.get(accessibility.focusedRef)
      : null;
    if (!state.dialog && focused?.actions.includes("select") && focused.frameId) {
      // Native popup windows are absent from page screenshots. Expose only the
      // focused control, through the same isolated-world redaction and budget
      // as focused DOM reads; never alter the page to draw a fake popup.
      let read: unknown = null;
      try {
        state.nodeRoute = this.oopifForFrame(state, focused.frameId);
        read = await this.callOnNode(
          state,
          focused.backendDOMNodeId,
          DOM_READ_FUNCTION,
          [{ value: 16_384 }, { value: [] }, { value: true }],
          { isolatedFrameId: focused.frameId },
        );
      } catch (error) {
        // This optional projection may lose its node after the AX snapshot.
        // Omit choices in that case; transport/context failures still propagate.
        const disappeared =
          (error instanceof CdpProtocolError &&
            error.method === "DOM.resolveNode" &&
            error.code === -32000 &&
            error.message === "No node with given id found") ||
          (error instanceof InteractionDefiniteDriverError && error.code === "locator_not_found");
        if (!disappeared) throw error;
      } finally {
        state.nodeRoute = null;
      }
      if (
        isRecord(read) &&
        read.redacted === null &&
        read.truncated === false &&
        isRecord(read.select)
      ) {
        const visit = (nodes: typeof accessibility.roots): void => {
          for (const node of nodes) {
            if (node.ref === focused.ref)
              node.native = {
                platform: "dom",
                data: read.select as NonNullable<InteractionSemanticNodeValue["native"]>["data"],
              };
            if (node.children) visit(node.children);
          }
        };
        visit(accessibility.roots);
      }
    }
    this.assertCurrentTargetState(state);
    return BrowserObservation.parse({
      protocolVersion: INTERACTION_PROTOCOL_VERSION,
      observationId: `observation-${this.createId()}`,
      browserSessionId: this.browserSessionId,
      target: this.targetFromInfo(info, state),
      frameId: state.frameGeneration,
      semantic: {
        kind: "snapshot",
        roots: accessibility.roots,
        nodeCount: accessibility.nodeCount,
      },
      screenshot: null,
      viewport,
      focusedRef: accessibility.focusedRef,
      changedRegions: [],
      diagnostics: state.diagnostics,
      dialog: state.dialog,
      observedAt: this.timestamp(),
    });
  }

  private async mayHaveFocusedNativeSelect(state: TargetState): Promise<boolean> {
    const world = await this.sendTarget<{ executionContextId?: number }>(
      state,
      "Page.createIsolatedWorld",
      { frameId: state.frame.id, worldName: "opengeni-dom-read" },
      { timeoutMs: 500 },
    );
    if (!Number.isSafeInteger(world.executionContextId)) return false;
    const result = await this.sendTarget<{ result?: { value?: unknown } }>(
      state,
      "Runtime.evaluate",
      {
        contextId: world.executionContextId,
        expression: `(() => {
          let element = document.activeElement;
          for (let depth = 0; depth < 32 && element?.shadowRoot?.activeElement; depth++)
            element = element.shadowRoot.activeElement;
          return ["SELECT", "IFRAME", "FRAME"].includes(element?.tagName);
        })()`,
        returnByValue: true,
      },
      { timeoutMs: 500 },
    );
    return result.result?.value === true;
  }

  /** The main frame's visible scrolling panels, by backend node, with the
   * directions each can still scroll ("down", "up,down"). The outline marks
   * them so an agent can scroll the panel that holds the content, not the
   * fixed layout around it. Optional: a page that cannot be read this way
   * gets no marks. */
  private async scrollPanels(state: TargetState): Promise<Map<number, string>> {
    const panels = new Map<number, string>();
    if (this.engine === "lightpanda") return panels;
    const objectGroup = "opengeni-scroll-panels";
    try {
      const world = await this.sendTarget<{ executionContextId?: unknown }>(
        state,
        "Page.createIsolatedWorld",
        { frameId: state.frame.id, worldName: "opengeni-dom-read" },
      );
      if (!Number.isSafeInteger(world.executionContextId)) return panels;
      const evaluated = await this.sendTarget<{ result?: unknown; exceptionDetails?: unknown }>(
        state,
        "Runtime.evaluate",
        {
          contextId: world.executionContextId,
          expression: SCROLL_PANELS_EXPRESSION,
          objectGroup,
          returnByValue: false,
        },
      );
      if (
        evaluated.exceptionDetails ||
        !isRecord(evaluated.result) ||
        typeof evaluated.result.objectId !== "string"
      )
        return panels;
      const properties = await this.sendTarget<{ result?: unknown }>(
        state,
        "Runtime.getProperties",
        { objectId: evaluated.result.objectId, ownProperties: true },
      );
      if (!Array.isArray(properties.result)) return panels;
      const byIndex = new Map<number, Record<string, unknown>>();
      for (const property of properties.result) {
        if (!isRecord(property) || !isRecord(property.value)) continue;
        const index = Number(property.name);
        if (Number.isSafeInteger(index) && index >= 0) byIndex.set(index, property.value);
      }
      const directions = byIndex.get(0)?.value;
      if (typeof directions !== "string" || directions === "") return panels;
      const described = await Promise.all(
        directions.split("|").map(async (direction, index) => {
          const objectId = byIndex.get(index + 1)?.objectId;
          if (typeof objectId !== "string") return null;
          const node = await this.sendTarget<{ node?: unknown }>(state, "DOM.describeNode", {
            objectId,
          });
          return isRecord(node.node) && typeof node.node.backendNodeId === "number"
            ? ([node.node.backendNodeId, direction] as const)
            : null;
        }),
      );
      for (const entry of described) if (entry) panels.set(entry[0], entry[1]);
      return panels;
    } catch (error) {
      // The page navigated or the node went away while it was read.
      if (error instanceof CdpProtocolError) return new Map();
      throw error;
    } finally {
      await this.sendTarget(state, "Runtime.releaseObjectGroup", { objectGroup }).catch(
        () => undefined,
      );
    }
  }

  /**
   * Read the tab's accessibility tree, first rebuilding Chromium's tree when
   * accessibilityRebuildWanted says this read should.
   */
  private async refreshAccessibility(
    state: TargetState,
    read: AccessibilityRead = "read",
  ): Promise<CdpAccessibilitySnapshot> {
    const rebuilding =
      this.engine !== "lightpanda" &&
      accessibilityRebuildWanted({
        read,
        lastNodeCount: state.accessibilityNodeCount,
        firstReadOfCall: state.accessibilityRebuildDue,
        msSinceRebuild: Date.now() - state.accessibilityRebuiltAt,
      });
    for (let attempt = 0; attempt < ACCESSIBILITY_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const before = flattenFrameTree(await this.frameTree(state.sessionId));
      // The snapshot carries the current document's generation, so it must be
      // read from that document: a commit since the frame was last read makes
      // the new page current first, and the read starts over.
      const main = before[0];
      if (main && (main.loaderId !== state.frame.loaderId || main.id !== state.frame.id)) {
        this.assertCurrentTargetState(state);
        this.adoptMainFrame(state, main);
        continue;
      }
      if (rebuilding) await this.rebuildAccessibility(state.sessionId);
      state.accessibilityRebuildDue = false;
      const nodes = await this.collectAccessibilityFrames(state.sessionId, before);
      if (state.oopifs.size > 0)
        nodes.push(...(await this.oopifAccessibility(state, before, nodes, rebuilding)));
      const after = flattenFrameTree(await this.frameTree(state.sessionId));
      if (frameTreeFingerprint(before) !== frameTreeFingerprint(after)) {
        continue;
      }
      const accessibility = normalizeCdpAccessibilityTree({
        nodes,
        controllerGeneration: this.controllerGeneration,
        targetId: state.targetId,
        documentGeneration: state.documentGeneration,
      });
      this.assertCurrentTargetState(state);
      state.accessibility = accessibility;
      state.accessibilityNodeCount = nodes.length;
      if (rebuilding) state.accessibilityRebuiltAt = Date.now();
      return accessibility;
    }
    throw new Error("browser frame tree did not settle for a bounded accessibility observation");
  }

  /**
   * Chromium updates its accessibility tree incrementally and can miss a
   * change: content assigned to a shadow-root slot after that slot was laid
   * out stays out of the tree (or is reported as not rendered) while it is
   * on screen, so a custom context menu can be visible yet absent. Restarting
   * the domain makes the next read build the tree from the current DOM and
   * layout, at some cost on large pages, so refreshAccessibility rebuilds it
   * only for the reads that matter. DOM-backed node ids are DOM node ids, so
   * refs survive the rebuild (see normalizeCdpAccessibilityTree for the
   * others).
   */
  private async rebuildAccessibility(sessionId: string): Promise<void> {
    if (this.engine === "lightpanda") return;
    const connection = await this.ensureConnection();
    await connection.send("Accessibility.disable", {}, { sessionId });
    await connection.send("Accessibility.enable", {}, { sessionId });
  }

  private async collectAccessibilityFrames(
    sessionId: string,
    frames: readonly MainFrame[],
  ): Promise<CdpAxNode[]> {
    const nodes: CdpAxNode[] = [];
    for (let offset = 0; offset < frames.length; offset += ACCESSIBILITY_FRAME_CONCURRENCY) {
      const batch = frames.slice(offset, offset + ACCESSIBILITY_FRAME_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (frame) => ({
          frame,
          nodes: await this.accessibilityFrame(sessionId, frame),
        })),
      );
      const hasFailure = results.some((result) => result.status === "rejected");
      const current = hasFailure
        ? new Map(
            flattenFrameTree(await this.frameTree(sessionId)).map((frame) => [frame.id, frame]),
          )
        : null;
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") {
          nodes.push(...result.value.nodes);
          continue;
        }
        const currentFrame = current?.get(batch[index]!.id);
        if (currentFrame) nodes.push(...(await this.accessibilityFrame(sessionId, currentFrame)));
      }
    }
    return nodes;
  }

  private async accessibilityFrame(sessionId: string, frame: MainFrame): Promise<CdpAxNode[]> {
    const connection = await this.ensureConnection();
    const response = await connection.send<{ nodes?: unknown }>(
      "Accessibility.getFullAXTree",
      { frameId: frame.id },
      { sessionId },
    );
    if (!Array.isArray(response.nodes)) {
      throw new Error("CDP returned an invalid accessibility tree");
    }
    return namespaceCdpAccessibilityFrame(
      frame.id,
      response.nodes as CdpAxNode[],
      `${frame.id}\0${frame.loaderId}`,
    );
  }

  private async refreshFrame(state: TargetState, timeoutMs?: number): Promise<void> {
    const frame = await this.mainFrame(state.sessionId, timeoutMs);
    this.assertCurrentTargetState(state);
    this.adoptMainFrame(state, frame);
  }

  /**
   * Make `frame` the target's current main-frame document. Every generation a
   * receipt reports (its URL, outline refs, fences and screenshot labels)
   * derives from this one state, so a new document replaces all of them at
   * once and drops the old document's accessibility snapshot.
   */
  private adoptMainFrame(state: TargetState, frame: MainFrame): void {
    if (frame.loaderId === state.frame.loaderId && frame.id === state.frame.id) {
      // A new URL in the same document is a same-document commit (pushState,
      // a fragment), seen here before its event when the frame is read first.
      if (frame.url !== state.frame.url) state.mainFrameCommits += 1;
      state.frame = frame;
      return;
    }
    state.frame = frame;
    state.mainFrameCommits += 1;
    state.documentGeneration = documentGeneration(
      this.controllerGeneration,
      state.authorityGeneration,
      state.targetId,
      frame.loaderId,
    );
    state.frameGeneration = frameGeneration(
      this.controllerGeneration,
      state.authorityGeneration,
      state.targetId,
      frame.id,
    );
    state.accessibility = null;
    if (!state.committedLoaders.includes(frame.loaderId)) {
      state.committedLoaders.push(frame.loaderId);
      if (state.committedLoaders.length > COMMITTED_LOADER_HISTORY) state.committedLoaders.shift();
    }
  }

  private async mainFrame(sessionId: string, timeoutMs?: number): Promise<MainFrame> {
    return (await this.frameTree(sessionId, timeoutMs)).frame;
  }

  private async frameTree(sessionId: string, timeoutMs?: number): Promise<PageFrameTree> {
    const connection = await this.ensureConnection();
    let response: { frameTree?: unknown };
    try {
      response = await connection.send<{ frameTree?: unknown }>(
        "Page.getFrameTree",
        {},
        { sessionId, ...(timeoutMs ? { timeoutMs } : {}) },
      );
    } catch (error) {
      // Target validation runs before dispatch. Preserve its bounded diagnosis
      // in the receipt without exposing arbitrary provider error text or
      // weakening document/frame fences on an unresponsive renderer.
      if (
        !(error instanceof CdpTransportError) &&
        !(error instanceof CdpSessionDetachedError) &&
        !(error instanceof CdpProtocolError && error.code === -32_000)
      )
        throw error;
      if (error instanceof CdpCommandTimeoutError) throw tabNotRespondingError(error);
      const failure = new InteractionControllerError(
        "resource_unavailable",
        "browser frame inspection unavailable during Page.getFrameTree",
        true,
      );
      failure.cause = error;
      throw failure;
    }
    if (!isRecord(response.frameTree) || !isRecord(response.frameTree.frame)) {
      throw new Error("CDP returned an invalid frame tree");
    }
    return parseFrameTree(response.frameTree);
  }

  private async screenshotRead<T>(
    stage: string,
    deadline: number,
    read: (timeoutMs: number) => Promise<T>,
  ): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new InteractionControllerError(
        "timeout",
        `browser screenshot timed out during ${stage}`,
        true,
      );
    }
    try {
      return await read(remaining);
    } catch (error) {
      const transport = error instanceof InteractionControllerError ? error.cause : error;
      if (!(transport instanceof CdpTransportError)) throw error;
      const timeout = transport instanceof CdpCommandTimeoutError;
      const failure = new InteractionControllerError(
        timeout ? "timeout" : "resource_unavailable",
        `browser screenshot ${timeout ? "timed out" : "unavailable"} during ${stage}`,
        true,
      );
      failure.cause = error;
      throw failure;
    }
  }

  private async layoutMetrics(
    state: TargetState,
    timeoutMs?: number,
  ): Promise<{
    viewport: { x: number; y: number; width: number; height: number };
    content: { width: number; height: number };
  }> {
    const response = await this.sendTarget<{
      cssVisualViewport?: unknown;
      cssContentSize?: unknown;
    }>(state, "Page.getLayoutMetrics", {}, timeoutMs ? { timeoutMs } : undefined);
    const viewport = dimensionsRecord(response.cssVisualViewport, true);
    const content = dimensionsRecord(response.cssContentSize, false);
    return { viewport, content };
  }

  private async viewport(state: TargetState): Promise<BrowserObservationValue["viewport"]> {
    if (this.engine === "lightpanda") return null;
    let result: { result?: unknown; exceptionDetails?: unknown };
    try {
      result = await this.sendTarget<{
        result?: unknown;
        exceptionDetails?: unknown;
      }>(state, "Runtime.evaluate", {
        expression:
          "({width:innerWidth,height:innerHeight,visualWidth:visualViewport?.width??innerWidth,visualHeight:visualViewport?.height??innerHeight,deviceScaleFactor:devicePixelRatio,maxTouchPoints:navigator.maxTouchPoints??0})",
        returnByValue: true,
      });
    } catch (error) {
      // A page between documents (a restored tab still loading) has no
      // JavaScript context to read. The viewport is optional; the
      // observation stays usable without it, as when the page throws.
      if (missingExecutionContext(error)) return null;
      throw error;
    }
    const value = isRecord(result.result) ? result.result.value : null;
    if (result.exceptionDetails || !isRecord(value)) {
      return null;
    }
    // A newly mapped headed window may report zero dimensions before layout.
    // Keep the semantic observation usable without inventing viewport geometry.
    const viewport = BrowserObservation.shape.viewport.safeParse(value);
    return viewport.success ? (viewport.data ?? null) : null;
  }

  private imageFrame(options: {
    state: TargetState;
    sequence: number;
    format: "jpeg" | "png";
    data: Uint8Array;
    width: number;
    height: number;
    deviceScaleFactor: number;
    scrollX: number;
    scrollY: number;
  }): BrowserImageFrame {
    return {
      // This is the causal main-frame generation used by action fences, not a
      // capture id. `sequence` identifies individual images within the stream.
      frameId: options.state.frameGeneration,
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
      targetId: options.state.targetId,
      targetGeneration: this.targetGeneration(options.state.targetId),
      documentGeneration: options.state.documentGeneration,
      sequence: options.sequence,
      mediaType: options.format === "jpeg" ? "image/jpeg" : "image/png",
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.deviceScaleFactor,
      scrollX: options.scrollX,
      scrollY: options.scrollY,
      data: options.data,
      capturedAt: this.timestamp(),
    };
  }

  private async captureFallbackFrame(targetId: string, expected: TargetScreencast): Promise<void> {
    if (expected.capturePromise) return await expected.capturePromise;
    const capture = (async () => {
      // Frame sampling is deliberately outside TargetState.tail. Media is
      // latest-only and must never queue ahead of clicks, typing, navigation,
      // observations, or tab control.
      const state = this.states.get(targetId);
      if (!state) throw new Error("browser target does not exist");
      if (state.screencasts.get(expected.key) !== expected) return;
      const metrics = await this.layoutMetrics(state, FRAME_CAPTURE_TIMEOUT_MS);
      const viewport = metrics.viewport;
      // Reuse the accepted clip scale for this viewport. Inferring a new device
      // scale from rounded image pixels feeds quantization back into every frame
      // and makes an unchanged mobile viewport oscillate in size.
      const previous = expected.captureScale;
      let scale =
        previous?.width === viewport.width && previous.height === viewport.height
          ? previous.scale
          : Math.min(
              1,
              expected.options.maxWidth / viewport.width,
              expected.options.maxHeight / viewport.height,
            );
      let data: Uint8Array<ArrayBufferLike> = new Uint8Array();
      let dimensions = { width: 0, height: 0 };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await this.sendTarget<{ data?: unknown }>(
          state,
          "Page.captureScreenshot",
          {
            format: expected.options.format,
            ...(expected.options.format === "jpeg" ? { quality: expected.options.quality } : {}),
            fromSurface: true,
            captureBeyondViewport: false,
            clip: {
              x: viewport.x,
              y: viewport.y,
              width: viewport.width,
              height: viewport.height,
              scale,
            },
          },
          { timeoutMs: FRAME_CAPTURE_TIMEOUT_MS },
        );
        data = decodeBoundedBase64Image(response.data);
        dimensions = imageDimensions(data, expected.options.format);
        if (
          dimensions.width <= expected.options.maxWidth &&
          dimensions.height <= expected.options.maxHeight
        ) {
          break;
        }
        scale *= Math.min(
          expected.options.maxWidth / dimensions.width,
          expected.options.maxHeight / dimensions.height,
        );
      }
      if (
        dimensions.width > expected.options.maxWidth ||
        dimensions.height > expected.options.maxHeight
      ) {
        throw new Error("browser screenshot could not honor the frame dimension bound");
      }
      if (state.screencasts.get(expected.key) !== expected) return;
      expected.captureScale = { width: viewport.width, height: viewport.height, scale };
      const frame = this.imageFrame({
        state,
        sequence: ++expected.sequence,
        format: expected.options.format,
        data,
        width: dimensions.width,
        height: dimensions.height,
        deviceScaleFactor: finiteScale(dimensions.width / viewport.width),
        scrollX: viewport.x,
        scrollY: viewport.y,
      });
      expected.lastFrameAt = Date.now();
      for (const subscription of expected.subscriptions.values()) subscription.push(frame);
    })();
    expected.capturePromise = capture;
    try {
      await capture;
    } finally {
      if (expected.capturePromise === capture) expected.capturePromise = null;
    }
  }

  private pollFallbackFrames(targetId: string, expected: TargetScreencast): void {
    void (async () => {
      let consecutiveFailures = 0;
      while (!expected.fallbackAbort.signal.aborted) {
        await delay(FRAME_FALLBACK_INTERVAL_MS * expected.options.everyNthFrame);
        if (expected.fallbackAbort.signal.aborted) return;
        const state = this.states.get(targetId);
        if (!state || state.screencasts.get(expected.key) !== expected) return;
        if (Date.now() - expected.lastFrameAt < FRAME_FALLBACK_INTERVAL_MS) continue;
        try {
          await this.captureFallbackFrame(targetId, expected);
          consecutiveFailures = 0;
        } catch (error) {
          consecutiveFailures += 1;
          if (consecutiveFailures < FRAME_CAPTURE_FAILURE_LIMIT) continue;
          const current = this.states.get(targetId);
          if (current?.screencasts.get(expected.key) === expected) {
            this.failScreencast(current, expected, transportError(error));
          }
          return;
        }
      }
    })();
  }

  private refreshSubscribedFrame(targetId: string): void {
    const state = this.states.get(targetId);
    if (!state) return;
    for (const screencast of state.screencasts.values()) {
      void this.captureFallbackFrame(targetId, screencast).catch(() => {
        // The regular fallback loop owns recovery. This eager capture exists only
        // to make an accepted input visible without waiting for its idle cadence.
      });
    }
  }

  private async releaseFrameSubscription(
    targetId: string,
    profileKey: string,
    subscriptionId: string,
  ): Promise<void> {
    const state = this.states.get(targetId);
    if (!state) return;
    const release = state.tail.then(async () => {
      const screencast = state.screencasts.get(profileKey);
      if (!screencast) return;
      screencast.subscriptions.delete(subscriptionId);
      if (screencast.subscriptions.size > 0) return;
      screencast.unsubscribe();
      screencast.fallbackAbort.abort();
      state.screencasts.delete(profileKey);
    });
    state.tail = release.then(
      () => undefined,
      () => undefined,
    );
    await release;
  }

  private failScreencast(state: TargetState, screencast: TargetScreencast, error: Error): void {
    if (state.screencasts.get(screencast.key) !== screencast) return;
    state.screencasts.delete(screencast.key);
    screencast.unsubscribe();
    screencast.fallbackAbort.abort();
    for (const subscription of screencast.subscriptions.values()) subscription.fail(error);
    screencast.subscriptions.clear();
  }

  private failAllScreencasts(state: TargetState, error: Error): void {
    for (const screencast of [...state.screencasts.values()]) {
      this.failScreencast(state, screencast, error);
    }
  }

  /**
   * WebAuthn refuses `navigator.credentials.create()` in a page without focus,
   * and focus emulation does not satisfy it. With passkeys enabled, the tab an
   * action targets comes to the front first (once, until another tab does).
   */
  private async bringToFrontForAction(state: TargetState): Promise<void> {
    if (!this.passkeys || state.dialog || this.frontTargetId === state.targetId) return;
    try {
      await this.sendTarget(state, "Page.bringToFront");
      this.frontTargetId = state.targetId;
    } catch (error) {
      if (!(error instanceof CdpProtocolError)) throw error;
    }
  }

  private async dispatchAction(
    state: TargetState,
    action: BrowserAction,
    operationId: string,
    options: { refindAfterDocumentChange?: boolean } = {},
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.dispatchActionOnce(state, action, operationId);
      return;
    } catch (error) {
      // The page moved to a new document after the action found its element,
      // just before its first input event (which would have landed on the new
      // page at the old element's position). Only an action whose locators
      // follow the page by design (a later action of a batch without
      // fenceEachAction) looks for an element named by role, text or another
      // locator once more there, within its own locator deadline. A single or
      // first action is fenced to the document its caller checked, and a ref
      // names an element of the page the caller saw: both stay refusals.
      const locators = actionLocators(action);
      if (
        options.refindAfterDocumentChange !== true ||
        !(error instanceof DocumentMovedBeforeInputError) ||
        locators.length === 0 ||
        locators.some((locator) => locator.kind === "ref")
      )
        throw error;
      state.locatorDeadline = startedAt + LOCATOR_WAIT_MS;
    }
    try {
      await this.refreshFrame(state);
      await this.dispatchActionOnce(state, action, operationId);
    } catch (error) {
      if (error instanceof InteractionDefiniteDriverError && error.code === "locator_not_found") {
        throw new InteractionDefiniteDriverError(
          "document_stale",
          `browser document changed before the action sent input, and its element was not found on the new page (${error.message}); no input was sent`,
        );
      }
      throw error;
    } finally {
      state.locatorDeadline = null;
    }
  }

  private async dispatchActionOnce(
    state: TargetState,
    action: BrowserAction,
    operationId: string,
  ): Promise<void> {
    state.nodeRoute = null;
    state.inputFence = null;
    switch (action.type) {
      case "navigate":
        await this.navigate(state, action.url);
        return;
      case "history":
        await this.navigateHistory(state, action.direction);
        return;
      case "activate":
        await (
          await this.ensureConnection()
        ).send("Target.activateTarget", {
          targetId: state.targetId,
        });
        this.frontTargetId = state.targetId;
        return;
      case "viewport":
        for (const stream of state.screencasts.values()) stream.captureScale = null;
        if (this.engine === "lightpanda") {
          throw new InteractionDefiniteDriverError(
            "unsupported",
            "this browser engine does not support viewport emulation",
          );
        }
        await this.sendActionTarget(state, "Emulation.setDeviceMetricsOverride", {
          width: action.width,
          height: action.height,
          deviceScaleFactor: action.deviceScaleFactor ?? 1,
          mobile: action.mobile,
          screenWidth: action.width,
          screenHeight: action.height,
        });
        await this.sendActionTarget(state, "Emulation.setTouchEmulationEnabled", {
          enabled: action.mobile,
          ...(action.mobile ? { maxTouchPoints: 1 } : {}),
        });
        state.emulatedViewport = {
          width: action.width,
          height: action.height,
          deviceScaleFactor: action.deviceScaleFactor ?? 1,
        };
        {
          const viewport = { ...state.emulatedViewport, mobile: action.mobile };
          this.targetViewports.set(state.targetId, viewport);
          this.sessionViewport = {
            viewport,
            preexisting: new Set([...this.firstSeenAt.keys(), ...this.states.keys()]),
          };
        }
        // Let the page lay out and present one frame at the new size, so the
        // next read or capture sees it. Bounded: a throttled page never blocks.
        await this.sendTarget(
          state,
          "Runtime.evaluate",
          {
            expression: NEXT_PRESENTED_FRAME_EXPRESSION,
            awaitPromise: true,
            returnByValue: true,
          },
          { timeoutMs: 1_000 },
        ).catch(() => undefined);
        return;
      case "click": {
        const node = await this.resolveActionLocator(state, action.locator);
        if ((action.button ?? "left") === "left" && (await this.chooseDropdownOption(state, node)))
          return;
        await this.clickNode(
          state,
          node.backendDOMNodeId,
          action.button ?? "left",
          1,
          node.frameId ?? state.frame.id,
        );
        return;
      }
      case "double_click": {
        const node = await this.resolveActionLocator(state, action.locator);
        await this.clickNode(
          state,
          node.backendDOMNodeId,
          "left",
          2,
          node.frameId ?? state.frame.id,
        );
        return;
      }
      case "hover": {
        const node = await this.resolveActionLocator(state, action.locator, { input: false });
        const point = await this.actionPoint(
          state,
          node.backendDOMNodeId,
          true,
          node.frameId ?? state.frame.id,
        );
        await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
        });
        return;
      }
      case "fill": {
        const node = await this.resolveActionLocator(state, action.locator);
        if (await this.fillNativeDateTimeInput(state, node.backendDOMNodeId, action.value)) return;
        if (await this.fillSlider(state, node.backendDOMNodeId, action.value)) return;
        await this.assertFillableTarget(state, node.backendDOMNodeId);
        await this.focusNode(state, node.backendDOMNodeId);
        await this.selectAllAndDelete(state, node.backendDOMNodeId);
        if (action.value || this.engine === "lightpanda")
          await this.sendActionTarget(state, "Input.insertText", {
            text: action.value,
          });
        const confirmed = await this.callOnNode(
          state,
          node.backendDOMNodeId,
          CONFIRM_EDITABLE_VALUE_FUNCTION,
          [{ value: action.value }],
        );
        if (confirmed !== true) {
          throw new InteractionOutcomeUnknownDriverError(
            "outcome_unknown",
            "browser fill was dispatched but the field did not keep the requested value; check the current page before continuing",
          );
        }
        return;
      }
      case "type":
        if (action.locator) {
          const node = await this.resolveActionLocator(state, action.locator);
          await this.focusNode(state, node.backendDOMNodeId);
        }
        if (
          action.text &&
          this.engine === "lightpanda" &&
          (await this.evaluate(state, LIGHTPANDA_TYPING_TARGET_EXPRESSION)) !== true
        ) {
          // Lightpanda 0.3.5 acknowledges insertText on contenteditable without
          // inserting anything. Refuse before dispatch rather than certify it.
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "Lightpanda typing requires an editable text input or textarea; use Chromium for rich-text editors",
          );
        }
        if (action.text && action.mode === "keys") {
          // One key press per character for split one-time-code boxes and
          // pages that listen for keydown and move focus themselves.
          // Such pages usually move focus a frame after the key (React
          // effects), so the next key waits for that frame; sent at once,
          // keys land in the old box and overwrite or drop characters.
          let first = true;
          for (const character of action.text) {
            if (!first) await this.evaluateAction(state, AFTER_KEY_EFFECTS_EXPRESSION);
            first = false;
            await this.pressKey(state, characterKey(character));
          }
          return;
        }
        if (action.text)
          await this.sendActionTarget(state, "Input.insertText", {
            text: action.text,
          });
        return;
      case "press": {
        // Validate the key before focusing: focus is an input effect, so a
        // key rejected after it would surface as outcome_unknown instead of
        // a definite, side-effect-free invalid_action.
        const key = this.parseActionKey(action.key);
        if (action.locator) {
          const node = await this.resolveActionLocator(state, action.locator);
          await this.focusNode(state, node.backendDOMNodeId);
        }
        await this.pressKey(state, key);
        return;
      }
      case "select": {
        const node = await this.resolveActionLocator(state, action.locator);
        const inspected = await this.callOnNode(
          state,
          node.backendDOMNodeId,
          SELECT_TARGET_FUNCTION,
          [],
        );
        if (isRecord(inspected) && inspected.kind === "popup") {
          await this.selectPopupOptions(state, node, inspected, action.values);
          return;
        }
        const result = await this.changeSelection(
          state,
          node.backendDOMNodeId,
          SELECT_OPTIONS_FUNCTION,
          [{ value: action.values }],
        );
        if (result !== true) {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            isRecord(inspected) && inspected.kind === "native"
              ? "this select has no enabled option with that value or label, or takes only one option"
              : "browser locator is not a selectable control",
          );
        }
        return;
      }
      case "check": {
        const node = await this.resolveActionLocator(state, action.locator);
        const current = await this.callOnNode(state, node.backendDOMNodeId, CHECKED_FUNCTION, []);
        if (typeof current !== "boolean") {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "browser locator is not a checkable control",
          );
        }
        if (current !== action.checked)
          await this.clickNode(
            state,
            node.backendDOMNodeId,
            "left",
            1,
            node.frameId ?? state.frame.id,
          );
        return;
      }
      case "scroll": {
        // A located scroll moves the nearest box that can scroll that way, as a
        // wheel over the element would; a page scroll moves the viewport. When
        // nothing moves, no scroll event fired, so the refusal is definite.
        const effectsBeforeScroll = state.actionEffectCount;
        let moved: unknown;
        if (action.locator) {
          const node = await this.resolveActionLocator(state, action.locator, { input: false });
          moved = await this.callOnNode(
            state,
            node.backendDOMNodeId,
            SCROLL_FUNCTION,
            [{ value: action.deltaX }, { value: action.deltaY }],
            { isolatedFrameId: node.frameId ?? state.frame.id, potentialEffect: true },
          );
        } else {
          moved = await this.evaluateAction(
            state,
            `(${PAGE_SCROLL_FUNCTION})(${json(action.deltaX)}, ${json(action.deltaY)})`,
          );
        }
        if (moved !== true && (action.deltaX !== 0 || action.deltaY !== 0)) {
          state.actionEffectCount = effectsBeforeScroll;
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            action.locator
              ? "nothing at this element can scroll further in that direction"
              : "the page cannot scroll further in that direction; to scroll an inner panel, pass its locator",
          );
        }
        return;
      }
      case "drag": {
        const from = await this.resolveActionLocator(state, action.from, { input: false });
        const fromRoute = state.nodeRoute;
        const to = await this.resolveActionLocator(state, action.to, { input: false });
        if (fromRoute !== state.nodeRoute) {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "browser drag between different cross-origin frames is unsupported; use pointer drag coordinates",
          );
        }
        await this.dragNodes(state, from.backendDOMNodeId, to.backendDOMNodeId);
        return;
      }
      case "pointer":
        await this.dispatchPointerAction(state, action);
        return;
      case "handle_dialog":
        if (!state.dialog) {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "browser target has no open JavaScript dialog",
          );
        }
        if (action.promptText !== undefined && state.dialog.type !== "prompt") {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "prompt text is valid only for a browser prompt dialog",
          );
        }
        await this.sendActionTarget(state, "Page.handleJavaScriptDialog", {
          accept: action.response === "accept",
          ...(action.promptText !== undefined ? { promptText: action.promptText } : {}),
        });
        state.dialog = null;
        return;
      case "upload": {
        if (!this.resolveWorkspaceFiles) {
          throw new InteractionDefiniteDriverError(
            "unsupported",
            "this browser placement cannot resolve workspace files for upload",
          );
        }
        const paths = await this.resolveWorkspaceFiles(operationId, action.workspaceFileIds);
        if (paths.length !== action.workspaceFileIds.length) {
          throw new InteractionDefiniteDriverError(
            "resource_not_found",
            "one or more workspace files are unavailable on the browser placement",
          );
        }
        await this.uploadFiles(state, action.locator, paths);
        return;
      }
      case "clipboard":
        await this.dispatchClipboardAction(state, action);
        return;
      case "permission":
        await this.dispatchPermissionAction(state, action);
        return;
      case "wait":
        await this.waitForCondition(state, action);
        return;
    }
  }

  private async uploadFiles(
    state: TargetState,
    locator: BrowserLocator,
    paths: readonly string[],
  ): Promise<void> {
    const node = await this.resolveActionLocator(state, locator);
    const frameId = node.frameId ?? state.frame.id;
    if (this.engine === "lightpanda") {
      // Lightpanda supports direct file inputs, not Chromium's native chooser.
      await this.setUploadFiles(state, node.backendDOMNodeId, frameId, paths);
      return;
    }
    const isFileInput = await this.callOnNode(
      state,
      node.backendDOMNodeId,
      "function () { return this instanceof HTMLInputElement && this.type === 'file'; }",
      [],
      { isolatedFrameId: frameId },
    );
    if (isFileInput === true) {
      await this.setUploadFiles(state, node.backendDOMNodeId, frameId, paths);
      return;
    }

    // A cross-origin frame renders in its own process: its frame tree, file
    // chooser interception and chooser events belong to that frame's session.
    const frameSessionId = this.oopifForFrame(state, frameId)?.sessionId ?? state.sessionId;
    const sourceFrame = flattenFrameTree(await this.frameTree(frameSessionId)).find(
      (frame) => frame.id === frameId,
    );
    if (!sourceFrame) {
      throw new InteractionDefiniteDriverError(
        "document_stale",
        "upload control frame is unavailable",
      );
    }
    const connection = await this.ensureConnection();
    // Intercept only for this upload. The normal browser/native picker remains
    // untouched outside the target's serialized action.
    try {
      await connection.send(
        "Page.setInterceptFileChooserDialog",
        { enabled: true },
        {
          sessionId: frameSessionId,
        },
      );
    } catch (error) {
      if (error instanceof CdpProtocolError) {
        throw new InteractionDefiniteDriverError(
          "unsupported",
          "this browser cannot intercept file choosers; target a file input directly",
        );
      }
      throw error;
    }
    const abort = new AbortController();
    const chooser = connection
      .waitForEvent("Page.fileChooserOpened", {
        sessionId: frameSessionId,
        timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
        signal: abort.signal,
        predicate: (params) => params.frameId === frameId,
      })
      .then(
        (event) => event,
        () => null,
      );
    // The click's input can be acknowledged before a dialog it opened is
    // reported; a dialog instead of a chooser still means nothing was chosen.
    let dialogOpened = false;
    const dialog = new Promise<"dialog">((resolve) => {
      const stops = [...new Set([state.sessionId, frameSessionId])].map((sessionId) =>
        connection.on(
          "Page.javascriptDialogOpening",
          () => {
            dialogOpened = true;
            resolve("dialog");
          },
          sessionId,
        ),
      );
      abort.signal.addEventListener("abort", () => {
        for (const stop of stops) stop();
      });
    });
    let clicked = false;
    try {
      await this.clickNode(state, node.backendDOMNodeId, "left", 1, frameId);
      clicked = true;
      const event = await Promise.race([chooser, dialog]);
      if (event === "dialog") throw new DialogOpenedSignal("upload control opened a dialog");
      if (!event) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "upload control was clicked but no file chooser was confirmed; inspect the page before continuing",
        );
      }
      const currentFrame = flattenFrameTree(await this.frameTree(frameSessionId)).find(
        (frame) => frame.id === frameId,
      );
      if (currentFrame?.loaderId !== sourceFrame.loaderId) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "upload control changed documents; no files were selected",
        );
      }
      const backendNodeId = event.params.backendNodeId;
      if (typeof backendNodeId !== "number" || !Number.isSafeInteger(backendNodeId)) {
        throw new InteractionDefiniteDriverError(
          "unsupported",
          "this file chooser is not backed by a file input",
        );
      }
      await this.setUploadFiles(state, backendNodeId, frameId, paths);
    } catch (error) {
      if (error instanceof DialogOpenedSignal) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "upload control opened a JavaScript dialog; no file selection was confirmed",
        );
      }
      if (clicked && error instanceof InteractionDefiniteDriverError) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          `upload control was clicked, but file selection failed (${error.code}): ${error.message}`,
        );
      }
      throw error;
    } finally {
      abort.abort();
      const restored = connection.send(
        "Page.setInterceptFileChooserDialog",
        { enabled: false },
        {
          sessionId: frameSessionId,
        },
      );
      // An open dialog holds the page's commands until it is answered; the
      // restore stays queued behind it instead of hiding the dialog outcome.
      if (dialogOpened || state.dialog) void restored.catch(() => undefined);
      else await restored;
    }
  }

  private async setUploadFiles(
    state: TargetState,
    backendNodeId: number | null,
    frameId: string,
    paths: readonly string[],
  ): Promise<void> {
    if (this.engine !== "lightpanda") {
      const input = await this.callOnNode(
        state,
        backendNodeId,
        `function () {
        return {
          file: this instanceof HTMLInputElement && this.type === 'file',
          disabled: this.matches(':disabled'), multiple: this.multiple,
          directory: this.webkitdirectory
        };
      }`,
        [],
        { isolatedFrameId: frameId },
      );
      if (!isRecord(input) || input.file !== true || input.disabled === true) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "upload requires an enabled file input",
        );
      }
      if (input.directory === true || (paths.length > 1 && input.multiple !== true)) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          input.directory === true
            ? "directory selection is not supported; choose a file upload control"
            : "this file input accepts only one file",
        );
      }
    }
    const effectsBeforeSelection = state.actionEffectCount;
    try {
      await this.sendActionTarget(state, "DOM.setFileInputFiles", {
        files: [...paths],
        backendNodeId,
      });
    } catch (error) {
      if (
        this.engine === "chrome" &&
        error instanceof CdpProtocolError &&
        error.message === "Not allowed"
      ) {
        // Chrome lets an extension's debugger pick local files only when the
        // person allowed it file URL access. Without that, put the same files
        // on the input from the page, as a drag-and-drop would. The refusal
        // selected nothing, so it is not a page effect.
        state.actionEffectCount = effectsBeforeSelection;
        await this.transferUploadFiles(state, backendNodeId, frameId, paths);
        return;
      }
      if (
        error instanceof CdpProtocolError &&
        error.message === "Node is not a file input element"
      ) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "upload target is no longer a file input",
        );
      }
      throw error;
    }
  }

  /** Set a file input's files from inside the page, in bounded chunks that fit
   * the attached browser's one-megabyte command limit. The input receives the
   * same input and change events as when Chrome selects the files itself. */
  private async transferUploadFiles(
    state: TargetState,
    backendNodeId: number | null,
    frameId: string,
    paths: readonly string[],
  ): Promise<void> {
    if (backendNodeId === null) {
      throw new InteractionDefiniteDriverError("invalid_action", "upload requires a file input");
    }
    const files = await Promise.all(paths.map(async (path) => ({ path, info: await stat(path) })));
    const totalBytes = files.reduce((sum, file) => sum + file.info.size, 0);
    if (totalBytes > ATTACHED_TRANSFER_UPLOAD_MAX_BYTES) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        `these files total ${formatMegabytes(totalBytes)}; without file access this Chrome can ` +
          `receive at most ${formatMegabytes(ATTACHED_TRANSFER_UPLOAD_MAX_BYTES)} per upload. ` +
          'The person can turn on "Allow access to file URLs" for the browser extension in ' +
          "chrome://extensions to upload larger files",
      );
    }
    const world = await this.sendTarget<{ executionContextId?: unknown }>(
      state,
      "Page.createIsolatedWorld",
      { frameId, worldName: "opengeni-upload" },
    );
    if (!Number.isSafeInteger(world.executionContextId)) {
      throw new Error("CDP did not create an isolated upload world");
    }
    const resolved = await this.sendTarget<{ object?: unknown }>(state, "DOM.resolveNode", {
      backendNodeId,
      executionContextId: world.executionContextId,
    });
    if (!isRecord(resolved.object) || typeof resolved.object.objectId !== "string") {
      throw new InteractionDefiniteDriverError(
        "locator_not_found",
        "upload file input is no longer present",
      );
    }
    const inputId = resolved.object.objectId;
    let partsId: string | null = null;
    try {
      const parts = await this.sendTarget<{ result?: unknown }>(state, "Runtime.callFunctionOn", {
        objectId: inputId,
        functionDeclaration: "function () { return []; }",
        returnByValue: false,
      });
      if (!isRecord(parts.result) || typeof parts.result.objectId !== "string") {
        throw new Error("CDP did not create an upload buffer");
      }
      partsId = parts.result.objectId;
      for (const [index, file] of files.entries()) {
        const bytes = await readFile(file.path);
        if (bytes.byteLength !== file.info.size) {
          throw new InteractionDefiniteDriverError(
            "resource_unavailable",
            "an upload file changed while it was being read",
          );
        }
        for (let offset = 0; offset < bytes.byteLength; offset += ATTACHED_TRANSFER_CHUNK_BYTES) {
          const appended = await this.sendTarget<{ exceptionDetails?: unknown }>(
            state,
            "Runtime.callFunctionOn",
            {
              objectId: partsId,
              functionDeclaration:
                "function (index, data) { (this[index] = this[index] || []).push(data); }",
              arguments: [
                { value: index },
                {
                  value: bytes
                    .subarray(offset, offset + ATTACHED_TRANSFER_CHUNK_BYTES)
                    .toString("base64"),
                },
              ],
              returnByValue: true,
            },
          );
          if (appended.exceptionDetails) throw new Error("browser upload buffer failed");
        }
      }
      const result = await this.sendActionTarget<{ result?: unknown; exceptionDetails?: unknown }>(
        state,
        "Runtime.callFunctionOn",
        {
          objectId: inputId,
          functionDeclaration: TRANSFER_UPLOAD_FILES_FUNCTION,
          arguments: [
            { objectId: partsId },
            {
              value: files.map((file) => ({
                name: basename(file.path),
                type: uploadMediaType(file.path),
                lastModified: Math.trunc(file.info.mtimeMs),
              })),
            },
          ],
          returnByValue: true,
        },
        { potentialEffect: true },
      );
      if (result.exceptionDetails) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "the page failed while receiving the upload; inspect the file input before continuing",
        );
      }
      const selected = isRecord(result.result) ? result.result.value : undefined;
      if (selected === "not_file_input") {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "upload target is no longer an enabled file input",
        );
      }
      if (selected !== files.length) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "the file input did not keep every uploaded file; inspect it before continuing",
        );
      }
    } finally {
      for (const objectId of [partsId, inputId]) {
        if (objectId) {
          await this.sendTarget(state, "Runtime.releaseObject", { objectId }).catch(
            () => undefined,
          );
        }
      }
    }
  }

  private async dispatchClipboardAction(
    state: TargetState,
    action: Extract<BrowserAction, { type: "clipboard" }>,
  ): Promise<void> {
    if (action.operation === "clear") {
      this.setClipboard("", "clear", state.targetId);
      return;
    }
    if (action.operation === "write") {
      if (action.text === undefined) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser clipboard write requires text",
        );
      }
      this.setClipboard(action.text, "write", state.targetId);
      return;
    }
    if (action.operation === "copy") {
      // Copying an element without saying what copies what it shows, or its
      // selected part; without an element, the page's selection.
      const text = await this.copyBrowserText(
        state,
        action.locator,
        action.content ?? (action.locator ? "whole" : "selection"),
      );
      this.setClipboard(text, "copy", state.targetId);
      return;
    }
    const text = action.text ?? this.clipboardText;
    if (action.text !== undefined) this.setClipboard(text, "paste", state.targetId);
    if (action.locator) {
      const node = await this.resolveActionLocator(state, action.locator);
      await this.focusNode(state, node.backendDOMNodeId);
    }
    if (text) {
      await this.sendActionTarget(state, "Input.insertText", { text });
    }
  }

  private async dispatchPermissionAction(
    state: TargetState,
    action: BrowserPermissionAction,
  ): Promise<void> {
    if (!this.permissionControl) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser placement cannot set web permissions programmatically",
      );
    }
    const origin = webOrigin(state.frame.url);
    try {
      await (
        await this.ensureConnection()
      ).send("Browser.setPermission", {
        ...this.contextScope(),
        permission: { name: CDP_PERMISSION_NAMES[action.permission] },
        setting: action.setting,
        origin,
      });
    } catch (error) {
      if (error instanceof CdpProtocolError) {
        throw new InteractionDefiniteDriverError(
          error.code === -32_601 ? "unsupported" : "invalid_action",
          error.code === -32_601
            ? "this browser engine does not support programmatic permission control"
            : "the browser rejected this permission setting",
        );
      }
      throw error;
    }
  }

  private async copyBrowserText(
    state: TargetState,
    locator: BrowserLocator | undefined,
    content: "selection" | "value" | "text" | "whole",
  ): Promise<string> {
    let value: unknown;
    if (locator) {
      const node = await this.resolveActionLocator(state, locator, { input: false });
      value = await this.callOnNode(state, node.backendDOMNodeId, COPY_BROWSER_TEXT_FUNCTION, [
        { value: content },
      ]);
    } else {
      value = await this.evaluateAction(
        state,
        `(${COPY_ACTIVE_BROWSER_TEXT_FUNCTION})(${json(content)})`,
      );
      if (!isRecord(value) || (value.ok !== true && value.error !== "protected")) {
        const accessibility = await this.refreshAccessibility(state);
        const focused = accessibility.focusedRef
          ? accessibility.entriesByRef.get(accessibility.focusedRef)
          : null;
        if (focused?.backendDOMNodeId) {
          state.nodeRoute = this.oopifForFrame(state, focused.frameId);
          value = await this.callOnNode(
            state,
            focused.backendDOMNodeId,
            COPY_BROWSER_TEXT_FUNCTION,
            [{ value: content }],
          );
        }
      }
    }
    if (!isRecord(value) || value.ok !== true || typeof value.text !== "string") {
      const reason =
        isRecord(value) && typeof value.error === "string" ? value.error : "unavailable";
      throw new InteractionDefiniteDriverError(
        reason === "protected" ? "permission_denied" : "invalid_action",
        clipboardCopyFailure(reason, locator !== undefined),
      );
    }
    this.assertClipboardText(value.text);
    return value.text;
  }

  private setClipboard(
    text: string,
    source: Exclude<BrowserClipboardValue["source"], "empty">,
    targetId: string,
  ): void {
    this.assertClipboardText(text);
    if (this.clipboardRevision >= Number.MAX_SAFE_INTEGER) {
      throw new InteractionDefiniteDriverError(
        "resource_unavailable",
        "browser clipboard revision capacity is exhausted",
      );
    }
    this.clipboardRevision += 1;
    this.clipboardText = text;
    this.clipboardSource = source;
    this.clipboardSourceTargetId = targetId;
    this.clipboardUpdatedAt = this.timestamp();
  }

  private assertClipboardText(text: string): void {
    if (Buffer.byteLength(text, "utf8") > INTERACTION_MAX_CLIPBOARD_BYTES) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser clipboard text exceeds its UTF-8 byte envelope",
      );
    }
  }

  /** Resolve a locator an action is about to act on and, when the command is
   * traced, record which element it resolved to before any input is sent. */
  /**
   * The element an action acts on, once it can take the action. A role, label,
   * text, placeholder, test id or CSS locator waits for its element to appear,
   * as after a click that loads the next page or a form that renders late; an
   * input action also waits while the element is disabled, as in a form whose
   * fields stay greyed out until it loads. So a batch of steps across page
   * changes runs without an observation between them. A ref names a node the
   * caller already saw, so it does not wait to appear. The wait ends at
   * LOCATOR_WAIT_MS; the action then fails as it would have without waiting.
   * Only a later action of a batch without fenceEachAction may follow the page
   * to a new document while it waits; any other action stops with
   * document_stale before input, as its document fence requires.
   */
  private async resolveActionLocator(
    state: TargetState,
    locator: BrowserLocator,
    options: { input?: boolean } = {},
  ): Promise<CdpAccessibilityEntry> {
    const input = options.input ?? true;
    const deadline = state.locatorDeadline ?? Date.now() + LOCATOR_WAIT_MS;
    const fence = state.locatorFollowsNavigation
      ? null
      : { document: state.documentGeneration, frame: state.frameGeneration };
    let pause = 25;
    let entry: CdpAccessibilityEntry;
    let finalAttempt = false;
    let missed = false;
    let read: AccessibilityRead = "read";
    for (;;) {
      let found: CdpAccessibilityEntry | null = null;
      const purpose: AccessibilityRead = finalAttempt ? "final" : read;
      read = "read";
      // The document this attempt reads. A match counts only if that document
      // is still the current one once the element is found.
      const document = state.documentGeneration;
      try {
        found = await this.resolveLocator(state, locator, purpose);
      } catch (error) {
        const notFound =
          error instanceof InteractionDefiniteDriverError && error.code === "locator_not_found";
        if (locator.kind === "ref" || !notFound || finalAttempt) throw error;
        // Polls may reuse Chromium's tree; "not found" is only reported from
        // a freshly built one, and the first miss looks again at once.
        if (!missed) {
          missed = true;
          read = "miss";
          continue;
        }
        if (Date.now() >= deadline) {
          finalAttempt = true;
          continue;
        }
      }
      if (
        fence &&
        (state.documentGeneration !== fence.document || state.frameGeneration !== fence.frame)
      ) {
        throw new InteractionDefiniteDriverError(
          "document_stale",
          "browser document changed while the action waited for its element",
        );
      }
      if (found && state.documentGeneration !== document) {
        // A followed navigation committed while this attempt read the page
        // it left: look for the element again in the new document.
        found = null;
      }
      if (found) {
        if (!input || Date.now() >= deadline || !(await this.nodeDisabled(state, found))) {
          entry = found;
          if (state.inputFence !== null && state.inputFence !== document) {
            // An action with two elements (a drag) needs both in one document.
            throw new InteractionDefiniteDriverError(
              "document_stale",
              "browser document changed while the action waited for its element",
            );
          }
          state.inputFence = document;
          break;
        }
      }
      await delay(pause);
      pause = Math.min(pause * 2, 200);
    }
    const current = state.actionTrace;
    if (current) {
      current.trace.record(await this.describeResolvedTarget(state, entry, current.actionIndex));
    }
    return entry;
  }

  /** Whether a resolved element is disabled, natively or with aria-disabled. */
  private async nodeDisabled(state: TargetState, entry: CdpAccessibilityEntry): Promise<boolean> {
    if (entry.nodeId !== "" && entry.states.includes("disabled")) return true;
    try {
      return (
        (await this.callOnNode(state, entry.backendDOMNodeId, NODE_DISABLED_FUNCTION, [])) === true
      );
    } catch (error) {
      // A node that went away is re-resolved on the next try.
      if (error instanceof InteractionDefiniteDriverError && error.code === "locator_not_found") {
        return true;
      }
      throw error;
    }
  }

  private async describeResolvedTarget(
    state: TargetState,
    entry: CdpAccessibilityEntry,
    actionIndex: number,
  ): Promise<BrowserActionResolvedTargetValue> {
    if (entry.nodeId !== "") {
      // Accessibility-resolved locators already carry role, name and ancestry.
      const snapshot = state.accessibility;
      const container =
        snapshot && snapshot.entriesByNodeId.has(entry.nodeId)
          ? accessibilityContainer(snapshot, entry.nodeId)
          : null;
      return {
        actionIndex,
        ref: entry.ref || null,
        role: boundedTargetRole(entry.role),
        name: boundedTargetText(entry.name),
        container: container
          ? { role: boundedTargetRole(container.role), name: boundedTargetText(container.name) }
          : null,
      };
    }
    // CSS, test id and placeholder locators resolve through the DOM. Read that
    // node and its ancestors from Chromium's accessibility tree. The read is
    // optional: an engine or frame without it reports no role or container.
    const unknown: BrowserActionResolvedTargetValue = {
      actionIndex,
      ref: null,
      role: "generic",
      name: null,
      container: null,
    };
    if (entry.backendDOMNodeId === null) return unknown;
    let response: { nodes?: unknown };
    try {
      response = await this.sendTarget(state, "Accessibility.getPartialAXTree", {
        backendNodeId: entry.backendDOMNodeId,
        fetchRelatives: true,
      });
    } catch {
      return unknown;
    }
    if (!Array.isArray(response.nodes)) return unknown;
    let snapshot: CdpAccessibilitySnapshot;
    try {
      snapshot = normalizeCdpAccessibilityTree({
        nodes: response.nodes as CdpAxNode[],
        controllerGeneration: this.controllerGeneration,
        targetId: state.targetId,
        documentGeneration: state.documentGeneration,
      });
    } catch {
      return unknown;
    }
    const resolved = snapshot.entries.find(
      (candidate) => candidate.backendDOMNodeId === entry.backendDOMNodeId,
    );
    if (!resolved) return unknown;
    const container = accessibilityContainer(snapshot, resolved.nodeId);
    return {
      ...unknown,
      role: boundedTargetRole(resolved.role),
      name: boundedTargetText(resolved.name),
      container: container
        ? { role: boundedTargetRole(container.role), name: boundedTargetText(container.name) }
        : null,
    };
  }

  private async resolveLocator(
    state: TargetState,
    locator: BrowserLocator,
    read: AccessibilityRead = "read",
  ): Promise<CdpAccessibilityEntry> {
    // Each resolution decides where this node's DOM and runtime calls go:
    // the page session, or the session of the cross-origin frame holding it.
    state.nodeRoute = null;
    const entry = await this.resolveLocatorInPage(state, locator, read);
    state.nodeRoute = this.oopifForFrame(state, entry.frameId);
    return entry;
  }

  private async resolveLocatorInPage(
    state: TargetState,
    locator: BrowserLocator,
    read: AccessibilityRead = "read",
  ): Promise<CdpAccessibilityEntry> {
    await this.refreshFrame(state);
    if (locator.kind === "css" || locator.kind === "test_id" || locator.kind === "placeholder") {
      const backendDOMNodeId = await this.uniqueDomMatch(state, domLocatorSelector(locator));
      return syntheticEntry(backendDOMNodeId);
    }
    // A reference already identifies one concrete node. Revalidate that node
    // against Chromium instead of reading every unrelated node before input.
    // Frame/engine cases without this exact proof retain full-tree resolution.
    if (locator.kind === "ref" && this.engine === "chromium") {
      const cached = state.accessibility?.entriesByRef.get(locator.ref);
      if (cached?.backendDOMNodeId != null && cached.frameId === state.frame.id) {
        const partial = await this.resolveMainFrameReference(state, cached);
        if (partial) return partial;
      }
    }
    const accessibility = await this.refreshAccessibility(state, read);
    if (locator.kind === "ref") {
      const entry = accessibility.entriesByRef.get(locator.ref);
      if (!entry || entry.backendDOMNodeId === null) {
        throw new InteractionDefiniteDriverError(
          "locator_not_found",
          "browser element reference is stale or unavailable",
        );
      }
      return entry;
    }
    const matches = accessibilityLocatorMatches(accessibility.entries, locator);
    const needle = locator.kind === "role" ? locator.name : locator.text;
    // "Save" also matches "Save as draft". When exactly one candidate's whole
    // name is the requested text, that is the element the caller named.
    const unique =
      uniqueEntries(matches) ??
      (needle !== undefined && !locator.exact
        ? uniqueEntries(matches.filter((entry) => sameAccessibleName(entry.name, needle)))
        : null);
    if (!unique) {
      throw new InteractionDefiniteDriverError(
        matches.length === 0 ? "locator_not_found" : "locator_ambiguous",
        matches.length === 0
          ? "browser locator found no element"
          : ambiguousLocatorMessage(matches),
      );
    }
    return unique;
  }

  private async resolveMainFrameReference(
    state: TargetState,
    previous: CdpAccessibilityEntry,
  ): Promise<CdpAccessibilityEntry | null> {
    const frame = state.frame;
    let response: { nodes?: unknown };
    try {
      response = await this.sendTarget(state, "Accessibility.getPartialAXTree", {
        backendNodeId: previous.backendDOMNodeId,
        fetchRelatives: false,
      });
    } catch (error) {
      // Older CDP implementations and disappeared nodes can reject this read.
      // Full-tree resolution remains authoritative; no input has been sent.
      if (error instanceof CdpProtocolError) return null;
      throw error;
    }
    if (!Array.isArray(response.nodes)) return null;
    await this.refreshFrame(state);
    if (frame.id !== state.frame.id || frame.loaderId !== state.frame.loaderId) {
      throw new InteractionDefiniteDriverError(
        "document_stale",
        "browser document changed while resolving the element reference",
      );
    }
    const current = normalizeCdpAccessibilityTree({
      nodes: namespaceCdpAccessibilityFrame(
        frame.id,
        response.nodes as CdpAxNode[],
        `${frame.id}\0${frame.loaderId}`,
      ),
      controllerGeneration: this.controllerGeneration,
      targetId: state.targetId,
      documentGeneration: state.documentGeneration,
    }).entriesByRef.get(previous.ref);
    // Chromium's incremental tree can report a visible node as not rendered.
    // Without this proof, the rebuilt full tree decides whether the ref holds.
    return current && current.backendDOMNodeId === previous.backendDOMNodeId ? current : null;
  }

  private async uniqueDomMatch(state: TargetState, selector: string): Promise<number> {
    const nodeIds = await this.domMatchNodeIds(state, selector);
    if (nodeIds.length === 0) {
      throw new InteractionDefiniteDriverError(
        "locator_not_found",
        "browser locator found no element",
      );
    }
    if (nodeIds.length !== 1) {
      throw new InteractionDefiniteDriverError(
        "locator_ambiguous",
        "browser locator matched multiple elements",
      );
    }
    const backendNodeId = await this.describeBackendNode(state, nodeIds[0]!);
    if (backendNodeId === null) {
      throw new InteractionDefiniteDriverError(
        "locator_not_found",
        "browser locator found no element",
      );
    }
    return backendNodeId;
  }

  /**
   * The node ids `selector` matches in the current main-frame document.
   * DOM.getDocument and DOM.querySelectorAll are two calls, and a document
   * that commits between them (a navigation while a locator waits) drops the
   * root's node id. Chromium refuses that query with the same error code as
   * an invalid selector, so only a refusal of a root it still holds reports
   * the selector as invalid; a vanished root is read again from the new
   * document, whose generation the caller's fence then sees.
   */
  private async domMatchNodeIds(state: TargetState, selector: string): Promise<number[]> {
    for (let attempt = 1; ; attempt += 1) {
      const document = await this.sendTarget<{ root?: unknown }>(state, "DOM.getDocument", {
        depth: 0,
        pierce: true,
      });
      if (!isRecord(document.root) || typeof document.root.nodeId !== "number") {
        throw new Error("CDP returned an invalid DOM root");
      }
      let result: { nodeIds?: unknown };
      try {
        result = await this.sendTarget(state, "DOM.querySelectorAll", {
          nodeId: document.root.nodeId,
          selector,
        });
      } catch (error) {
        if (cdpNodeGone(error)) {
          if (attempt >= DOM_QUERY_ATTEMPTS) throw error;
          await this.refreshFrame(state);
          continue;
        }
        if (error instanceof CdpProtocolError) {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "browser CSS selector is invalid",
          );
        }
        throw error;
      }
      if (!Array.isArray(result.nodeIds)) {
        throw new Error("CDP returned an invalid DOM query result");
      }
      return result.nodeIds.filter((value): value is number => typeof value === "number");
    }
  }

  /** A matched node's backend id, or null when its document has since gone. */
  private async describeBackendNode(state: TargetState, nodeId: number): Promise<number | null> {
    let described: { node?: unknown };
    try {
      described = await this.sendTarget<{ node?: unknown }>(state, "DOM.describeNode", {
        nodeId,
      });
    } catch (error) {
      if (cdpNodeGone(error)) return null;
      throw error;
    }
    if (!isRecord(described.node) || typeof described.node.backendNodeId !== "number") {
      throw new Error("CDP did not resolve the DOM locator");
    }
    return described.node.backendNodeId;
  }

  /**
   * Every element a locator names. A wait asks whether such an element is on
   * screen, not which one to act on, so several matches are not an error:
   * "visible" holds when any match is visible and "hidden" when none is.
   */
  private async locatorCandidates(
    state: TargetState,
    locator: BrowserLocator,
    read: AccessibilityRead,
  ): Promise<CdpAccessibilityEntry[]> {
    if (locator.kind === "ref") return [await this.resolveLocatorInPage(state, locator, read)];
    await this.refreshFrame(state);
    if (locator.kind === "css" || locator.kind === "test_id" || locator.kind === "placeholder") {
      const nodeIds = await this.domMatchNodeIds(state, domLocatorSelector(locator));
      const entries: CdpAccessibilityEntry[] = [];
      for (const nodeId of nodeIds.slice(0, WAIT_LOCATOR_CANDIDATE_LIMIT)) {
        const backendNodeId = await this.describeBackendNode(state, nodeId);
        if (backendNodeId !== null) entries.push(syntheticEntry(backendNodeId));
      }
      return entries;
    }
    const accessibility = await this.refreshAccessibility(state, read);
    const byBackend = new Map<number, CdpAccessibilityEntry>();
    for (const entry of accessibilityLocatorMatches(accessibility.entries, locator)) {
      if (entry.backendDOMNodeId !== null && !byBackend.has(entry.backendDOMNodeId)) {
        byBackend.set(entry.backendDOMNodeId, entry);
      }
    }
    return [...byBackend.values()].slice(0, WAIT_LOCATOR_CANDIDATE_LIMIT);
  }

  /**
   * The options of a native dropdown (a single-choice select shown as a
   * button) have no box on the page: the browser draws its list itself, so a
   * pointer cannot reach them. A person who clicks one chooses it, so choose
   * it the same way the select action does. Returns false for any other
   * element, which is clicked as usual.
   */
  private async chooseDropdownOption(
    state: TargetState,
    node: CdpAccessibilityEntry,
  ): Promise<boolean> {
    // Only an option, or an element a DOM locator found (its role is not
    // known), costs the extra read; every other click goes straight on.
    const synthetic = node.nodeId === "";
    if (
      node.backendDOMNodeId === null ||
      this.engine === "lightpanda" ||
      (!synthetic && !/option/iu.test(node.role))
    )
      return false;
    const option = await this.callOnNode(
      state,
      node.backendDOMNodeId,
      DROPDOWN_OPTION_FUNCTION,
      [],
    );
    if (!isRecord(option) || option.kind === "other") return false;
    if (option.kind === "unavailable") {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "this option of a native dropdown is disabled or hidden and cannot be chosen",
      );
    }
    // As for a person: the option is chosen (the page sees input and change
    // only when that changes the value), and then the open list closes.
    if (option.kind === "choosable") {
      const chosen = await this.changeSelection(
        state,
        node.backendDOMNodeId,
        CHOOSE_DROPDOWN_OPTION_FUNCTION,
        [],
      );
      if (chosen !== true) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "this option of a native dropdown is disabled or hidden and cannot be chosen",
        );
      }
    }
    if (option.open === true) await this.closeDropdownList(state);
    return true;
  }

  /**
   * Runs a page function that changes a select's value and then dispatches
   * input and change, returning true, or returns false before any change.
   * The page's handlers run inside the call, and one of them may open a
   * JavaScript dialog that holds the call open, so the call counts as an
   * effect from the moment it is sent; only a false reply undoes that.
   */
  private async changeSelection(
    state: TargetState,
    backendDOMNodeId: number | null,
    functionDeclaration: string,
    args: Array<{ value?: unknown }>,
  ): Promise<unknown> {
    const effectsBefore = state.actionEffectCount;
    const result = await this.callOnNode(state, backendDOMNodeId, functionDeclaration, args, {
      potentialEffect: true,
    });
    if (result !== true) state.actionEffectCount = effectsBefore;
    return result;
  }

  /**
   * Closes the list a native dropdown shows while it is open. The browser
   * draws that list itself and gives it the keyboard, so an Escape key press
   * closes it and the list consumes it. Only the press is sent: the release
   * would arrive after the list closed and reach the page, and a person's
   * choice makes no key events at all. Nor is there a blur or focus on the
   * select, which keeps its focus. Best effort: a list that stays open
   * changes nothing about the choice already made.
   */
  private async closeDropdownList(state: TargetState): Promise<void> {
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }

  private async clickNode(
    state: TargetState,
    backendDOMNodeId: number | null,
    button: "left" | "right" | "middle",
    count: 1 | 2,
    frameId?: string,
  ): Promise<void> {
    const point = await this.actionPoint(state, backendDOMNodeId, true, frameId);
    const { x, y, sessionId } = await this.clickInput(state, point);
    const input = sessionId === undefined ? {} : { sessionId };
    const guard = await this.installHitTargetGuard(state, backendDOMNodeId, frameId);
    try {
      await this.sendActionTarget(
        state,
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", x, y },
        input,
      );
      for (let clickCount = 1; clickCount <= count; clickCount += 1) {
        await this.sendActionTarget(
          state,
          "Input.dispatchMouseEvent",
          { type: "mousePressed", x, y, button, clickCount },
          input,
        );
        await this.sendActionTarget(
          state,
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", x, y, button, clickCount },
          input,
        );
      }
    } catch (error) {
      // The input already fails or pauses this action (a JavaScript dialog,
      // an unresponsive tab), and reading the guard back now could wait on
      // the same page. The next action removes it, and it disarms itself
      // after a few seconds regardless.
      if (guard !== null) {
        guard.stopReports();
        state.unsettledHitTargetGuards.push(guard);
      }
      throw error;
    }
    if (guard === null) return;
    const blocked = await this.settleHitTargetGuard(state, guard, count);
    if (blocked !== null) {
      // The pointer did move there, so whatever its arrival did stands, and
      // the refusal is reported as an unknown outcome.
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        `browser element is covered by ${blocked.slice(0, 160)} at its center; the click was not delivered`,
        true,
      );
    }
  }

  /**
   * Installs the hit-target guard for one click, before any pointer input, and
   * returns a handle to it. Only an engine without the guard (Lightpanda, which
   * has no compositor hit testing to race) clicks unguarded; on Chromium a
   * guard that cannot be installed refuses the click instead of sending it
   * unverified. When the target's frame is known the listeners live in an
   * isolated world, out of page scripts' reach, and also report each press's
   * verdict as it happens, so the verdict survives the document going away
   * before it is read back.
   */
  private async installHitTargetGuard(
    state: TargetState,
    backendDOMNodeId: number | null,
    frameId: string | undefined,
  ): Promise<HitTargetGuard | null> {
    if (this.engine === "lightpanda") return null;
    if (backendDOMNodeId === null) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser node cannot receive pointer input",
      );
    }
    const connection = await this.ensureConnection();
    const reportSession = this.commandSession(state, "Runtime.addBinding");
    const token = randomUUID();
    const verdicts: Array<string | null> = [];
    let stopReports: () => void = () => undefined;
    let executionContextId: number | undefined;
    if (frameId !== undefined) {
      const world = await this.sendTarget<{ executionContextId?: unknown }>(
        state,
        "Page.createIsolatedWorld",
        { frameId, worldName: HIT_TARGET_GUARD_WORLD },
      );
      if (!Number.isSafeInteger(world.executionContextId)) {
        throw new Error("CDP did not create an isolated world for the click guard");
      }
      executionContextId = world.executionContextId as number;
      // Exposed only to the guard's isolated world; the page cannot see or
      // call it. Chrome reports calls without the Runtime domain enabled.
      await this.sendTarget(state, "Runtime.addBinding", {
        name: HIT_TARGET_VERDICT_BINDING,
        executionContextName: HIT_TARGET_GUARD_WORLD,
      });
      stopReports = connection.on(
        "Runtime.bindingCalled",
        (event) => {
          if (event.params.name !== HIT_TARGET_VERDICT_BINDING) return;
          if (typeof event.params.payload !== "string") return;
          let report: unknown;
          try {
            report = JSON.parse(event.params.payload);
          } catch {
            return;
          }
          if (!isRecord(report) || report.token !== token) return;
          verdicts.push(typeof report.blocked === "string" ? report.blocked : null);
        },
        reportSession,
      );
    }
    try {
      const resolved = await this.sendTarget<{ object?: unknown }>(state, "DOM.resolveNode", {
        backendNodeId: backendDOMNodeId,
        ...(executionContextId === undefined ? {} : { executionContextId }),
      });
      if (!isRecord(resolved.object) || typeof resolved.object.objectId !== "string") {
        throw new InteractionDefiniteDriverError(
          "locator_not_found",
          "browser element is no longer present",
        );
      }
      const nodeObjectId = resolved.object.objectId;
      try {
        const installed = await this.sendTarget<{ result?: unknown; exceptionDetails?: unknown }>(
          state,
          "Runtime.callFunctionOn",
          {
            objectId: nodeObjectId,
            functionDeclaration: HIT_TARGET_GUARD_FUNCTION,
            arguments: [{ value: token }],
          },
        );
        if (installed.exceptionDetails || !isRecord(installed.result)) {
          throw new Error("browser click guard could not be installed");
        }
        if (typeof installed.result.objectId !== "string") {
          // The guard function returns null only for a detached element.
          throw new InteractionDefiniteDriverError(
            "locator_not_found",
            "browser element is no longer present",
          );
        }
        return {
          objectId: installed.result.objectId,
          reported: executionContextId !== undefined,
          verdicts,
          stopReports,
        };
      } finally {
        // Not awaited: CDP runs a session's commands in order, and nothing
        // waits on the release.
        void this.sendTarget(state, "Runtime.releaseObject", { objectId: nodeObjectId }).catch(
          () => undefined,
        );
      }
    } catch (error) {
      stopReports();
      throw error;
    }
  }

  /**
   * Removes the guard's listeners and returns what it held back, or null when
   * every press reached the target. When the guarded document is gone before
   * the readback (the click, a hover effect, a timer or a navigation replaced
   * or detached it), the verdicts the guard reported as each press happened
   * decide; without a verdict for every press, and on any other failure, it
   * is unknown whether the click reached the target, and the error says so.
   */
  private async settleHitTargetGuard(
    state: TargetState,
    guard: HitTargetGuard,
    presses: number,
  ): Promise<string | null> {
    const unknown = () =>
      new InteractionOutcomeUnknownDriverError(
        "outcome_unknown",
        "browser click was sent, but whether it reached the element could not be confirmed; check the page before continuing",
      );
    let settled: { result?: unknown; exceptionDetails?: unknown };
    try {
      settled = await this.sendTarget<{ result?: unknown; exceptionDetails?: unknown }>(
        state,
        "Runtime.callFunctionOn",
        {
          objectId: guard.objectId,
          functionDeclaration: "function () { return this.settle(); }",
          returnByValue: true,
        },
      );
    } catch (error) {
      if (error instanceof CdpProtocolError && GUARD_DOCUMENT_GONE.test(error.message)) {
        // Over the extension bridge, the reports the guard sent before its
        // document went away can still be on their way; take them in first.
        try {
          await (await this.ensureConnection()).flushEvents?.();
        } catch {
          // The verdicts already in decide, as without a bridge.
        }
        guard.stopReports();
        const blocked = guard.verdicts.find((verdict) => verdict !== null);
        if (blocked !== undefined) return blocked;
        if (guard.reported && guard.verdicts.length >= presses) return null;
        throw unknown();
      }
      guard.stopReports();
      if (!(error instanceof CdpProtocolError)) throw error;
      throw unknown();
    }
    guard.stopReports();
    void this.sendTarget(state, "Runtime.releaseObject", { objectId: guard.objectId }).catch(
      () => undefined,
    );
    const value = isRecord(settled.result) ? settled.result.value : undefined;
    if (settled.exceptionDetails || (value !== null && typeof value !== "string")) {
      throw unknown();
    }
    return value === null || value === "" ? null : value;
  }

  /** Removes guards an interrupted click left armed, so they cannot hold back
   * later input. Best effort: a guard that cannot be reached is gone with its
   * document or disarms itself shortly. */
  private async settleUnsettledHitTargetGuards(state: TargetState): Promise<void> {
    if (state.dialog) return;
    const guards = state.unsettledHitTargetGuards.splice(0);
    for (const guard of guards) {
      await this.sendTarget(state, "Runtime.callFunctionOn", {
        objectId: guard.objectId,
        functionDeclaration: "function () { this.settle(); }",
      }).catch(() => undefined);
      await this.sendTarget(state, "Runtime.releaseObject", { objectId: guard.objectId }).catch(
        () => undefined,
      );
    }
  }

  /**
   * Where a click on a node goes. A node in a cross-origin frame is clicked
   * through that frame's own session, in its local coordinates. Sent to the
   * page at page coordinates, Chrome routes the event into the frame by the
   * compositor's hit-test data, which can lag a freshly loaded frame: the
   * click then lands on nothing although Blink's hit test passed (seen headed
   * with a CAPTCHA widget, about one click in five).
   */
  private async clickInput(
    state: TargetState,
    point: { x: number; y: number },
  ): Promise<{ x: number; y: number; sessionId?: string }> {
    const route = state.nodeRoute;
    if (!route) return point;
    const offset = await this.frameOffset(state, route);
    return { x: point.x - offset.x, y: point.y - offset.y, sessionId: route.sessionId };
  }

  /** Scroll offsets of the window, visual viewport and every composed
   * ancestor of a top-level-frame node, read in an isolated world so page
   * scripts cannot fake them. Null means unknown: treat any scroll as an effect. */
  private async scrollPositions(
    state: TargetState,
    backendDOMNodeId: number,
    frameId: string | undefined,
  ): Promise<string | null> {
    if (frameId === undefined) return null;
    try {
      const positions = await this.callOnNode(
        state,
        backendDOMNodeId,
        SCROLL_POSITIONS_FUNCTION,
        [],
        { isolatedFrameId: frameId },
      );
      return typeof positions === "string" ? positions : null;
    } catch {
      return null;
    }
  }

  private async actionPoint(
    state: TargetState,
    backendDOMNodeId: number | null,
    requireHit: boolean,
    frameId?: string,
  ): Promise<{ x: number; y: number }> {
    if (backendDOMNodeId === null) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser node cannot receive pointer input",
      );
    }
    // Scrolling runs page scroll listeners, so it counts as a possible effect
    // and a later refusal stays an unknown outcome. When the target is already
    // in view nothing scrolls, and a refusal (covered, no box) is definite.
    const scrollBefore = await this.scrollPositions(state, backendDOMNodeId, frameId);
    const effectsBeforeScroll = state.actionEffectCount;
    if (state.nodeRoute) await this.scrollFrameOwnersIntoView(state, state.nodeRoute);
    const effectsBeforeElementScroll = state.actionEffectCount;
    try {
      await this.sendActionTarget(state, "DOM.scrollIntoViewIfNeeded", {
        backendNodeId: backendDOMNodeId,
      });
    } catch (error) {
      // -32001: the tab's session is gone, which is not about this element.
      if (!(error instanceof CdpProtocolError) || error.code === -32_001) throw error;
      // The browser refused the scroll itself, so nothing moved.
      state.actionEffectCount = effectsBeforeElementScroll;
      throw scrollRefusal(error.message) ?? error;
    }
    if (
      scrollBefore !== null &&
      (await this.scrollPositions(state, backendDOMNodeId, frameId)) === scrollBefore
    )
      state.actionEffectCount = effectsBeforeScroll;
    let point = await this.centerPoint(state, backendDOMNodeId);
    if (requireHit && !(await this.hitsAtCenter(state, backendDOMNodeId))) {
      const revealed =
        (await this.revealFromStickyCover(state, backendDOMNodeId, frameId)) ??
        (await this.revealByHover(state, backendDOMNodeId, frameId, point));
      if (!revealed) {
        const cover = await this.coveringElement(state, backendDOMNodeId);
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          cover
            ? `browser element is covered by ${cover} at its center`
            : "browser element is covered or not pointer-actionable",
          true,
        );
      }
      point = revealed;
    }
    return point;
  }

  private async centerPoint(
    state: TargetState,
    backendDOMNodeId: number,
  ): Promise<{ x: number; y: number }> {
    const result = await this.sendTarget<{ model?: unknown }>(state, "DOM.getBoxModel", {
      backendNodeId: backendDOMNodeId,
    });
    if (!isRecord(result.model) || !Array.isArray(result.model.content)) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser element has no visible action point",
        true,
      );
    }
    const numbers = result.model.content.filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    if (numbers.length < 8) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser element has no visible action point",
        true,
      );
    }
    const xs = [numbers[0]!, numbers[2]!, numbers[4]!, numbers[6]!];
    const ys = [numbers[1]!, numbers[3]!, numbers[5]!, numbers[7]!];
    // A box inside a cross-origin frame is in that frame's viewport space.
    const offset = state.nodeRoute
      ? await this.frameOffset(state, state.nodeRoute)
      : { x: 0, y: 0 };
    return {
      x: offset.x + xs.reduce((sum, value) => sum + value, 0) / xs.length,
      y: offset.y + ys.reduce((sum, value) => sum + value, 0) / ys.length,
    };
  }

  private async hitsAtCenter(state: TargetState, backendDOMNodeId: number): Promise<boolean> {
    return (await this.callOnNode(state, backendDOMNodeId, HIT_TEST_FUNCTION, [])) === true;
  }

  /** A short role-and-label description of what receives pointer input at the
   * target's center instead of the target, or null when nothing else does. */
  private async coveringElement(
    state: TargetState,
    backendDOMNodeId: number,
  ): Promise<string | null> {
    try {
      const value = await this.callOnNode(state, backendDOMNodeId, COVER_DESCRIPTION_FUNCTION, []);
      return typeof value === "string" && value ? value.slice(0, 160) : null;
    } catch {
      return null;
    }
  }

  /**
   * Row actions and toolbar buttons are often hidden and pointer-transparent
   * until the pointer is over their row or card (CSS :hover). The hit test
   * then lands on the target's own ancestor. A person moves the pointer onto
   * the spot first, so do the same and test again. The move is real input, so
   * a refusal after it is an unknown outcome. Returns the action point, or
   * null when the target is not hover-revealed or stays unreachable.
   */
  private async revealByHover(
    state: TargetState,
    backendDOMNodeId: number,
    frameId: string | undefined,
    point: { x: number; y: number },
  ): Promise<{ x: number; y: number } | null> {
    if (frameId === undefined) return null;
    const transparent = await this.callOnNode(
      state,
      backendDOMNodeId,
      POINTER_TRANSPARENT_FUNCTION,
      [],
      { isolatedFrameId: frameId },
    ).catch(() => false);
    if (transparent !== true) return null;
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    if (!(await this.hitsAtCenter(state, backendDOMNodeId))) return null;
    return await this.centerPoint(state, backendDOMNodeId);
  }

  /**
   * Sticky table columns and headers, and fixed toolbars, can cover a target
   * that Chromium already considers in view, so scrolling "if needed" does
   * nothing. A person scrolls the container until the target clears the bar;
   * try the same with other scroll alignments. A layer over the whole viewport
   * (a modal or its backdrop) is not scrolled past, so that refusal stays
   * definite. Returns the new action point, or null when still covered.
   */
  private async revealFromStickyCover(
    state: TargetState,
    backendDOMNodeId: number,
    frameId: string | undefined,
  ): Promise<{ x: number; y: number } | null> {
    if (frameId === undefined) return null;
    const sticky = await this.callOnNode(state, backendDOMNodeId, STICKY_COVER_FUNCTION, [], {
      isolatedFrameId: frameId,
    }).catch(() => false);
    if (sticky !== true) return null;
    const scrollBefore = await this.scrollPositions(state, backendDOMNodeId, frameId);
    const effectsBeforeScroll = state.actionEffectCount;
    for (const alignment of ["end", "center", "start"] as const) {
      // Scrolling runs page scroll listeners, so it is a possible effect: a
      // refusal after it is reported as an unknown outcome.
      await this.callOnNode(
        state,
        backendDOMNodeId,
        SCROLL_INTO_VIEW_FUNCTION,
        [{ value: alignment }],
        {
          potentialEffect: true,
        },
      );
      // Layout that reacts to the scroll, such as a popover that follows its
      // anchor, catches up on the next frames. Test the hit after it has.
      await this.callOnNode(state, backendDOMNodeId, SETTLE_FRAMES_FUNCTION, [], {
        isolatedFrameId: frameId,
      });
      if (await this.hitsAtCenter(state, backendDOMNodeId)) {
        return await this.centerPoint(state, backendDOMNodeId);
      }
    }
    // Nothing could move (for example a sticky bar taller than its scroller):
    // no scroll listener ran, so the refusal is still definite.
    if (
      scrollBefore !== null &&
      (await this.scrollPositions(state, backendDOMNodeId, frameId)) === scrollBefore
    )
      state.actionEffectCount = effectsBeforeScroll;
    return null;
  }

  private async focusNode(state: TargetState, backendDOMNodeId: number | null): Promise<void> {
    if (backendDOMNodeId === null) {
      throw new InteractionDefiniteDriverError("invalid_action", "browser node cannot be focused");
    }
    if (this.engine === "lightpanda") {
      const focused = await this.callOnNode(
        state,
        backendDOMNodeId,
        "function () { this.focus(); return document.activeElement === this; }",
        [],
      );
      if (focused !== true) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser node cannot be focused",
        );
      }
      return;
    }
    const effectsBeforeFocus = state.actionEffectCount;
    try {
      if (state.nodeRoute) {
        state.actionEffectCount += 1;
        await this.focusFrameOwners(state, state.nodeRoute);
      }
      await this.sendActionTarget(state, "DOM.focus", {
        backendNodeId: backendDOMNodeId,
      });
    } catch (error) {
      // Chromium validates the node (an Element that can take focus) before
      // moving focus, so a protocol refusal changed nothing. Report it as a
      // definite refusal instead of letting it surface as an unknown outcome.
      if (error instanceof CdpProtocolError && error.method === "DOM.focus") {
        state.actionEffectCount = effectsBeforeFocus;
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser node cannot be focused",
        );
      }
      throw error;
    }
  }

  /**
   * Native date, time, month, week and datetime-local inputs render their
   * editable parts as spin buttons inside a user-agent shadow root, and they
   * ignore text insertion. Select-all plus Backspace would only clear the
   * focused part. Fill such a control, or any of its parts, by setting the
   * host input's value in the input's own format, the way a date picker
   * commits a choice. Returns false for every other element so the ordinary
   * text path still applies.
   */
  private async fillNativeDateTimeInput(
    state: TargetState,
    backendDOMNodeId: number | null,
    value: string,
  ): Promise<boolean> {
    const inspected = await this.callOnNode(
      state,
      backendDOMNodeId,
      INSPECT_NATIVE_DATE_TIME_FILL_FUNCTION,
      [{ value }],
    );
    if (!isRecord(inspected) || inspected.kind === "other") return false;
    const type = typeof inspected.type === "string" ? inspected.type : "date";
    if (inspected.kind === "not_editable") {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        `browser ${type} input is disabled or read-only`,
      );
    }
    if (inspected.kind === "invalid_value") {
      const part = inspected.part === true ? "this field is one part of a native " : "a native ";
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        `${part}${type} input; fill the whole input with a value in its format (${NATIVE_DATE_TIME_FORMATS[type] ?? "its value format"}), or an empty string to clear it`,
      );
    }
    const retained = await this.callOnNode(
      state,
      backendDOMNodeId,
      SET_NATIVE_DATE_TIME_VALUE_FUNCTION,
      [{ value }],
      { potentialEffect: true },
    );
    if (retained !== true) {
      throw new InteractionOutcomeUnknownDriverError(
        "outcome_unknown",
        `browser set the ${type} input's value but the page did not keep it; check the current page before continuing`,
      );
    }
    return true;
  }

  /**
   * Sets a slider to a number. A native range input takes the value
   * directly, the way dragging its handle commits one. A custom slider
   * (role slider) only moves the way its page lets a person move it, so press
   * the arrow keys toward the value, reading its aria-valuenow after each
   * press. Returns false for every other element.
   */
  private async fillSlider(
    state: TargetState,
    backendDOMNodeId: number | null,
    value: string,
  ): Promise<boolean> {
    if (backendDOMNodeId === null) return false;
    const target = value.trim() === "" ? Number.NaN : Number(value.trim());
    const read = async (): Promise<SliderState | null> =>
      sliderState(
        await this.callOnNode(state, backendDOMNodeId, SLIDER_STATE_FUNCTION, [
          { value: Number.isFinite(target) ? target : null },
        ]),
      );
    const initial = await read();
    if (initial === null) return false;
    if (initial.disabled) {
      throw new InteractionDefiniteDriverError("invalid_action", "this slider is disabled");
    }
    const range = `${initial.min ?? "its minimum"} to ${initial.max ?? "its maximum"}`;
    if (
      !Number.isFinite(target) ||
      (initial.min !== null && target < initial.min) ||
      (initial.max !== null && target > initial.max)
    ) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        `this slider takes a number from ${range}; it is at ${initial.value ?? "an unknown value"}`,
      );
    }
    if (initial.kind === "range") {
      if (initial.nearest !== null && initial.nearest !== target) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          `this slider moves in steps; the nearest value it takes is ${initial.nearest}`,
        );
      }
      const result = await this.callOnNode(
        state,
        backendDOMNodeId,
        SET_RANGE_VALUE_FUNCTION,
        [{ value: target }],
        { potentialEffect: true },
      );
      if (!isRecord(result) || result.kind !== "set") {
        if (isRecord(result) && result.kind === "disabled") {
          throw new InteractionDefiniteDriverError("invalid_action", "this slider is disabled");
        }
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "browser set the slider's value but the page did not keep it; check the current page before continuing",
        );
      }
      return true;
    }
    if (initial.value === null) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "this slider does not report its value; drag its handle or press its keys and check the page",
      );
    }
    if (sameSliderValue(initial.value, target)) return true;
    await this.focusNode(state, backendDOMNodeId);
    let current = initial.value;
    let presses = 0;
    const press = async (key: string): Promise<number | null> => {
      presses += 1;
      await this.pressKey(state, this.parseActionKey(key));
      let next = (await read())?.value ?? null;
      if (next !== null && sameSliderValue(next, current)) {
        await this.evaluateAction(state, AFTER_KEY_EFFECTS_EXPRESSION);
        next = (await read())?.value ?? null;
      }
      return next !== null && sameSliderValue(next, current) ? null : next;
    };
    // Which arrow raises the value depends on the slider: a vertical one may
    // listen only for up and down, and a right-to-left one lowers with the
    // right arrow. Learn it from the first press that moves the slider.
    const [primary, secondary] = initial.vertical
      ? [SLIDER_VERTICAL_KEYS, SLIDER_HORIZONTAL_KEYS]
      : [SLIDER_HORIZONTAL_KEYS, SLIDER_VERTICAL_KEYS];
    let keys: { raise: string; lower: string } | null = null;
    while (!sameSliderValue(current, target)) {
      if (presses >= SLIDER_MAX_KEY_PRESSES) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          `the slider moved from ${initial.value} to ${current} in ${presses} arrow key presses without reaching ${target}; drag its handle the rest of the way`,
        );
      }
      const up = current < target;
      let next: number | null = null;
      if (keys === null) {
        const candidates = up
          ? [primary.raise, secondary.raise, primary.lower]
          : [primary.lower, secondary.lower, primary.raise];
        for (const key of candidates) {
          next = await press(key);
          if (next === null) continue;
          const opposite = SLIDER_OPPOSITE_KEY[key] ?? key;
          keys = next > current ? { raise: key, lower: opposite } : { raise: opposite, lower: key };
          break;
        }
        if (next === null) {
          throw new InteractionOutcomeUnknownDriverError(
            "outcome_unknown",
            `this slider did not move when its arrow keys were pressed (it is at ${current}); drag its handle or click its track instead`,
          );
        }
        // A first press the wrong way only taught which key is which.
        if (up ? next < current : next > current) {
          current = next;
          continue;
        }
      } else {
        next = await press(up ? keys.raise : keys.lower);
        if (next === null) {
          throw new InteractionOutcomeUnknownDriverError(
            "outcome_unknown",
            `this slider did not move when its arrow key was pressed (it is at ${current}); drag its handle or click its track instead`,
          );
        }
        if (up ? next < current : next > current) {
          throw new InteractionOutcomeUnknownDriverError(
            "outcome_unknown",
            `this slider moved away from ${target} when its arrow keys were pressed; it is now at ${next}`,
          );
        }
      }
      if (!sameSliderValue(next, target) && (up ? next > target : next < target)) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          `this slider moves in steps of ${Number(Math.abs(next - current).toPrecision(12))} and cannot be set to ${target}; it is now at ${next}`,
        );
      }
      current = next;
    }
    return true;
  }

  /**
   * Fill replaces the text of an editable field. Refuse any other element
   * before focusing or typing, with the action that does work on it: typing
   * into a select or a custom combobox would at best do nothing and at worst
   * pick an option through type-ahead, leaving an unknown outcome.
   */
  private async assertFillableTarget(
    state: TargetState,
    backendDOMNodeId: number | null,
  ): Promise<void> {
    if (backendDOMNodeId === null) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser fill needs a text input, textarea or editable element",
      );
    }
    const inspected = await this.callOnNode(state, backendDOMNodeId, FILL_TARGET_FUNCTION, []);
    if (!isRecord(inspected) || inspected.kind === "editable") return;
    const role = typeof inspected.role === "string" && inspected.role ? inspected.role : "element";
    const type = typeof inspected.type === "string" ? inspected.type : "";
    const message =
      inspected.kind === "read_only"
        ? "browser fill target is disabled or read-only"
        : inspected.kind === "select"
          ? "this is a native select, not a text field; use the select action with the option's value or label"
          : inspected.kind === "input"
            ? `this is a ${type} input, not a text field; use ${
                type === "checkbox" || type === "radio"
                  ? "check"
                  : type === "file"
                    ? "upload"
                    : "click"
              } instead`
            : inspected.kind === "popup"
              ? `this ${role} is not a text field; use the select action with the option's label`
              : `browser fill needs a text input, textarea or editable element, and this ${role} is not one`;
    throw new InteractionDefiniteDriverError("invalid_action", message);
  }

  /**
   * Chooses options of a custom combobox, listbox or listbox button by their
   * visible label, as a person would: open the popup when the option is not
   * showing, then click the option. A popup already in the document that has
   * no such option is refused before any input.
   */
  private async selectPopupOptions(
    state: TargetState,
    node: CdpAccessibilityEntry,
    inspected: Readonly<Record<string, unknown>>,
    values: readonly string[],
  ): Promise<void> {
    const role = typeof inspected.role === "string" ? inspected.role : "combobox";
    if (inspected.disabled === true) {
      throw new InteractionDefiniteDriverError("invalid_action", `this ${role} is disabled`);
    }
    if (values.length > 1 && inspected.multiple !== true) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        `this ${role} takes one option; pass a single value`,
      );
    }
    const listed = stringList(inspected.options);
    if (listed.length > 0) {
      const missing = values.find(
        (value) => !listed.some((label) => sameOptionLabel(label, value)),
      );
      if (missing !== undefined) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          `this ${role} has no option labeled ${JSON.stringify(missing)}; its options are ${optionList(listed)}`,
        );
      }
    }
    const frameId = node.frameId ?? state.frame.id;
    for (const value of values) {
      let option = await this.popupOptionNode(state, node.backendDOMNodeId, value);
      if (
        option === null &&
        role !== "listbox" &&
        (await this.callOnNode(state, node.backendDOMNodeId, POPUP_EXPANDED_FUNCTION, [])) !== true
      ) {
        await this.clickNode(state, node.backendDOMNodeId, "left", 1, frameId);
        const deadline = Date.now() + POPUP_OPTION_WAIT_MS;
        while (option === null && Date.now() < deadline) {
          await delay(50);
          option = await this.popupOptionNode(state, node.backendDOMNodeId, value);
        }
      }
      if (option === null) {
        const showing = stringList(
          await this.callOnNode(state, node.backendDOMNodeId, POPUP_OPTION_FUNCTION, [
            { value: null },
          ]),
        );
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          showing.length > 0
            ? `no option labeled ${JSON.stringify(value)} is showing; the showing options are ${optionList(showing)}`
            : `no option labeled ${JSON.stringify(value)} appeared after opening this ${role}; if it filters as you type, type part of the label first, then select`,
        );
      }
      await this.clickNode(state, option, "left", 1, frameId);
    }
  }

  /** The showing option of a popup control whose label matches, or null. */
  private async popupOptionNode(
    state: TargetState,
    backendDOMNodeId: number | null,
    label: string,
  ): Promise<number | null> {
    if (backendDOMNodeId === null) return null;
    const resolved = await this.sendTarget<{ object?: unknown }>(state, "DOM.resolveNode", {
      backendNodeId: backendDOMNodeId,
    });
    if (!isRecord(resolved.object) || typeof resolved.object.objectId !== "string") {
      throw new InteractionDefiniteDriverError(
        "locator_not_found",
        "browser element is no longer present",
      );
    }
    const objectIds = [resolved.object.objectId];
    try {
      const result = await this.sendActionTarget<{ result?: unknown; exceptionDetails?: unknown }>(
        state,
        "Runtime.callFunctionOn",
        {
          objectId: resolved.object.objectId,
          functionDeclaration: POPUP_OPTION_FUNCTION,
          arguments: [{ value: label }],
          returnByValue: false,
        },
        { potentialEffect: false },
      );
      if (result.exceptionDetails) throw new Error("browser element function failed");
      if (!isRecord(result.result) || typeof result.result.objectId !== "string") return null;
      objectIds.push(result.result.objectId);
      const described = await this.sendTarget<{ node?: unknown }>(state, "DOM.describeNode", {
        objectId: result.result.objectId,
      });
      return isRecord(described.node) && typeof described.node.backendNodeId === "number"
        ? described.node.backendNodeId
        : null;
    } finally {
      for (const objectId of objectIds) {
        await this.sendTarget(state, "Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  }

  private async selectAllAndDelete(
    state: TargetState,
    backendDOMNodeId: number | null,
  ): Promise<void> {
    if (this.engine === "lightpanda") {
      // Pinned Lightpanda ignores rawKeyDown and has no select-all/backspace
      // editing defaults. Clear through the native setter, then let insertText
      // emit the native input event (also for an empty replacement). Bypassing
      // framework-owned setters preserves controlled-input change tracking.
      const cleared = await this.callOnNode(
        state,
        backendDOMNodeId,
        LIGHTPANDA_CLEAR_EDITABLE_FUNCTION,
        [],
      );
      if (cleared !== true) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "Lightpanda fill requires an editable text input or textarea",
        );
      }
      return;
    }
    const meta = /Macintosh|Mac OS/u.test(this.userAgent);
    const modifiers = meta ? 4 : 2;
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      modifiers,
      windowsVirtualKeyCode: 65,
      // macOS Chromium does not derive native editing commands from CDP's
      // synthetic Command+A event. Without this, Backspace deletes one character.
      ...(meta ? { commands: ["selectAll"] } : {}),
    });
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers,
      windowsVirtualKeyCode: 65,
    });
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
  }

  private parseActionKey(input: string): ParsedKey {
    return parseKey(input, /Macintosh|Mac OS/u.test(this.userAgent));
  }

  private async pressKey(state: TargetState, key: ParsedKey): Promise<void> {
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: key.key,
      code: key.code,
      modifiers: key.modifiers,
      windowsVirtualKeyCode: key.keyCode,
      ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
      ...(/Macintosh|Mac OS/u.test(this.userAgent) && key.modifiers === 4 && key.code === "KeyA"
        ? { commands: ["selectAll"] }
        : {}),
    });
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: key.key,
      code: key.code,
      modifiers: key.modifiers,
      windowsVirtualKeyCode: key.keyCode,
    });
  }

  private async dragNodes(
    state: TargetState,
    fromBackendNodeId: number | null,
    toBackendNodeId: number | null,
  ): Promise<void> {
    const from = await this.actionPoint(state, fromBackendNodeId, true);
    await this.dragPoints(
      state,
      from,
      () => this.actionPoint(state, toBackendNodeId, false),
      "left",
    );
  }

  private async dispatchPointerAction(
    state: TargetState,
    action: Extract<BrowserAction, { type: "pointer" }>,
  ): Promise<void> {
    const start = await this.viewportPoint(state, action.x, action.y);
    const button = action.button ?? "left";
    switch (action.action) {
      case "move":
        await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: start.x,
          y: start.y,
        });
        return;
      case "click":
      case "double_click": {
        if (action.action === "click" && action.clickCount === 2) {
          await this.clickPoint(state, start, button, 2, 2);
        } else {
          await this.clickPoint(state, start, button, action.action === "click" ? 1 : 2);
        }
        return;
      }
      case "scroll":
        await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: start.x,
          y: start.y,
          deltaX: action.deltaX ?? 0,
          deltaY: action.deltaY ?? 0,
        });
        return;
      case "drag": {
        if (action.endX === undefined || action.endY === undefined) {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "browser pointer drag requires an end coordinate",
          );
        }
        const end = await this.viewportPoint(state, action.endX, action.endY);
        await this.dragPoints(state, start, end, button);
        return;
      }
    }
  }

  private async viewportPoint(
    state: TargetState,
    x: number,
    y: number,
  ): Promise<{ x: number; y: number }> {
    const viewport = await this.evaluate(
      state,
      "({ width: window.innerWidth, height: window.innerHeight })",
    );
    if (!isRecord(viewport)) throw new Error("browser returned invalid viewport dimensions");
    const width = numberField(viewport, "width");
    const height = numberField(viewport, "height");
    if (width === null || height === null || width <= 0 || height <= 0) {
      throw new Error("browser returned invalid viewport dimensions");
    }
    if (x < 0 || y < 0 || x > width || y > height) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser pointer coordinate is outside the current viewport",
        true,
      );
    }
    return { x, y };
  }

  private async clickPoint(
    state: TargetState,
    point: { x: number; y: number },
    button: "left" | "right" | "middle",
    count: 1 | 2,
    firstCount: 1 | 2 = 1,
  ): Promise<void> {
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    for (let clickCount = firstCount; clickCount <= count; clickCount += 1) {
      await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
      await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
    }
  }

  private async dragPoints(
    state: TargetState,
    from: { x: number; y: number },
    destination: { x: number; y: number } | (() => Promise<{ x: number; y: number }>),
    button: "left" | "right" | "middle",
  ): Promise<void> {
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x,
      y: from.y,
    });
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: from.x,
      y: from.y,
      button,
      buttons: mouseButtonMask(button),
      clickCount: 1,
    });
    let point = from;
    try {
      if (typeof destination === "function") {
        // Start the drag before revealing the destination: scrolling it into
        // view can move the source away from its measured coordinates.
        point = { x: from.x + (from.x >= 8 ? -8 : 8), y: from.y };
        await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
          button,
          buttons: mouseButtonMask(button),
        });
      }
      const to = typeof destination === "function" ? await destination() : destination;
      const start = point;
      for (let step = 1; step <= 10; step += 1) {
        point = {
          x: start.x + ((to.x - start.x) * step) / 10,
          y: start.y + ((to.y - start.y) * step) / 10,
        };
        await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
          button,
          buttons: mouseButtonMask(button),
        });
      }
      // The final step may only enter a small target. A second move delivers
      // dragover, allowing the page to accept the drop before mouse release.
      await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
        button,
        buttons: mouseButtonMask(button),
      });
    } finally {
      await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button,
        buttons: 0,
        clickCount: 1,
      });
    }
  }

  private async navigate(
    state: TargetState,
    url: string,
    options: BrowserTabNavigationOptions = {},
  ): Promise<string | null> {
    this.connection?.assertNavigable?.(url);
    const startedAt = Date.now();
    const loaderBefore = state.frame.loaderId;
    let result: { errorText?: unknown; loaderId?: unknown; isDownload?: unknown };
    try {
      result = await this.sendActionTarget<{
        errorText?: unknown;
        loaderId?: unknown;
        isDownload?: unknown;
      }>(state, "Page.navigate", { url }, { timeoutMs: this.navigationCommitTimeoutMs });
    } catch (error) {
      if (!(error instanceof CdpCommandTimeoutError)) throw error;
      // The server never answered. Stop the pending navigation so the tab
      // keeps its current document instead of committing at some later time.
      await this.sendActionTarget(
        state,
        "Page.stopLoading",
        {},
        { potentialEffect: false, timeoutMs: TARGET_CLOSE_SETTLE_TIMEOUT_MS },
      ).catch(() => undefined);
      const failure = new NavigationNotAnsweredError(this.navigationCommitTimeoutMs);
      failure.cause = error;
      throw failure;
    }
    let errorText =
      typeof result.errorText === "string" && result.errorText ? result.errorText : null;
    if (errorText !== null && !isPageLoadError(errorText)) {
      throw new InteractionDefiniteDriverError(
        "resource_unavailable",
        "browser could not navigate to the requested URL",
        true,
      );
    }
    // Chromium answers once the response is ready to commit, while the tab
    // still shows the previous document. Until the new document commits, a
    // readiness check or a locator would read the page being left. A failed
    // load commits the browser's error page under the same loader, except an
    // aborted one (a download, an empty response), which commits nothing. A
    // response the browser turned into a download never commits either: the
    // tab keeps its page, and the navigation is over once Chromium says so.
    const loaderId =
      typeof result.loaderId === "string" && result.loaderId ? result.loaderId : null;
    if (
      loaderId !== null &&
      this.engine !== "lightpanda" &&
      errorText !== "net::ERR_ABORTED" &&
      result.isDownload !== true
    ) {
      const committed = () => state.committedLoaders.includes(loaderId);
      const outcome = await this.waitForCommit(
        state,
        committed,
        () => state.abandonedLoaders.includes(loaderId),
        errorText === null
          ? Math.max(
              startedAt + this.navigationCommitTimeoutMs,
              Date.now() + NAVIGATION_COMMIT_GRACE_MS,
            )
          : Date.now() + NAVIGATION_COMMIT_GRACE_MS,
      );
      if (outcome === "committed") {
        // The server answered with an HTTP error status and an empty body, so
        // the browser shows its own page naming that status. That is the
        // site's answer, as a status page with a body would be, not a failure.
        if (errorText === HTTP_ERROR_STATUS_LOAD_ERROR) errorText = null;
      } else if (errorText === null) {
        await this.failUncommittedNavigation(state, loaderBefore, outcome, committed);
      }
    }
    // A failed load is reported whichever page the tab shows.
    if (errorText !== null && options.keepTabOnLoadError !== true) {
      throw new InteractionDefiniteDriverError(
        "resource_unavailable",
        `browser could not navigate to the requested URL (${errorText})`,
        true,
      );
    }
    await this.waitForDocumentReady(state, DEFAULT_ACTION_TIMEOUT_MS);
    await this.refreshFrame(state);
    // The caller asked to keep the tab on the browser's error page.
    return errorText;
  }

  /**
   * Wait until `committed` holds for the main frame, reading the frame tree as
   * the authority so a commit event still in flight cannot be missed. Ends
   * early when `abandoned` reports that the browser gave the navigation up.
   */
  private async waitForCommit(
    state: TargetState,
    committed: () => boolean,
    abandoned: () => boolean,
    deadline: number,
  ): Promise<"committed" | "abandoned" | "timeout"> {
    for (;;) {
      if (committed()) return "committed";
      await this.refreshFrame(state);
      if (committed()) return "committed";
      if (state.dialog) {
        // A beforeunload prompt holds the navigation until it is answered.
        throw new DialogOpenedSignal("browser navigation opened a JavaScript dialog");
      }
      if (abandoned()) return "abandoned";
      if (Date.now() >= deadline) return "timeout";
      await delay(NAVIGATION_COMMIT_POLL_MS);
    }
  }

  /**
   * Fail a navigation whose page did not commit. One still pending is stopped
   * first, so it cannot replace the page later; the failure observation then
   * shows the page the tab kept.
   */
  private async failUncommittedNavigation(
    state: TargetState,
    loaderBefore: string,
    outcome: "abandoned" | "timeout",
    committed: () => boolean,
  ): Promise<void> {
    if (outcome === "timeout") {
      await this.sendActionTarget(
        state,
        "Page.stopLoading",
        {},
        { potentialEffect: false, timeoutMs: TARGET_CLOSE_SETTLE_TIMEOUT_MS },
      ).catch(() => undefined);
    }
    await this.refreshFrame(state);
    if (committed()) return;
    const kept =
      state.frame.loaderId === loaderBefore ? "; the tab still shows its previous page" : "";
    throw outcome === "timeout"
      ? new InteractionDefiniteDriverError(
          "timeout",
          `browser navigation did not commit a new page in time and was stopped${kept}`,
          true,
        )
      : new InteractionDefiniteDriverError(
          "resource_unavailable",
          `browser navigation was cancelled before its page committed${kept}`,
          true,
        );
  }

  private async navigateHistory(state: TargetState, direction: "back" | "forward"): Promise<void> {
    if (this.engine === "lightpanda") {
      // Pinned Lightpanda mixes subframe loads into its session-wide history
      // and traverses every entry in the main frame. The CDP entries omit
      // frame identity, so filtering URLs cannot recover safe target history.
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "Lightpanda does not support safe Back/Forward history; navigate to an explicit URL",
      );
    }
    const history = await this.sendActionTarget<{
      currentIndex?: unknown;
      entries?: unknown;
    }>(state, "Page.getNavigationHistory", {});
    const nextIndex =
      typeof history.currentIndex === "number"
        ? history.currentIndex + (direction === "back" ? -1 : 1)
        : -1;
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const entry = entries[nextIndex];
    if (!isRecord(entry) || typeof entry.id !== "number") {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        `browser target has no ${direction} history entry`,
      );
    }
    const commitsBefore = state.mainFrameCommits;
    const loaderBefore = state.frame.loaderId;
    const startedAt = Date.now();
    await this.sendActionTarget(state, "Page.navigateToHistoryEntry", { entryId: entry.id });
    // The entry commits after Chromium answered: a new document, a page the
    // back/forward cache restores, or a same-document entry (pushState).
    const committed = () => state.mainFrameCommits !== commitsBefore;
    const outcome = await this.waitForCommit(
      state,
      committed,
      () => false,
      Math.max(startedAt + this.navigationCommitTimeoutMs, Date.now() + NAVIGATION_COMMIT_GRACE_MS),
    );
    if (outcome !== "committed")
      await this.failUncommittedNavigation(state, loaderBefore, outcome, committed);
    await this.waitForDocumentReady(state, DEFAULT_ACTION_TIMEOUT_MS);
    await this.refreshFrame(state);
  }

  private async waitForCondition(
    state: TargetState,
    action: Extract<BrowserAction, { type: "wait" }>,
  ): Promise<void> {
    const timeoutMs = action.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let pollMs = 0;
    let lookedFinal = false;
    let locatorPolls = 0;
    let loaded = false;
    // When a poll last saw a request still loading: one that stops counting
    // (its body stalled, or it waited too long for a response) leaves the
    // same quiet window after it as one that finished.
    let loadingSeenAt = 0;
    while (Date.now() < deadline) {
      const pollStartedAt = Date.now();
      if (action.condition === "load") {
        // An explicit load wait means the load event: images and other
        // subresources finished, unlike navigation's own interactive wait.
        if ((await this.evaluate(state, "document.readyState")) === "complete") return;
      } else if (action.condition === "network_idle") {
        if (state.networkTrackingOverflow) {
          throw new InteractionDefiniteDriverError(
            "resource_unavailable",
            "browser network tracking exceeded its bounded envelope",
            true,
          );
        }
        loaded = await this.documentReady(state);
        const now = Date.now();
        let loading = false;
        let longPolls = 0;
        let stalled = 0;
        for (const requestId of state.inflightRequests) {
          const load = requestLoad(state.requests.get(requestId), now);
          if (load === "loading") {
            loading = true;
            break;
          }
          if (load === "long_poll") longPolls += 1;
          if (load === "stalled") stalled += 1;
        }
        if (loading) loadingSeenAt = now;
        if (
          loaded &&
          !loading &&
          now - Math.max(state.lastNetworkActivityAt, loadingSeenAt) >= NETWORK_IDLE_MS
        ) {
          if (longPolls > 0) {
            state.actionTrace?.trace.record({
              actionIndex: state.actionTrace.actionIndex,
              kind: "network_busy",
              message: `page loaded; its network went quiet except for ${longPolls === 1 ? "1 request" : `${longPolls} requests`} still waiting for a response after ${formatSeconds(NETWORK_LONG_POLL_MS)} (as long polls do), so the wait ended without ${longPolls === 1 ? "it" : "them"}`,
            } satisfies BrowserActionNoteValue);
          }
          if (stalled > 0) {
            state.actionTrace?.trace.record({
              actionIndex: state.actionTrace.actionIndex,
              kind: "network_busy",
              message: `page loaded; its network went quiet except for ${stalled === 1 ? "1 response" : `${stalled} responses`} whose body has had no data for ${formatSeconds(NETWORK_BODY_STALL_MS)} (as paused streams do; more may still arrive), so the wait ended without ${stalled === 1 ? "it" : "them"}`,
            } satisfies BrowserActionNoteValue);
          }
          return;
        }
      } else if (action.locator) {
        // Polls may reuse Chromium's tree; the one after the first miss and
        // the one expected to be last before the deadline look at a freshly
        // built one, once each.
        const last: boolean = !lookedFinal && pollStartedAt + pollMs + 50 >= deadline;
        const visible = await this.locatorVisible(
          state,
          action.locator,
          last ? "final" : locatorPolls === 1 ? "miss" : "read",
        );
        if (action.condition === "visible" ? visible : !visible) return;
        lookedFinal ||= last;
        locatorPolls += 1;
        pollMs = Date.now() - pollStartedAt;
      } else {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          `${action.condition} wait requires a locator`,
        );
      }
      await delay(50);
    }
    if (
      action.locator &&
      !lookedFinal &&
      (action.condition === "visible" || action.condition === "hidden")
    ) {
      // A poll ran longer than expected and the deadline passed first: the
      // timeout is still only reported from a freshly built tree.
      const visible = await this.locatorVisible(state, action.locator, "final");
      if (action.condition === "visible" ? visible : !visible) return;
    }
    // Some live pages never go quiet: a long poll or a request the page keeps
    // open is indistinguishable from a slow fetch until it ends. A loaded page
    // is ready to use, so the wait ends here and the batch carries on, and the
    // receipt says the network never went idle rather than claim it did.
    if (action.condition === "network_idle" && loaded) {
      state.actionTrace?.trace.record({
        actionIndex: state.actionTrace.actionIndex,
        kind: "network_busy",
        message: `page loaded; its network was still busy after ${formatSeconds(timeoutMs)} (it kept requests open or kept starting new ones, as pages that poll continuously do), so the wait ended there`,
      } satisfies BrowserActionNoteValue);
      return;
    }
    throw new InteractionDefiniteDriverError("timeout", "browser wait condition timed out", true);
  }

  private async waitForDocumentReady(state: TargetState, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.documentReady(state)) return;
      } catch (error) {
        // A document that has just committed may not have its JavaScript
        // context yet; read it again shortly.
        if (!missingExecutionContext(error)) throw error;
      }
      await delay(25);
    }
    throw new InteractionDefiniteDriverError("timeout", "browser navigation timed out", true);
  }

  private async documentReady(state: TargetState): Promise<boolean> {
    const value = await this.evaluate(state, "document.readyState");
    return value === "interactive" || value === "complete";
  }

  private async locatorVisible(
    state: TargetState,
    locator: BrowserLocator,
    read: AccessibilityRead = "read",
  ): Promise<boolean> {
    let candidates: CdpAccessibilityEntry[];
    try {
      candidates = await this.locatorCandidates(state, locator, read);
    } catch (error) {
      if (error instanceof InteractionDefiniteDriverError && error.code === "locator_not_found") {
        return false;
      }
      throw error;
    }
    for (const entry of candidates) {
      state.nodeRoute = this.oopifForFrame(state, entry.frameId);
      try {
        if ((await this.callOnNode(state, entry.backendDOMNodeId, VISIBLE_FUNCTION, [])) === true) {
          return true;
        }
      } catch (error) {
        // A match removed between listing and reading is simply not visible.
        if (
          !(error instanceof InteractionDefiniteDriverError && error.code === "locator_not_found")
        ) {
          throw error;
        }
      }
    }
    return false;
  }

  /**
   * A click often starts a request whose response then updates the page, as
   * when a form posts and shows "Submitted". Observing immediately shows the
   * page before that update, so the agent waits for, or guesses at, a result
   * that is already on its way. Briefly wait for the requests the action
   * itself started (not ones already open, such as long polls) to finish,
   * then give the page a moment to apply the response. Actions that caused
   * no network activity pay nothing, and the wait is bounded.
   */
  private async settleActionRequests(
    state: TargetState,
    before: ActionSettleBaseline,
  ): Promise<void> {
    if (state.dialog) return;
    try {
      // The renderer reports a request or navigation it starts before it
      // answers a later command on the same session, so one cheap round trip
      // makes sure the ones this action started have been sent, and a flush
      // that they have been seen where events arrive separately from replies.
      await this.sendTarget(state, "Runtime.getIsolateId", {});
      await (await this.ensureConnection()).flushEvents?.();
    } catch {
      // Settling only improves the snapshot; it never decides the outcome.
    }
    if (state.navigationSequence !== before.navigation) await this.settleActionNavigation(state);
    if (state.dialog || state.networkActivitySequence === before.activity) return;
    const deadline = Date.now() + ACTION_REQUEST_SETTLE_LIMIT_MS;
    const pending = () =>
      state.networkTrackingOverflow ||
      [...state.inflightRequests].some(
        (requestId) =>
          !before.open.has(requestId) &&
          requestLoad(state.requests.get(requestId), Date.now()) === "loading",
      );
    while (pending() && Date.now() < deadline && !state.dialog) {
      await delay(ACTION_REQUEST_POLL_MS);
    }
    if (!state.dialog) await delay(ACTION_RESPONSE_APPLY_MS);
  }

  /**
   * An action started a main-frame navigation (a submitted form, a followed
   * link). Wait, within a bound, for the new document to commit and parse, so
   * the result shows the page the action led to instead of the one it left.
   * A navigation that ends without a new document (a 204 answer, a download)
   * stops the wait as soon as the frame stops loading.
   */
  private async settleActionNavigation(state: TargetState): Promise<void> {
    const deadline = Date.now() + ACTION_NAVIGATION_SETTLE_LIMIT_MS;
    const loaderId = state.frame.loaderId;
    while (state.navigationPending && Date.now() < deadline && !state.dialog) {
      if (state.frame.loaderId !== loaderId) break;
      await delay(ACTION_REQUEST_POLL_MS);
    }
    if (state.dialog || state.frame.loaderId === loaderId) return;
    while (Date.now() < deadline && !state.dialog) {
      try {
        if (await this.documentReady(state)) return;
      } catch {
        // The new document's context may not exist yet; try again shortly.
      }
      await delay(ACTION_REQUEST_POLL_MS);
    }
  }

  private onNavigationStarted(state: TargetState, event: CdpEvent): void {
    if (event.params.frameId !== state.frame.id) return;
    state.navigationPending = true;
    state.navigationSequence += 1;
  }

  /**
   * Menus, listboxes and dialogs usually animate out before they leave the
   * DOM. A snapshot taken mid-animation reports UI the action already
   * dismissed, so briefly wait for finite running animations to finish.
   * Infinite ones (spinners) are ignored and the wait is bounded. This is a
   * read in an isolated world: page scripts cannot stall or observe it, and
   * any failure simply observes the page as it is.
   */
  private async settleFiniteAnimations(state: TargetState): Promise<void> {
    if (this.engine !== "chromium" || state.dialog) return;
    await this.evaluateForSettle(
      state,
      SETTLE_FINITE_ANIMATIONS_EXPRESSION,
      ANIMATION_SETTLE_LIMIT_MS + 1_000,
    );
  }

  /**
   * Many handlers await something before their request: reading the chosen
   * file, hashing a password, a validation promise. When the action's first
   * settle ran, that request had not started, so the result would show the
   * page before the response the agent is waiting for. Give such a handler
   * one frame to start its request, and settle every request started since
   * `later` (taken before animations settled) like the others. A page that
   * starts nothing pays only that frame.
   */
  private async settleLateActionRequests(
    state: TargetState,
    later: ActionSettleBaseline,
  ): Promise<void> {
    if (this.engine !== "chromium" || state.dialog) return;
    await this.evaluateForSettle(state, LATE_REQUEST_FRAME_EXPRESSION, 1_000);
    await this.settleActionRequests(state, later);
    if (
      state.networkActivitySequence !== later.activity ||
      state.navigationSequence !== later.navigation
    ) {
      await this.settleFiniteAnimations(state);
    }
  }

  /** Evaluates a settle wait where page scripts cannot see or stall it. */
  private async evaluateForSettle(
    state: TargetState,
    expression: string,
    timeoutMs: number,
  ): Promise<void> {
    try {
      const world = await this.sendTarget<{ executionContextId?: unknown }>(
        state,
        "Page.createIsolatedWorld",
        { frameId: state.frame.id, worldName: "opengeni-dom-read" },
      );
      if (!Number.isSafeInteger(world.executionContextId)) return;
      await this.sendTarget(
        state,
        "Runtime.evaluate",
        {
          expression,
          contextId: world.executionContextId,
          returnByValue: true,
          awaitPromise: true,
        },
        { timeoutMs },
      );
    } catch {
      // Settling only improves the snapshot; it never decides the outcome.
    }
  }

  private async evaluate(state: TargetState, expression: string): Promise<unknown> {
    const result = await this.sendTarget<{
      result?: unknown;
      exceptionDetails?: unknown;
    }>(state, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error("browser evaluation failed");
    return isRecord(result.result) ? result.result.value : undefined;
  }

  private async evaluateAction(state: TargetState, expression: string): Promise<unknown> {
    const result = await this.sendActionTarget<{
      result?: unknown;
      exceptionDetails?: unknown;
    }>(state, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error("browser evaluation failed");
    return isRecord(result.result) ? result.result.value : undefined;
  }

  private async callOnNode(
    state: TargetState,
    backendDOMNodeId: number | null,
    functionDeclaration: string,
    args: Array<{ objectId?: string; value?: unknown }>,
    options: { isolatedFrameId?: string; potentialEffect?: boolean } = {},
  ): Promise<unknown> {
    if (backendDOMNodeId === null) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser node has no DOM action target",
      );
    }
    // DOM reads enforce redaction in JavaScript. Resolve the node into a
    // separate world so page scripts cannot replace getAttribute, matches,
    // querySelectorAll, or value accessors used by that policy.
    let executionContextId: number | undefined;
    if (options.isolatedFrameId) {
      const world = await this.sendTarget<{ executionContextId?: unknown }>(
        state,
        "Page.createIsolatedWorld",
        { frameId: options.isolatedFrameId, worldName: "opengeni-dom-read" },
      );
      if (!Number.isSafeInteger(world.executionContextId)) {
        throw new Error("CDP did not create an isolated DOM read world");
      }
      executionContextId = world.executionContextId as number;
    }
    const resolved = await this.sendTarget<{ object?: unknown }>(state, "DOM.resolveNode", {
      backendNodeId: backendDOMNodeId,
      ...(executionContextId === undefined ? {} : { executionContextId }),
    });
    if (!isRecord(resolved.object) || typeof resolved.object.objectId !== "string") {
      throw new InteractionDefiniteDriverError(
        "locator_not_found",
        "browser element is no longer present",
      );
    }
    const objectId = resolved.object.objectId;
    try {
      const result = await this.sendActionTarget<{
        result?: unknown;
        exceptionDetails?: unknown;
      }>(
        state,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration,
          arguments: args.map((argument) =>
            argument.objectId ? { objectId: argument.objectId } : { value: argument.value },
          ),
          returnByValue: true,
          awaitPromise: true,
        },
        { potentialEffect: options.potentialEffect ?? false },
      );
      if (result.exceptionDetails) throw new Error("browser element function failed");
      return isRecord(result.result) ? result.result.value : undefined;
    } finally {
      await this.sendTarget(state, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }

  private async sendTarget<T = Record<string, unknown>>(
    state: TargetState,
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const connection = await this.ensureConnection();
    this.assertCurrentTargetState(state);
    return await connection.send<T>(method, params, {
      sessionId: this.commandSession(state, method),
      ...options,
    });
  }

  /** Node-level calls for a node inside a cross-origin frame go to that frame's
   * session. Input and page-level calls use the page session, with pointer
   * coordinates translated into page space; node clicks pass their frame's
   * session explicitly (see clickInput). */
  private commandSession(state: TargetState, method: string): string {
    const route = state.nodeRoute;
    if (!route) return state.sessionId;
    return method.startsWith("DOM.") ||
      method.startsWith("Runtime.") ||
      method.startsWith("Accessibility.") ||
      method === "Page.createIsolatedWorld"
      ? route.sessionId
      : state.sessionId;
  }

  private async sendActionTarget<T = Record<string, unknown>>(
    state: TargetState,
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: { potentialEffect?: boolean; sessionId?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    const connection = await this.ensureConnection();
    this.assertCurrentTargetState(state);
    if (state.inputFence !== null && method.startsWith("Input.")) {
      const fence = state.inputFence;
      // Checked once, before the action's first input event: input that the
      // page answers by navigating (a mousedown handler, say) must still be
      // allowed to finish, as must the release of a pressed button.
      state.inputFence = null;
      // Input lands on whatever document the tab shows, so read the frame tree
      // itself: a commit whose event is still in flight counts too.
      await this.refreshFrame(state);
      if (fence !== state.documentGeneration) {
        throw new DocumentMovedBeforeInputError(
          "browser document changed after the action found its element; no input was sent",
        );
      }
    }
    let unsubscribe: () => void = () => undefined;
    const dialog = new Promise<{ kind: "dialog" }>((resolve) => {
      unsubscribe = connection.on(
        "Page.javascriptDialogOpening",
        () => resolve({ kind: "dialog" }),
        state.sessionId,
      );
    });
    if (options.potentialEffect !== false && method !== "Page.getNavigationHistory")
      state.actionEffectCount += 1;
    const command = connection.send<T>(method, params, {
      sessionId: options.sessionId ?? this.commandSession(state, method),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    try {
      const result = await Promise.race([
        command.then((value) => ({ kind: "result" as const, value })),
        dialog,
      ]);
      if (result.kind === "dialog") {
        void command.catch(() => undefined);
        throw new DialogOpenedSignal("browser action opened a JavaScript dialog");
      }
      return result.value;
    } finally {
      unsubscribe();
    }
  }

  /**
   * Runs page work that a JavaScript dialog would block, ending it as soon as
   * a dialog is open instead of waiting out command deadlines: until the
   * dialog is answered the page cannot reply. Work that notices the dialog
   * itself (input that opened it) settles right away, and its own account of
   * what happened stands; otherwise it is abandoned and settles later.
   */
  private async untilDialog<T>(state: TargetState, work: () => Promise<T>): Promise<T> {
    if (state.dialog) throw new DialogBlockedError(state.dialog);
    const connection = await this.ensureConnection();
    let unsubscribe: () => void = () => undefined;
    const opened = new Promise<{ kind: "dialog" }>((resolve) => {
      unsubscribe = connection.on(
        "Page.javascriptDialogOpening",
        () => resolve({ kind: "dialog" }),
        state.sessionId,
      );
    });
    const scope: DialogWorkScope = { abandoned: false };
    const settled = dialogWork.run(scope, work).then(
      (value) => ({ kind: "result" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    try {
      let outcome = await Promise.race([settled, opened]);
      if (outcome.kind === "dialog") {
        const dialog = outcome;
        outcome = await Promise.race([settled, delay(DIALOG_WORK_SETTLE_MS).then(() => dialog)]);
      }
      if (outcome.kind === "dialog") {
        // The work is still blocked on the page. It must never act after
        // its caller was told where it stopped.
        scope.abandoned = true;
        throw new DialogBlockedError(state.dialog);
      }
      if (outcome.kind === "result") return outcome.value;
      const error = outcome.error;
      // A typed driver outcome already says what happened. Anything else that
      // failed while a dialog is open failed because of it.
      if (
        state.dialog &&
        !(
          error instanceof DialogBlockedError ||
          error instanceof InteractionDefiniteDriverError ||
          error instanceof InteractionOutcomeUnknownDriverError
        )
      )
        throw new DialogBlockedError(state.dialog);
      throw error;
    } finally {
      unsubscribe();
    }
  }

  private assertExpectedGenerations(command: BrowserActionCommandValue, state: TargetState): void {
    if (command.browserSessionId !== this.browserSessionId) {
      throw new InteractionDefiniteDriverError(
        "resource_not_found",
        "browser command targets another browser session",
      );
    }
    if (command.controllerGeneration !== this.controllerGeneration) {
      throw new InteractionDefiniteDriverError(
        "controller_stale",
        "browser command targets an earlier controller",
      );
    }
    if (command.expectedTargetGeneration !== this.targetGeneration(state.targetId)) {
      throw new InteractionDefiniteDriverError(
        "target_stale",
        "browser command targets an earlier target generation",
      );
    }
    if (command.expectedDocumentGeneration !== state.documentGeneration) {
      throw new InteractionDefiniteDriverError(
        "document_stale",
        "browser command targets an earlier document",
      );
    }
    if (command.expectedFrameId !== state.frameGeneration) {
      throw new InteractionDefiniteDriverError(
        "frame_stale",
        "browser command targets an earlier frame generation",
      );
    }
  }

  private targetFromInfo(info: TargetInfo, state: TargetState | null): BrowserTargetValue {
    return BrowserTarget.parse({
      id: info.targetId,
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
      targetGeneration: this.targetGeneration(info.targetId),
      documentGeneration: state?.documentGeneration ?? null,
      kind: targetKind(info),
      title: info.title,
      // Chromium can briefly report ":" or an empty main-frame URL during
      // target creation. Use the first absolute URL so an accepted tab create
      // cannot turn into a schema-validation 500.
      url: absoluteTargetUrl(state?.frame.url) ?? absoluteTargetUrl(info.url) ?? "about:blank",
      selected: this.selectedTargetId === info.targetId,
      attached: state !== null,
      createdAt: state?.createdAt ?? this.firstSeen(info.targetId),
    });
  }

  private targetGeneration(targetId: string): string {
    return generation(
      "target",
      this.browserSessionId,
      this.controllerGeneration,
      this.targetPhysicalGeneration(targetId),
      targetId,
    );
  }

  private targetPhysicalGeneration(targetId: string): string {
    return this.targetPhysicalGenerations.get(targetId) ?? this.physicalGeneration;
  }

  private assertCurrentTargetState(state: TargetState): void {
    if (
      this.states.get(state.targetId) !== state ||
      this.targetPhysicalGeneration(state.targetId) !== state.authorityGeneration
    ) {
      throw new InteractionDefiniteDriverError("target_stale", "Browser tab attachment changed");
    }
  }

  private contextScope(): { browserContextId?: string } {
    return this.browserContextId ? { browserContextId: this.browserContextId } : {};
  }

  private async targetInfos(connection: BrowserCdpConnection): Promise<TargetInfo[]> {
    const response = await connection.send<{ targetInfos?: unknown }>("Target.getTargets");
    if (!Array.isArray(response.targetInfos))
      throw new Error("CDP returned an invalid target list");
    return response.targetInfos
      .map(normalizeTargetInfo)
      .filter(
        (target) =>
          this.browserContextId === undefined || target.browserContextId === this.browserContextId,
      );
  }

  private async requireTargetInfo(
    connection: BrowserCdpConnection,
    targetId: string,
  ): Promise<TargetInfo> {
    const info = (await this.targetInfos(connection)).find(
      (candidate) => candidate.targetId === targetId,
    );
    if (!info || !isVisibleTarget(info)) {
      if (!info && this.closedBlankTargetIds.has(targetId))
        throw this.closedBlankTargetError(targetId);
      throw this.missingTargetError(info ? null : targetId);
    }
    return info;
  }

  /** No open tab has this ID: say why when this driver knows, and how to
   * carry on. */
  private missingTargetError(targetId: string | null): InteractionDefiniteDriverError {
    return new InteractionDefiniteDriverError(
      "target_not_found",
      goneBrowserTargetMessage(targetId ? (this.goneTargets.get(targetId) ?? null) : null),
    );
  }

  /** A tab this driver knew closed. A close this driver asked for says so;
   * any other close came from the page or from someone using the browser. */
  private rememberClosedTarget(targetId: string, byCloseCall = false): void {
    const closing = byCloseCall || this.closingTargetIds.has(targetId);
    const existing = this.goneTargets.get(targetId);
    if (existing?.kind === "relaunched") return;
    if (existing && !closing) return;
    if (!closing && !this.firstSeenAt.has(targetId) && !this.states.has(targetId)) return;
    this.rememberGoneTarget(targetId, {
      kind: "closed",
      at: this.timestamp().replace(/\.\d{3}Z$/u, "Z"),
      byCloseCall: closing,
    });
  }

  private rememberGoneTarget(targetId: string, gone: GoneBrowserTarget): void {
    this.goneTargets.delete(targetId);
    this.goneTargets.set(targetId, gone);
    while (this.goneTargets.size > MAX_GONE_TARGETS) {
      this.goneTargets.delete(this.goneTargets.keys().next().value!);
    }
  }

  /** The browser this driver runs replaced an earlier one, whose tabs it
   * reopened with new IDs: a call naming an earlier tab learns why it is gone
   * and which tab shows its page now. */
  noteRelaunchedTabs(relaunched: BrowserRelaunchedTabs): void {
    for (const tab of relaunched.tabs) {
      this.rememberGoneTarget(tab.targetId, {
        kind: "relaunched",
        reason: relaunched.reason,
        ...(relaunched.idleReleaseMinutes !== undefined
          ? { idleReleaseMinutes: relaunched.idleReleaseMinutes }
          : {}),
        replacementId: tab.replacementId,
      });
    }
  }

  /** The session closed its own empty tab when it last let go of the
   * person's browser: say so, and where to continue. */
  private closedBlankTargetError(targetId: string): InteractionDefiniteDriverError {
    const current = this.selectedTargetId;
    return new InteractionDefiniteDriverError(
      "target_not_found",
      `browser target does not exist: this session closed this empty tab when it last released the browser${current && current !== targetId ? `; its current tab is ${current}` : ""}`,
    );
  }

  /** Headed Chromium can acknowledge a background target before its first URL
   * reaches Target.getTargets/Page.getFrameTree. Do not expose that transient
   * empty document (or fail after the tab was already created); wait for the
   * exact returned target to become observable while keeping it unfocused. */
  private async waitForCreatedTargetInfo(
    connection: BrowserCdpConnection,
    targetId: string,
  ): Promise<TargetInfo> {
    const deadline = Date.now() + TARGET_CREATION_SETTLE_TIMEOUT_MS;
    let last: TargetInfo | null = null;
    do {
      last =
        (await this.targetInfos(connection)).find((candidate) => candidate.targetId === targetId) ??
        null;
      if (last && isVisibleTarget(last) && absoluteTargetUrl(last.url)) return last;
      await delay(25);
    } while (Date.now() < deadline);
    if (!last || !isVisibleTarget(last)) {
      throw new InteractionDefiniteDriverError("target_not_found", "browser target does not exist");
    }
    throw new InteractionDefiniteDriverError(
      "timeout",
      "browser target did not become observable",
      true,
    );
  }

  private async waitForCreatedTargetFrame(state: TargetState): Promise<void> {
    const deadline = Date.now() + TARGET_CREATION_SETTLE_TIMEOUT_MS;
    do {
      await this.refreshFrame(state);
      if (absoluteTargetUrl(state.frame.url)) return;
      await delay(25);
    } while (Date.now() < deadline);
    throw new InteractionDefiniteDriverError(
      "timeout",
      "browser target document did not become observable",
      true,
    );
  }

  private onFrameNavigated(state: TargetState, event: CdpEvent): void {
    if (!isRecord(event.params.frame) || typeof event.params.frame.parentId === "string") return;
    const frame = event.params.frame;
    if (
      typeof frame.id !== "string" ||
      typeof frame.loaderId !== "string" ||
      typeof frame.url !== "string"
    ) {
      return;
    }
    // Some CDP-compatible engines omit `parentId` on child-frame navigation
    // events. A page target has one established main-frame id, so never let a
    // malformed child event invalidate the top-level document generation.
    // `refreshFrame` still detects the exceptional case where the real main
    // frame id itself changes.
    if (frame.id !== state.frame.id) return;
    state.navigationPending = false;
    state.mainFrameCommits += 1;
    if (frame.loaderId !== state.frame.loaderId) {
      // The previous document and its frames are gone. Chromium does not
      // always report their unfinished requests (a WebUI start page's
      // resources, for one), so they must not keep the new page loading.
      for (const requestId of [...state.inflightRequests]) {
        const loaderId = state.requests.get(requestId)?.loaderId;
        if (loaderId == null || loaderId === frame.loaderId) continue;
        state.inflightRequests.delete(requestId);
        state.requests.delete(requestId);
      }
    }
    const replaced = frame.loaderId !== state.frame.loaderId;
    this.adoptMainFrame(state, { id: frame.id, loaderId: frame.loaderId, url: frame.url });
    // Any main-frame commit can change the page's content, so its snapshot
    // is read again even when the loader id stayed the same.
    if (!replaced) state.accessibility = null;
  }

  private recordFailedRequest(
    state: TargetState,
    requestId: string,
    details: { message: string; status?: number; url?: string | null },
  ): void {
    if (state.failedRequests.has(requestId)) return;
    const request = state.requests.get(requestId);
    if (request?.browserInitiated) return;
    state.failedRequests.add(requestId);
    state.diagnostics.failedRequestCount += 1;
    this.appendDiagnostic(state, {
      kind: "failed_request",
      level: "error",
      message: details.message,
      url: details.url ?? request?.url ?? null,
      method: request?.method ?? null,
      status: details.status ?? null,
      filename: null,
    });
  }

  /**
   * Append the tab's console messages and uncaught exceptions that were not
   * reported yet. The page session never keeps Runtime enabled, because a page
   * can detect that. Chrome buffers these messages per document and replays
   * them all, before answering, when Runtime is enabled; a brief enable, then
   * disable, reads them only when the caller asks for diagnostics.
   */
  private async harvestRuntimeDiagnostics(state: TargetState): Promise<void> {
    // Lightpanda reports these live (see attachTarget); enabling and disabling
    // Runtime here would only stop that stream.
    if (this.engine === "lightpanda") return;
    const connection = await this.ensureConnection();
    const sessionId = state.sessionId;
    const replayed: Array<
      | { kind: "console"; key: string; params: Record<string, unknown> }
      | { kind: "page_error"; key: string; params: Record<string, unknown> }
    > = [];
    const stops = [
      connection.on(
        "Runtime.consoleAPICalled",
        (event) => {
          const params = event.params;
          replayed.push({
            kind: "console",
            key: `console:${String(params.executionContextId)}:${String(params.timestamp)}:${String(params.type)}`,
            params,
          });
        },
        sessionId,
      ),
      connection.on(
        "Runtime.exceptionThrown",
        (event) => {
          const params = event.params;
          const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : {};
          replayed.push({
            kind: "page_error",
            key: `exception:${String(details.exceptionId)}:${String(params.timestamp)}`,
            params,
          });
        },
        sessionId,
      ),
    ];
    try {
      // The replay arrives before the enable response on the same session.
      await connection.send("Runtime.enable", {}, { sessionId });
    } finally {
      for (const stop of stops) stop();
      void connection.send("Runtime.disable", {}, { sessionId }).catch(() => undefined);
    }
    if (this.states.get(state.targetId) !== state) return;
    const current = new Set<string>();
    for (const message of replayed) {
      current.add(message.key);
      if (state.runtimeDiagnosticKeys.has(message.key)) continue;
      this.appendRuntimeDiagnostic(
        state,
        message.kind,
        message.params,
        runtimeTimestamp(message.params.timestamp),
      );
    }
    // Chrome drops a document's messages with the document, so anything it no
    // longer replays cannot come back; keep only the keys it still holds.
    state.runtimeDiagnosticKeys = current;
  }

  /** Record one Runtime console message or uncaught exception for the tab.
   * A replayed message carries when it was logged; a live one happened now. */
  private appendRuntimeDiagnostic(
    state: TargetState,
    kind: "console" | "page_error",
    params: Record<string, unknown>,
    occurredAt?: string,
  ): void {
    if (kind === "console") {
      const level = consoleLevel(params.type);
      if (level === "error") state.diagnostics.consoleErrorCount += 1;
      this.appendDiagnostic(
        state,
        {
          kind: "console",
          level,
          message: consoleMessage(params.args, (text) => this.typedSecrets.redact(text)),
          url: null,
          method: null,
          status: null,
          filename: null,
        },
        occurredAt,
      );
    } else {
      state.diagnostics.pageErrorCount += 1;
      const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : {};
      this.appendDiagnostic(
        state,
        {
          kind: "page_error",
          level: "error",
          message: exceptionMessage(details, (text) => this.typedSecrets.redact(text)),
          url: boundedUrlField(details.url),
          method: null,
          status: null,
          filename: null,
        },
        occurredAt,
      );
    }
  }

  private appendDiagnostic(
    state: TargetState,
    entry: Omit<BrowserDiagnosticEntry, "sequence" | "occurredAt">,
    occurredAt: string = this.timestamp(),
  ): void {
    const parsed = BrowserDiagnosticEntry.parse({
      ...entry,
      sequence: ++state.diagnosticSequence,
      occurredAt,
    });
    state.diagnosticEntries.push(parsed);
    if (state.diagnosticEntries.length > INTERACTION_MAX_DIAGNOSTIC_ENTRIES) {
      state.diagnosticEntries.splice(
        0,
        state.diagnosticEntries.length - INTERACTION_MAX_DIAGNOSTIC_ENTRIES,
      );
    }
  }

  private removeState(targetId: string, preserveFirstSeen = false): void {
    // A closed or destroyed tab is gone; a crashed one that we only detached from stays marked.
    if (!preserveFirstSeen) this.crashedTargets.delete(targetId);
    const state = this.states.get(targetId);
    if (!state) return;
    this.failAllScreencasts(state, new CdpTransportError("browser target closed"));
    for (const unsubscribe of state.unsubscribe) unsubscribe();
    for (const oopif of state.oopifs.values()) {
      for (const stop of oopif.unsubscribe.splice(0)) stop();
    }
    for (const worker of state.workers.values()) {
      for (const stop of worker.unsubscribe.splice(0)) stop();
    }
    state.workers.clear();
    this.states.delete(targetId);
    if (!preserveFirstSeen) {
      this.firstSeenAt.delete(targetId);
      this.targetViewports.delete(targetId);
    }
  }

  /**
   * The tab's renderer died. Nothing will answer its pending or later page
   * commands, so detach: that ends every command waiting on it at once, and
   * the next use re-attaches and reports the crash immediately.
   */
  private onTargetCrashed(state: TargetState): void {
    if (this.states.get(state.targetId) !== state) return;
    this.crashedTargets.add(state.targetId);
    const forget = () => {
      if (this.states.get(state.targetId) !== state) return;
      this.targetPhysicalGenerations.set(state.targetId, randomUUID());
      this.removeState(state.targetId, true);
    };
    void this.ensureConnection()
      .then((connection) =>
        connection.send(
          "Target.detachFromTarget",
          { sessionId: state.sessionId },
          { timeoutMs: 1_000 },
        ),
      )
      .catch(() => undefined)
      .finally(forget);
  }

  private firstSeen(targetId: string): string {
    const existing = this.firstSeenAt.get(targetId);
    if (existing) return existing;
    const createdAt = this.timestamp();
    this.firstSeenAt.set(targetId, createdAt);
    return createdAt;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

/** Retrying can't help a tab whose page process died; say what will. */
function tabCrashedError(): InteractionDefiniteDriverError {
  return new InteractionDefiniteDriverError(
    "tab_crashed",
    "This browser tab crashed and no longer responds. Open a new tab (and close this one), then continue there.",
    false,
  );
}

/** How long a runtime continuing a session in the person's own browser waits
 * for the tab the session was using before it opens a new one instead. A
 * live page answers in well under a second. */
const REBIND_TIMEOUT_MS = 5_000;

const TAB_NOT_RESPONDING_MESSAGE =
  "This browser tab is not responding: its page did not answer in time. Close it and open the page in a new tab, or reload it from the browser window. The browser and other tabs remain usable.";

/** A page-scoped command deadline means this tab stopped answering, not that
 * the browser or its transport was lost. Waiting again cannot help until the
 * tab is reloaded or replaced, so the diagnosis is definite and not retryable. */
function tabNotRespondingError(cause: CdpCommandTimeoutError): InteractionControllerError {
  const failure = new InteractionControllerError("tab_not_responding", TAB_NOT_RESPONDING_MESSAGE);
  failure.cause = cause;
  return failure;
}

function frameStreamDiagnostic(event: string, fields: Readonly<Record<string, unknown>>): void {
  console.info(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

function normalizeTargetInfo(value: unknown): TargetInfo {
  if (!isRecord(value) || typeof value.targetId !== "string" || typeof value.type !== "string") {
    throw new Error("CDP returned an invalid target");
  }
  return {
    browserContextId: typeof value.browserContextId === "string" ? value.browserContextId : null,
    targetId: value.targetId,
    type: value.type,
    title: typeof value.title === "string" ? value.title : "",
    url: typeof value.url === "string" ? value.url : "about:blank",
    attached: value.attached === true,
    openerId: typeof value.openerId === "string" ? value.openerId : null,
  };
}

/** A tab with no page: the blank document a new tab starts on (attached
 * Chrome creates it as an empty data URL) or the browser's new-tab page. */
export function isBlankTabUrl(url: string): boolean {
  return (
    url === "" ||
    url === "about:blank" ||
    url === "data:text/html," ||
    url === "chrome://newtab/" ||
    url === "chrome://new-tab-page/"
  );
}

/** Why the tab list after a completed close could not be read. A lost
 * connection leaves the result unknown, not failed: the tab closed, but which
 * tabs remain is unread. Other failures keep their own classification. */
function closedTargetListFailure(error: unknown): unknown {
  if (!(error instanceof CdpTransportError || error instanceof CdpCommandTimeoutError)) {
    return error;
  }
  return new InteractionOutcomeUnknownDriverError(
    "outcome_unknown",
    "The tab closed, but the browser's connection ended before its remaining tabs could be listed; list the tabs again once the browser is connected",
    false,
  );
}

/** Why a clipboard copy found nothing to copy, and what copies instead. */
export function clipboardCopyFailure(reason: string, fromElement: boolean): string {
  switch (reason) {
    case "protected":
      return "browser clipboard cannot copy a protected field";
    case "no_value":
      return 'browser clipboard copy found no value on this element; copy its text with content "text", or read it with browser_read mode=dom';
    case "no_selection":
      return fromElement
        ? "browser clipboard copy found nothing selected in this element; omit content to copy all of its text or value"
        : "browser clipboard copy found nothing selected on the page; select text first, or pass a locator to copy an element's text or value";
    case "detached":
      return "browser clipboard copy lost its element, which is no longer on the page; observe the page and copy again";
    case "too_large":
      return "browser clipboard copy is larger than the 1 MiB clipboard limit; read the text in parts with browser_read mode=dom and offset";
    default:
      return "browser clipboard copy found no focused element to copy from; pass a locator to copy an element's text or value";
  }
}

function absoluteTargetUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return null;
  try {
    return new URL(value).href.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function visibleTargets(infos: readonly TargetInfo[]): TargetInfo[] {
  const targets = infos.filter(isVisibleTarget);
  const hasOrdinaryPage = targets.some(
    (target) => target.type === "page" && target.url !== "chrome://newtab/",
  );
  return hasOrdinaryPage ? targets.filter((target) => target.url !== "chrome://newtab/") : targets;
}

function visiblePageTargets(infos: readonly TargetInfo[]): TargetInfo[] {
  return visibleTargets(infos).filter((target) => target.type === "page");
}

function isVisibleTarget(info: TargetInfo): boolean {
  return info.type === "page";
}

function targetKind(info: TargetInfo): BrowserTargetValue["kind"] {
  if (info.openerId) return "popup";
  if (info.type === "background_page") return "background_page";
  if (info.type.includes("worker")) return "worker";
  return "page";
}

function documentGeneration(
  controllerGeneration: string,
  physicalGeneration: string,
  targetId: string,
  loaderId: string,
): string {
  return generation("document", controllerGeneration, physicalGeneration, targetId, loaderId);
}

function frameGeneration(
  controllerGeneration: string,
  physicalGeneration: string,
  targetId: string,
  frameId: string,
): string {
  return generation("frame", controllerGeneration, physicalGeneration, targetId, frameId);
}

function generation(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}

function uniqueEntries(entries: CdpAccessibilityEntry[]): CdpAccessibilityEntry | null {
  const byBackend = new Map<number, CdpAccessibilityEntry>();
  for (const entry of entries) {
    if (entry.backendDOMNodeId !== null) byBackend.set(entry.backendDOMNodeId, entry);
  }
  return byBackend.size === 1 ? [...byBackend.values()][0]! : null;
}

function sameAccessibleName(name: string | null, requested: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  return name !== null && normalize(name) === normalize(requested);
}

const AMBIGUOUS_LOCATOR_LISTED_MATCHES = 5;
/** Bounds the per-poll work of a wait whose locator matches many elements. */
const WAIT_LOCATOR_CANDIDATE_LIMIT = 50;
/** Queries of a CSS locator when each finds its document root gone. */
const DOM_QUERY_ATTEMPTS = 3;

function domLocatorSelector(
  locator: Extract<BrowserLocator, { kind: "css" | "test_id" | "placeholder" }>,
): string {
  return locator.kind === "css"
    ? locator.selector
    : locator.kind === "test_id"
      ? `[data-testid="${cssString(locator.value)}"]`
      : `[placeholder="${cssString(locator.text)}"]`;
}

function accessibilityLocatorMatches(
  entries: readonly CdpAccessibilityEntry[],
  locator: Extract<BrowserLocator, { kind: "role" | "label" | "text" }>,
): CdpAccessibilityEntry[] {
  if (locator.kind === "role") {
    return entries.filter(
      (entry) =>
        entry.backendDOMNodeId !== null &&
        entry.role.toLowerCase() === locator.role.toLowerCase() &&
        (locator.name === undefined ||
          (locator.exact
            ? sameAccessibleName(entry.name, locator.name)
            : (entry.name ?? "").toLocaleLowerCase().includes(locator.name.toLocaleLowerCase()))),
    );
  }
  if (locator.kind === "label") {
    return entries.filter(
      (entry) =>
        entry.backendDOMNodeId !== null &&
        sameAccessibleName(entry.name, locator.text) &&
        isFormControlRole(entry.role),
    );
  }
  return entries.filter(
    (entry) =>
      entry.backendDOMNodeId !== null &&
      entry.role === "text" &&
      (locator.exact
        ? sameAccessibleName(entry.name, locator.text)
        : (entry.name ?? "").toLocaleLowerCase().includes(locator.text.toLocaleLowerCase())),
  );
}

/** Name the candidates so the caller can act on one ref instead of guessing. */
function ambiguousLocatorMessage(matches: readonly CdpAccessibilityEntry[]): string {
  const byBackend = new Map<number, CdpAccessibilityEntry>();
  for (const entry of matches) {
    if (entry.backendDOMNodeId !== null && !byBackend.has(entry.backendDOMNodeId))
      byBackend.set(entry.backendDOMNodeId, entry);
  }
  const distinct = [...byBackend.values()];
  const listed = distinct
    .slice(0, AMBIGUOUS_LOCATOR_LISTED_MATCHES)
    .map((entry) => {
      const name = boundedTargetText(entry.name);
      return `${entry.role}${name ? ` ${JSON.stringify(name)}` : ""} [${entry.ref}]`;
    })
    .join(", ");
  const more =
    distinct.length > AMBIGUOUS_LOCATOR_LISTED_MATCHES
      ? ` and ${distinct.length - AMBIGUOUS_LOCATOR_LISTED_MATCHES} more`
      : "";
  return `browser locator matched ${distinct.length} elements: ${listed}${more}; act on one ref or make the locator exact`;
}

function boundedTargetText(value: string | null): string | null {
  const text = value?.replace(/\s+/gu, " ").trim() ?? "";
  if (!text) return null;
  const codePoints = Array.from(text);
  return codePoints.length <= INTERACTION_MAX_RESOLVED_TARGET_TEXT
    ? text
    : `${codePoints.slice(0, INTERACTION_MAX_RESOLVED_TARGET_TEXT - 1).join("")}\u2026`;
}

function boundedTargetRole(value: string): string {
  const role = value.trim().slice(0, 64);
  return role || "generic";
}

function syntheticEntry(backendDOMNodeId: number): CdpAccessibilityEntry {
  return {
    ref: "",
    nodeId: "",
    parentNodeId: null,
    backendDOMNodeId,
    frameId: null,
    role: "generic",
    name: null,
    states: [],
    actions: [],
    nameSources: [],
  };
}

function emptyAccessibilitySnapshot(): CdpAccessibilitySnapshot {
  return {
    roots: [],
    nodeCount: 0,
    focusedRef: null,
    entries: [],
    entriesByRef: new Map(),
    entriesByNodeId: new Map(),
  };
}

/** The outline's copy of a snapshot with scrolling panels marked: a
 * "scrollable=<directions>" state and the scroll action, which also lists the
 * panel's ref. The snapshot that resolves locators is left as it was. */
function withScrollPanels(
  snapshot: CdpAccessibilitySnapshot,
  frameId: string,
  panels: ReadonlyMap<number, string>,
): CdpAccessibilitySnapshot {
  const marked = new Map<string, string>();
  for (const entry of snapshot.entries) {
    if (entry.frameId !== frameId || entry.backendDOMNodeId === null) continue;
    const directions = panels.get(entry.backendDOMNodeId);
    if (directions) marked.set(entry.ref, directions);
  }
  if (marked.size === 0) return snapshot;
  const mark = (nodes: InteractionSemanticNodeValue[]): InteractionSemanticNodeValue[] => {
    const next = nodes.map((node) => {
      const directions = marked.get(node.ref);
      const children = node.children ? mark(node.children) : undefined;
      if (!directions && children === node.children) return node;
      return {
        ...node,
        ...(directions
          ? {
              states: [...node.states, `scrollable=${directions}`],
              actions: node.actions.includes("scroll") ? node.actions : [...node.actions, "scroll"],
            }
          : {}),
        ...(children ? { children } : {}),
      };
    });
    return next.every((node, index) => node === nodes[index]) ? nodes : next;
  };
  return { ...snapshot, roots: mark(snapshot.roots) };
}

function isFormControlRole(role: string): boolean {
  return [
    "button",
    "checkbox",
    "combobox",
    "listbox",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "textbox",
  ].includes(role);
}

type ParsedKey = {
  key: string;
  code: string;
  keyCode: number;
  modifiers: number;
  text: string;
};

/** A literal character as one key press (typed with `type.mode: "keys"`). */
function characterKey(character: string): ParsedKey {
  if (character === "\n" || character === "\r") {
    return { key: "Enter", code: "Enter", keyCode: 13, modifiers: 0, text: "\r" };
  }
  if (character === " ") return { key: " ", code: "Space", keyCode: 32, modifiers: 0, text: " " };
  if (/^[0-9]$/u.test(character)) {
    return {
      key: character,
      code: `Digit${character}`,
      keyCode: character.charCodeAt(0),
      modifiers: 0,
      text: character,
    };
  }
  if (/^[a-z]$/iu.test(character)) {
    const upper = character.toUpperCase();
    return {
      key: character,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      modifiers: 0,
      text: character,
    };
  }
  return { key: character, code: "", keyCode: 0, modifiers: 0, text: character };
}

/** Replace `{{secret:…}}` references with the controller-private values right
 * before dispatch. The returned command no longer carries the side map, so
 * nothing downstream can echo it. */
function materializeCommandSecrets(command: BrowserActionCommandValue): BrowserActionCommandValue {
  if (command.secretValues === undefined) return command;
  try {
    const action = materializeBrowserActionSecrets(command);
    const { secretValues: _consumed, ...rest } = command;
    return { ...rest, action };
  } catch (error) {
    if (error instanceof InteractionSecretValueError) {
      throw new InteractionDefiniteDriverError("invalid_action", error.message);
    }
    throw error;
  }
}

function parseKey(input: string, mac: boolean): ParsedKey {
  const parts = input.split("+");
  const rawKey = parts.pop()?.trim();
  if (!rawKey) throw new InteractionDefiniteDriverError("invalid_action", "browser key is invalid");
  let modifiers = 0;
  for (const part of parts) {
    const modifier = part.trim().toLowerCase();
    if (modifier === "alt" || modifier === "option") modifiers |= 1;
    else if (modifier === "control" || modifier === "ctrl") modifiers |= 2;
    else if (modifier === "mod") modifiers |= mac ? 4 : 2;
    else if (modifier === "meta" || modifier === "command" || modifier === "cmd") modifiers |= 4;
    else if (modifier === "shift") modifiers |= 8;
    else
      throw new InteractionDefiniteDriverError("invalid_action", "browser key modifier is invalid");
  }
  if (rawKey.toLowerCase() === "mod") {
    throw new InteractionDefiniteDriverError(
      "invalid_action",
      "browser key requires a non-modifier key",
    );
  }
  const special = KEY_DEFINITIONS[rawKey.toLowerCase()];
  if (special) return { ...special, modifiers, text: special.text ?? "" };
  if ([...rawKey].length !== 1) {
    throw new InteractionDefiniteDriverError("invalid_action", "browser key is unsupported");
  }
  const upper = rawKey.toUpperCase();
  return {
    key: rawKey,
    code: /[a-z]/iu.test(rawKey) ? `Key${upper}` : rawKey,
    keyCode: upper.codePointAt(0) ?? 0,
    modifiers,
    text: modifiers === 0 ? rawKey : "",
  };
}

type KeyDefinition = { key: string; code: string; keyCode: number; text?: string };

const NAMED_KEY_DEFINITIONS: Record<string, KeyDefinition> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  contextmenu: { key: "ContextMenu", code: "ContextMenu", keyCode: 93 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

// Standard key names (KeyboardEvent.key, case-insensitive), the function keys
// F1-F24, and the common short spellings of the same keys.
const KEY_DEFINITIONS: Record<string, KeyDefinition> = {
  ...NAMED_KEY_DEFINITIONS,
  ...Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => {
      const name = `F${index + 1}`;
      return [name.toLowerCase(), { key: name, code: name, keyCode: 112 + index }];
    }),
  ),
  esc: NAMED_KEY_DEFINITIONS.escape!,
  return: NAMED_KEY_DEFINITIONS.enter!,
  del: NAMED_KEY_DEFINITIONS.delete!,
  ins: NAMED_KEY_DEFINITIONS.insert!,
  pgup: NAMED_KEY_DEFINITIONS.pageup!,
  pgdn: NAMED_KEY_DEFINITIONS.pagedown!,
  up: NAMED_KEY_DEFINITIONS.arrowup!,
  down: NAMED_KEY_DEFINITIONS.arrowdown!,
  left: NAMED_KEY_DEFINITIONS.arrowleft!,
  right: NAMED_KEY_DEFINITIONS.arrowright!,
};

// Typical exit animations take 100-300 ms. Longer finite animations are
// waited for only this long, so a slow transition cannot stall every action.
// Action request deadlines count these settle limits (BROWSER_ACTION_SETTLE_MAX_MS).
const ANIMATION_SETTLE_LIMIT_MS = BROWSER_ANIMATION_SETTLE_MS;
// Requests an action starts usually answer in well under a second; a request
// that stays open (a stream, a stalled server) must not hold the result back.
const ACTION_REQUEST_SETTLE_LIMIT_MS = BROWSER_ACTION_REQUEST_SETTLE_MS;
// A navigation an action starts (a form post, a followed link) is waited for
// this long to show its new document; a server slower than this leaves the
// result on the page as it is, still loading.
const ACTION_NAVIGATION_SETTLE_LIMIT_MS = BROWSER_ACTION_NAVIGATION_SETTLE_MS;
const ACTION_REQUEST_POLL_MS = 20;
// Input after which a page handler commonly starts a request: a click or
// key that submits, a choice, a chosen file, a click at a point, typed keys
// (a code box that submits after its last digit).
const LATE_REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  "click",
  "double_click",
  "press",
  "type",
  "select",
  "check",
  "upload",
  "pointer",
]);

/** What an action's settle had seen, to tell later requests apart. */
function settleBaseline(state: TargetState): ActionSettleBaseline {
  return {
    open: new Set(state.inflightRequests),
    activity: state.networkActivitySequence,
    navigation: state.navigationSequence,
  };
}

/** Resolves after the next frame and the task after it, or within 50 ms when
 * the page does not animate. A hidden tab neither draws frames nor runs short
 * timers promptly, so there two message-channel tasks stand in for them. */
const LATE_REQUEST_FRAME_EXPRESSION = `new Promise((resolve) => {
  const done = () => resolve(true);
  if (document.visibilityState === "hidden") {
    const channel = new MessageChannel();
    let turns = 0;
    channel.port1.onmessage = () => (++turns >= 2 ? done() : channel.port2.postMessage(0));
    channel.port2.postMessage(0);
    return;
  }
  setTimeout(done, 50);
  requestAnimationFrame(() => setTimeout(done, 0));
})`;
// The response handler runs after the network layer reports the load finished.
const ACTION_RESPONSE_APPLY_MS = 50;

// Waits until no finite animation is running, then lets animationend
// handlers commit their DOM removal (which can chain another animation).
const SETTLE_FINITE_ANIMATIONS_EXPRESSION = `(async () => {
  const deadline = performance.now() + ${ANIMATION_SETTLE_LIMIT_MS};
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const remaining = () => deadline - performance.now();
  const running = () =>
    document.getAnimations().filter((animation) => {
      if (animation.playState !== "running") return false;
      const end = animation.effect?.getComputedTiming().endTime;
      return typeof end === "number" && Number.isFinite(end);
    });
  // Hidden documents do not advance animations, so there is nothing to wait for.
  if (document.visibilityState === "hidden") return true;
  let pending = running();
  if (pending.length === 0) return true;
  while (pending.length > 0) {
    if (remaining() <= 0) return false;
    await Promise.race([
      Promise.allSettled(pending.map((animation) => animation.finished)),
      pause(remaining()),
    ]);
    await Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
      pause(Math.min(50, remaining())),
    ]);
    pending = running();
  }
  return true;
})()`;

/** Resolves after the page has produced the next frame (two animation frames:
 * the first may already be in flight at the old size), or after 300 ms when
 * the page does not animate (hidden or throttled). */
const NEXT_PRESENTED_FRAME_EXPRESSION = `new Promise((resolve) => {
  const done = () => resolve(true);
  setTimeout(done, 300);
  requestAnimationFrame(() => requestAnimationFrame(done));
})`;

/** Resolves once work a page scheduled in response to the last key (a task
 * queued in the next animation frame, such as a React effect moving focus)
 * has run, or after 50 ms in a tab that does not animate (background). */
const AFTER_KEY_EFFECTS_EXPRESSION = `new Promise((resolve) => {
  const done = () => resolve(true);
  setTimeout(done, 50);
  requestAnimationFrame(() => setTimeout(done, 0));
})`;

// A child frame's scroll can also move its parent documents, which this frame
// cannot read, so only top-level frames report positions.
const SCROLL_POSITIONS_FUNCTION = `function() {
  if (window !== window.top) return null;
  const start = this instanceof Element ? this : this.parentElement;
  if (!(start instanceof Element)) return null;
  const viewport = window.visualViewport;
  const positions = [window.scrollX, window.scrollY, viewport ? viewport.offsetLeft : 0, viewport ? viewport.offsetTop : 0];
  for (let node = start; node; ) {
    if (node instanceof Element) positions.push(node.scrollLeft, node.scrollTop);
    const parent = node.assignedSlot || node.parentNode;
    node = parent instanceof ShadowRoot ? parent.host : parent instanceof Element ? parent : null;
  }
  const root = document.scrollingElement;
  if (root) positions.push(root.scrollLeft, root.scrollTop);
  return positions.join(",");
}`;

// Page-side helpers shared by the hit tests below. topHit is the element on
// top at a point in the target's own tree scope. It uses elementsFromPoint:
// for a shadow-DOM control whose label is text slotted in from the light DOM
// (a web-component button), the single-element query answers with the host,
// while elementsFromPoint answers with the control itself. owns follows the
// flat tree (slot assignment, then parents, then shadow hosts), the tree that
// pointer events travel, so slotted content counts as inside its slot's
// element and shadow content as inside its host.
const HIT_HELPERS = `
  const topHit = (target, x, y) => {
    const root = target.getRootNode();
    const scope = root && typeof root.elementsFromPoint === "function" ? root : document;
    return scope.elementsFromPoint(x, y)[0] ?? null;
  };
  const owns = (ancestor, node) => {
    for (let current = node; current; ) {
      if (current === ancestor) return true;
      current = current.assignedSlot ?? current.parentNode ?? null;
      if (current instanceof ShadowRoot) current = current.host;
    }
    return false;
  };`;

const HIT_TEST_FUNCTION = `function() {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element) || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  ${HIT_HELPERS}
  const hit = topHit(element, rect.left + rect.width / 2, rect.top + rect.height / 2);
  return Boolean(hit && owns(element, hit));
}`;

// Describes an element by its nearest labelled ancestor: role (or tag) and
// accessible label. Text content is read only from non-editable elements and
// bounded; input values never are.
const DESCRIBE_HELPER = `
  const describe = (hit) => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    let node = hit instanceof Element ? hit : hit && hit.parentElement;
    if (!(node instanceof Element)) return "another element";
    const start = node;
    for (let depth = 0; node instanceof Element && depth < 6; depth += 1) {
      const role = node.getAttribute("role");
      const label = clean(node.getAttribute("aria-label") || node.getAttribute("title"));
      if (role || label) {
        const kind = role || node.tagName.toLowerCase();
        return label ? kind + " " + JSON.stringify(label.slice(0, 80)) : kind;
      }
      node = node.parentElement;
    }
    const editable = start.closest("input, textarea, select, [contenteditable]");
    const text = editable ? "" : clean(start.textContent).slice(0, 60);
    return start.tagName.toLowerCase() + (text ? " " + JSON.stringify(text) : "");
  };`;

// Describes the element on top at the target's centre, or null when nothing
// else is there.
const COVER_DESCRIPTION_FUNCTION = `function() {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element) || !element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  ${HIT_HELPERS}
  ${DESCRIBE_HELPER}
  const hit = topHit(element, rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!hit || owns(element, hit) || owns(hit, element)) return null;
  return describe(hit);
}`;

// Guards one pointer click on the target. Hit-testing happens before input is
// sent, and the page can still move something over the target in between: a
// popover following its anchor after a scroll, or a card the pointer's arrival
// opens. Capture listeners on the target's window see each press first; one
// that would reach anything other than the target (or its descendants) is
// cancelled and stopped there, as are the release and clicks that follow it,
// and the guard records what was in the way. Releases and clicks are not
// judged by their own target: pointer capture can retarget a release, and a
// label forwards its click to its control.
// Returns the guard object; its settle() removes the listeners and
// reports what was held back. A guard that is never settled (a JavaScript
// dialog interrupted the click) disarms itself after a few seconds.
const HIT_TARGET_GUARD_WORLD = "opengeni-hit-target-guard";
const HIT_TARGET_VERDICT_BINDING = "__opengeniHitTargetVerdict";

/** One click's guard: its object in the page, and the verdicts it reported
 * for each press as it happened (null: the press reached the target; text:
 * what it landed on instead). `reported` is false when the guard runs where
 * it cannot report (no isolated world), so only its readback counts. */
interface HitTargetGuard {
  objectId: string;
  reported: boolean;
  verdicts: Array<string | null>;
  stopReports: () => void;
}

const HIT_TARGET_GUARD_FUNCTION = `function(token) {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element) || !element.isConnected) return null;
  const view = element.ownerDocument && element.ownerDocument.defaultView;
  if (!view) return null;
  ${HIT_HELPERS}
  ${DESCRIBE_HELPER}
  const report = globalThis.${HIT_TARGET_VERDICT_BINDING};
  // The target's own markup and its parent's text, as found: a copy must
  // match both, so a re-render that shifted other data into the target's
  // place (the next item's button, a row now showing another invoice) does
  // not pass for it.
  const markup = (node) => String(node.outerHTML || "");
  const text = (node) => String(node.textContent || "");
  const original = markup(element);
  const parent = element.parentElement;
  const parentText = parent ? text(parent) : "";
  const position = parent ? Array.prototype.indexOf.call(parent.children, element) : -1;
  const reaches = (hit) => {
    if (hit instanceof Node && owns(element, hit)) return true;
    // Seen from outside a closed shadow root, a press on the target is
    // retargeted to that root's host.
    if (
      hit instanceof Element &&
      hit.shadowRoot === null &&
      owns(hit, element) &&
      element.getRootNode() !== hit.getRootNode()
    )
      return true;
    // The page re-rendered the target since it was found, replacing it with
    // a copy in the same place of the same parent: the press reaches the
    // copy, as it would a person's. A lookalike elsewhere (the next row's
    // identical button once this row is removed) is not the target.
    if (!element.isConnected && parent && parent.isConnected && text(parent) === parentText) {
      const copy = parent.children[position];
      if (copy && markup(copy) === original && hit instanceof Node && owns(copy, hit)) return true;
    }
    return false;
  };
  const presses = ["pointerdown", "mousedown"];
  const followers = ["pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu"];
  const types = [...presses, ...followers];
  const guard = { blocked: null };
  const expiresAt = Date.now() + 5000;
  let pointerDowns = 0;
  const listener = (event) => {
    if (Date.now() > expiresAt) {
      guard.settle();
      return;
    }
    if (!event.isTrusted) return;
    if (presses.includes(event.type)) {
      if (event.type === "pointerdown") pointerDowns += 1;
      const hit = event.composedPath()[0];
      // Only a click's first press is judged: a double-click's second press
      // lands where the first one's effect left the page (a row the first
      // click turned into an editor), as a person's does.
      const onTarget = pointerDowns > 1 || reaches(hit);
      const verdict = onTarget ? null : describe(hit);
      // One report per physical press, before any page listener after this
      // one can replace the document.
      if (event.type === "pointerdown" && typeof report === "function") {
        report(JSON.stringify({ token, blocked: verdict }));
      }
      if (onTarget && guard.blocked === null) return;
      if (guard.blocked === null) guard.blocked = verdict;
    } else if (guard.blocked === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of types) view.addEventListener(type, listener, true);
  guard.settle = () => {
    for (const type of types) view.removeEventListener(type, listener, true);
    return guard.blocked;
  };
  return guard;
}`;

// Chromium's replies when a remote object's execution context is gone: the
// document that held the click guard was replaced or detached.
const GUARD_DOCUMENT_GONE =
  /Cannot find context with specified id|Could not find object with given id|Execution context was destroyed|Inspected target navigated or closed/i;

// Resolves after the page has rendered two more frames, so layout that reacts
// to a scroll (scroll listeners, anchored popovers) has caught up. Bounded,
// because a hidden tab may not render frames at all.
const SETTLE_FRAMES_FUNCTION = `function() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 100);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve(true);
    }));
  });
}`;

// Whether pointer input at the target's centre falls through it to one of its
// own ancestors: the target (or a wrapper) is pointer-transparent there, as a
// hover-revealed control is before the pointer arrives, rather than covered.
const POINTER_TRANSPARENT_FUNCTION = `function() {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element) || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  ${HIT_HELPERS}
  const hit = topHit(element, rect.left + rect.width / 2, rect.top + rect.height / 2);
  return Boolean(hit && !owns(element, hit) && owns(hit, element));
}`;

// Whether the element at the target's centre belongs to a sticky element, or
// to a fixed one smaller than the viewport, i.e. a bar that scrolling can
// move the target out from under.
const STICKY_COVER_FUNCTION = `function() {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element) || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  ${HIT_HELPERS}
  let node = topHit(element, rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!node || owns(element, node)) return false;
  while (node instanceof Element) {
    const position = getComputedStyle(node).position;
    if (position === "sticky") return true;
    if (position === "fixed") {
      const box = node.getBoundingClientRect();
      // The layout viewport excludes visible scrollbars, which a fixed layer
      // over the whole page does not cover.
      const viewport = document.scrollingElement || document.documentElement;
      const width = viewport.clientWidth || innerWidth;
      const height = viewport.clientHeight || innerHeight;
      return !(box.left <= 0 && box.top <= 0 && box.right >= width && box.bottom >= height);
    }
    const parentRoot = node.getRootNode();
    node = node.parentElement ?? (parentRoot instanceof ShadowRoot ? parentRoot.host : null);
  }
  return false;
}`;

const SCROLL_INTO_VIEW_FUNCTION = `function(alignment) {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element)) return false;
  element.scrollIntoView({ block: alignment, inline: alignment, behavior: "instant" });
  return true;
}`;

const VISIBLE_FUNCTION = `function() {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element) || !element.isConnected) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}`;

const CHECKED_FUNCTION = `function() {
  return typeof this.checked === "boolean" ? this.checked : null;
}`;

/** Disabled natively (including inside a disabled fieldset) or with aria-disabled. */
const NODE_DISABLED_FUNCTION = `function() {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element)) return false;
  return element.matches(":disabled") || element.closest('[aria-disabled="true"]') !== null;
}`;

const SELECT_OPTIONS_FUNCTION = `function(values) {
  if (!(this instanceof HTMLSelectElement) || this.matches(":disabled")) return false;
  const selected = new Set(values.map(String));
  const choices = Array.from(this.options).filter(option => selected.has(option.value) || selected.has(option.label));
  if (values.some(value => !choices.some(option => option.value === String(value) || option.label === String(value)))) return false;
  if ((!this.multiple && choices.length > 1) || choices.some(option => !option.selected && (option.disabled || option.closest("optgroup[disabled]")))) return false;
  for (const option of this.options) option.selected = selected.has(option.value) || selected.has(option.label);
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

// Whether the option (this) is hidden from a dropdown's list, which never
// shows it: hidden itself or by its group, by attribute or by style.
const HIDDEN_OPTION_SOURCE = `[this, this.parentElement instanceof HTMLOptGroupElement ? this.parentElement : null].some((element) => element !== null && (element.hidden || getComputedStyle(element).display === "none"))`;

// What a click on an option of a native dropdown (whose options are never
// laid out on the page) does, read without changing anything: kind
// "choosable", "selected" when it is already chosen, "unavailable" when it is
// disabled or hidden, or "other" for anything else (including an option a
// pointer can reach); open says whether the dropdown's list is showing.
const DROPDOWN_OPTION_FUNCTION = `function() {
  if (!(this instanceof HTMLOptionElement) || this.getClientRects().length > 0) return { kind: "other" };
  const select = this.closest("select");
  if (!(select instanceof HTMLSelectElement) || select.multiple || select.getClientRects().length === 0) return { kind: "other" };
  let open = false;
  try { open = select.matches(":open"); } catch {}
  if (select.matches(":disabled") || this.matches(":disabled") || ${HIDDEN_OPTION_SOURCE}) return { kind: "unavailable", open };
  return { kind: this.selected ? "selected" : "choosable", open };
}`;

// Chooses that option, as the browser does when a person picks it from the
// list; false, before any change, when it cannot be chosen.
const CHOOSE_DROPDOWN_OPTION_FUNCTION = `function() {
  const select = this instanceof HTMLOptionElement ? this.closest("select") : null;
  if (!(select instanceof HTMLSelectElement) || select.matches(":disabled") || this.matches(":disabled") || ${HIDDEN_OPTION_SOURCE}) return false;
  if (this.selected) return true;
  this.selected = true;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

/** How long select waits for a custom popup's option to show after opening it. */
const POPUP_OPTION_WAIT_MS = 2_000;

// A custom popup control's options: the elements its aria-controls or
// aria-owns name (or the listbox itself), else every option in the document.
// Labels are the accessible label or collapsed text.
const POPUP_SOURCE = `
  const popupLabel = (element) => {
    const label = element.getAttribute("aria-label");
    return String(label && label.trim() ? label : element.textContent || "").replace(/\\s+/g, " ").trim();
  };
  const popupRoots = (control) => {
    if (String(control.getAttribute("role") || "").toLowerCase() === "listbox") return { roots: [control], explicit: true };
    const root = control.getRootNode();
    const lookup = (id) => (typeof root.getElementById === "function" && root.getElementById(id)) || control.ownerDocument.getElementById(id);
    const ids = [control.getAttribute("aria-controls"), control.getAttribute("aria-owns")].join(" ").split(/\\s+/).filter(Boolean);
    const roots = ids.map(lookup).filter(Boolean);
    return roots.length > 0 ? { roots, explicit: true } : { roots: [control.ownerDocument], explicit: false };
  };
  const popupOptions = (control) => {
    const { roots, explicit } = popupRoots(control);
    const options = [];
    for (const root of roots) {
      if (root !== control.ownerDocument && root.getAttribute("role") === "option") options.push(root);
      for (const option of root.querySelectorAll('[role="option"]')) if (!options.includes(option)) options.push(option);
    }
    return { roots, options, explicit };
  };
  const optionShowing = (option) => {
    if (!option.isConnected || option.getAttribute("aria-disabled") === "true") return false;
    if (typeof option.checkVisibility === "function" && !option.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const rect = option.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
`;

// What select acts on: a native select, a custom popup control (with the
// options its popup already holds, when it names one), or neither.
const SELECT_TARGET_FUNCTION = `function() {
  ${POPUP_SOURCE}
  if (!(this instanceof Element) || !this.isConnected) return { kind: "other" };
  if (String(this.tagName || "").toLowerCase() === "select") return { kind: "native" };
  const role = String(this.getAttribute("role") || "").toLowerCase();
  const popup = String(this.getAttribute("aria-haspopup") || "").toLowerCase();
  if (role !== "combobox" && role !== "listbox" && popup !== "listbox") return { kind: "other" };
  const { roots, options, explicit } = popupOptions(this);
  const multiple = roots.some((root) => root !== this.ownerDocument && root.getAttribute("aria-multiselectable") === "true");
  return {
    kind: "popup",
    role: role || "button",
    disabled: this.matches(":disabled") || this.getAttribute("aria-disabled") === "true",
    multiple,
    options: explicit ? options.filter((option) => option.getAttribute("aria-disabled") !== "true").map(popupLabel).slice(0, 500) : [],
  };
}`;

// With a label: the first showing option with that label (exact, then
// case-insensitive), or null. With null: the showing options' labels.
const POPUP_OPTION_FUNCTION = `function(label) {
  ${POPUP_SOURCE}
  const showing = popupOptions(this).options.filter(optionShowing);
  if (label === null) return showing.map(popupLabel).slice(0, 500);
  const wanted = String(label);
  return showing.find((option) => popupLabel(option) === wanted) ||
    showing.find((option) => popupLabel(option).toLowerCase() === wanted.trim().toLowerCase()) ||
    null;
}`;

const POPUP_EXPANDED_FUNCTION = `function() {
  return this instanceof Element && this.getAttribute("aria-expanded") === "true";
}`;

function sameOptionLabel(label: string, value: string): boolean {
  return label === value || label.toLowerCase() === value.trim().toLowerCase();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function optionList(labels: readonly string[]): string {
  const shown = labels
    .slice(0, 25)
    .map((label) => JSON.stringify(label))
    .join(", ");
  return labels.length > 25 ? `${shown} and ${labels.length - 25} more` : shown;
}

/** Scroll from a starting element the way a wheel over it would, crossing
 * shadow roots and slots. Only boxes a user can scroll count: overflow auto,
 * scroll or overlay, or the viewport unless it hides overflow. Each axis tries,
 * in order: the element itself (or the viewport for a page scroll), the
 * scrolling panels inside it under its centre when it cannot scroll at all on
 * that axis (the wheel's order), its own ancestors, and then, only when none
 * of those can scroll at all on that axis, the largest visible scrolling panel
 * inside it. A box at its end is not a fallback case: the scroll is refused, so
 * a scroll-until-it-stops loop stops. Panels inside count because fixed
 * layouts (side sheets, drawers, dialogs, split views) put the content that
 * moves in an inner box the agent may not have targeted. Form fields are not
 * panels: their content is their value. Returns whether anything moved. */
const SCROLL_FROM_FUNCTION = `function(start, page, deltaX, deltaY) {
  const doc = start.ownerDocument;
  const view = doc.defaultView;
  const root = doc.scrollingElement || doc.documentElement;
  const parentOf = (element) =>
    element.assignedSlot ||
    element.parentElement ||
    (element.parentNode && element.parentNode.nodeType === 11 ? element.parentNode.host : null);
  const overflow = (element, axis) =>
    view.getComputedStyle(element)[axis === "x" ? "overflowX" : "overflowY"];
  const scrollable = (element, axis) => {
    if (element !== root) return ["auto", "scroll", "overlay"].includes(overflow(element, axis));
    const html = overflow(doc.documentElement, axis);
    const viewport = html === "visible" && doc.body ? overflow(doc.body, axis) : html;
    return viewport !== "hidden" && viewport !== "clip";
  };
  const range = (element, axis) =>
    axis === "x"
      ? element.scrollWidth - element.clientWidth
      : element.scrollHeight - element.clientHeight;
  // Whether a box can scroll on an axis at all, wherever it is now.
  const canScroll = (element, axis) => scrollable(element, axis) && range(element, axis) > 1;
  const fields = new Set(["INPUT", "TEXTAREA", "SELECT"]);
  const panel = (element, axis) =>
    element !== root &&
    !fields.has(element.tagName) &&
    canScroll(element, axis);
  const visibleArea = (element) => {
    const box = element.getBoundingClientRect();
    const width = Math.min(box.right, view.innerWidth) - Math.max(box.left, 0);
    const height = Math.min(box.bottom, view.innerHeight) - Math.max(box.top, 0);
    return width > 0 && height > 0 ? width * height : 0;
  };
  // Panels under the centre of the start's visible box, innermost first.
  const underCentre = () => {
    const box = page
      ? { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight }
      : start.getBoundingClientRect();
    const left = Math.max(box.left, 0);
    const right = Math.min(box.right, view.innerWidth);
    const top = Math.max(box.top, 0);
    const bottom = Math.min(box.bottom, view.innerHeight);
    if (right <= left || bottom <= top) return [];
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    let hit = doc.elementFromPoint(x, y);
    for (let depth = 0; depth < 32 && hit && hit.shadowRoot; depth++) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    const chain = [];
    let element = hit;
    for (; element && element !== start; element = parentOf(element)) chain.push(element);
    return element === start ? chain : [];
  };
  let inside = null;
  const insidePanels = () => {
    if (inside) return inside;
    inside = [];
    let visited = 0;
    const walk = (scope) => {
      const walker = doc.createTreeWalker(scope, 1);
      for (let element = walker.nextNode(); element && visited < 20000; element = walker.nextNode()) {
        visited++;
        if (element.shadowRoot) walk(element.shadowRoot);
        inside.push(element);
      }
    };
    walk(start);
    return inside;
  };
  const scrollAxis = (axis, delta) => {
    if (!delta) return false;
    const read = (element) => (axis === "x" ? element.scrollLeft : element.scrollTop);
    const tried = new Set();
    const tryScroll = (element) => {
      if (tried.has(element)) return false;
      tried.add(element);
      const before = read(element);
      element.scrollBy(
        axis === "x" ? { left: delta, behavior: "instant" } : { top: delta, behavior: "instant" },
      );
      return read(element) !== before;
    };
    const first = page ? root : start;
    if (scrollable(first, axis) && tryScroll(first)) return true;
    let chainCanScroll = canScroll(first, axis);
    // Panels are a fallback for boxes that cannot scroll at all on this axis,
    // never for one that is at its end: that refusal is how an agent knows
    // it reached the end. A panel under the centre that is at its end counts
    // the same way, so it is not skipped for another panel elsewhere.
    if (!chainCanScroll)
      for (const element of underCentre()) {
        if (!panel(element, axis)) continue;
        chainCanScroll = true;
        if (tryScroll(element)) return true;
      }
    if (!page) {
      for (let element = parentOf(start); element; element = element === root ? null : parentOf(element)) {
        if (!scrollable(element, axis)) continue;
        chainCanScroll ||= canScroll(element, axis);
        if (tryScroll(element)) return true;
      }
      chainCanScroll ||= canScroll(root, axis);
      if (scrollable(root, axis) && tryScroll(root)) return true;
    }
    if (chainCanScroll) return false;
    const panels = insidePanels()
      .filter((element) => panel(element, axis))
      .map((element) => [visibleArea(element), element])
      .filter((entry) => entry[0] > 0)
      .sort((a, b) => b[0] - a[0]);
    for (const [, element] of panels) if (tryScroll(element)) return true;
    return false;
  };
  const movedX = scrollAxis("x", deltaX);
  const movedY = scrollAxis("y", deltaY);
  return movedX || movedY;
}`;

const SCROLL_FUNCTION = `function(deltaX, deltaY) {
  const start = this && this.nodeType === 1 ? this : this?.parentElement;
  if (!start || !start.isConnected) return false;
  return (${SCROLL_FROM_FUNCTION})(start, false, deltaX, deltaY);
}`;

const PAGE_SCROLL_FUNCTION = `function(deltaX, deltaY) {
  return (${SCROLL_FROM_FUNCTION})(document.documentElement, true, deltaX, deltaY);
}`;

/** Elements one outline reads looking for scrolling panels, and panels it marks. */
const SCROLL_PANELS_MAX_ELEMENTS = 50_000;
const SCROLL_PANELS_MAX = 16;

/** The visible scrolling panels of a document and the directions each can
 * still scroll, for the outline. Returns ["dirs|dirs|…", element, …], largest
 * first. Only boxes that overflow and that a user can scroll are read, so a
 * page without inner scrolling adds nothing; form fields and the viewport are
 * left out. Open shadow roots are included. */
const SCROLL_PANELS_EXPRESSION = `(() => {
  const view = window;
  const root = document.scrollingElement || document.documentElement;
  const fields = new Set(["INPUT", "TEXTAREA", "SELECT"]);
  const scrolls = (value) => value === "auto" || value === "scroll" || value === "overlay";
  const found = [];
  let visited = 0;
  const walk = (scope) => {
    const walker = document.createTreeWalker(scope, 1);
    for (let element = walker.nextNode(); element && visited < ${SCROLL_PANELS_MAX_ELEMENTS}; element = walker.nextNode()) {
      visited++;
      if (element.shadowRoot) walk(element.shadowRoot);
      if (element === root || fields.has(element.tagName)) continue;
      // Style first: it is cached, while each layout read costs more and
      // few elements on any page can scroll.
      const style = view.getComputedStyle(element);
      const styleY = scrolls(style.overflowY);
      const styleX = scrolls(style.overflowX);
      if (!styleY && !styleX) continue;
      const canY = styleY && element.scrollHeight - element.clientHeight > 1;
      const canX = styleX && element.scrollWidth - element.clientWidth > 1;
      if (!canY && !canX) continue;
      const box = element.getBoundingClientRect();
      const width = Math.min(box.right, view.innerWidth) - Math.max(box.left, 0);
      const height = Math.min(box.bottom, view.innerHeight) - Math.max(box.top, 0);
      if (width <= 0 || height <= 0) continue;
      const directions = [];
      if (canY) {
        const top = element.scrollTop;
        const max = element.scrollHeight - element.clientHeight;
        if (top > 1) directions.push("up");
        if (top < max - 1) directions.push("down");
      }
      if (canX) {
        // Right-to-left boxes count scrollLeft from 0 down to -max.
        const max = element.scrollWidth - element.clientWidth;
        const offset = Math.abs(element.scrollLeft);
        const rtl = style.direction === "rtl";
        if (rtl ? offset < max - 1 : offset > 1) directions.push("left");
        if (rtl ? offset > 1 : offset < max - 1) directions.push("right");
      }
      if (directions.length) found.push([width * height, element, directions.join(",")]);
    }
  };
  walk(document);
  found.sort((a, b) => b[0] - a[0]);
  const kept = found.slice(0, ${SCROLL_PANELS_MAX});
  return [kept.map((entry) => entry[2]).join("|"), ...kept.map((entry) => entry[1])];
})()`;

/** Why an element's text or value must not leave the page: it is, sits in, or
 * (as a container) holds a password, one-time code, payment, hidden or
 * explicitly private field. With a range, only the descendants that range
 * touches count, for a copy of selected text. Shared by DOM reads and
 * clipboard copies, so neither can return what the other withholds. */
const PROTECTED_CONTENT_FUNCTION = `function(element, range) {
  const privateSelector = "[data-private], [data-sensitive], [data-opengeni-private]";
  const sensitiveReason = (node) => {
    const nodeTag = String(node.tagName || "").toLowerCase();
    const type = nodeTag === "input" ? String(node.getAttribute("type") || "text").toLowerCase() : "";
    const autocomplete = String(node.getAttribute("autocomplete") || "").toLowerCase();
    const fieldName = String(node.getAttribute("name") || "") + " " + String(node.getAttribute("id") || "");
    if (type === "password" || /(?:current|new)-password|one-time-code/.test(autocomplete)) return "password";
    if (/(?:^|\\s)cc-/.test(autocomplete) || /(?:card.?number|credit.?card|cvv|cvc|security.?code|expiry|expiration)/i.test(fieldName)) return "payment";
    if (type === "hidden" || node.matches(privateSelector)) return "private";
    return null;
  };
  let reason = sensitiveReason(element);
  for (let ancestor = element.parentElement; !reason && ancestor; ancestor = ancestor.parentElement) {
    reason = sensitiveReason(ancestor);
  }
  if (reason) return reason;
  // A container's text includes its sensitive descendants. Refuse the whole
  // container rather than returning their protected text through an ancestor.
  for (const node of element.querySelectorAll("[id], [name], [autocomplete], input, " + privateSelector)) {
    if (range && !range.intersectsNode(node)) continue;
    const found = sensitiveReason(node);
    if (found) return found;
  }
  return null;
}`;

/** Fixed browser-side projection. Every field shares one character budget, so
 * a huge page cannot turn a focused query into an unbounded CDP payload. */
const DOM_READ_FUNCTION = `function(maxChars, requestedAttributes, includeSelect, offset) {
  const element = this && this.nodeType === 1 ? this : this?.parentElement;
  if (!element || element.nodeType !== 1 || !element.isConnected) return { ok: false };
  const tag = String(element.tagName || "").toLowerCase();
  const redacted = (${PROTECTED_CONTENT_FUNCTION})(element, null);
  if (redacted) return { ok: true, text: null, value: null, attributes: {}, redacted, truncated: false };
  const allowed = new Set(["href", "src", "alt", "title", "role", "aria-label", "aria-expanded",
    "aria-checked", "aria-selected", "placeholder", "type", "name", "data-testid"]);
  let remaining = maxChars;
  let truncated = false;
  const bounded = (raw, skip = 0) => {
    if (raw === null || raw === undefined) return null;
    const value = String(raw).slice(skip);
    let kept = value.slice(0, remaining);
    // Never end a page between the two halves of a character outside the
    // basic plane; the next page starts with the whole character instead.
    if (kept.length > 1 && kept.length < value.length) {
      const last = kept.charCodeAt(kept.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
    }
    remaining -= kept.length;
    if (kept.length < value.length) {
      truncated = true;
      remaining = 0;
    }
    return kept;
  };
  const skip = Number(offset) || 0;
  const text = bounded(element.innerText ?? element.textContent ?? "", skip);
  const value = tag === "input" || tag === "textarea" || tag === "select"
    ? bounded(element.value ?? "", skip) : null;
  const attributes = {};
  for (const attribute of requestedAttributes) {
    if (allowed.has(attribute)) attributes[attribute] = bounded(element.getAttribute(attribute));
  }
  let select = null;
  if (includeSelect && element instanceof HTMLSelectElement && element.options.length <= 200) {
    select = { kind: "native-select", multiple: element.multiple, disabled: element.matches(":disabled"),
      options: Array.from(element.options, (option) => ({
        value: bounded(option.value), label: bounded(option.label), selected: option.selected,
        disabled: option.disabled || Boolean(option.closest("optgroup[disabled]"))
      })) };
  }
  return { ok: true, text, value, attributes, redacted: null, truncated, select };
}`;

/** Attribute and pseudo selectors would turn count/not-found into a secret-value oracle. */
function assertSafeDomReadSelector(selector: string): void {
  if (!/^[A-Za-z0-9_#.,\s>*-]+$/u.test(selector)) {
    throw new InteractionDefiniteDriverError(
      "invalid_action",
      "browser DOM read supports only tag, class, id, descendant, and child selectors",
    );
  }
}

// What a clipboard copy takes from an element. "value" is a form field's
// value, or the text of an element whose accessible value is its text
// (editable content, custom text boxes, combo boxes and spin buttons);
// "text" is what the element shows, which for a text field is its value;
// "selection" is the selected text inside it; "whole" (content omitted) is
// the selection when there is one, otherwise all of what it shows.
const COPY_BROWSER_TEXT_FUNCTION = `function(content) {
  const element = this && this.nodeType === 1 ? this : this?.parentElement;
  if (!element || element.nodeType !== 1 || !element.isConnected) return { ok: false, error: "detached" };
  const protectedContent = ${PROTECTED_CONTENT_FUNCTION};
  const tag = String(element.tagName || "").toLowerCase();
  const textField = tag === "input" || tag === "textarea";
  const shown = () => textField
    ? String(element.value ?? "")
    : String(element.innerText ?? element.textContent ?? "");
  // Size is checked here, before the text crosses to the controller. Each
  // UTF-16 unit is at most three UTF-8 bytes, so most text needs no encoding.
  const copied = (text) => {
    if (text.length > ${INTERACTION_MAX_CLIPBOARD_BYTES} || (text.length * 3 > ${INTERACTION_MAX_CLIPBOARD_BYTES}
      && new TextEncoder().encode(text).length > ${INTERACTION_MAX_CLIPBOARD_BYTES})) {
      return { ok: false, error: "too_large" };
    }
    return { ok: true, text };
  };
  // A protected text field is refused whatever is asked of it.
  if (textField && protectedContent(element, null)) return { ok: false, error: "protected" };
  const whole = () => protectedContent(element, null) ? { ok: false, error: "protected" } : copied(shown());
  if (content === "value") {
    if (textField) return copied(String(element.value ?? ""));
    if (tag === "select") {
      return protectedContent(element, null) ? { ok: false, error: "protected" } : copied(String(element.value ?? ""));
    }
    const role = String(element.getAttribute("role") || "").toLowerCase();
    if (element.isContentEditable === true || ["textbox", "searchbox", "combobox", "spinbutton"].includes(role)) {
      return whole();
    }
    return { ok: false, error: "no_value" };
  }
  if (content === "text") return whole();
  if (textField) {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (typeof start === "number" && typeof end === "number" && end > start) {
      return copied(String(element.value).slice(start, end));
    }
  } else {
    const selection = element.ownerDocument.defaultView?.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (element === range.commonAncestorContainer || element.contains(range.commonAncestorContainer)) {
        const selected = selection.toString();
        if (selected !== "") {
          const common = range.commonAncestorContainer.nodeType === 1
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
          return common && protectedContent(common, range)
            ? { ok: false, error: "protected" }
            : copied(selected);
        }
      }
    }
  }
  if (content === "whole") return whole();
  return { ok: false, error: "no_selection" };
}`;

const COPY_ACTIVE_BROWSER_TEXT_FUNCTION = `function(content) {
  let element = document.activeElement || document.body;
  for (let depth = 0; depth < 16 && ["iframe", "frame"].includes(String(element?.tagName || "").toLowerCase()); depth += 1) {
    try {
      const nested = element.contentDocument?.activeElement;
      if (!nested) return { ok: false, error: "unavailable" };
      element = nested;
    } catch {
      return { ok: false, error: "unavailable" };
    }
  }
  return (${COPY_BROWSER_TEXT_FUNCTION}).call(element, content);
}`;

const LIGHTPANDA_TYPING_TARGET_EXPRESSION = `(() => {
  const element = document.activeElement;
  if (!(element instanceof Element) || !element.isConnected || element.disabled || element.readOnly) return false;
  const tag = String(element.tagName || "").toLowerCase();
  return tag === "textarea" || (tag === "input" && ["text", "search", "url", "tel", "password", "email", "number"].includes(element.type));
})()`;

const LIGHTPANDA_CLEAR_EDITABLE_FUNCTION = `function() {
  if (!(this instanceof Element) || !this.isConnected || document.activeElement !== this) return false;
  const tag = String(this.tagName || "").toLowerCase();
  if (tag !== "input" && tag !== "textarea") return false;
  if (this.disabled || this.readOnly) return false;
  if (tag === "input" && !["text", "search", "url", "tel", "password", "email", "number"].includes(this.type)) return false;
  const prototype = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (typeof setter !== "function") return false;
  setter.call(this, "");
  return true;
}`;

// Classifies a fill target. Text-like inputs, textareas and editable content
// are fillable; anything else reports what it is, so the refusal can name the
// action that works on it.
const FILL_TARGET_FUNCTION = `function() {
  if (!(this instanceof Element) || !this.isConnected) return { kind: "other", role: "element" };
  const tag = String(this.tagName || "").toLowerCase();
  const role = String(this.getAttribute("role") || "").toLowerCase();
  if (tag === "textarea" || (tag === "input" && ["text", "search", "url", "tel", "password", "email", "number"].includes(String(this.type).toLowerCase()))) {
    return this.disabled || this.readOnly ? { kind: "read_only" } : { kind: "editable" };
  }
  if (this.isContentEditable === true) return { kind: "editable" };
  if (tag === "select") return { kind: "select" };
  if (tag === "input") return { kind: "input", type: String(this.type).toLowerCase() };
  const popup = String(this.getAttribute("aria-haspopup") || "").toLowerCase();
  if (role === "combobox" || role === "listbox" || (popup !== "" && popup !== "false")) {
    return { kind: "popup", role: role || "button" };
  }
  return { kind: "other", role: role || tag || "element" };
}`;

// Enough arrow presses for a 0 to 100 slider end to end, twice over.
const SLIDER_MAX_KEY_PRESSES = 250;

const SLIDER_HORIZONTAL_KEYS = { raise: "ArrowRight", lower: "ArrowLeft" };
const SLIDER_VERTICAL_KEYS = { raise: "ArrowUp", lower: "ArrowDown" };
const SLIDER_OPPOSITE_KEY: Record<string, string> = {
  ArrowRight: "ArrowLeft",
  ArrowLeft: "ArrowRight",
  ArrowUp: "ArrowDown",
  ArrowDown: "ArrowUp",
};

// Page sliders often step in tenths, which add up to values like
// 0.30000000000000004; those count as the value asked for.
function sameSliderValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

type SliderState = {
  kind: "range" | "aria";
  value: number | null;
  min: number | null;
  max: number | null;
  /** For a range input, the value it would take for the requested one. */
  nearest: number | null;
  disabled: boolean;
  /** The slider says it runs up and down. */
  vertical: boolean;
};

function sliderState(value: unknown): SliderState | null {
  if (!isRecord(value) || (value.kind !== "range" && value.kind !== "aria")) return null;
  const number = (field: unknown): number | null =>
    typeof field === "number" && Number.isFinite(field) ? field : null;
  return {
    kind: value.kind,
    value: number(value.value),
    min: number(value.min),
    max: number(value.max),
    nearest: number(value.nearest),
    disabled: value.disabled === true,
    vertical: value.vertical === true,
  };
}

// A native range input, or an element with role slider and its ARIA value. A
// control is disabled the way a person meets it: disabled itself or by a
// disabled fieldset, or marked aria-disabled on itself or an ancestor.
const SLIDER_STATE_FUNCTION = `function(expected) {
  if (!(this instanceof Element) || !this.isConnected) return { kind: "other" };
  const number = (text) => {
    if (text === null || text === undefined || String(text).trim() === "") return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const disabled = this.matches(":disabled") || this.closest('[aria-disabled="true"]') !== null;
  if (String(this.tagName || "").toLowerCase() === "input" && String(this.type).toLowerCase() === "range") {
    let nearest = null;
    if (typeof expected === "number") {
      const probe = this.ownerDocument.createElement("input");
      probe.type = "range";
      for (const name of ["min", "max", "step"]) if (this.hasAttribute(name)) probe.setAttribute(name, this.getAttribute(name));
      probe.value = String(expected);
      nearest = Number(probe.value);
    }
    return {
      kind: "range",
      value: number(this.value),
      min: number(this.min) ?? 0,
      max: number(this.max) ?? 100,
      nearest,
      disabled,
      vertical: false,
    };
  }
  if (String(this.getAttribute("role") || "").toLowerCase() !== "slider") return { kind: "other" };
  return {
    kind: "aria",
    value: number(this.getAttribute("aria-valuenow")),
    min: number(this.getAttribute("aria-valuemin")),
    max: number(this.getAttribute("aria-valuemax")),
    disabled,
    vertical: String(this.getAttribute("aria-orientation") || "").toLowerCase() === "vertical",
  };
}`;

// Sets a native range input through the prototype setter, which bypasses the
// per-instance value trackers frameworks install, then notifies listeners as
// a drag does.
const SET_RANGE_VALUE_FUNCTION = `async function(expected) {
  if (!(this instanceof HTMLInputElement) || !this.isConnected) return { kind: "gone" };
  if (this.matches(":disabled") || this.closest('[aria-disabled="true"]') !== null) return { kind: "disabled" };
  const view = this.ownerDocument.defaultView;
  const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value").set;
  this.focus();
  setter.call(this, String(expected));
  this.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new view.Event("change", { bubbles: true }));
  await Promise.resolve();
  return this.isConnected && Number(this.value) === Number(expected) ? { kind: "set" } : { kind: "lost" };
}`;

const CONFIRM_EDITABLE_VALUE_FUNCTION = `async function(expected) {
  await Promise.resolve();
  if (!(this instanceof Element) || !this.isConnected) return false;
  const tag = String(this.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return String(this.value) === String(expected);
  if (this.isContentEditable === true) return String(this.textContent || "") === String(expected);
  return false;
}`;

const NATIVE_DATE_TIME_FORMATS: Readonly<Record<string, string>> = {
  date: "YYYY-MM-DD",
  time: "HH:MM in 24-hour time, optionally HH:MM:SS",
  "datetime-local": "YYYY-MM-DDTHH:MM",
  month: "YYYY-MM",
  week: "YYYY-Www",
};

// Resolves a native date/time input from the input itself or from one of the
// parts in its user-agent shadow root. Inputs cannot host author shadow roots,
// so a shadow root whose host is an input is always the browser's own.
const NATIVE_DATE_TIME_HOST_SOURCE = `
  const nativeDateTimeHost = (node) => {
    let element = node;
    for (let depth = 0; depth < 4 && element; depth++) {
      if (String(element.tagName || "").toLowerCase() === "input") break;
      const root = typeof element.getRootNode === "function" ? element.getRootNode() : null;
      element = root && root.host ? root.host : null;
    }
    if (!element || String(element.tagName || "").toLowerCase() !== "input") return null;
    const type = String(element.type || "").toLowerCase();
    return ${JSON.stringify(Object.keys(NATIVE_DATE_TIME_FORMATS))}.includes(type) ? element : null;
  };`;

const INSPECT_NATIVE_DATE_TIME_FILL_FUNCTION = `function(expected) {${NATIVE_DATE_TIME_HOST_SOURCE}
  const input = nativeDateTimeHost(this);
  if (!input) return { kind: "other" };
  const type = String(input.type).toLowerCase();
  const part = input !== this;
  if (input.disabled || input.readOnly) return { kind: "not_editable", type, part };
  const probe = input.ownerDocument.createElement("input");
  probe.type = type;
  probe.value = String(expected);
  if (probe.value !== String(expected)) return { kind: "invalid_value", type, part };
  return { kind: "native", type, part };
}`;

// The prototype setter bypasses per-instance value trackers that frameworks
// install, so their input listeners see the change as user input.
const SET_NATIVE_DATE_TIME_VALUE_FUNCTION = `async function(expected) {${NATIVE_DATE_TIME_HOST_SOURCE}
  const input = nativeDateTimeHost(this);
  if (!input || !input.isConnected) return false;
  const view = input.ownerDocument.defaultView;
  const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value").set;
  input.focus();
  setter.call(input, String(expected));
  input.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new view.Event("change", { bubbles: true }));
  await Promise.resolve();
  return input.isConnected && input.value === String(expected);
}`;

function cssString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\r?\n/gu, "\\a ");
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function browserDialog(params: Record<string, unknown>, openedAt: string): BrowserDialog {
  const type = ["alert", "confirm", "prompt", "beforeunload"].includes(String(params.type))
    ? String(params.type)
    : "alert";
  return BrowserDialog.parse({
    type,
    message: boundedTextField(params.message, 8_192) ?? "",
    defaultPrompt: boundedTextField(params.defaultPrompt, 32_768) ?? "",
    openedAt,
  });
}

/** A CDP Runtime timestamp (milliseconds since the epoch) as an ISO time. */
function runtimeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function consoleLevel(value: unknown): BrowserDiagnosticEntry["level"] {
  if (value === "debug") return "debug";
  if (value === "error" || value === "assert") return "error";
  if (value === "warning") return "warning";
  return "info";
}

/** Console text with each argument redacted before it is clipped and joined:
 * a secret clipped mid-argument and followed by more text would otherwise
 * survive as an unrecognizable prefix. */
function consoleMessage(value: unknown, redact: (text: string) => string): string {
  if (!Array.isArray(value) || value.length === 0) return "Console event";
  const text = value
    .slice(0, 100)
    .map((entry) => remoteObjectText(entry, redact))
    .filter(Boolean)
    .join(" ")
    .slice(0, 8_192);
  return text || "Console event";
}

function remoteObjectText(value: unknown, redact: (text: string) => string): string {
  if (!isRecord(value)) return "";
  if (value.value !== undefined) {
    if (typeof value.value === "string") return redact(value.value).slice(0, 4_096);
    try {
      return redact(JSON.stringify(value.value)).slice(0, 4_096);
    } catch {
      return "[unserializable value]";
    }
  }
  if (typeof value.description === "string") return redact(value.description).slice(0, 4_096);
  return typeof value.type === "string" ? `[${value.type.slice(0, 128)}]` : "";
}

function exceptionMessage(
  details: Record<string, unknown>,
  redact: (text: string) => string,
): string {
  const exception = isRecord(details.exception) ? details.exception : {};
  const text =
    typeof exception.description === "string"
      ? exception.description
      : typeof details.text === "string"
        ? details.text
        : null;
  return text === null ? "Unhandled page exception" : redact(text).slice(0, 8_192);
}

function boundedTextField(value: unknown, maxLength: number): string | null {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function boundedUrlField(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, 16_384);
}

function boundedMethod(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "GET";
  return value.slice(0, 32);
}

function boundMap<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function boundedNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`browser ${label} must be a nonnegative integer`);
  }
  return value;
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`browser ${label} must be a positive bounded integer`);
  }
  return value;
}

/** Chrome's answer to a Runtime call on a page that has no JavaScript context
 * at that moment: one between documents, or one whose document was replaced
 * while the call ran. */
function missingExecutionContext(error: unknown): boolean {
  return (
    error instanceof CdpProtocolError &&
    /(cannot find (default )?(execution )?context|execution context was destroyed)/iu.test(
      error.message,
    )
  );
}

/** A wait length as people say it: "30 s", or "1.5 s" below ten seconds. */
function formatSeconds(ms: number): string {
  const seconds = ms / 1_000;
  return `${seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds)} s`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function dimensionsRecord(
  value: unknown,
  includeOffset: boolean,
): { x: number; y: number; width: number; height: number } {
  if (!isRecord(value)) throw new Error("CDP returned invalid page dimensions");
  const width = numberField(value, includeOffset ? "clientWidth" : "width");
  const height = numberField(value, includeOffset ? "clientHeight" : "height");
  const x = includeOffset ? (numberField(value, "pageX") ?? 0) : 0;
  const y = includeOffset ? (numberField(value, "pageY") ?? 0) : 0;
  if (width === null || height === null || width <= 0 || height <= 0) {
    throw new Error("CDP returned invalid page dimensions");
  }
  return { x, y, width, height };
}

function numberField(value: Record<string, unknown>, key: string): number | null {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function finiteScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error("browser frame has an invalid scale");
  }
  return value;
}

function mouseButtonMask(button: "left" | "right" | "middle"): number {
  switch (button) {
    case "left":
      return 1;
    case "right":
      return 2;
    case "middle":
      return 4;
  }
}

function frameStreamProfileKey(options: NormalizedBrowserFrameStreamOptions): string {
  return [
    options.format,
    options.quality,
    options.maxWidth,
    options.maxHeight,
    options.everyNthFrame,
  ].join(":");
}

function transportError(value: unknown): Error {
  return value instanceof Error ? value : new CdpTransportError("browser media stream failed");
}

function parseUserAgentMetadata(value: unknown): BrowserUserAgentMetadata {
  if (!isRecord(value) || typeof value.mobile !== "boolean") {
    throw new Error("browser returned invalid User-Agent metadata");
  }
  const metadata: BrowserUserAgentMetadata = {
    platform: userAgentMetadataString(value.platform),
    platformVersion: userAgentMetadataString(value.platformVersion),
    architecture: userAgentMetadataString(value.architecture),
    model: userAgentMetadataString(value.model),
    mobile: value.mobile,
  };
  const brands = userAgentBrandList(value.brands);
  const fullVersionList = userAgentBrandList(value.fullVersionList);
  const bitness = optionalUserAgentMetadataString(value.bitness);
  const formFactors = userAgentStringList(value.formFactors);
  if (brands) metadata.brands = brands;
  if (fullVersionList) metadata.fullVersionList = fullVersionList;
  if (bitness !== undefined) metadata.bitness = bitness;
  if (typeof value.wow64 === "boolean") metadata.wow64 = value.wow64;
  if (formFactors) metadata.formFactors = formFactors;
  return metadata;
}

function userAgentBrandList(value: unknown): Array<{ brand: string; version: string }> | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("browser returned invalid User-Agent brands");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error("browser returned invalid User-Agent brand");
    return {
      brand: userAgentMetadataString(entry.brand),
      version: userAgentMetadataString(entry.version),
    };
  });
}

function userAgentStringList(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("browser returned invalid User-Agent form factors");
  }
  return value.map(userAgentMetadataString);
}

function optionalUserAgentMetadataString(value: unknown): string | undefined {
  return value === undefined ? undefined : userAgentMetadataString(value);
}

function userAgentMetadataString(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 512 || /[\r\n\0]/u.test(value)) {
    throw new Error("browser returned invalid User-Agent metadata");
  }
  return value;
}

function normalizeLocale(value: string): string {
  return value.replaceAll("_", "-").toLocaleLowerCase();
}

function webOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InteractionDefiniteDriverError(
      "invalid_action",
      "browser permission control requires an HTTP(S) top-level document",
    );
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null") {
    throw new InteractionDefiniteDriverError(
      "invalid_action",
      "browser permission control requires an HTTP(S) top-level document",
    );
  }
  return url.origin;
}

/** A frame document's origin for its accessibility description, if it has one. */
function frameOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin.slice(0, 2_048);
  } catch {
    return null;
  }
}

function parseFrameTree(
  value: Record<string, unknown>,
  state: { count: number } = { count: 0 },
): PageFrameTree {
  state.count += 1;
  if (state.count > MAX_FRAME_TREES) {
    throw new Error("CDP frame tree exceeds its bounded envelope");
  }
  if (!isRecord(value.frame)) throw new Error("CDP returned an invalid frame tree");
  const frame = value.frame;
  if (
    typeof frame.id !== "string" ||
    typeof frame.loaderId !== "string" ||
    typeof frame.url !== "string"
  ) {
    throw new Error("CDP returned an invalid frame");
  }
  const rawChildren = value.childFrames;
  if (rawChildren !== undefined && !Array.isArray(rawChildren)) {
    throw new Error("CDP returned invalid child frames");
  }
  return {
    frame: { id: frame.id, loaderId: frame.loaderId, url: frame.url },
    childFrames: (rawChildren ?? []).map((child) => {
      if (!isRecord(child)) throw new Error("CDP returned an invalid child frame");
      return parseFrameTree(child, state);
    }),
  };
}

function flattenFrameTree(root: PageFrameTree): MainFrame[] {
  const frames: MainFrame[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    frames.push(current.frame);
    pending.unshift(...current.childFrames);
  }
  return frames;
}

function frameTreeFingerprint(frames: readonly MainFrame[]): string {
  return frames.map((frame) => `${frame.id}\0${frame.loaderId}`).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Chromium's refusal of a DOM node id its current document no longer holds,
 * as after the page navigated. It shares its error code with an invalid
 * selector's refusal ("DOM Error while querying"), so only the message tells
 * them apart.
 */
function cdpNodeGone(error: unknown): boolean {
  return error instanceof CdpProtocolError && /could not find node/i.test(error.message);
}

/** Answer an authenticating proxy for every page, worker and new tab of the
 * browser. Browser-wide request interception is the only CDP surface that
 * reaches proxy challenges, so each request pauses briefly and is continued
 * unchanged; only a challenge from the proxy itself receives the
 * credentials, and every other challenge keeps the browser's default. */
async function answerProxyChallenges(
  connection: BrowserCdpConnection,
  credentials: { username: string; password: string },
): Promise<Array<() => void>> {
  const unsubscribe = [
    connection.on("Fetch.requestPaused", (event) => {
      const requestId = event.params.requestId;
      if (typeof requestId !== "string") return;
      void connection.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
    }),
    connection.on("Fetch.authRequired", (event) => {
      const requestId = event.params.requestId;
      if (typeof requestId !== "string") return;
      const challenge = event.params.authChallenge;
      const fromProxy = isRecord(challenge) && challenge.source === "Proxy";
      void connection
        .send("Fetch.continueWithAuth", {
          requestId,
          authChallengeResponse: fromProxy
            ? {
                response: "ProvideCredentials",
                username: credentials.username,
                password: credentials.password,
              }
            : { response: "Default" },
        })
        .catch(() => undefined);
    }),
  ];
  try {
    await connection.send("Fetch.enable", {
      handleAuthRequests: true,
      patterns: [{ urlPattern: "*" }],
    });
  } catch (error) {
    for (const stop of unsubscribe) stop();
    throw error;
  }
  return unsubscribe;
}

async function assertOwnedCdpProcess(
  connection: BrowserCdpConnection,
  process: OwnedManagedBrowserProcess,
) {
  if ((await ownedCdpProcessId(connection)) !== process.pid)
    throw new Error("CDP endpoint does not identify the exact owned browser process");
}

async function ownedCdpProcessId(connection: BrowserCdpConnection): Promise<number> {
  const result = await connection.send<{ processInfo?: unknown }>(
    "SystemInfo.getProcessInfo",
    {},
    { timeoutMs: 2_000 },
  );
  if (!Array.isArray(result.processInfo))
    throw new Error("owned browser CDP process identity is unavailable");
  const browsers = result.processInfo.filter(
    (value: unknown): value is { type: string; id: number } =>
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "browser",
  );
  const pid = browsers[0]?.id;
  if (
    browsers.length !== 1 ||
    !Number.isSafeInteger(pid) ||
    pid === undefined ||
    pid < 2 ||
    pid > 2_147_483_647
  ) {
    throw new Error("CDP endpoint does not identify the exact owned browser process");
  }
  return pid;
}

function isNavigationTimeout(error: unknown): boolean {
  return (
    !(error instanceof NavigationNotAnsweredError) &&
    (error instanceof CdpCommandTimeoutError ||
      (error instanceof InteractionDefiniteDriverError && error.code === "timeout"))
  );
}

/** The page committed a new document after an action found its element and
 * before its first input event: nothing was sent to either document. */
class DocumentMovedBeforeInputError extends InteractionDefiniteDriverError {
  constructor(message: string) {
    super("document_stale", message);
    this.name = "DocumentMovedBeforeInputError";
  }
}

/** The locators an action resolves before it sends input. */
function actionLocators(action: BrowserAction): BrowserLocator[] {
  const locators: Array<BrowserLocator | undefined> = [];
  if (action.type === "wait") return [];
  if ("locator" in action) locators.push(action.locator);
  if ("from" in action) locators.push(action.from);
  if ("to" in action) locators.push(action.to);
  return locators.filter((locator): locator is BrowserLocator => locator !== undefined);
}

/** The server never answered and the tab stopped loading: unlike a slow
 * page, nothing will appear in it later. */
class NavigationNotAnsweredError extends InteractionDefiniteDriverError {
  constructor(timeoutMs: number) {
    super(
      "timeout",
      `browser could not load the requested URL: its server did not respond within ${Math.round(
        timeoutMs / 1_000,
      )} seconds`,
      true,
    );
    this.name = "NavigationNotAnsweredError";
  }
}

/** Chromium reports a page that could not load (DNS, connection, TLS, ...)
 * as a `net::ERR_*` navigation error after committing its error page. Other
 * navigation errors, such as an invalid URL, leave no page for the URL. */
function isPageLoadError(errorText: string): boolean {
  return /^net::ERR_[A-Z0-9_]+$/u.test(errorText);
}
