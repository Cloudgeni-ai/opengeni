import { useState } from "react";
import { RowButton } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { invalidateModelSettingsQueries, useSharedQueryActivity } from "@/lib/shared-query";
import { ModelSettingsPlaceholder } from "./model-settings-placeholder";

export function ModelsRefreshControl({ client }: { client: object }) {
  const activity = useSharedQueryActivity(client, [
    "model-settings",
    "codex-accounts",
    "subscription-pool",
    "supergrok-accounts",
  ]);
  const [refreshing, setRefreshing] = useState(false);
  return (
    <div
      className="mb-4 flex min-h-8 items-center justify-end gap-2 text-xs text-fg-muted"
      aria-live="polite"
    >
      {activity.updatedAt ? (
        <RelativeTime date={activity.updatedAt} prefix="Updated" />
      ) : (
        <ModelSettingsPlaceholder />
      )}
      <span aria-hidden="true">·</span>
      <RowButton
        variant="ghost"
        disabled={refreshing}
        onClick={async () => {
          setRefreshing(true);
          try {
            await invalidateModelSettingsQueries(client);
          } finally {
            setRefreshing(false);
          }
        }}
      >
        {refreshing ? "Refreshing…" : "Refresh"}
      </RowButton>
    </div>
  );
}
