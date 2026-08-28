// The sandbox workbench — the SDK-embeddable dock "brain" (Workbench v2, M4).
//
// This module owns the whole session workspace surface an embedder mounts:
//   Changes  — review-first git: turn-end capture (cold) or live diff (warm)
//   Files    — tree + inline editor (capture-backed cold, live warm)
//   Terminal — interactive xterm wired to the box PTY (Channel-A projection)
//   Browser  — workspace-wide BrowserSessions, tabs, live frames, and input
//   Computer — workspace ComputerSessions: native targets, frames, and input
// plus a machine-state chip in the dock header (the one truthful live/waking/
// offline indicator) and any host-injected extra tabs (Run/Debug in apps/web).
//
// It is decoupled from the host app: the client comes from <OpenGeniProvider>
// (never an app context), notifications flow through an optional `onNotify` prop
// (no `sonner` import), and every surface renders with package primitives + og
// tokens only. `apps/web` consumes this through the exact public surface an
// external embedder uses — that is criterion F1.
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SessionEvent } from "@opengeni/sdk";
import type { InteractionPlacement } from "@opengeni/sdk/interaction";
import {
  CircleCheckIcon,
  CpuIcon,
  FileCode2Icon,
  GitCompareArrowsIcon,
  Globe2Icon,
  LoaderCircleIcon,
  MonitorIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { type ClientOverride, useOpenGeni } from "../provider";
import { cn } from "../lib/cn";
import { xtermThemeFromTokens } from "../lib/xterm-theme";
import { sandboxAcceptsLiveIo } from "../lib/sandbox-liveness";
import type { BrowserFrameWebSocketFactory } from "../hooks/use-browser-frame-stream";
import type { ComputerFrameWebSocketFactory } from "../hooks/use-computer-frame-stream";
import type { FileNodeVisibilityPredicate } from "../file-node-visibility";
import { useSessionCapabilities } from "../hooks/use-session-capabilities";
import { useSandboxFiles } from "../hooks/use-sandbox-files";
import {
  useSandboxGit,
  type SandboxGitComparison,
  type UseSandboxGitResult,
} from "../hooks/use-sandbox-git";
import { useSandboxTerminal } from "../hooks/use-sandbox-terminal";
import { useWorkspaceCapture } from "../hooks/use-workspace-capture";
import { useMachineChip, type MachineChip } from "../hooks/use-machine-chip";
import { MACHINES_SESSION_POLL_MS, useMachines } from "../hooks/use-machines";
import type { MachineView } from "../types/machines";
import { SandboxFiles } from "./sandbox-files";
import { WorkbenchChanges } from "./workbench-changes";
import { SandboxTerminal, type XtermTheme } from "./sandbox-terminal";
import { WorkspaceDock, type WorkspaceDockProps, type WorkspaceTab } from "./workspace-dock";

const LazyBrowserViewer = lazy(async () => {
  const { BrowserViewer } = await import("./browser-viewer");
  return { default: BrowserViewer };
});

const LazyComputerViewer = lazy(async () => {
  const { ComputerViewer } = await import("./computer-viewer");
  return { default: ComputerViewer };
});

/** A host-routed notification (replaces the app-only `sonner` toast coupling). */
export type WorkspaceNotification = { kind: "error" | "info"; message: string };

/** The workbench's canonical tab ids (a host injects extras around these). */
export const WORKBENCH_TAB_CHANGES = "changes";
export const WORKBENCH_TAB_FILES = "files";
export const WORKBENCH_TAB_TERMINAL = "terminal";
export const WORKBENCH_TAB_BROWSER = "browser";
export const WORKBENCH_TAB_DESKTOP = "desktop";

/**
 * The built-in workbench surfaces in their canonical display order. Hosts can
 * pass a subset through `surfaces`; omission preserves the complete standalone
 * workbench.
 */
export const WORKBENCH_SURFACES = [
  WORKBENCH_TAB_CHANGES,
  WORKBENCH_TAB_FILES,
  WORKBENCH_TAB_TERMINAL,
  WORKBENCH_TAB_BROWSER,
  WORKBENCH_TAB_DESKTOP,
] as const;

export type SandboxWorkspaceSurface = (typeof WORKBENCH_SURFACES)[number];

function isWorkbenchSurface(value: string): value is SandboxWorkspaceSurface {
  return (WORKBENCH_SURFACES as readonly string[]).includes(value);
}

function sourceDrivenDefaultTab(
  hasChanges: boolean,
  changesEnabled: boolean,
  filesEnabled: boolean,
): string | null {
  if (hasChanges && changesEnabled) return WORKBENCH_TAB_CHANGES;
  if (filesEnabled) return WORKBENCH_TAB_FILES;
  if (changesEnabled) return WORKBENCH_TAB_CHANGES;
  return null;
}

function captureDegradedMessage(reason: string): string {
  switch (reason) {
    case "repository_discovery_timed_out":
      return "Workspace capture is incomplete because repository discovery timed out. Live files remain authoritative.";
    case "repository_discovery_result_limit_exceeded":
      return "Workspace capture is incomplete because the repository limit was exceeded. Live files remain authoritative.";
    case "repository_read_unavailable":
      return "Workspace capture is incomplete because repository changes could not be read. Live files remain authoritative.";
    default:
      return "Workspace capture is incomplete because repository discovery failed. Live files remain authoritative.";
  }
}

function WorkbenchSurfaceLoading({ name }: { name: "Browser" | "Desktop" }) {
  return (
    <CenteredState
      icon={
        <LoaderCircleIcon className="size-5 animate-spin motion-reduce:animate-none" aria-hidden />
      }
    >
      <p className="text-og-sm font-medium text-og-fg">Opening {name}</p>
    </CenteredState>
  );
}

/**
 * Decide a workspace tab from an already-local event log: the newest
 * `workspace.revision.captured` announce carries the change surface stats, so
 * "changes exist → Changes, else Files" needs zero machine round-trips. A host
 * `override` (e.g. a landing "run" tab) wins when supplied.
 *
 * `<SandboxWorkspace>` uses this only as an optional early hint after its own
 * capture GET reports no durable capture. A pure embedder needs no events-at-mount
 * contract: it falls through to authoritative live Git instead.
 */
export function initialWorkspaceTab(
  events: SessionEvent[] | undefined,
  override?: string | null,
): string {
  if (override) return override;
  let bestSeq = -1;
  let bestFileCount = 0;
  for (const event of events ?? []) {
    if (event.type !== "workspace.revision.captured") continue;
    if (event.sequence <= bestSeq) continue;
    const stats = (event.payload as { stats?: { fileCount?: number } } | null)?.stats;
    bestSeq = event.sequence;
    bestFileCount = typeof stats?.fileCount === "number" ? stats.fileCount : 0;
  }
  if (bestFileCount > 0) return WORKBENCH_TAB_CHANGES;

  let latestGitSeq = -1;
  let committedOnly = false;
  for (const event of events ?? []) {
    if (event.type !== "git.changed" || event.sequence > bestSeq) continue;
    if (event.sequence <= latestGitSeq) continue;
    const payload = event.payload as { ahead?: number; reason?: string } | null;
    latestGitSeq = event.sequence;
    committedOnly =
      (typeof payload?.ahead === "number" && payload.ahead > 0) || payload?.reason === "commit";
  }
  return committedOnly ? WORKBENCH_TAB_CHANGES : WORKBENCH_TAB_FILES;
}

/**
 * Whether a lazy sandbox provision is in flight on this event stream: the latest
 * `sandbox.provision` operation event is a `.started` not yet closed by a
 * `.completed`/`.failed`. Package-local twin of apps/web's events helper so the
 * dock brain can wake its on-demand capability negotiation when the box warms.
 */
function sandboxProvisionInFlight(events: SessionEvent[]): boolean {
  let inFlight = false;
  for (const event of events) {
    if (
      event.type !== "sandbox.operation.started" &&
      event.type !== "sandbox.operation.completed" &&
      event.type !== "sandbox.operation.failed"
    ) {
      continue;
    }
    const payload = event.payload;
    const name =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).name
        : null;
    if (name !== "sandbox.provision") continue;
    if (event.type === "sandbox.operation.started") {
      inFlight = true;
    } else {
      inFlight = false;
    }
  }
  return inFlight;
}

