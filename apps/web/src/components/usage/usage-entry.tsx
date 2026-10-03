// Usage in always-loaded chrome: the account-menu row and the composer's
// near/at-limit notice. Eager and dependency-light (the SDK's `/usage/me` read
// plus the presentational React views); budget pages stay in their lazy chunk.
import { UsageLimitNoticeView, UsageMeterView, summarizeUsage } from "@opengeni/react/usage";
import { getMyUsage, type WorkspaceUsageResponse } from "@opengeni/sdk/usage-allowances";
import { useNavigate } from "@tanstack/react-router";
import { GaugeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useAppContext } from "@/context";
import { CONSOLE_ALLOWANCE_LABELS } from "@/lib/allowance-labels";
import { isPersonalWorkspace } from "@/lib/managed-self-context";

/** The signed-in person's `/usage/me`; nothing for Personal workspaces or on error. */
function useOwnUsage(workspaceId: string, refreshKey?: unknown) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  // Budgets exist only in shared workspaces; a Personal workspace never asks.
  const enabled = Boolean(workspace) && !isPersonalWorkspace(workspace, context.managedSelfContext);
  const client = context.client;
  const [usage, setUsage] = useState<{ workspaceId: string; value: WorkspaceUsageResponse } | null>(
    null,
  );
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    getMyUsage(client, workspaceId, {}, { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setUsage({ workspaceId, value });
      })
      // Usage is a hint here: a failed or refused read just shows nothing.
      .catch(() => undefined);
    return () => abort.abort();
  }, [client, enabled, workspaceId, refreshKey]);
  const value = enabled && usage?.workspaceId === workspaceId ? usage.value : null;
  return useMemo(() => (value ? summarizeUsage(value) : null), [value]);
}

/**
 * "Usage · 38% left" in the account menu while the current workspace has a
 * limit for you. Opens the workspace's Usage page. Nothing when unlimited.
 */
export function AccountUsageMenuItem({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const summary = useOwnUsage(workspaceId);
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
  const summary = useOwnUsage(workspaceId, refreshKey);
  return (
    <UsageLimitNoticeView
      summary={summary}
      labels={CONSOLE_ALLOWANCE_LABELS}
      dismissStorageKey={`opengeni.usage-notice:${workspaceId}`}
    />
  );
}
