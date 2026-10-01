// Usage surfaces that live in always-loaded chrome (the account menu and the
// composer). Loaded lazily through ./usage-entry so the usage SDK and React
// usage components never join the session or rail bundles.
import { UsageLimitNoticeView, UsageMeterView, useUsage } from "@opengeni/react/usage";
import { useNavigate } from "@tanstack/react-router";
import { GaugeIcon } from "lucide-react";

import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { CONSOLE_ALLOWANCE_LABELS } from "@/lib/usage-allowances";

function useConsoleUsage(workspaceId: string, refreshKey?: unknown) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  // Budgets exist only in shared workspaces; a Personal workspace never asks.
  const enabled = Boolean(workspace) && !isPersonalWorkspace(workspace, context.managedSelfContext);
  return useUsage({ client: context.client, workspaceId, enabled, refreshKey });
}

/**
 * "Usage · 38% left" in the account menu while the current workspace has a
 * limit for you. Opens the workspace's Usage page. Nothing when unlimited.
 */
export function AccountUsageMenuItem({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const { summary } = useConsoleUsage(workspaceId);
  if (!summary || summary.state === "unlimited") return null;
  return (
    <>
      <DropdownMenuItem
        onSelect={() =>
          void navigate({
            to: "/workspaces/$workspaceId/settings",
            params: { workspaceId },
            search: { section: "usage" },
          })
        }
        className="gap-2"
      >
        <GaugeIcon />
        <span className="min-w-0 truncate">Usage</span>
        <UsageMeterView
          summary={summary}
          density="compact"
          className="pointer-events-none ml-auto shrink-0 [&>span:last-child]:w-10"
        />
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

/**
 * The composer's near/at-limit line: what happened, who can raise it, when it
 * resets. A warning can be dismissed for this tab; reaching a limit can't.
 */
export function ComposerUsageNotice({
  workspaceId,
  refreshKey,
}: {
  workspaceId: string;
  refreshKey?: unknown;
}) {
  const { summary } = useConsoleUsage(workspaceId, refreshKey);
  return (
    <UsageLimitNoticeView
      summary={summary}
      labels={CONSOLE_ALLOWANCE_LABELS}
      dismissStorageKey={`opengeni.usage-notice:${workspaceId}`}
    />
  );
}