/**
 * Whether this session currently owns an admitted agent turn. Automatic live
 * Files/Git reads pause across the whole turn: command boundaries are not a safe
 * gap because the next tool can dispatch before a remote provider read releases
 * its sandbox holder. Existing/captured content remains usable, and the terminal
 * turn event resumes one authoritative refresh.
 */
function workspaceTurnInFlight(events: SessionEvent[]): boolean {
  const activeTurnIds = new Set<string>();
  let anonymousTurnInFlight = false;
  let sessionOwnsWorkspace = false;
  for (const event of events) {
    if (event.type === "session.status.changed") {
      const status =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>).status
          : null;
      sessionOwnsWorkspace = status === "running" || status === "recovering";
      continue;
    }
    if (event.type === "turn.started") {
      if (event.turnId) activeTurnIds.add(event.turnId);
      else anonymousTurnInFlight = true;
      continue;
    }
    if (
      event.type !== "turn.completed" &&
      event.type !== "turn.failed" &&
      event.type !== "turn.cancelled" &&
      event.type !== "turn.superseded"
    ) {
      continue;
    }
    if (event.turnId) activeTurnIds.delete(event.turnId);
    else anonymousTurnInFlight = false;
  }
  // The retained event window preserves the latest status even after a very
  // long turn has evicted its original turn.started event.
  return sessionOwnsWorkspace || anonymousTurnInFlight || activeTurnIds.size > 0;
}

