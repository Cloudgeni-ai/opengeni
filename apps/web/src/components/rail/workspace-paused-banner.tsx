import { Link } from "@tanstack/react-router";
import { PauseIcon, PlayIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { useAppContext } from "@/context";
import { canManageWorkspaceSettings } from "@/lib/permissions";
import { useWorkspaceTimerClock, workspaceTimerLabel } from "@/lib/workspace-timer";

/**
 * While agent work is paused, a banner across the workspace says so on every
 * page, with Resume for the people who can resume it.
 */
export function WorkspacePausedBanner({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  if (!workspace || workspace.inferenceControl.state !== "paused") return null;
  return <PausedBanner workspaceId={workspaceId} />;
}

function PausedBanner({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId)!;
  const control = workspace.inferenceControl;
  const now = useWorkspaceTimerClock(control, () => context.refreshWorkspace(workspaceId));
  const canManage = canManageWorkspaceSettings(
    context.accessContext,
    workspace,
    context.managedSelfContext,
  );
  const [busy, setBusy] = useState(false);
  const timer = control.timer?.action === "resume" ? workspaceTimerLabel(control, now) : null;

  async function resume() {
    setBusy(true);
    try {
      await context.setWorkspaceInferenceControl(workspaceId, "resume");
      toast.success("Agent work resumed");
    } catch {
      toast.error("Couldn't resume agent work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Notice
      layout="banner"
      tone="muted"
      icon={<PauseIcon className="size-4" />}
      className="shrink-0 bg-surface"
      action={
        canManage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void resume()}
            className="pointer-coarse:h-11"
          >
            <PlayIcon aria-hidden="true" />
            Resume
          </Button>
        ) : (
          <Link
            to="/workspaces/$workspaceId/settings"
            params={{ workspaceId }}
            search={{ section: "general" }}
            className="inline-flex h-8 items-center text-xs font-medium text-brand underline-offset-2 hover:underline"
          >
            Agent activity
          </Link>
        )
      }
    >
      <span className="text-fg">Agent work is paused in {workspace.name}.</span>{" "}
      <span className="text-fg-muted">
        New sessions and scheduled runs wait{timer ? ` · ${timer}` : " until someone resumes it"}.
      </span>
    </Notice>
  );
}
