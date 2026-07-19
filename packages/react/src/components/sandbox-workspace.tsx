// The sandbox workbench — the SDK-embeddable dock "brain" (Workbench v2, M4).
//
// This module owns the whole session workspace surface an embedder mounts:
//   Changes  — review-first git: turn-end capture (cold) or live diff (warm)
//   Files    — tree + inline editor (capture-backed cold, live warm)
//   Terminal — interactive xterm wired to the box PTY (Channel-A projection)
//   Desktop  — noVNC (Channel-B), watch by default + a server-gated take-control
// plus a machine-state chip in the dock header (the one truthful live/waking/
// offline indicator) and any host-injected extra tabs (Run/Debug in apps/web).
//
// It is decoupled from the host app: the client comes from <OpenGeniProvider>
// (never an app context), notifications flow through an optional `onNotify` prop
// (no `sonner` import), and every surface renders with package primitives + og
// tokens only. `apps/web` consumes this through the exact public surface an
// external embedder (cloudgeni #1577) uses — that is criterion F1.
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import type { SessionEvent } from "@opengeni/sdk";
import {
  CircleCheckIcon,
  CpuIcon,
  LaptopIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { type ClientOverride, useOpenGeni } from "../provider";
import { cn } from "../lib/cn";
import { xtermThemeFromTokens } from "../lib/xterm-theme";
import { usePortalTokenStyle } from "../lib/use-portal-token-style";
import { useSessionCapabilities } from "../hooks/use-session-capabilities";
import { useSandboxFiles } from "../hooks/use-sandbox-files";
import { useSandboxGit, type UseSandboxGitResult } from "../hooks/use-sandbox-git";
import { useSandboxTerminal } from "../hooks/use-sandbox-terminal";
import { useWorkspaceCapture } from "../hooks/use-workspace-capture";
import { formatAsOf, useMachineChip, type MachineChip } from "../hooks/use-machine-chip";
import { useMachines } from "../hooks/use-machines";
import type { MachineView } from "../types/machines";
import { connectionStatusForState } from "../types/machines";
import { ConnectionStatusPill } from "./machine-status-pill";
import { SharedMachineDisclosure } from "./machine-dock-bar";
import { SandboxFiles } from "./sandbox-files";
import { WorkbenchChanges } from "./workbench-changes";
import { SandboxTerminal, type XtermTheme } from "./sandbox-terminal";
import { DesktopViewer } from "./desktop-viewer";
import { WorkspaceDock, type WorkspaceDockProps, type WorkspaceTab } from "./workspace-dock";

/** A host-routed notification (replaces the app-only `sonner` toast coupling). */
export type WorkspaceNotification = { kind: "error" | "info"; message: string };

/** The workbench's canonical tab ids (a host injects extras around these). */
export const WORKBENCH_TAB_CHANGES = "changes";
export const WORKBENCH_TAB_FILES = "files";

function captureDegradedMessage(reason: string): string {
  switch (reason) {
    case "repository_discovery_timed_out":
      return "Workspace capture is incomplete because repository discovery timed out. Live files remain authoritative.";
    case "repository_discovery_result_limit_exceeded":
      return "Workspace capture is incomplete because the repository limit was exceeded. Live files remain authoritative.";
    default:
      return "Workspace capture is incomplete because repository discovery failed. Live files remain authoritative.";
  }
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
  return bestFileCount > 0 ? WORKBENCH_TAB_CHANGES : WORKBENCH_TAB_FILES;
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

export type WorkspaceMachine = {
  /** The derived live/waking/offline chip model (dossier §3 #10). */
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
  /** Override the source-driven default tab (e.g. a host landing tab id). When
   *  omitted the workbench picks Changes-vs-Files from capture or live Git. */
  initialTab?: string | null | undefined;
  /** Host-routed notifications (mutation errors, desktop-consent failures). The
   *  package never imports a toast library — the host decides how to surface. */
  onNotify?: ((notification: WorkspaceNotification) => void) | undefined;
  /** File requested by a Changes guard. The Files surface defers the read until
   *  the sandbox is live, then reveals this path. */
  requestedFilePath?: string | null | undefined;
  /** Unique identity for `requestedFilePath`, including repeated requests for the
   *  same path. */
  requestedFileRequestId?: string | number | null | undefined;
  /** Route a guarded diff into the host's Files tab. */
  onOpenFile?: ((path: string) => void) | undefined;
};

export type UseSandboxWorkspaceTabsResult = {
  /** Changes | Files | Terminal | Desktop (capability-gated where noted). */
  tabs: WorkspaceTab[];
  /** The source-driven default tab: Changes when the first authoritative capture
   *  or live Git result has changes, else Files (a host `initialTab` overrides).
   *  null while that source resolves; the choice latches once. */
  defaultTab: string | null;
  /** The machine-state model for the dock-header chip. */
  machine: WorkspaceMachine;
};

type SessionWarmIntents = {
  sessionId: string;
  watchDesktop: boolean;
  warmTerminal: boolean;
  warmFiles: boolean;
};

function emptyWarmIntents(sessionId: string): SessionWarmIntents {
  return {
    sessionId,
    watchDesktop: false,
    warmTerminal: false,
    warmFiles: false,
  };
}

/**
 * Build the workbench tabs + the machine-chip model for one session. This is the
 * dock "brain": capability negotiation, capture-backed cold reads, prewarm
 * flags, desktop consent, and the xterm theme observer — all package-local.
 */
export function useSandboxWorkspaceTabs(
  options: UseSandboxWorkspaceTabsOptions,
): UseSandboxWorkspaceTabsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const { sessionId, events, onNotify, requestedFilePath, requestedFileRequestId, onOpenFile } =
    options;
  const initialTab = options.initialTab ?? null;

  // The three box-warming INTENTS, each off by default and each
  // flipped true by a genuine user action (never on mount, never on a passive
  // capture glance): desktop watch consent, terminal engagement (`onActivate`), and
  // a deliberate live-file open/edit in Files. Browsing capture-served
  // Changes/Files warms nothing — that is the whole point of Refinement 1.
  const [storedWarmIntents, setStoredWarmIntents] = useState<SessionWarmIntents>(() =>
    emptyWarmIntents(sessionId),
  );
  const warmIntents =
    storedWarmIntents.sessionId === sessionId ? storedWarmIntents : emptyWarmIntents(sessionId);
  const { watchDesktop, warmTerminal, warmFiles } = warmIntents;
  const requestWarmIntent = useCallback(
    (intent: Exclude<keyof SessionWarmIntents, "sessionId">) => {
      setStoredWarmIntents((previous) => {
        const current = previous.sessionId === sessionId ? previous : emptyWarmIntents(sessionId);
        return current[intent] ? current : { ...current, [intent]: true };
      });
    },
    [sessionId],
  );

  // The session's machine fleet + the active-sandbox pointer. Drives the header
  // chip (which machine + its connection state). Polls slowly — ambient context.
  const machines = useMachines({
    workspaceId,
    sessionId,
    pollIntervalMs: 8000,
  });
  const activeMachine: MachineView | null =
    machines.machines.find((m) => m.sandboxId === machines.activeSandboxId) ??
    machines.machines.find((m) => m.active) ??
    null;

  const caps = useSessionCapabilities(sessionId, {
    events,
    attachDesktop: watchDesktop,
    attachTerminal: warmTerminal,
    // Explicit live-file intent only — NOT "the Files tab is open". A cold edit
    // or guarded-file open wakes the box; a glance at the tree/diff does not.
    attachFiles: warmFiles,
  });
  const capabilities = caps.capabilities;
  const liveness = capabilities?.liveness;
  const fileSystemOn = capabilities?.FileSystem.available ?? false;
  // The FS is writable only when it's live AND not read-only. A self-hosted box
  // that's offline (or any read-only advertisement) or a capture-served cold tree
  // must not offer create/rename/delete/edit affordances — you cannot mutate a
  // machine you can't reach (dossier §12-A2/C3). Tree-structure ops need a warm
  // writable box; content editing on a cold CLOUD box is the wake-on-edit path in
  // the editor, not tree mutation.
  const fsReadOnly = capabilities?.FileSystem.readOnly ?? false;
  // Mutations are live-only. A capture is a review artifact, never a writable
  // surrogate for a sleeping machine; the user must deliberately open the live
  // workspace before create/rename/delete/edit controls appear.
  const filesEditable =
    fileSystemOn && !fsReadOnly && (liveness === "warm" || liveness === "draining");
  const gitOn = capabilities?.Git.available ?? false;
  const terminalOn = (capabilities?.Terminal.transport ?? null) !== null;
  // The REAL interactive terminal is the ttyd pty-ws stream. When it's live the
  // legacy HTTP PTY must NOT run; `useSandboxTerminal` opens its HTTP PTY only as
  // the firehose-mode fallback (a backend without ttyd).
  const ptyWsLive =
    capabilities?.Terminal.transport === "pty-ws" && Boolean(capabilities?.Terminal.url);
  const ptyCapable = (capabilities?.Terminal.ptyCapable ?? false) && !ptyWsLive;
  const terminal = useSandboxTerminal(sessionId, {
    events,
    interactive: ptyCapable,
    liveness,
  });
  const desktopAdvertised =
    (capabilities?.DesktopStream.transport ?? null) !== null ||
    capabilities?.DesktopStream.reason === "lease_cold";

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

  // The cold-paint data source: the latest turn-end capture, fetched with a single
  // api round-trip on mount (no machine). Feeds the Files tree + the Changes/Git
  // diff when the box is not warm; a warm box always wins (live path unchanged).
  const captureState = useWorkspaceCapture(sessionId, { events });
  const captureAvailable = captureState.available;
  const liveWorkspaceExpected = liveness === "warm" || liveness === "draining";
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
    enabled: captureAvailable || (fileSystemOn && liveWorkspaceExpected),
    liveness,
    capture: captureState.capture,
    // A reverted optimistic mutation (e.g. a 409 rename collision) surfaces as a
    // host notification — the tree silently rolls back, the user sees why.
    onMutationError: (error, op) =>
      onNotify?.({
        kind: "error",
        message: `Could not ${op}: ${error.message}`,
      }),
  });
  const git = useSandboxGit(sessionId, {
    events,
    enabled: captureAvailable || (gitOn && liveWorkspaceExpected),
    repoPaths,
    liveness,
    capture: captureState.capture,
  });
  const stagedGit = useSandboxGit(sessionId, {
    events,
    // Captures intentionally expose one combined review diff, not a staged
    // index. Never probe the live index while the lease is cold.
    enabled: gitOn && liveWorkspaceExpected,
    staged: true,
    repoPaths,
    liveness,
    capture: captureState.capture,
  });

  // Token-derived xterm theme; re-derive on a `data-og-theme` flip. Generic — it
  // belongs in the package (an embedder's theme toggle drives it too).
  const [xtermTheme, setXtermTheme] = useState<XtermTheme | undefined>(undefined);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const derive = () => setXtermTheme(xtermThemeFromTokens());
    derive();
    const observer = new MutationObserver(derive);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-og-theme", "class"],
    });
    return () => observer.disconnect();
  }, []);

  async function acknowledgeAndWatch() {
    try {
      const shared = capabilities?.DesktopStream.shared ?? false;
      await client.acknowledgeStream(workspaceId, sessionId, {
        acknowledgeUnredacted: true,
        acknowledgeShared: shared,
      });
      requestWarmIntent("watchDesktop");
      caps.renegotiate();
    } catch (error) {
      onNotify?.({
        kind: "error",
        message: `Could not start the desktop stream: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // Re-warm WITHOUT re-acknowledging: the consent was already recorded, only the
  // box drained back to cold. Idempotent — the viewer auto-warm de-dupes.
  function rewarmDesktop() {
    if (!watchDesktop) requestWarmIntent("watchDesktop");
    caps.renegotiate();
  }

  const dirtyCount = git.diff.length;

  // The one truthful machine indicator, derived from the live capability/liveness
  // surface + the active machine's connection state + the latest capture time.
  const chip = useMachineChip({
    liveness,
    capabilitiesState: caps.state,
    activeMachineState: activeMachine?.state ?? null,
    activeIsSelfhosted: activeMachine?.kind === "selfhosted",
    wantsWarm: warmTerminal || watchDesktop || warmFiles,
    capturedAt: captureState.capturedAt,
  });
  const workspaceWaking = chip.state === "waking";

  // The pre-paint default tab is decided from the first AUTHORITATIVE workspace
  // source. A capture wins immediately on the cold/offline fast path; a warm box
  // waits for live Git so a prior snapshot can never outrank the current tree.
  // When the GET says no capture exists, `fileCount: 0` does NOT itself mean the
  // working tree is clean. A captured-revision announce can
  // resolve Changes earlier, but a pure embedder with no event preload still gets
  // the correct live default. The choice latches once so later edits never steal
  // the user's current tab.
  const defaultTabRef = useRef<{ sessionId: string; value: string | null }>({
    sessionId,
    value: null,
  });
  if (defaultTabRef.current.sessionId !== sessionId) {
    defaultTabRef.current = { sessionId, value: null };
  }
  const captureIsAuthoritative =
    !liveWorkspaceExpected && (liveness !== undefined || caps.error !== null);
  const captureUnavailable = captureState.fileCount === 0 || captureState.error !== null;
  if (defaultTabRef.current.value === null) {
    if (initialTab) {
      defaultTabRef.current.value = initialTab;
    } else if (git.source === "live") {
      defaultTabRef.current.value =
        git.diff.length > 0 ? WORKBENCH_TAB_CHANGES : WORKBENCH_TAB_FILES;
    } else if (
      captureIsAuthoritative &&
      captureState.fileCount !== null &&
      captureState.available
    ) {
      defaultTabRef.current.value =
        captureState.fileCount > 0 ? WORKBENCH_TAB_CHANGES : WORKBENCH_TAB_FILES;
    } else if (
      captureIsAuthoritative &&
      captureUnavailable &&
      initialWorkspaceTab(events) === WORKBENCH_TAB_CHANGES
    ) {
      defaultTabRef.current.value = WORKBENCH_TAB_CHANGES;
    } else if (captureUnavailable && caps.error) {
      // The Changes surface owns the truthful sandbox-unavailable state + retry.
      // Files would misleadingly describe this as a missing filesystem.
      defaultTabRef.current.value = WORKBENCH_TAB_CHANGES;
    } else if (captureIsAuthoritative && captureState.fileCount !== null && captureUnavailable) {
      // No durable review surface exists and the machine is resting. Files owns
      // the explicit wake gate; do not issue a live Git probe merely to choose a
      // tab.
      defaultTabRef.current.value = WORKBENCH_TAB_FILES;
    } else if (captureState.available && git.error && captureState.fileCount !== null) {
      // A warm live read failed but the durable capture is intact: retain an
      // immediate, deterministic review surface instead of hanging unresolved.
      defaultTabRef.current.value =
        captureState.fileCount > 0 ? WORKBENCH_TAB_CHANGES : WORKBENCH_TAB_FILES;
    } else if (captureUnavailable && git.error) {
      // No capture and live Git failed: Files is the least surprising fallback
      // and preserves the established no-capture degraded behavior.
      defaultTabRef.current.value = WORKBENCH_TAB_FILES;
    }
  }
  // null only during the brief pre-first-resolve window (no host override yet).
  const defaultTab = defaultTabRef.current.value;

  const tabs = useMemo(() => {
    const list: WorkspaceTab[] = [];

    // Changes — always present (capture-backed, works cold/offline). The default
    // primary surface. M5 replaces this body with the windowed diff renderer; the
    // seam is the `<ChangesTabBody>` element (this is the minimal placeholder).
    list.push({
      id: WORKBENCH_TAB_CHANGES,
      label: "Changes",
      badge: dirtyCount > 0 ? <DirtyBadge count={dirtyCount} /> : undefined,
      content: (
        <ChangesTabBody
          git={git}
          captureAvailable={captureAvailable}
          captureRevision={captureState.revision}
          capturePending={capturePending}
          liveWorkspaceExpected={liveWorkspaceExpected}
          workspaceWaking={workspaceWaking}
          capabilitiesState={caps.state}
          capabilitiesError={caps.error}
          onRetry={caps.renegotiate}
          onWake={() => requestWarmIntent("warmFiles")}
          {...(onOpenFile
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

    // Files — always present (capture-backed cold tree; live warm). M5 virtualizes.
    list.push({
      id: WORKBENCH_TAB_FILES,
      label: "Files",
      content: (
        <SandboxFiles
          key={sessionId}
          files={files}
          git={git}
          stagedGit={stagedGit}
          fileSystemAvailable={fileSystemOn || captureAvailable}
          editable={filesEditable}
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
                requestedPathReady: liveness === "warm" || liveness === "draining",
              }
            : {})}
          // Ordinary capture browsing does not warm a box. The first edit — or an
          // explicit guarded-file open from Changes — is deliberate live-file intent.
          onEditIntent={() => requestWarmIntent("warmFiles")}
          className="h-full"
        />
      ),
    });

    // Terminal — capability-gated (appears after negotiation; never the default).
    if (terminalOn) {
      list.push({
        id: "terminal",
        label: "Terminal",
        content: (
          <div className="h-full bg-og-bg p-1">
            <SandboxTerminal
              result={terminal}
              terminalCapability={capabilities?.Terminal ?? null}
              onActivate={() => requestWarmIntent("warmTerminal")}
              showHeader
              shell={capabilities?.Terminal.shell ?? undefined}
              liveness={liveness}
              {...(xtermTheme ? { theme: xtermTheme } : {})}
            />
          </div>
        ),
      });
    }

    // Desktop — capability-gated + consent-gated.
    if (desktopAdvertised) {
      list.push({
        id: "desktop",
        label: "Desktop",
        badge: watchDesktop ? (
          <span className="rounded-og-xs bg-og-status-running/20 px-1 text-og-xs text-og-status-running">
            Live
          </span>
        ) : undefined,
        content: (
          <DesktopViewer
            capability={capabilities?.DesktopStream ?? null}
            viewerCapReached={caps.viewerCapReached}
            watching={watchDesktop}
            onAcknowledge={() => void acknowledgeAndWatch()}
            onWarm={rewarmDesktop}
            className="h-full"
          />
        ),
      });
    }

    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fileSystemOn,
    terminalOn,
    desktopAdvertised,
    captureAvailable,
    dirtyCount,
    watchDesktop,
    warmTerminal,
    requestedFilePath,
    requestedFileRequestId,
    onOpenFile,
    liveness,
    sessionId,
    files,
    git,
    stagedGit,
    terminal,
    xtermTheme,
    capabilities,
    workspaceWaking,
    caps.state,
    caps.error,
    caps.viewerCapReached,
    requestWarmIntent,
  ]);

  return {
    tabs,
    defaultTab,
    machine: {
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
  /** Host tabs injected BEFORE the workbench tabs (e.g. a "Run" landing tab). */
  leadingTabs?: WorkspaceTab[] | undefined;
  /** Host tabs injected AFTER the workbench tabs (e.g. a "Debug" tab). */
  trailingTabs?: WorkspaceTab[] | undefined;
  /** Override the pre-paint default tab (e.g. a host landing tab id). When
   *  omitted the workbench decides from capture, then live Git when no capture exists. */
  initialTab?: string | undefined;
  /** Host-routed notifications (no toast dependency in the package). */
  onNotify?: ((notification: WorkspaceNotification) => void) | undefined;
  /** Controlled collapsed state for hosts with their own dock toggle. */
  collapsed?: boolean | undefined;
  onCollapsedChange?: ((collapsed: boolean) => void) | undefined;
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
 * (client + workspaceId) and import `@opengeni/react/styles.css`; that is the
 * entire integration (see `docs/embedding-workbench.md`).
 */
export function SandboxWorkspace(props: SandboxWorkspaceProps): ReactNode {
  const {
    sessionId,
    events,
    primary,
    leadingTabs,
    trailingTabs,
    initialTab,
    onNotify,
    collapsed,
    onCollapsedChange,
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
    requestId: number;
  } | null>(null);
  const nextFileRequestId = useRef(0);
  const openFile = useCallback(
    (path: string) => {
      nextFileRequestId.current += 1;
      setRequestedFile({ sessionId, path, requestId: nextFileRequestId.current });
      setStoredSelection({ sessionId, tab: WORKBENCH_TAB_FILES });
    },
    [sessionId],
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
    ...(initialTab ? { initialTab } : {}),
    ...(onNotify ? { onNotify } : {}),
    requestedFilePath: requestedFile?.sessionId === sessionId ? requestedFile.path : null,
    requestedFileRequestId: requestedFile?.sessionId === sessionId ? requestedFile.requestId : null,
    onOpenFile: openFile,
  });

  // A user's tab click wins forever; before that we follow the source-driven
  // default. While it is still resolving (null, pure-embedder pre-first-resolve)
  // we pass no controlled tab, so the dock renders its own first-tab fallback
  // (Changes) — whose body is a connecting/loading state until the capture lands,
  // so committing the real default at first-resolve produces no CONTENT switch.
  const tabs: WorkspaceTab[] = [...(leadingTabs ?? []), ...workbenchTabs, ...(trailingTabs ?? [])];
  const selectedTab = storedSelection?.sessionId === sessionId ? storedSelection.tab : null;
  const activeTab = selectedTab ?? defaultTab ?? tabs[0]?.id;
  const selectTab = useCallback(
    (tab: string) => setStoredSelection({ sessionId, tab }),
    [sessionId],
  );

  return (
    <WorkspaceDock
      primary={primary}
      tabs={tabs}
      {...(activeTab !== undefined ? { activeTab } : {})}
      onActiveTabChange={selectTab}
      headerAccessory={
        <MachineStateChip
          chip={machine.chip}
          activeMachine={machine.activeMachine}
          error={machine.error}
          onRetry={() => void machine.refresh()}
        />
      }
      {...(mobileLeadingControl !== undefined ? { mobileLeadingControl } : {})}
      {...(collapsed !== undefined ? { collapsed } : {})}
      {...(onCollapsedChange ? { onCollapsedChange } : {})}
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

/** A machine-kind glyph for the chip popover. */
function MachineKindIcon({
  kind,
  className,
}: {
  kind: MachineView["kind"] | undefined;
  className?: string;
}) {
  const Icon = kind === "selfhosted" ? LaptopIcon : CpuIcon;
  return <Icon className={cn("size-3.5 shrink-0 text-og-fg-subtle", className)} aria-hidden />;
}

function chipDotClass(state: MachineChip["state"]): string {
  if (state === "live") return "bg-og-status-running";
  if (state === "waking") return "bg-og-status-idle animate-pulse motion-reduce:animate-none";
  return "bg-og-fg-subtle";
}

/**
 * The dock-header machine chip: the one truthful live/waking/offline indicator,
 * with a popover carrying the machine identity, connection state, the "shown as
 * of <time>" staleness note, the shared-session disclosure, and a retry when the
 * fleet failed to resolve (the old per-surface machine bar + Sandbox info tab,
 * folded into one header affordance — dossier §10.6 recommendation).
 */
function MachineStateChip({
  chip,
  activeMachine,
  error,
  onRetry,
}: {
  chip: MachineChip;
  activeMachine: MachineView | null;
  error: Error | null;
  onRetry: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const portalStyle = usePortalTokenStyle(triggerRef);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={`Machine: ${chip.label}`}
          className="inline-flex min-h-7 items-center gap-1.5 rounded-og-sm px-2 py-1 text-og-xs font-medium text-og-fg-muted transition-colors hover:bg-og-surface-2 hover:text-og-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent max-[1023px]:min-h-11 pointer-coarse:min-h-11"
        >
          <span
            className={cn("size-1.5 shrink-0 rounded-full", chipDotClass(chip.state))}
            aria-hidden
          />
          <span className="max-w-[11rem] truncate">{chip.label}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal forceMount>
        <Popover.Content
          forceMount
          data-machine-state-popover
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="og-root z-50 w-64 max-w-[calc(100vw-1rem)] rounded-og-md border border-og-border bg-og-surface-1 p-3 text-og-sm text-og-fg shadow-lg outline-none"
          style={portalStyle}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <MachineKindIcon kind={activeMachine?.kind} />
            <span className="min-w-0 truncate font-medium">{activeMachine?.name ?? "Sandbox"}</span>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="text-og-xs text-og-fg-subtle">Connection</span>
            {activeMachine ? (
              <ConnectionStatusPill
                status={connectionStatusForState(activeMachine.state)}
                size="sm"
              />
            ) : (
              <span className="text-og-xs text-og-fg-muted">{chip.label}</span>
            )}
          </div>
          {chip.asOf ? (
            <p className="mt-2.5 text-og-xs leading-4 text-og-fg-subtle">
              Workspace shown as of {formatAsOf(chip.asOf, Date.now())} — the machine is not live.
            </p>
          ) : null}
          {activeMachine && activeMachine.sharedSessionCount > 1 ? (
            <div className="mt-2.5">
              <SharedMachineDisclosure
                sharedSessionCount={activeMachine.sharedSessionCount}
                density="full"
              />
            </div>
          ) : null}
          {error ? (
            <div className="mt-2.5 space-y-1.5 border-t border-og-border pt-2.5">
              <p className="text-og-xs leading-4 text-og-danger">
                Couldn't reach the sandbox for this session.
              </p>
              <DockActionButton onClick={onRetry}>
                <RefreshCwIcon className="size-3" />
                Retry
              </DockActionButton>
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A minimal token-styled action button (the package has no app Button import). */
function DockActionButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-og-sm border border-og-border px-2 py-1 text-og-xs font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:text-og-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent max-[1023px]:min-h-11 pointer-coarse:min-h-11"
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
  git,
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
      <WorkbenchChanges
        diff={diff}
        source={git.source}
        capturedAt={git.capturedAt}
        captureRevision={captureRevision}
        {...(onOpenFile ? { onOpenFile } : {})}
      />
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

  if (!liveWorkspaceExpected && !captureAvailable) {
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
            : "No captured revision is available yet. Wake the sandbox to inspect current changes."}
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
      <p className="text-og-sm font-medium text-og-fg">Working tree is clean</p>
      <p className="text-og-sm leading-5 text-og-fg-subtle">
        File edits from future turns will appear here.
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
