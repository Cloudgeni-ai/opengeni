// Browser and computer hand-offs ("press your passkey", "sign in here") that a
// session's agent is paused on. They live on the browser or computer the agent
// used, so without this the chat says the session needs you but shows nothing
// to act on. Done tells the agent to carry on; the X cancels the request.
import type { ChatClient } from "@opengeni/sdk";
import type { InteractionIntervention } from "@opengeni/sdk/interaction";
import { useCallback, useMemo } from "react";

import { InteractionInterventionBanner } from "../../../components/interaction-intervention-banner";
import { useInteractionInterventions } from "../../../hooks/use-interaction-interventions";
import { useOpenGeniText } from "../../../messages/runtime";
import type { EmbeddedInterventionClientOverride } from "../../../session-context";
import { userErrorText } from "../../../ui/api-error";
import { toast } from "../../lib/toast";
import { cn } from "../../lib/utils";

export type InterventionOutcome = "completed" | "dismissed";

export type SessionInterventions = {
  /** Open hand-offs by the session whose agent asked for them, oldest first. */
  bySession: ReadonlyMap<string, readonly InteractionIntervention[]>;
  mutating: boolean;
  resolve: (intervention: InteractionIntervention, outcome: InterventionOutcome) => Promise<void>;
};

const NONE: readonly InteractionIntervention[] = [];
// Live hints drive refreshes; this is only the fallback while they are down.
const FALLBACK_POLL_MS = 10_000;

/** Open hand-offs of these sessions; reads nothing while the list is empty. */
export function useSessionInterventions(options: {
  client: EmbeddedInterventionClientOverride<ChatClient>["client"];
  workspaceId: string;
  sessionIds: readonly string[];
}): SessionInterventions {
  const t = useOpenGeniText();
  const key = [...options.sessionIds].sort().join(",");
  const interventions = useInteractionInterventions({
    client: options.client,
    workspaceId: options.workspaceId,
    enabled: key.length > 0,
    pollIntervalMs: FALLBACK_POLL_MS,
  });
  const bySession = useMemo(
    () => groupOpenInterventions(interventions.interventions, key ? key.split(",") : []),
    [interventions.interventions, key],
  );
  const resolveIntervention = interventions.resolve;
  const resolve = useCallback(
    async (intervention: InteractionIntervention, outcome: InterventionOutcome) => {
      try {
        await resolveIntervention(intervention.id, {
          expectedVersion: intervention.version,
          outcome,
        });
      } catch (error) {
        toast.error(t("browserViewer.couldNotUpdateTheBrowser"), {
          description: userErrorText(error),
        });
      }
    },
    [resolveIntervention, t],
  );
  return { bySession, mutating: interventions.mutating, resolve };
}

/** The open hand-offs among `interventions` that these sessions asked for. */
export function groupOpenInterventions(
  interventions: readonly InteractionIntervention[],
  sessionIds: readonly string[],
): Map<string, InteractionIntervention[]> {
  const wanted = new Set(sessionIds);
  const grouped = new Map<string, InteractionIntervention[]>();
  for (const intervention of interventions) {
    if (intervention.status !== "open" || !wanted.has(intervention.originatingSessionId)) continue;
    const list = grouped.get(intervention.originatingSessionId) ?? [];
    list.push(intervention);
    grouped.set(intervention.originatingSessionId, list);
  }
  for (const list of grouped.values())
    list.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return grouped;
}

export function interventionsFor(
  interventions: SessionInterventions | undefined,
  sessionId: string,
): readonly InteractionIntervention[] {
  return interventions?.bySession.get(sessionId) ?? NONE;
}

/** One session's open hand-offs, as a card above the composer. */
export function SessionInterventionNotice(props: {
  interventions: readonly InteractionIntervention[];
  mutating: boolean;
  onResolve: (intervention: InteractionIntervention, outcome: InterventionOutcome) => void;
  className?: string | undefined;
}) {
  if (props.interventions.length === 0) return null;
  return (
    <div data-session-interventions="" className={props.className}>
      <InteractionInterventionBanner
        interventions={[...props.interventions]}
        mutating={props.mutating}
        onResolve={props.onResolve}
        className={cn("rounded-lg border")}
      />
    </div>
  );
}
