import { useEffect, useState } from "react";
import { ongoingPersonalResourceNames } from "@/lib/personal-resource-ongoing-access";
import { PersonalResourceScopeChoice } from "./personal-resource-scope-choice";
import { RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  PersonalResourceAttachmentController,
  PersonalResourceNotice,
} from "@/lib/use-personal-resource-attachment";

const noticeMessages: Record<PersonalResourceNotice, string> = {
  source_changed:
    "Access to the selected personal resource changed. Choose an available resource before submitting.",
  reloading: "Session authority changed. Reloading personal resources before retrying.",
  reload_failed: "Session authority could not be refreshed. Retry before sending again.",
  reloaded: "Session authority changed. Personal resources were reloaded before retrying.",
  accepted: "Personal-resource use was accepted for this work.",
};

export function PersonalResourceAttachmentControl(props: {
  controller: PersonalResourceAttachmentController;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { controller } = props;
  // Healthy selections are already described inside their pickers. Keep the
  // composer-top surface for transient or actionable status only.
  const showScopeChoice =
    controller.visibility === "workspace" &&
    controller.selected.personalResourceCount > 0 &&
    controller.mode !== null;
  const hasVisibleStatus =
    showScopeChoice ||
    controller.loading ||
    controller.notice !== null ||
    controller.error !== null ||
    controller.truncated;
  const ongoingNames = useOngoingNames(controller);
  if (!controller.eligible || !hasVisibleStatus) {
    return null;
  }
  const disabled = props.disabled || controller.loading || controller.refreshing;
  return (
    <div
      data-personal-resource-attachment
      className={cn("min-w-0 space-y-2", props.compact ? "mt-2" : "mt-4")}
      aria-busy={controller.loading || controller.refreshing}
    >
      {ongoingNames.length > 0 ? (
        <p className="text-xs text-fg-muted">
          Existing ongoing authorization: {ongoingNames.join(", ")}. This is separate from your
          next-message choice.
        </p>
      ) : null}
      {showScopeChoice ? (
        <PersonalResourceScopeChoice
          mode={controller.mode!}
          onModeChange={controller.setMode}
          disabled={disabled || controller.requiresDecision}
        />
      ) : null}
      {controller.loading ? (
        <p role="status" className="text-xs text-fg-subtle">
          Loading selected personal resources…
        </p>
      ) : null}
      {controller.notice ? (
        <p className="text-xs text-fg-muted" role="status" aria-live="polite">
          {noticeMessages[controller.notice]}
        </p>
      ) : null}
      {controller.error ? (
        <div className="flex items-center justify-between gap-3" role="alert">
          <span className="text-xs text-danger">
            The selected personal resource is unavailable. Retry, or open Variable Sets to replace
            or remove it.
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => void controller.refresh()}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
            Retry
          </Button>
        </div>
      ) : null}
      {controller.truncated ? (
        <p className="text-2xs text-fg-subtle" role="status">
          Showing the first 400 personal resources of each supported type.
        </p>
      ) : null}
    </div>
  );
}

function useOngoingNames(controller: PersonalResourceAttachmentController): string[] {
  const [checkedAt, setCheckedAt] = useState(Date.now);
  const authorities = controller.catalog
    ? [
        ...controller.catalog.variableSetAuthorities,
        ...controller.catalog.rigAuthorities,
        ...controller.catalog.connectedMachineAuthorities,
      ]
    : [];
  const nextExpiry = Math.min(
    ...authorities.flatMap((authority) =>
      authority.grants.flatMap((grant) =>
        grant.status === "active" &&
        grant.expiresAt !== null &&
        Date.parse(grant.expiresAt) > checkedAt
          ? [Date.parse(grant.expiresAt)]
          : [],
      ),
    ),
  );
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(
      () => setCheckedAt(Date.now()),
      Math.min(2_147_483_647, Math.max(1, nextExpiry - Date.now() + 1)),
    );
    return () => clearTimeout(timer);
  }, [nextExpiry, checkedAt]);
  if (!controller.ongoingScope) return [];
  return ongoingPersonalResourceNames({
    ...controller.ongoingScope,
    authorities,
    resources: [
      ...controller.selected.variableSets.map((resource) => ({
        kind: "variable_set" as const,
        id: resource.id,
        name: resource.name,
      })),
      ...controller.selected.rigs.map((resource) => ({
        kind: "rig" as const,
        id: resource.id,
        name: resource.name,
      })),
      ...controller.selected.connectedMachines.map((resource) => ({
        kind: "connected_machine" as const,
        id: resource.enrollmentId,
        name: resource.name,
      })),
    ],
    now: Math.max(checkedAt, Date.now()),
  });
}