export type WorkspaceMachine = {
  /** Whether at least one built-in workbench surface is enabled. */
  enabled: boolean;
  /** The derived live/waking/sleeping-or-offline chip model. */
  chip: MachineChip;
  /** The machine these surfaces are bound to (the Modal group box or a
   *  self-hosted machine), or null while the fleet is still resolving. */
  activeMachine: MachineView | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

export type UseSandboxWorkspaceTabsOptions = ClientOverride & {
  sessionId: string;
  /** Live event log (usually `useSessionEvents().events`). */
  events: SessionEvent[];
  /**
   * Built-in surfaces this host wants to expose. Omit for all five. A disabled
   * surface is behaviorally dormant: its data hooks, warm intents, stream
   * attachment, and navigation callbacks are not activated.
   */
  surfaces?: readonly SandboxWorkspaceSurface[] | undefined;
  /** Override the source-driven default tab (e.g. a host landing tab id). When
   *  omitted the workbench picks Changes-vs-Files from capture or live Git. */
  initialTab?: string | null | undefined;
  /** Actually selected dock tab. Inactive data surfaces retain cache but issue no live reads. */
  activeTab?: string | null | undefined;
  /** Whether the dock is visible. Hidden docks retain UI state but must not keep
   * expensive browser/computer media streams alive. */
  workspaceVisible?: boolean | undefined;
  /** Host-routed notifications (mutation errors, desktop-consent failures). The
   *  package never imports a toast library — the host decides how to surface. */
  onNotify?: ((notification: WorkspaceNotification) => void) | undefined;
  /** Alternate frame transport for non-browser runtimes and deterministic tests. */
  browserWebSocketFactory?: BrowserFrameWebSocketFactory | undefined;
  /** Alternate Computer frame transport for non-browser runtimes and deterministic tests. */
  computerWebSocketFactory?: ComputerFrameWebSocketFactory | undefined;
  /** Host-owned setup page or store listing for attaching an existing Chrome profile. */
  browserExtensionSetupUrl?: string | undefined;
  /** File requested by a Changes guard. The Files surface defers the read until
   *  the sandbox is live, then reveals this path. */
  requestedFilePath?: string | null | undefined;
  /** Unique identity for `requestedFilePath`, including repeated requests for the
   *  same path. */
  requestedFileRequestId?: string | number | null | undefined;
  /** 1-based line to reveal after `requestedFilePath` opens. */
  requestedFileLine?: number | null | undefined;
  /** Route a guarded diff into the host's Files tab. */
  onOpenFile?: ((path: string) => void) | undefined;
  /** Restore and report navigation inside the built-in workbench surfaces. */
  initialFilePath?: string | null | undefined;
  onFilePathChange?: ((path: string | null) => void) | undefined;
  /** Presentation-only filter for Files tree nodes and selected-file viewing. */
  isFileNodeVisible?: FileNodeVisibilityPredicate | undefined;
  initialBrowserSessionId?: string | null | undefined;
  onBrowserSessionIdChange?: ((browserSessionId: string | null) => void) | undefined;
  initialComputerSessionId?: string | null | undefined;
  onComputerSessionIdChange?: ((computerSessionId: string | null) => void) | undefined;
  /** Navigate the host dock to one exact linked ComputerSession. */
  onOpenComputerSession?: ((computerSessionId: string) => void) | undefined;
  requestedComputerSessionId?: string | null | undefined;
  requestedComputerRequestId?: string | number | null | undefined;
};

export type UseSandboxWorkspaceTabsResult = {
  /** Changes | Files | Terminal | Browser | Desktop (capability-gated where noted). */
  tabs: WorkspaceTab[];
  /** The source-driven default tab: Changes when the first authoritative capture
   *  has changes, else Files (a host `initialTab` overrides). Choosing a tab
   *  never performs hidden live workspace I/O.
   *  null while that source resolves, or permanently when neither Changes nor
   *  Files is enabled; the choice latches once. */
  defaultTab: string | null;
  /** The machine-state model for the dock-header chip. */
  machine: WorkspaceMachine;
};

type SessionWarmIntents = {
  sessionId: string;
  warmTerminal: boolean;
  warmFiles: boolean;
};

function emptyWarmIntents(sessionId: string): SessionWarmIntents {
  return {
    sessionId,
    warmTerminal: false,
    warmFiles: false,
  };
}

/**
 * Build the workbench tabs + the machine-chip model for one session. This is the
 * dock "brain": capability negotiation, capture-backed cold reads, prewarm
 * flags, automatic desktop acknowledgment, and the xterm theme observer — all
 * package-local.
 */
export function useSandboxWorkspaceTabs(
  options: UseSandboxWorkspaceTabsOptions,
): UseSandboxWorkspaceTabsResult {
  const { client, workspaceId, workspaceInteractionEvent } = useOpenGeni(options);
  const {
    sessionId,
    events,
    onNotify,
    browserWebSocketFactory,
    computerWebSocketFactory,
    browserExtensionSetupUrl,
    requestedFilePath,
    requestedFileRequestId,
    requestedFileLine,
    onOpenFile,
    initialFilePath,
    onFilePathChange,
    isFileNodeVisible,
    initialBrowserSessionId,
    onBrowserSessionIdChange,
    initialComputerSessionId,
    onComputerSessionIdChange,
    onOpenComputerSession,
    requestedComputerSessionId,
    requestedComputerRequestId,
  } = options;
  const initialTab = options.initialTab ?? null;
  const activeTab = options.activeTab ?? initialTab;
  const workspaceVisible = options.workspaceVisible ?? true;
  const requestedSurfaces = options.surfaces ?? WORKBENCH_SURFACES;
  const surfaceSet = new Set<SandboxWorkspaceSurface>(requestedSurfaces);
  const changesEnabled = surfaceSet.has(WORKBENCH_TAB_CHANGES);
  const filesEnabled = surfaceSet.has(WORKBENCH_TAB_FILES);
  const terminalEnabled = surfaceSet.has(WORKBENCH_TAB_TERMINAL);
  const browserEnabled = surfaceSet.has(WORKBENCH_TAB_BROWSER);
  const desktopEnabled = surfaceSet.has(WORKBENCH_TAB_DESKTOP);
  const createLinkedComputer = useCallback(
    async (name: string, placement?: InteractionPlacement) => {
      const response = await client.createComputerSession(workspaceId, {
        operationId: crypto.randomUUID(),
        sessionId,
        name,
        ...(placement ? { placement } : {}),
      });
      if (response.operation.state !== "completed" || response.session.lifecycle !== "active") {
        throw new Error(response.operation.error?.message ?? "The desktop could not be opened.");
      }
      return {
        id: response.session.id,
        placement: response.session.placement,
      };
    },
    [client, sessionId, workspaceId],
  );
  const workspaceDataEnabled = changesEnabled || filesEnabled;
  const machineSurfaceEnabled = workspaceDataEnabled || terminalEnabled || desktopEnabled;
  // Do not speculatively activate both remote workspace surfaces while the dock
  // is still resolving its selected tab. Modal calls cannot be cancelled after
  // dispatch, so that transient state otherwise creates an aborted duplicate
  // batch immediately before the real selected-tab request.
  const resolvedActiveTab = activeTab ?? initialTab;
  const changesActive = resolvedActiveTab === WORKBENCH_TAB_CHANGES;
  const filesActive = resolvedActiveTab === WORKBENCH_TAB_FILES;
  const turnInFlight = workspaceTurnInFlight(events);
  const surfaceIdentity = WORKBENCH_SURFACES.filter((surface) => surfaceSet.has(surface)).join(",");

  // The two box-warming INTENTS, each off by default and each
  // flipped true by a genuine user action (never on mount, never on a passive
  // capture glance): terminal engagement (`onActivate`) and a deliberate
  // live-file open/edit in Files. Browsing capture-served
  // Changes/Files warms nothing — that is the whole point of Refinement 1.
  const [storedWarmIntents, setStoredWarmIntents] = useState<SessionWarmIntents>(() =>
    emptyWarmIntents(sessionId),
  );
  const warmIntents =
    storedWarmIntents.sessionId === sessionId ? storedWarmIntents : emptyWarmIntents(sessionId);
  const { warmTerminal, warmFiles } = warmIntents;
  const requestWarmIntent = useCallback(
    (intent: Exclude<keyof SessionWarmIntents, "sessionId">) => {
      setStoredWarmIntents((previous) => {
        const current = previous.sessionId === sessionId ? previous : emptyWarmIntents(sessionId);
        return current[intent] ? current : { ...current, [intent]: true };
      });
    },
    [sessionId],
  );
  useEffect(() => {
    if (requestedFilePath) requestWarmIntent("warmFiles");
  }, [requestWarmIntent, requestedFilePath, requestedFileRequestId]);

  // The session's machine fleet + the active-sandbox pointer. Drives the header
  // chip (which machine + its connection state). Shares the session list poll.
  const machines = useMachines({
    workspaceId,
    sessionId,
    pollIntervalMs: MACHINES_SESSION_POLL_MS,
    enabled: machineSurfaceEnabled,
  });
  const activeMachine: MachineView | null =
    machines.machines.find((m) => m.sandboxId === machines.activeSandboxId) ??
    machines.machines.find((m) => m.active) ??
    null;

  const caps = useSessionCapabilities(sessionId, {
    events,
    enabled: machineSurfaceEnabled,
    attachDesktop: false,
    attachTerminal: terminalEnabled && warmTerminal,
    // Explicit live-file intent only — NOT "the Files tab is open". A cold edit
    // or guarded-file open wakes the box; a glance at the tree/diff does not.
    attachFiles: workspaceDataEnabled && warmFiles,
  });
  const capabilities = caps.capabilities;
  const liveness = capabilities?.liveness;
  // A missing capability document is not evidence that the sandbox is live.
  // Pass explicit null to live-I/O hooks so fast capture/event hydration cannot
  // exploit their legacy "liveness omitted" compatibility path while negotiation
  // is still pending.
  const liveIoLiveness = liveness ?? null;
  const fileSystemOn = capabilities?.FileSystem.available ?? false;
  // The FS is writable only when it's live AND not read-only. A self-hosted box
  // that's offline (or any read-only advertisement) or a capture-served cold tree
  // must not offer create/rename/delete/edit affordances — you cannot mutate a
  // machine you can't reach (C3). Tree-structure ops need a warm
  // writable box; content editing on a cold CLOUD box is the wake-on-edit path in
  // the editor, not tree mutation.
  const fsReadOnly = capabilities?.FileSystem.readOnly ?? false;
  // Mutations are live-only. A capture is a review artifact, never a writable
  // surrogate for a sleeping machine; the user must deliberately open the live
  // workspace before create/rename/delete/edit controls appear.
  const filesEditable = fileSystemOn && !fsReadOnly && sandboxAcceptsLiveIo(liveness);
  const gitOn = capabilities?.Git.available ?? false;
  const terminalOn = terminalEnabled && (capabilities?.Terminal.transport ?? null) !== null;
  // A descriptor-only pty-ws cell intentionally has no short-lived URL until
  // terminal intent acquires one. Do not mistake that grant boundary for a
  // legacy HTTP PTY and eagerly open a second terminal. The fallback exists only
  // for a genuinely firehose-transport backend with no typed degradation.
  const ptyCapable =
    warmTerminal &&
    (capabilities?.Terminal.ptyCapable ?? false) &&
    capabilities?.Terminal.transport === "sse-events" &&
    capabilities?.Terminal.reason === null;
  const terminal = useSandboxTerminal(sessionId, {
    events: terminalEnabled ? events : [],
    interactive: terminalEnabled && ptyCapable,
    liveness,
  });
  // Lazy provisioning (#315) creates the box mid-turn on the first sandbox tool
  // call, emitting sandbox.provision started→completed/failed on the live stream.
  // The on-demand resting hook rests without polling, so when the box warms the
  // cold capability doc never refreshes on its own — Terminal/Desktop would stay
  // hidden. Watch the provision edge and renegotiate when it settles so the
  // freshly-warm box's surfaces fill in.
  const provisioning = sandboxProvisionInFlight(events);
  const renegotiate = caps.renegotiate;
  const provisioningRef = useRef({ sessionId, provisioning });
  useEffect(() => {
    const previous = provisioningRef.current;
    if (previous.sessionId === sessionId && previous.provisioning && !provisioning) {
      renegotiate();
    }
    provisioningRef.current = { sessionId, provisioning };
  }, [sessionId, provisioning, renegotiate]);

  // BrowserSession and ComputerSession lifecycles use the same placement lease
  // as files/terminal/desktop, but are workspace resources rather than session
  // events. Re-read the capability document on their canonical workspace
  // invalidation so the one machine chip cannot remain "Offline" beside a live
  // browser/computer (or remain "Live" after the final interaction holder ends).
  // This is a read-only negotiation: it never acquires a holder or wakes a box.
  useEffect(() => {
    if (workspaceInteractionEvent?.workspaceId !== workspaceId) return;
    renegotiate();
  }, [workspaceId, workspaceInteractionEvent, renegotiate]);

  // The cold-paint data source: the latest turn-end capture, fetched with a single
  // api round-trip on mount (no machine). Feeds the Files tree + the Changes/Git
  // diff immediately; a warm box reconciles live without discarding the capture
  // when that provider read is temporarily unavailable.
  const captureState = useWorkspaceCapture(sessionId, {
    events,
    enabled: workspaceDataEnabled,
  });
  const captureAvailable = captureState.available;
  const liveWorkspaceExpected = sandboxAcceptsLiveIo(liveness);
  // Capability negotiation and capture resolution are independent requests. A
  // cold capability document can win that race by a few milliseconds; enabling
  // the leaf hooks in that window would make them interpret `capture: null` as a
  // real miss and issue Channel-A reads, waking the very box the capture exists
  // to avoid. Wait until the capture request has conclusively resolved. A warm
  // workspace never waits on this server-side snapshot.
  const capturePending =
    !liveWorkspaceExpected && (captureState.fileCount === null || captureState.loading);
  const repoPaths = useMemo(() => {
    const advertised = capabilities?.Git.repos ?? [];
    if (advertised.length > 0) return advertised;
    return captureState.capture?.repos.map((repo) => repo.root) ?? [];
  }, [capabilities?.Git.repos, captureState.capture]);
  const notifiedCaptureDegradedReason = useRef<{
    sessionId: string;
    reason: string | null;
  }>({
    sessionId,
    reason: null,
  });
  if (notifiedCaptureDegradedReason.current.sessionId !== sessionId) {
    notifiedCaptureDegradedReason.current = { sessionId, reason: null };
  }
  useEffect(() => {
    const reason = captureState.degradedReason;
    if (!reason || notifiedCaptureDegradedReason.current.reason === reason) return;
    notifiedCaptureDegradedReason.current = { sessionId, reason };
    onNotify?.({ kind: "error", message: captureDegradedMessage(reason) });
  }, [sessionId, captureState.degradedReason, onNotify]);

  const files = useSandboxFiles(sessionId, {
    events,
    // No passive Channel-A reads while cold, even after a conclusive capture
    // miss. A missing capture gets an explicit "Open live workspace" gate.
    enabled: filesEnabled && (captureAvailable || (fileSystemOn && liveWorkspaceExpected)),
    // A cold sandbox can become warm while the first agent command still owns
    // startup. Do not race that command with an automatic Files read. Keeping
    // this fence at turn scope also avoids unsafe millisecond gaps between
    // sequential tool calls; rendered state and explicit user actions remain.
    active: filesActive && !turnInFlight,
    // A deliberate canonical absolute-path open browses in the selected target's
    // advertised namespace, so the authoritative tree and link share exact paths.
    ...(requestedFilePath?.startsWith("/") && capabilities?.FileSystem.root
      ? { rootPath: capabilities.FileSystem.root }
      : {}),
    repoPaths,
    liveness: liveIoLiveness,
    capture: captureState.capture,
    // A reverted optimistic mutation (e.g. a 409 rename collision) surfaces as a
    // host notification — the tree silently rolls back, the user sees why.
    onMutationError: (error, op) =>
      onNotify?.({
        kind: "error",
        message: `Could not ${op}: ${error.message}`,
      }),
  });
  const [storedChangesComparison, setStoredChangesComparison] = useState<{
    sessionId: string;
    value: SandboxGitComparison;
  } | null>(null);
  const captureSupportsBranch =
    captureState.capture !== null &&
    captureState.capture.repos.length > 0 &&
    captureState.capture.repos.every((repo) => repo.branchDiff !== undefined);
  // A sleeping workspace can truthfully serve only the captured working-tree
  // comparison. A live workspace defaults to the branch comparison so committed
  // agent work remains visible. Explicit user selection is scoped per session.
  const changesComparison =
    storedChangesComparison?.sessionId === sessionId
      ? storedChangesComparison.value
      : liveWorkspaceExpected || captureSupportsBranch
        ? "branch"
        : "working";
  const setChangesComparison = useCallback(
    (value: SandboxGitComparison) => setStoredChangesComparison({ sessionId, value }),
    [sessionId],
  );
  const git = useSandboxGit(sessionId, {
    events,
    enabled:
      changesComparison === "working"
        ? workspaceDataEnabled && (captureAvailable || (gitOn && liveWorkspaceExpected))
        : changesComparison === "branch"
          ? workspaceDataEnabled && (captureSupportsBranch || (gitOn && liveWorkspaceExpected))
          : workspaceDataEnabled && gitOn && liveWorkspaceExpected,
    // Live Git belongs to the visible Changes surface. In particular, do not
    // turn an unresolved/default tab into a hidden provider read: that races the
    // agent's own sandbox commands and used to refresh after every tool output
    // even while Files was visibly selected.
    active: changesActive && !turnInFlight,
    repoPaths,
    liveness: liveIoLiveness,
    comparison: changesComparison,
    capture: changesComparison === "staged" ? null : captureState.capture,
  });
  useEffect(() => {
    if (
      changesComparison === "branch" &&
      git.error &&
      storedChangesComparison?.sessionId !== sessionId
    ) {
      // `origin/HEAD` is not guaranteed on a newly initialized repository, a
      // connected machine, or a clone whose remote was renamed. The implicit
      // live default must not strand the whole Changes surface when its ordinary
      // working-tree comparison is still valid. Fall back once; an explicit
      // user-selected Branch view remains selected and surfaces its real error.
      setStoredChangesComparison({ sessionId, value: "working" });
    }
  }, [changesComparison, git.error, sessionId, storedChangesComparison?.sessionId]);
  // Token-derived xterm theme; re-derive on a `data-og-theme` flip. Generic — it
  // belongs in the package (an embedder's theme toggle drives it too).
  const [xtermTheme, setXtermTheme] = useState<XtermTheme | undefined>(undefined);
  useEffect(() => {
    if (!terminalEnabled || typeof document === "undefined") return;
    const derive = () => setXtermTheme(xtermThemeFromTokens());
    derive();
    const observer = new MutationObserver(derive);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-og-theme", "class"],
    });
    return () => observer.disconnect();
  }, [terminalEnabled]);

  const dirtyCount = git.diff.length;

  // The one truthful machine indicator, derived from the live capability/liveness
  // surface + the active machine's connection state + the latest capture time.
  const chip = useMachineChip({
    liveness,
    capabilitiesState: caps.state,
    activeMachineState: activeMachine?.state ?? null,
    activeIsSelfhosted: activeMachine?.kind === "selfhosted",
    wantsWarm: (terminalEnabled && warmTerminal) || (workspaceDataEnabled && warmFiles),
    capturedAt: captureState.capturedAt,
  });
  const workspaceWaking = chip.state === "waking";

  // The pre-paint default comes only from the durable capture. Default selection
  // must never dispatch live provider work: a live Git probe can overlap the
  // agent's first command, and an uncontrolled dock used to keep that probe
  // active forever after it visibly selected Files. A capture with reviewable
  // changes opens Changes; no capture (or an empty one) opens Files. The choice
  // latches once so later edits never steal the user's current tab.
  const defaultIdentity = `${sessionId}\u0000${surfaceIdentity}`;
  const defaultTabRef = useRef<{ identity: string; value: string | null }>({
    identity: defaultIdentity,
    value: null,
  });
  if (defaultTabRef.current.identity !== defaultIdentity) {
    defaultTabRef.current = { identity: defaultIdentity, value: null };
  }
  const captureHasChanges =
    (captureState.fileCount ?? 0) > 0 ||
    (captureState.capture?.repos.some((repo) => (repo.branchDiff?.length ?? 0) > 0) ?? false);
  const captureUnavailable =
    (captureState.fileCount === 0 && !captureHasChanges) || captureState.error !== null;
  if (defaultTabRef.current.value === null) {
    if (initialTab && (!isWorkbenchSurface(initialTab) || surfaceSet.has(initialTab))) {
      defaultTabRef.current.value = initialTab;
    } else if (captureState.fileCount !== null && captureState.available) {
      defaultTabRef.current.value = sourceDrivenDefaultTab(
        captureHasChanges,
        changesEnabled,
        filesEnabled,
      );
    } else if (captureUnavailable && initialWorkspaceTab(events) === WORKBENCH_TAB_CHANGES) {
      defaultTabRef.current.value = sourceDrivenDefaultTab(true, changesEnabled, filesEnabled);
    } else if (captureState.fileCount !== null || captureState.error !== null) {
      // No durable review surface exists. Files owns the explicit live-workspace
      // gate; a user can open Changes deliberately if they need a fresh Git read.
      defaultTabRef.current.value = sourceDrivenDefaultTab(false, changesEnabled, filesEnabled);
    }
  }
  // null only during the brief pre-first-resolve window (no host override yet).
  const defaultTab = defaultTabRef.current.value;

  const tabs = useMemo(() => {
    const list: WorkspaceTab[] = [];

    // Changes — capture-backed and usable cold/offline when the host enables it.
    if (changesEnabled)
      list.push({
        id: WORKBENCH_TAB_CHANGES,
        label: "Changes",
        icon: <GitCompareArrowsIcon />,
        badge: dirtyCount > 0 ? <DirtyBadge count={dirtyCount} /> : undefined,
        content: (
          <ChangesTabBody
            git={git}
            comparison={changesComparison}
            onComparisonChange={setChangesComparison}
            captureAvailable={captureAvailable}
            captureRevision={captureState.revision}
            capturePending={capturePending}
            liveWorkspaceExpected={liveWorkspaceExpected}
            workspaceWaking={workspaceWaking}
            capabilitiesState={caps.state}
            capabilitiesError={caps.error}
            onRetry={caps.renegotiate}
            onWake={() => requestWarmIntent("warmFiles")}
            {...(filesEnabled && onOpenFile
              ? {
                  onOpenFile: (path: string) => {
                    requestWarmIntent("warmFiles");
                    onOpenFile(path);
                  },
                }
              : {})}
          />
        ),
      });

    // Files — capture-backed cold tree; live warm when the host enables it.
    if (filesEnabled)
      list.push({
        id: WORKBENCH_TAB_FILES,
        label: "Files",
        icon: <FileCode2Icon />,
        content: (
          <SandboxFiles
            key={sessionId}
            files={files}
            git={git}
            isNodeVisible={isFileNodeVisible}
            fileSystemAvailable={fileSystemOn || captureAvailable}
            editable={
              filesEditable && files.source === "live" && files.error === null && !files.loading
            }
            workspaceResting={
              !liveWorkspaceExpected &&
              liveness !== undefined &&
              !capturePending &&
              !captureAvailable &&
              !workspaceWaking
            }
            workspaceWaking={!liveWorkspaceExpected && !captureAvailable && workspaceWaking}
            liveWorkspaceReady={liveWorkspaceExpected}
            onWakeWorkspace={() => requestWarmIntent("warmFiles")}
            {...(requestedFilePath
              ? {
                  requestedPath: requestedFilePath,
                  ...(requestedFileRequestId !== null && requestedFileRequestId !== undefined
                    ? { requestedPathRequestId: requestedFileRequestId }
                    : {}),
                  requestedPathReady: sandboxAcceptsLiveIo(liveness),
                  ...(requestedFileLine != null && requestedFileLine > 0
                    ? { requestedLine: requestedFileLine }
                    : {}),
                }
              : {})}
            // Ordinary capture browsing does not warm a box. The first edit — or an
            // explicit guarded-file open from Changes — is deliberate live-file intent.
            onEditIntent={() => requestWarmIntent("warmFiles")}
            initialSelectedPath={initialFilePath}
            onSelectedPathChange={onFilePathChange}
            className="h-full"
          />
        ),
      });

    // Terminal — capability-gated (appears after negotiation; never the default).
    if (terminalOn) {
      list.push({
        id: WORKBENCH_TAB_TERMINAL,
        label: "Terminal",
        icon: <SquareTerminalIcon />,
        content: (
          <div className="h-full bg-og-bg p-1">
            <SandboxTerminal
              key={sessionId}
              result={terminal}
              terminalCapability={capabilities?.Terminal ?? null}
              onActivate={() => requestWarmIntent("warmTerminal")}
              onReconnectNeeded={caps.renegotiate}
              showHeader
              shell={capabilities?.Terminal.shell ?? undefined}
              liveness={liveness}
              {...(xtermTheme ? { theme: xtermTheme } : {})}
            />
          </div>
        ),
      });
    }

    // Browser — independent from sandbox capability negotiation. BrowserSessions
    // are workspace resources and may live in this agent's sandbox, a peer's
    // sandbox, a connected machine, or an external browser placement.
    if (browserEnabled) {
      list.push({
        id: WORKBENCH_TAB_BROWSER,
        label: "Browser",
        icon: <Globe2Icon />,
        content: (
          <Suspense fallback={<WorkbenchSurfaceLoading name="Browser" />}>
            <LazyBrowserViewer
              key={sessionId}
              client={client}
              workspaceId={workspaceId}
              sessionId={sessionId}
              // WorkspaceDock mounts a heavy surface only after its first visit,
              // then keeps it mounted behind `hidden` when another tab is
              // selected. Keep that already-visited surface enabled while the
              // dock itself remains open: tearing down its controller + media
              // socket on every Browser↔Computer tab switch turned an ordinary
              // click into a multi-second cold reconnect. This does not eagerly
              // start BrowserViewer—the lazy panel is still unmounted until the
              // user/agent first visits it.
              enabled={workspaceVisible}
              onNotify={onNotify}
              initialBrowserSessionId={initialBrowserSessionId}
              onBrowserSessionIdChange={onBrowserSessionIdChange}
              {...(desktopEnabled ? { createLinkedComputer } : {})}
              {...(onOpenComputerSession ? { onOpenComputer: onOpenComputerSession } : {})}
              {...(browserWebSocketFactory ? { webSocketFactory: browserWebSocketFactory } : {})}
              {...(browserExtensionSetupUrl ? { browserExtensionSetupUrl } : {})}
              className="h-full"
            />
          </Suspense>
        ),
      });
    }

    // Computer — stable legacy tab id, new workspace resource body. Like Browser,
    // it is independent from the selected agent's sandbox capability document.
    if (desktopEnabled) {
      list.push({
        id: WORKBENCH_TAB_DESKTOP,
        label: "Desktop",
        icon: <MonitorIcon />,
        content: (
          <Suspense fallback={<WorkbenchSurfaceLoading name="Desktop" />}>
            <LazyComputerViewer
              key={sessionId}
              client={client}
              workspaceId={workspaceId}
              sessionId={sessionId}
              // Same visited-surface lifetime as Browser above. A live noVNC
              // connection survives tab switches and ResizeObserver re-fits its
              // canvas when this hidden panel becomes visible again, making the
              // second and later Computer opens local-machine fast.
              enabled={workspaceVisible}
              onNotify={onNotify}
              initialComputerSessionId={initialComputerSessionId}
              onComputerSessionIdChange={onComputerSessionIdChange}
              requestedComputerSessionId={requestedComputerSessionId}
              requestedComputerRequestId={requestedComputerRequestId}
              {...(computerWebSocketFactory ? { webSocketFactory: computerWebSocketFactory } : {})}
              className="h-full"
            />
          </Suspense>
        ),
      });
    }

    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fileSystemOn,
    changesEnabled,
    filesEnabled,
    terminalOn,
    browserEnabled,
    desktopEnabled,
    captureAvailable,
    dirtyCount,
    warmTerminal,
    requestedFilePath,
    requestedFileRequestId,
    requestedFileLine,
    onOpenFile,
    initialFilePath,
    onFilePathChange,
    isFileNodeVisible,
    initialBrowserSessionId,
    onBrowserSessionIdChange,
    initialComputerSessionId,
    onComputerSessionIdChange,
    onOpenComputerSession,
    requestedComputerSessionId,
    requestedComputerRequestId,
    onNotify,
    browserWebSocketFactory,
    computerWebSocketFactory,
    workspaceVisible,
    resolvedActiveTab,
    client,
    workspaceId,
    liveness,
    sessionId,
    files,
    git,
    changesComparison,
    terminal,
    xtermTheme,
    capabilities,
    workspaceWaking,
    caps.state,
    caps.error,
    caps.viewerCapReached,
    requestWarmIntent,
    createLinkedComputer,
  ]);

  return {
    tabs,
    defaultTab,
    machine: {
      enabled: machineSurfaceEnabled,
      chip,
      activeMachine,
      loading: machines.loading,
      error: machines.error,
      refresh: machines.refresh,
    },
  };
}

