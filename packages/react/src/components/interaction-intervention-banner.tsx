import type { InteractionIntervention } from "@opengeni/sdk/interaction";
import { CheckIcon, CircleAlertIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { useOpenGeniText, type OpenGeniText } from "../messages/runtime";

export type InteractionInterventionBannerProps = {
  interventions: InteractionIntervention[];
  activeTargetId?: string | null | undefined;
  mutating?: boolean | undefined;
  className?: string | undefined;
  onOpen?: ((intervention: InteractionIntervention) => void) | undefined;
  onResolve: (intervention: InteractionIntervention, outcome: "completed" | "dismissed") => void;
};

/** Compact durable human-action prompt shared by Browser and Computer viewers. */
export function InteractionInterventionBanner({
  interventions,
  activeTargetId,
  mutating = false,
  className,
  onOpen,
  onResolve,
}: InteractionInterventionBannerProps) {
  const t = useOpenGeniText();
  const intervention = interventions[0];
  if (!intervention) return null;
  const targetOpen = activeTargetId === undefined || activeTargetId === intervention.targetId;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-b border-og-status-waiting/25 bg-og-status-waiting/[0.07] px-3 py-2",
        className,
      )}
      role="status"
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-og-sm bg-og-status-waiting/10 text-og-status-waiting">
        <CircleAlertIcon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-og-control font-medium text-og-fg">
          {interventionTitle(t, intervention.kind)}
          {interventions.length > 1 ? (
            <span className="rounded-full bg-og-surface-2 px-1.5 py-0.5 text-[10px] font-normal text-og-muted">
              +{interventions.length - 1}
            </span>
          ) : null}
        </span>
        <span className="block truncate text-og-xs text-og-muted">{intervention.reason}</span>
      </span>
      {!targetOpen && onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(intervention)}
          disabled={mutating}
          className="h-7 shrink-0 rounded-og-sm border border-og-primary-border bg-og-primary px-2.5 text-og-control font-medium text-og-primary-fg transition hover:bg-og-primary-hover disabled:opacity-50"
        >
          {t("interactionInterventionBanner.open")}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onResolve(intervention, "completed")}
          disabled={mutating}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-og-sm border border-og-primary-border bg-og-primary text-og-primary-fg px-2.5 text-og-control font-medium transition hover:bg-og-primary-hover disabled:opacity-50"
        >
          {mutating ? (
            <LoaderCircleIcon className="size-3 animate-spin" />
          ) : (
            <CheckIcon className="size-3" />
          )}
          {t("interactionInterventionBanner.done")}
        </button>
      )}
      <button
        type="button"
        onClick={() => onResolve(intervention, "dismissed")}
        disabled={mutating}
        className="grid size-7 shrink-0 place-items-center rounded-og-sm text-og-muted transition hover:bg-og-surface-2 hover:text-og-fg disabled:opacity-50"
        aria-label={t("interactionInterventionBanner.cancelRequest")}
        title={t("interactionInterventionBanner.cancelRequest")}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

function interventionTitle(t: OpenGeniText, kind: InteractionIntervention["kind"]): string {
  switch (kind) {
    case "manual_login":
      return t("interactionInterventionBanner.signInNeeded");
    case "mfa":
      return t("interactionInterventionBanner.verificationNeeded");
    case "external_action":
      return t("interactionInterventionBanner.actionNeeded");
    case "confirmation":
      return t("interactionInterventionBanner.confirmationNeeded");
    case "other":
      return t("interactionInterventionBanner.agentNeedsYourHelp");
  }
}
