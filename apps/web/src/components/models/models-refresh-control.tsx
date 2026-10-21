import { useState } from "react";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import {
  invalidateModelSettingsQueries,
  invalidateSharedQueries,
  useSharedQueryActivity,
} from "@/lib/shared-query";
import { ModelSettingsPlaceholder } from "./model-settings-placeholder";

export function ModelsRefreshControl({ client }: { client: object }) {
  const activity = useSharedQueryActivity(client, [
    "model-settings",
    "codex-accounts",
    "subscription-pool",
    "supergrok-accounts",
    "subscription-usage-pools",
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
            await invalidateModelSettingsQueries(client, false);
            // Pool GETs project saved observations. Read them only after the
            // live checks above have recorded their newest provider readings.
            await invalidateSharedQueries(client, ["subscription-usage-pools"]);
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