export type SandboxWorkspaceProps = ClientOverride & {
  sessionId: string;
  /** Live event log (usually `useSessionEvents().events`). */
  events: SessionEvent[];
  /** The chat / primary pane shown beside the dock. */
  primary: ReactNode;
  /**
   * Built-in surfaces this host wants to expose. Omit for Changes, Files,
   * Terminal, Browser, and Desktop. Disabled surfaces remain behaviorally dormant.
   */
  surfaces?: readonly SandboxWorkspaceSurface[] | undefined;
  /** Host tabs injected BEFORE the workbench tabs (e.g. a "Run" landing tab). */
  leadingTabs?: WorkspaceTab[] | undefined;
  /** Host tabs injected AFTER the workbench tabs (e.g. a "Debug" tab). */
  trailingTabs?: WorkspaceTab[] | undefined;
  /** Override the pre-paint default tab (e.g. a host landing tab id). When
   *  omitted the workbench decides from the durable workspace capture. */
  initialTab?: string | undefined;
  onActiveTabChange?: ((activeTab: string) => void) | undefined;
  initialFilePath?: string | null | undefined;
  onFilePathChange?: ((path: string | null) => void) | undefined;
  /** Presentation-only filter for Files tree nodes and selected-file viewing. */
  isFileNodeVisible?: FileNodeVisibilityPredicate | undefined;
  /**
   * Host request to open a workspace file (and optional line) in Files. A new
   * `requestId` re-opens even the same path.
   */
  openFileRequest?:
    | {
        path: string;
        line?: number | null;
        requestId: number;
      }
    | null
    | undefined;
  initialBrowserSessionId?: string | null | undefined;
  onBrowserSessionIdChange?: ((browserSessionId: string | null) => void) | undefined;
  initialComputerSessionId?: string | null | undefined;
  onComputerSessionIdChange?: ((computerSessionId: string | null) => void) | undefined;
  /** Host-routed notifications (no toast dependency in the package). */
  onNotify?: ((notification: WorkspaceNotification) => void) | undefined;
  /** Alternate Browser frame transport for non-browser runtimes and deterministic tests. */
  browserWebSocketFactory?: BrowserFrameWebSocketFactory | undefined;
  /** Alternate Computer frame transport for non-browser runtimes and deterministic tests. */
  computerWebSocketFactory?: ComputerFrameWebSocketFactory | undefined;
  /** Host-owned setup page or store listing for attaching an existing Chrome profile. */
  browserExtensionSetupUrl?: string | undefined;
  /** Controlled collapsed state for hosts with their own dock toggle. */
  collapsed?: boolean | undefined;
  onCollapsedChange?: ((collapsed: boolean) => void) | undefined;
  /** Keep the dock's built-in collapse control with controlled collapsed state. */
  showCollapseControl?: boolean | undefined;
  /** Host navigation shown only in the phone workspace overlay header. */
  mobileLeadingControl?: ReactNode | undefined;
  autoSaveId?: string | undefined;
  defaultSize?: number | undefined;
  minSize?: number | undefined;
  maxSize?: number | undefined;
  className?: string | undefined;
};

