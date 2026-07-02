// The sandbox workbench — Phase 5 client surface. Beside the chat timeline, this
// panel surfaces the live sandbox via three capability-gated tabs:
//   Files    — review-first git: tree + changed-files + inline Pierre diff
//   Terminal — interactive xterm wired to the box PTY (Channel-A projection)
//   Desktop  — noVNC (Channel-B), watch by default + a server-gated take-control
// Every surface is GATED on the negotiated capability doc: we render only what
// THIS session+backend+OS advertises, and an unavailable surface degrades to a
// reason-aware notice — never a crash. This hook builds the `WorkspaceTab[]` the
// `WorkspaceDock` shell renders (the dock owns resize / collapse / maximize).
import {
  DesktopViewer,
  SandboxFiles,
  SandboxTerminal,
  useSandboxFiles,
  useSandboxGit,
  useSandboxTerminal,
  useSessionCapabilities,
  xtermThemeFromTokens,
  type WorkspaceTab,
  type XtermTheme,
} from "@opengeni/react";
import { MachineDockBar, SharedMachineDisclosure, useMachines, type MachineView } from "@opengeni/react/machines";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import type { SessionEvent } from "@/types";

/**
 * Build the capability-gated Workspace tabs (Files | Terminal | Desktop) plus a
 * sensible default. Returns `{ tabs, defaultTab }`; the caller feeds them to
 * `<WorkspaceDock>`.
 */
