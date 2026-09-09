import { useEffect, useState } from "react";

import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import { openGeniSlackBotUiMetadata } from "@/lib/slack-bot";
import type { SlackInstallationBinding } from "@/types";

/** Metadata discovery only. Each read still passes the destination API's access checks. */
export function useSlackInstallationDiscovery(workspaceId: string, enabled: boolean) {
  const { accessContext, client } = useAppContext();
  const accountId = accessContext?.workspaceGrants.find(
    (grant) => grant.workspaceId === workspaceId,
  )?.accountId;
  const candidates = [
    ...new Set(
      (accessContext?.workspaceGrants ?? [])
        .filter(
          (grant) =>
            grant.accountId === accountId &&
            grant.workspaceId !== workspaceId &&
            hasWorkspacePermission(accessContext, grant.workspaceId, "connections:read"),
        )
        .map((grant) => grant.workspaceId),
    ),
  ].sort();
  const key = JSON.stringify([workspaceId, accountId, accessContext?.subjectId, candidates]);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    bindings: SlackInstallationBinding[];
    verifiedIds: string[];
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setResult(null);
    void (async () => {
      const bindings: SlackInstallationBinding[] = [];
      const verifiedIds: string[] = [];
      let failed = false;
      // Keep fan-out bounded even for people administering many workspaces.
      for (let offset = 0; offset < candidates.length; offset += 3) {
        if (cancelled) return;
        const batch = await Promise.allSettled(
          candidates.slice(offset, offset + 3).map(async (id) => {
            const rows = await client.listSlackInstallationBindings(id);
            const connections = rows.length > 0 ? await client.listConnections(id) : [];
            return { rows, connections };
          }),
        );
        batch.forEach((entry, index) => {
          if (entry.status === "rejected") {
            failed = true;
            return;
          }
          const source = candidates[offset + index];
          for (const binding of entry.value.rows.filter(
            (candidate) => candidate.accountId === accountId && candidate.workspaceId === source,
          )) {
            bindings.push(binding);
            const connection = entry.value.connections.find(
              (row) =>
                row.id === binding.connectionId &&
                row.accountId === accountId &&
                row.workspaceId === source &&
                row.version === binding.connectionVersion,
            );
            const metadata = connection ? openGeniSlackBotUiMetadata(connection) : null;
            if (
              connection?.status === "active" &&
              metadata?.slackTeamId === binding.slackTeamId &&
              metadata.botId === binding.botId &&
              metadata.botUserId === binding.botUserId
            )
              verifiedIds.push(binding.id);
          }
        });
      }
      if (!cancelled) setResult({ key, bindings, verifiedIds, failed });
    })();
    return () => {
      cancelled = true;
    };
    // The serialized key includes every candidate and the authenticated subject.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, client, enabled, revision]);
  const current = enabled && result?.key === key ? result : null;
  return {
    loading: enabled && candidates.length > 0 && current === null,
    failed: current?.failed ?? false,
    bindings: current?.bindings ?? [],
    verifiedIds: current?.verifiedIds ?? [],
    retry: () => setRevision((value) => value + 1),
  };
}