/**
 * The whole session workspace, ready to mount: `<SandboxWorkspace>` assembles the
 * capability-gated tabs, pins the machine-state chip in the dock header, and
 * renders the resizable `<WorkspaceDock>`. Wrap the tree in `<OpenGeniProvider>`
 * (client + workspaceId) and import `@opengeni/react/compiled.css`; that is the
 * entire integration (see `docs/embedding-workbench.md`).
 */
export function SandboxWorkspace(props: SandboxWorkspaceProps): ReactNode {
  const {
    sessionId,
    events,
    primary,
    surfaces,
    leadingTabs,
    trailingTabs,
    initialTab,
    onActiveTabChange,
    initialFilePath,
    onFilePathChange,
    isFileNodeVisible,
    openFileRequest,
    initialBrowserSessionId,
    onBrowserSessionIdChange,
    initialComputerSessionId,
    onComputerSessionIdChange,
    onNotify,
    browserWebSocketFactory,
    computerWebSocketFactory,
    browserExtensionSetupUrl,
    collapsed,
    onCollapsedChange,
    showCollapseControl,
    mobileLeadingControl,
    autoSaveId,
    defaultSize,
    minSize,
    maxSize,
    className,
  } = props;

  const [storedSelection, setStoredSelection] = useState<{
    sessionId: string;
    tab: string;
  } | null>(null);
  const [requestedFile, setRequestedFile] = useState<{
    sessionId: string;
    path: string;
    line: number | null;
    requestId: number;
  } | null>(null);
  const [requestedComputer, setRequestedComputer] = useState<{
    sessionId: string;
    computerSessionId: string;
    requestId: number;
  } | null>(null);
  const nextFileRequestId = useRef(0);
  const nextComputerRequestId = useRef(0);
  const selectedTab = storedSelection?.sessionId === sessionId ? storedSelection.tab : null;
  const activeTabHint = selectedTab ?? initialTab ?? leadingTabs?.[0]?.id ?? null;
  const openFile = useCallback(
    (path: string, line?: number | null) => {
      setRequestedFile({
        sessionId,
        path,
        line: line != null && line > 0 ? line : null,
        requestId: ++nextFileRequestId.current,
      });
      setStoredSelection({ sessionId, tab: WORKBENCH_TAB_FILES });
      onActiveTabChange?.(WORKBENCH_TAB_FILES);
      onFilePathChange?.(path);
      onCollapsedChange?.(false);
    },
    [onActiveTabChange, onCollapsedChange, onFilePathChange, sessionId],
  );
  const handledOpenFileRequestId = useRef<number | null>(null);
  useEffect(() => {
    if (!openFileRequest) return;
    if (handledOpenFileRequestId.current === openFileRequest.requestId) return;
    handledOpenFileRequestId.current = openFileRequest.requestId;
    openFile(openFileRequest.path, openFileRequest.line);
  }, [openFile, openFileRequest]);
  const openComputer = useCallback(
    (computerSessionId: string) => {
      nextComputerRequestId.current += 1;
      setRequestedComputer({
        sessionId,
        computerSessionId,
        requestId: nextComputerRequestId.current,
      });
      setStoredSelection({ sessionId, tab: WORKBENCH_TAB_DESKTOP });
      onActiveTabChange?.(WORKBENCH_TAB_DESKTOP);
      onComputerSessionIdChange?.(computerSessionId);
    },
    [onActiveTabChange, onComputerSessionIdChange, sessionId],
  );

  const {
    tabs: workbenchTabs,
    machine,
    defaultTab,
  } = useSandboxWorkspaceTabs({
    ...(props.client ? { client: props.client } : {}),
    ...(props.workspaceId ? { workspaceId: props.workspaceId } : {}),
    sessionId,
    events,
    ...(surfaces ? { surfaces } : {}),
    ...(initialTab ? { initialTab } : {}),
    activeTab: activeTabHint,
    workspaceVisible: collapsed !== true,
    ...(onNotify ? { onNotify } : {}),
    ...(browserWebSocketFactory ? { browserWebSocketFactory } : {}),
    ...(computerWebSocketFactory ? { computerWebSocketFactory } : {}),
    ...(browserExtensionSetupUrl ? { browserExtensionSetupUrl } : {}),
    initialFilePath,
    onFilePathChange,
    isFileNodeVisible,
    initialBrowserSessionId,
    onBrowserSessionIdChange,
    initialComputerSessionId,
    onComputerSessionIdChange,
    requestedFilePath: requestedFile?.sessionId === sessionId ? requestedFile.path : null,
    requestedFileRequestId: requestedFile?.sessionId === sessionId ? requestedFile.requestId : null,
    requestedFileLine: requestedFile?.sessionId === sessionId ? requestedFile.line : null,
    onOpenFile: openFile,
    onOpenComputerSession: openComputer,
    requestedComputerSessionId:
      requestedComputer?.sessionId === sessionId ? requestedComputer.computerSessionId : null,
    requestedComputerRequestId:
      requestedComputer?.sessionId === sessionId ? requestedComputer.requestId : null,
  });

  // A user's tab click wins forever; before that we follow the source-driven
  // default. While it is still resolving (null, pure-embedder pre-first-resolve)
  // we pass no controlled tab, so the dock renders its own first-tab fallback
  // (Changes) — whose body is a connecting/loading state until the capture lands,
  // so committing the real default at first-resolve produces no CONTENT switch.
  const tabs: WorkspaceTab[] = [...(leadingTabs ?? []), ...workbenchTabs, ...(trailingTabs ?? [])];
  const preferredTab = selectedTab ?? defaultTab;
  const activeTab =
    preferredTab && tabs.some((tab) => tab.id === preferredTab) ? preferredTab : tabs[0]?.id;
  const selectTab = useCallback(
    (tab: string) => {
      setStoredSelection({ sessionId, tab });
      onActiveTabChange?.(tab);
    },
    [onActiveTabChange, sessionId],
  );
  useEffect(() => {
    if (selectedTab !== null || defaultTab === null) return;
    // Once the source-driven choice resolves, make it the real controlled
    // selection. Without this handoff the dock could visibly show Files while
    // the data hooks continued treating the selection as unresolved.
    setStoredSelection({ sessionId, tab: defaultTab });
  }, [defaultTab, selectedTab, sessionId]);

  return (
    <WorkspaceDock
      primary={primary}
      tabs={tabs}
      {...(activeTab !== undefined ? { activeTab } : {})}
      onActiveTabChange={selectTab}
      {...(machine.enabled
        ? {
            headerAccessory: <MachineStateChip chip={machine.chip} />,
          }
        : {})}
      {...(mobileLeadingControl !== undefined ? { mobileLeadingControl } : {})}
      {...(collapsed !== undefined ? { collapsed } : {})}
      {...(onCollapsedChange ? { onCollapsedChange } : {})}
      {...(showCollapseControl !== undefined ? { showCollapseControl } : {})}
      {...(autoSaveId !== undefined ? { autoSaveId } : {})}
      {...(defaultSize !== undefined ? { defaultSize } : {})}
      {...(minSize !== undefined ? { minSize } : {})}
      {...(maxSize !== undefined ? { maxSize } : {})}
      {...(className !== undefined ? { className } : {})}
    />
  );
}

