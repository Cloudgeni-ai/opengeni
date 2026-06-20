// The sandbox workbench — Phase 5 client surface. Beside the chat timeline, this
// panel surfaces the live sandbox: terminal (Channel-A event projection), file
// browser + git diff (Channel-A point queries), and the desktop (Channel-B
// noVNC, direct-to-provider). Every surface is GATED on the negotiated
// capability doc: we render only what THIS session+backend+OS advertises, and an
// unavailable surface degrades to a reason-aware notice — never a crash.
import {
  DesktopViewer,
  DiffView,
  FileBrowser,
  SandboxTerminal,
  useSandboxFiles,
  useSandboxGit,
  useSandboxTerminal,
  useSessionCapabilities,
} from "@opengeni/react";
import { useState } from "react";
import { toast } from "sonner";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppContext } from "@/context";
import type { SessionEvent } from "@/types";

export function SandboxWorkspace({
  workspaceId,
  sessionId,
  events,
}: {
  workspaceId: string;
  sessionId: string;
  events: SessionEvent[];
}) {
  const context = useAppContext();

  // Whether the user has opted into watching the desktop (drives the viewer
  // attach + the un-redacted acknowledgment). Off by default — the structured
  // surfaces (terminal/files/diff) need no consent and no warm box.
  const [watchDesktop, setWatchDesktop] = useState(false);

  const caps = useSessionCapabilities(sessionId, {
    events,
    attachDesktop: watchDesktop,
  });
  const terminal = useSandboxTerminal(sessionId, { events });
  const files = useSandboxFiles(sessionId, { events, enabled: caps.capabilities?.FileSystem.available ?? false });
  const git = useSandboxGit(sessionId, { events, enabled: caps.capabilities?.Git.available ?? false });

  const capabilities = caps.capabilities;
  const fileSystemOn = capabilities?.FileSystem.available ?? false;
  const gitOn = capabilities?.Git.available ?? false;
  const terminalOn = (capabilities?.Terminal.transport ?? null) !== null;
  // The desktop tab appears only when the capability doc advertises a transport
  // (no hardcoded backend check in the app — the doc is the single UI truth).
  const desktopAdvertised = (capabilities?.DesktopStream.transport ?? null) !== null
    || capabilities?.DesktopStream.reason === "lease_cold";

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

  if (caps.state === "negotiating" && !capabilities) {
    return <Notice>Negotiating sandbox surfaces…</Notice>;
  }
  if (caps.state === "error") {
    return <Notice>{caps.error?.message ?? "Sandbox surfaces unavailable."}</Notice>;
  }

  // Pick the first available tab as the default.
  const defaultTab = terminalOn ? "terminal" : fileSystemOn ? "files" : gitOn ? "diff" : "desktop";

  return (
    <Tabs defaultValue={defaultTab} className="flex h-full min-h-0 min-w-0 flex-col gap-0 overflow-hidden">
      <div className="min-w-0 border-b border-[color:var(--color-border)] px-2 py-2">
        <TabsList className="grid h-8 w-full min-w-0 auto-cols-fr grid-flow-col rounded-md bg-[color:var(--color-bg)] p-1">
          {terminalOn && <TabsTrigger value="terminal" className="h-6 min-w-0 rounded px-1 text-[11px]">Terminal</TabsTrigger>}
          {fileSystemOn && <TabsTrigger value="files" className="h-6 min-w-0 rounded px-1 text-[11px]">Files</TabsTrigger>}
          {gitOn && <TabsTrigger value="diff" className="h-6 min-w-0 rounded px-1 text-[11px]">Diff</TabsTrigger>}
          {desktopAdvertised && <TabsTrigger value="desktop" className="h-6 min-w-0 rounded px-1 text-[11px]">Desktop</TabsTrigger>}
        </TabsList>
      </div>

      {terminalOn && (
        <TabsContent value="terminal" className="min-h-0 min-w-0 flex-1 overflow-hidden bg-[color:var(--color-bg)] p-1">
          <SandboxTerminal result={terminal} readOnly />
        </TabsContent>
      )}

      {fileSystemOn && (
        <TabsContent value="files" className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <FileBrowser result={files} className="h-full" />
        </TabsContent>
      )}

      {gitOn && (
        <TabsContent value="diff" className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <DiffView diff={git.diff} isRepo={git.isRepo} className="h-full p-1" />
        </TabsContent>
      )}

      {desktopAdvertised && (
        <TabsContent value="desktop" className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <DesktopViewer
            capability={capabilities?.DesktopStream ?? null}
            viewerCapReached={caps.viewerCapReached}
            onAcknowledge={() => void acknowledgeAndWatch()}
            renderWarming={() => <Notice>Starting the desktop…</Notice>}
          />
        </TabsContent>
      )}
    </Tabs>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-xs text-[color:var(--color-fg-subtle)]">
      {children}
    </div>
  );
}