export function useSandboxWorkspaceTabs({
  workspaceId,
  sessionId,
  events,
  filesActive = false,
}: {
  workspaceId: string;
  sessionId: string;
  events: SessionEvent[];
  /** Whether the Files tab is the one on screen. Drives the warm-box viewer
   *  holder so Channel-A fs ops are ~100ms (warm) instead of ~5s (cold resume).
   *  Off ⇒ the Files surface negotiates read-only and lets the box drain. */
  filesActive?: boolean;
}): { tabs: WorkspaceTab[]; defaultTab: string } {
  const context = useAppContext();

  // Whether the user has opted into watching the desktop (drives the viewer
  // attach + the un-redacted acknowledgment). Off by default — the structured
  // surfaces (files/terminal) need no consent and no warm box.
  const [watchDesktop, setWatchDesktop] = useState(false);
  // Whether the user has engaged the terminal (focus/click). Off by default so a
  // cold box stays on the read-only firehose; flips true ON INTERACT to warm the
  // box for the REAL pty-ws terminal — never on mere mount. Shares the SAME viewer
  // attach as the desktop (one warm box serves both planes).
  const [warmTerminal, setWarmTerminal] = useState(false);

  // The session's machine fleet (the synthetic Modal group box + any enrolled
  // selfhosted machines), with the active-sandbox pointer. Drives the dock bar
  // (which machine these surfaces are bound to + its connection status) and the
  // shared "another session is on this machine" disclosure. Polls slowly — the
  // dock bar is ambient context, not a hot path.
  const machines = useMachines({ workspaceId, sessionId, pollIntervalMs: 8000 });
  const activeMachine: MachineView | null =
    machines.machines.find((m) => m.sandboxId === machines.activeSandboxId) ??
    machines.machines.find((m) => m.active) ??
    null;

  const caps = useSessionCapabilities(sessionId, {
    events,
    attachDesktop: watchDesktop,
    attachTerminal: warmTerminal,
    // Keep the box warm while the Files tab is on screen — one shared viewer
    // holder (no consent needed) so fs list/read/write/move are fast, not a cold
    // ~5s resume per op. Releases when the user leaves the tab (box drains).
    attachFiles: filesActive,
  });
  const capabilities = caps.capabilities;
  const fileSystemOn = capabilities?.FileSystem.available ?? false;
  const gitOn = capabilities?.Git.available ?? false;
  const terminalOn = (capabilities?.Terminal.transport ?? null) !== null;
  // The REAL interactive terminal is the ttyd pty-ws stream (driven inside
  // SandboxTerminal from the Terminal cell). When that's live, the broken legacy
  // ptyOpen/ptyWrite-over-HTTP path must NOT run — the ttyd socket owns stdin. So
  // `useSandboxTerminal` opens its HTTP PTY ONLY as the firehose-mode fallback
  // (transport still sse-events, e.g. a backend without ttyd). Once `pty-ws` is
  // advertised we keep the projection read-only (it just feeds the cold firehose
  // until the socket takes over).
  const ptyWsLive = capabilities?.Terminal.transport === "pty-ws" && Boolean(capabilities?.Terminal.url);
  const ptyCapable = (capabilities?.Terminal.ptyCapable ?? false) && !ptyWsLive;
  const terminal = useSandboxTerminal(sessionId, { events, interactive: ptyCapable, liveness: capabilities?.liveness });
  const desktopAdvertised =
    (capabilities?.DesktopStream.transport ?? null) !== null ||
    capabilities?.DesktopStream.reason === "lease_cold";

  const files = useSandboxFiles(sessionId, {
    events,
    enabled: fileSystemOn,
    liveness: capabilities?.liveness,
    // Surface a reverted optimistic mutation (e.g. a 409 rename collision) as a
    // toast — the tree silently rolls back, the user sees why.
    onMutationError: (error, op) =>
      toast.error(`Could not ${op}`, {
        description: error.message,
      }),
  });
  const git = useSandboxGit(sessionId, { events, enabled: gitOn });
  const stagedGit = useSandboxGit(sessionId, { events, enabled: gitOn, staged: true });

  // Token-derived xterm theme; re-derive on a data-og-theme flip.
  const [xtermTheme, setXtermTheme] = useState<XtermTheme | undefined>(undefined);
  useEffect(() => {
    const derive = () => setXtermTheme(xtermThemeFromTokens());
    derive();
    const observer = new MutationObserver(derive);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-og-theme", "class"] });
    return () => observer.disconnect();
  }, []);

  async function acknowledgeAndWatch() {
    try {
      const shared = capabilities?.DesktopStream.shared ?? false;
      await context.client.acknowledgeStream(workspaceId, sessionId, {
        acknowledgeUnredacted: true,
        acknowledgeShared: shared,
      });
      setWatchDesktop(true);
      caps.renegotiate();
    } catch (error) {
      toast.error("Could not start the desktop stream", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Re-warm WITHOUT re-acknowledging: the consent was already recorded, only the
  // box drained back to cold. Engage the viewer attach + re-negotiate so the
  // sandbox warms again. Idempotent — the viewer auto-warm de-dupes per episode.
  function rewarmDesktop() {
    if (!watchDesktop) setWatchDesktop(true);
    caps.renegotiate();
  }

  const dirtyCount = git.diff.length;

  return useMemo(() => {
    const tabs: WorkspaceTab[] = [];

    // Wrap a surface with the machine dock bar (which machine these surfaces are
    // bound to + its connection-status pill) and, when shared, the disclosure.
    // The bar is the ONLY backend-aware chrome — Files/Terminal/Desktop below it
    // render IDENTICALLY whether the active sandbox is the Modal box or a
    // selfhosted machine (the dock-parity contract). Omitted only when the fleet
    // hasn't resolved an active machine yet (graceful, never a crash).
    const withMachineBar = (surface: ReactNode): ReactNode => {
      if (!activeMachine) return surface;
      return (
        <div className="flex h-full min-h-0 flex-col">
          <MachineDockBar
            name={activeMachine.name}
            kind={activeMachine.kind}
            state={activeMachine.state}
            sharedSessionCount={activeMachine.sharedSessionCount}
          />
          {activeMachine.sharedSessionCount > 1 ? (
            <SharedMachineDisclosure sharedSessionCount={activeMachine.sharedSessionCount} />
          ) : null}
          <div className="min-h-0 flex-1">{surface}</div>
        </div>
      );
    };

    if (fileSystemOn) {
      tabs.push({
        id: "files",
        label: "Files",
        badge:
          dirtyCount > 0 ? (
            <span className="rounded-[var(--og-radius-xs,3px)] bg-og-accent-soft px-1 text-2xs text-og-fg-muted">
              {dirtyCount}
            </span>
          ) : undefined,
        content: withMachineBar(
          <SandboxFiles
            files={files}
            git={git}
            stagedGit={stagedGit}
            fileSystemAvailable={fileSystemOn}
            className="h-full"
          />,
        ),
      });
    }

    if (terminalOn) {
      tabs.push({
        id: "terminal",
        label: "Terminal",
        content: withMachineBar(
          <div className="h-full bg-og-bg p-1">
            <SandboxTerminal
              result={terminal}
              terminalCapability={capabilities?.Terminal ?? null}
              onActivate={() => setWarmTerminal(true)}
              showHeader
              shell={capabilities?.Terminal.shell ?? undefined}
              {...(xtermTheme ? { theme: xtermTheme } : {})}
            />
          </div>,
        ),
      });
    }

    if (desktopAdvertised) {
      tabs.push({
        id: "desktop",
        label: "Desktop",
        badge: watchDesktop ? (
          <span className="rounded-[var(--og-radius-xs,3px)] bg-og-status-running/20 px-1 text-2xs text-og-status-running">
            live
          </span>
        ) : undefined,
        content: withMachineBar(
          <DesktopViewer
            capability={capabilities?.DesktopStream ?? null}
            viewerCapReached={caps.viewerCapReached}
            watching={watchDesktop}
            onAcknowledge={() => void acknowledgeAndWatch()}
            onWarm={rewarmDesktop}
            className="h-full"
          />,
        ),
      });
    }

    const defaultTab = tabs[0]?.id ?? "files";
    return { tabs, defaultTab };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fileSystemOn,
    terminalOn,
    desktopAdvertised,
    dirtyCount,
    watchDesktop,
    warmTerminal,
    files,
    git,
    stagedGit,
    terminal,
    xtermTheme,
    capabilities,
    caps.viewerCapReached,
    activeMachine,
  ]);
}
