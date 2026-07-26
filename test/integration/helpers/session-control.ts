import type { ReasoningEffort, ResourceRef, ToolRef } from "@opengeni/contracts";
import {
  getSessionEvent,
  getSessionTurn,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectRls,
  type Database,
} from "@opengeni/db";

/**
 * Exercise the canonical foreground prompt transaction in integration fixtures
 * without bypassing its subject RLS, command receipt, control fence, or durable
 * wake registration. Event publication is intentionally left to tests that own
 * an EventBus; this helper only returns committed database truth.
 */
export async function submitTestHumanPrompt(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    subjectId: string;
    text: string;
    resources: ResourceRef[];
    tools: ToolRef[];
    delivery?: "send" | "steer";
    source?: "user" | "api";
    operationKey?: string;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    reasoningEffortFallback: ReasoningEffort;
    controlEtag?: string | null;
  },
) {
  const command = await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, (scoped) =>
    scoped.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as Database, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        subjectId: input.subjectId,
        actor: { type: "human", subjectId: input.subjectId },
        operationKey: input.operationKey ?? crypto.randomUUID(),
        delivery: input.delivery ?? "send",
        controlEtag: input.controlEtag ?? null,
        text: input.text,
        resources: input.resources,
        tools: input.tools,
        model: input.model ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
        reasoningEffortFallback: input.reasoningEffortFallback,
        source: input.source ?? "user",
      }),
    ),
  );
  const [accepted, turn] = await Promise.all([
    getSessionEvent(db, input.workspaceId, command.acceptedEventId),
    getSessionTurn(db, input.workspaceId, command.turnId),
  ]);
  if (!accepted || !turn) {
    throw new Error(`Canonical prompt command ${command.receipt.id} lost committed truth`);
  }
  return { command, accepted, turn };
}