// Re-export the dock so an embedder can grab the shell type off one import.
export type { WorkspaceDockProps };

function DirtyBadge({ count }: { count: number }) {
  return (
    <span className="rounded-og-xs bg-og-accent-soft px-1 text-og-xs text-og-fg-muted">
      {count}
    </span>
  );
}

function chipDotClass(state: MachineChip["state"]): string {
  if (state === "live") return "bg-og-status-running";
  if (state === "waking") return "bg-og-status-idle animate-pulse motion-reduce:animate-none";
  return "bg-og-fg-subtle";
}

/**
 * The dock-header machine status: one quiet, truthful live/waking/resting
 * indicator. It is intentionally not interactive; detailed machine controls do
 * not belong in a transient popover above the workspace tabs.
 */
function MachineStateChip({ chip }: { chip: MachineChip }) {
  return (
    <div
      role="status"
      aria-label={`Machine: ${chip.label}`}
      className="inline-flex min-h-7 min-w-0 items-center gap-1.5 px-2 py-1 text-og-xs font-medium text-og-fg-muted max-[1023px]:min-h-11 pointer-coarse:min-h-11"
    >
      <span
        className={cn("size-1.5 shrink-0 rounded-full", chipDotClass(chip.state))}
        aria-hidden
      />
      <span className="min-w-0 max-w-[11rem] truncate">{chip.label}</span>
    </div>
  );
}

