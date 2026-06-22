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
import { useEffect, useMemo, useState } from "react";
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
}: {
  workspaceId: string;
  sessionId: string;
  events: SessionEvent[];
}): { tabs: WorkspaceTab[]; defaultTab: string } {
  const context = useAppContext();

  // Whether the user has opted into watching the desktop (drives the viewer
  // attach + the un-redacted acknowledgment). Off by default — the structured
  // surfaces (files/terminal) need no consent and no warm box.
  const [watchDesktop, setWatchDesktop] = useState(false);

  const caps = useSessionCapabilities(sessionId, { events, attachDesktop: watchDesktop });
  const capabilities = caps.capabilities;
  const fileSystemOn = capabilities?.FileSystem.available ?? false;
  const gitOn = capabilities?.Git.available ?? false;
  const terminalOn = (capabilities?.Terminal.transport ?? null) !== null;
  // Open a real interactive PTY against the box once the backend advertises one
  // (pty-capable). This is what makes the terminal typeable rather than a
  // read-only firehose: the open spins/resumes the box and its output rides SSE.
  const ptyCapable = capabilities?.Terminal.ptyCapable ?? false;
  const terminal = useSandboxTerminal(sessionId, { events, interactive: ptyCapable });
  const desktopAdvertised =
    (capabilities?.DesktopStream.transport ?? null) !== null ||
    capabilities?.DesktopStream.reason === "lease_cold";

  const files = useSandboxFiles(sessionId, { events, enabled: fileSystemOn, liveness: capabilities?.liveness });
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

  const dirtyCount = git.diff.length;

  return useMemo(() => {
    const tabs: WorkspaceTab[] = [];

    if (fileSystemOn) {
      tabs.push({
        id: "files",
        label: "Files",
        badge:
          dirtyCount > 0 ? (
            <span className="rounded-[var(--og-radius-xs,3px)] bg-[color:var(--og-color-accent-soft,#2a2a2a)] px-1 text-[9px] text-[color:var(--og-color-fg-muted,#aaa)]">
              {dirtyCount}
            </span>
          ) : undefined,
        content: (
          <SandboxFiles
            files={files}
            git={git}
            stagedGit={stagedGit}
            fileSystemAvailable={fileSystemOn}
            className="h-full"
          />
        ),
      });
    }

    if (terminalOn) {
      tabs.push({
        id: "terminal",
        label: "Terminal",
        content: (
          <div className="h-full bg-[color:var(--og-color-bg,var(--color-bg))] p-1">
            <SandboxTerminal
              result={terminal}
              showHeader
              shell={capabilities?.Terminal.shell ?? undefined}
              {...(xtermTheme ? { theme: xtermTheme } : {})}
            />
          </div>
        ),
      });
    }

    if (desktopAdvertised) {
      tabs.push({
        id: "desktop",
        label: "Desktop",
        badge: watchDesktop ? (
          <span className="rounded-[var(--og-radius-xs,3px)] bg-[color:var(--og-color-status-running,#d29922)]/20 px-1 text-[9px] text-[color:var(--og-color-status-running,#d29922)]">
            live
          </span>
        ) : undefined,
        content: (
          <DesktopViewer
            capability={capabilities?.DesktopStream ?? null}
            viewerCapReached={caps.viewerCapReached}
            onAcknowledge={() => void acknowledgeAndWatch()}
            renderWarming={() => <Notice>Starting the desktop…</Notice>}
            className="h-full"
          />
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
    files,
    git,
    stagedGit,
    terminal,
    xtermTheme,
    capabilities,
    caps.viewerCapReached,
  ]);
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-xs text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
      {children}
    </div>
  );
}