/** A minimal token-styled action button (the package has no app Button import). */
function DockActionButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-og-sm border border-og-border px-2 py-1 text-og-xs font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent max-[1023px]:min-h-11 pointer-coarse:min-h-11"
    >
      {children}
    </button>
  );
}

/**
 * The Changes tab body: the real PR-review surface (`WorkbenchChanges` — file
 * rail + windowed Pierre diff pane) when there are changes, wrapped in the honest
 * connecting/offline/empty states so the default tab is never a blank surface.
 * The dock frame is untouched; this is the M5 seam.
 */
function ChangesTabBody({
  comparison,
  onComparisonChange,
  ...props
}: {
  comparison: SandboxGitComparison;
  onComparisonChange: (comparison: SandboxGitComparison) => void;
} & Parameters<typeof ChangesTabContent>[0]) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-og-border bg-og-surface-1 px-2 py-1.5">
        {(
          [
            ["branch", "Branch"],
            ["working", "Uncommitted"],
            ["staged", "Staged"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={comparison === value}
            onClick={() => onComparisonChange(value)}
            className={cn(
              "rounded-og-sm px-2 py-1 text-og-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent max-[1023px]:min-h-11 pointer-coarse:min-h-11",
              comparison === value
                ? "bg-og-surface-2 text-og-fg shadow-sm"
                : "text-og-fg-muted hover:bg-og-surface-2 hover:text-og-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <ChangesTabContent comparison={comparison} {...props} />
      </div>
    </div>
  );
}

function ChangesTabContent({
  git,
  comparison,
  captureAvailable,
  captureRevision,
  capturePending,
  liveWorkspaceExpected,
  workspaceWaking,
  capabilitiesState,
  capabilitiesError,
  onRetry,
  onWake,
  onOpenFile,
}: {
  git: UseSandboxGitResult;
  comparison: SandboxGitComparison;
  captureAvailable: boolean;
  captureRevision: number | null;
  capturePending: boolean;
  liveWorkspaceExpected: boolean;
  workspaceWaking: boolean;
  capabilitiesState: string;
  capabilitiesError: Error | null;
  onRetry: () => void;
  onWake: () => void;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const diff = git.diff;

  if (diff.length > 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {git.error ? (
          <div
            role="status"
            aria-live="polite"
            data-opengeni-changes-degraded
            className="flex shrink-0 items-center gap-2 border-b border-og-status-running/30 bg-og-status-running/10 px-2 py-1.5 text-og-xs text-og-fg-muted"
          >
            <TriangleAlertIcon className="size-3.5 shrink-0 text-og-status-running" aria-hidden />
            <span className="min-w-0 flex-1">
              {git.source === "capture"
                ? "Live changes are temporarily unavailable. Showing the latest captured revision."
                : "Live refresh failed. Showing the last loaded changes."}
            </span>
            <button
              type="button"
              onClick={() => void git.refresh()}
              disabled={git.loading}
              className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-og-sm border border-og-border bg-og-surface-1 px-2 font-medium text-og-fg transition-colors hover:border-og-border-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11"
            >
              <RefreshCwIcon
                className={cn("size-3", git.loading && "animate-spin motion-reduce:animate-none")}
                aria-hidden
              />
              Retry
            </button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          <WorkbenchChanges
            diff={diff}
            source={git.source}
            capturedAt={git.capturedAt}
            captureRevision={captureRevision}
            {...(onOpenFile ? { onOpenFile } : {})}
          />
        </div>
      </div>
    );
  }

  if (capabilitiesError && !captureAvailable) {
    return (
      <CenteredState icon={<TriangleAlertIcon className="size-5" aria-hidden />} tone="danger">
        <p className="text-og-sm font-medium text-og-fg">Sandbox unavailable</p>
        <p data-contrast-audited className="text-og-sm leading-5 text-og-fg-muted">
          {capabilitiesError.message || "Couldn't reach the sandbox for this session."}
        </p>
        <DockActionButton onClick={onRetry}>
          <RefreshCwIcon className="size-3" />
          Retry
        </DockActionButton>
      </CenteredState>
    );
  }

  if (
    (capturePending || capabilitiesState === "negotiating") &&
    !captureAvailable &&
    !workspaceWaking
  ) {
    return (
      <CenteredState
        icon={
          <LoaderCircleIcon
            className="size-5 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
        }
      >
        <p className="text-og-sm font-medium text-og-fg">Connecting workspace</p>
        <p className="text-og-sm leading-5 text-og-fg-subtle">
          Looking for the latest files and changes…
        </p>
      </CenteredState>
    );
  }

  if (!liveWorkspaceExpected && (comparison !== "working" || !captureAvailable)) {
    return (
      <CenteredState
        icon={
          workspaceWaking ? (
            <LoaderCircleIcon
              className="size-5 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            <CpuIcon className="size-5" aria-hidden />
          )
        }
      >
        <p className="text-og-sm font-medium text-og-fg">
          {workspaceWaking ? "Waking workspace" : "Workspace is resting"}
        </p>
        <p className="text-og-sm leading-5 text-og-fg-subtle">
          {workspaceWaking
            ? "Connecting to the live working tree…"
            : comparison === "branch"
              ? "Wake the sandbox to compare this branch with the remote default branch."
              : comparison === "staged"
                ? "Wake the sandbox to inspect staged changes."
                : "No captured revision is available yet. Wake the sandbox to inspect uncommitted changes."}
        </p>
        {!workspaceWaking ? (
          <DockActionButton onClick={onWake}>
            <CpuIcon className="size-3" />
            Open live workspace
          </DockActionButton>
        ) : null}
      </CenteredState>
    );
  }

  if (git.loading && git.source === null) {
    return (
      <CenteredState
        icon={
          <LoaderCircleIcon
            className="size-5 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
        }
      >
        <p className="text-og-sm font-medium text-og-fg">Loading workspace</p>
        <p className="text-og-sm leading-5 text-og-fg-subtle">Reading the current working tree…</p>
      </CenteredState>
    );
  }

  return (
    <CenteredState icon={<CircleCheckIcon className="size-5" aria-hidden />} tone="success">
      <p className="text-og-sm font-medium text-og-fg">
        {comparison === "branch"
          ? "No branch changes"
          : comparison === "staged"
            ? "No staged changes"
            : "No uncommitted changes"}
      </p>
      <p className="text-og-sm leading-5 text-og-fg-subtle">
        {comparison === "branch"
          ? "This branch matches the remote default branch."
          : comparison === "staged"
            ? "Stage files to review the next commit here."
            : "Local edits not yet committed will appear here."}
      </p>
    </CenteredState>
  );
}

function CenteredState({
  children,
  icon,
  tone = "neutral",
}: {
  children: ReactNode;
  icon?: ReactNode | undefined;
  tone?: "neutral" | "success" | "danger";
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      aria-atomic="true"
      aria-live={tone === "danger" ? "assertive" : "polite"}
      className="grid h-full place-items-center p-6 text-center"
    >
      <div className="flex max-w-sm flex-col items-center gap-2.5">
        {icon ? (
          <span
            className={cn(
              "grid size-10 place-items-center rounded-og-lg border bg-og-surface-1 shadow-sm",
              tone === "success" && "border-og-status-idle/30 text-og-status-idle",
              tone === "danger" && "border-og-status-failed/30 text-og-status-failed",
              tone === "neutral" && "border-og-border text-og-fg-muted",
            )}
          >
            {icon}
          </span>
        ) : null}
        {children}
      </div>
    </div>
  );
}
