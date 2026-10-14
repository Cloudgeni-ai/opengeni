import { readTurnExecutionPolicyV1, stableJson, ToolRef } from "@opengeni/contracts";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { Database } from "./database";
import { frozenCredentialRestriction } from "./turn-initiator";
import * as schema from "./schema";

type Turn = typeof schema.sessionTurns.$inferSelect;
type Update = typeof schema.sessionSystemUpdates.$inferSelect;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export function inboxOrigin(update: Pick<Update, "kind" | "lineage">, sessionId: string) {
  const { kind, lineage } = update;
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) return null;
  if (
    (kind === "agent_message" || kind === "agent_steer_instruction") &&
    (typeof lineage.callerAttemptId !== "string" ||
      !uuid.test(lineage.callerAttemptId) ||
      typeof lineage.callerExecutionGeneration !== "number" ||
      !Number.isSafeInteger(lineage.callerExecutionGeneration) ||
      lineage.callerExecutionGeneration < 1)
  )
    return null;
  const turnId =
    kind === "agent_message" || kind === "agent_steer_instruction"
      ? lineage.callerTurnId
      : kind.startsWith("child_")
        ? lineage.parentTurnId
        : lineage.causalTurnId;
  const originSessionId =
    kind === "agent_message" || kind === "agent_steer_instruction"
      ? lineage.callerSessionId
      : sessionId;
  return typeof turnId === "string" &&
    uuid.test(turnId) &&
    typeof originSessionId === "string" &&
    uuid.test(originSessionId)
    ? { turnId, sessionId: originSessionId }
    : null;
}

export function turnHuman(
  turn: Pick<Turn, "initiatingHumanSubjectId" | "initiatorKind" | "initiatorSubjectId">,
) {
  return (
    turn.initiatingHumanSubjectId ??
    (turn.initiatorKind === "subject" ? turn.initiatorSubjectId : null)
  );
}

export function informationalAgentUpdate(update: Pick<Update, "kind" | "scheduledTaskRunId">) {
  return (
    !update.scheduledTaskRunId &&
    (update.kind === "agent_message" || update.kind.startsWith("child_"))
  );
}

/** Accepted rows are the only authority source. No creator/default-account fallback. */
export async function loadInboxExecutionContext(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    contextTurnId: string | null;
    updates: readonly Update[];
  },
) {
  const ids = [
    ...new Set([
      ...(input.contextTurnId ? [input.contextTurnId] : []),
      ...input.updates.flatMap((update) => {
        const origin = inboxOrigin(update, input.sessionId);
        return origin ? [origin.turnId] : [];
      }),
    ]),
  ];
  const turns =
    ids.length === 0
      ? []
      : await tx
          .select({
            ...getTableColumns(schema.sessionTurns),
            externalLink: sql<unknown>`(select a.canonical_snapshot from external_link_turn_authorities a
      where a.account_id = ${input.accountId}::uuid and a.workspace_id = ${input.workspaceId}::uuid
        and a.turn_id = ${schema.sessionTurns.id})`,
            sessionMetadata: schema.sessions.metadata,
            sessionTools: schema.sessions.tools,
            sessionToolPolicy: schema.sessions.toolPolicy,
          })
          .from(schema.sessionTurns)
          .innerJoin(schema.sessions, eq(schema.sessions.id, schema.sessionTurns.sessionId))
          .where(
            and(
              eq(schema.sessionTurns.accountId, input.accountId),
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              inArray(schema.sessionTurns.id, ids),
            ),
          );
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const context = input.contextTurnId ? byId.get(input.contextTurnId) : undefined;
  if (input.contextTurnId && (!context || context.sessionId !== input.sessionId))
    throw new Error("Receiving session execution context is unavailable");
  const human = context ? turnHuman(context) : null;
  const eligibleIds = new Set<string>();
  for (const update of input.updates) {
    if (!context || context.externalLink || !human || !informationalAgentUpdate(update)) continue;
    const origin = inboxOrigin(update, input.sessionId);
    const turn = origin ? byId.get(origin.turnId) : undefined;
    if (
      !turn ||
      turn.sessionId !== origin?.sessionId ||
      turnHuman(turn) !== human ||
      turn.externalLink
    )
      continue;
    const policy = readTurnExecutionPolicyV1(turn.metadata);
    const initialPolicy = readTurnExecutionPolicyV1(turn.sessionMetadata);
    if (
      frozenCredentialRestriction(update.lineage) ||
      frozenCredentialRestriction(turn.initiatorContext) ||
      (policy.kind === "valid" && policy.policy.credentialRestriction) ||
      (initialPolicy.kind === "valid" && initialPolicy.policy.credentialRestriction)
    )
      continue;
    eligibleIds.add(update.id);
  }
  // Legacy/control lanes still compare real external permission ceilings. The
  // retired host-credential tables no longer participate in execution.
  const causalKeys = new Map(
    turns.map((turn) => [
      `${turn.sessionId}:${turn.id}`,
      turnHuman(turn)
        ? stableJson({ human: turnHuman(turn), externalLink: turn.externalLink })
        : null,
    ]),
  );
  return { context: context ?? null, eligibleIds, causalKeys, origins: byId };
}

/** Factual model context only; no credential identifiers, instructions or UI event changes. */
export function agentSelectionNotes(
  updates: readonly Update[],
  receiver: NonNullable<Awaited<ReturnType<typeof loadInboxExecutionContext>>["context"]>,
  origins: Awaited<ReturnType<typeof loadInboxExecutionContext>>["origins"],
): Record<string, string> {
  const selection = (tools: unknown[]) => {
    const parsed = tools.map((tool) => ToolRef.safeParse(tool));
    return parsed.every((tool) => tool.success)
      ? [...new Set(parsed.flatMap((tool) => (tool.success ? [tool.data.id] : [])))].sort()
      : null;
  };
  const selectedTools = (turn: typeof receiver) =>
    turn.toolsProvided
      ? turn.tools
      : turn.sessionToolPolicy?.mode === "workspace_default"
        ? null
        : turn.sessionTools;
  const receivingTools = selectedTools(receiver);
  const yours = receivingTools ? selection(receivingTools) : null;
  if (!yours) return {};
  let remainingBytes = 8192;
  return Object.fromEntries(
    updates.flatMap((update) => {
      if (update.kind !== "agent_message") return [];
      const origin = inboxOrigin(update, receiver.sessionId);
      const sender = origin ? origins.get(origin.turnId) : undefined;
      const sendingTools =
        sender && sender.sessionId === origin?.sessionId ? selectedTools(sender) : null;
      const theirs = sendingTools ? selection(sendingTools) : null;
      if (!theirs || stableJson(theirs) === stableJson(yours)) return [];
      const note = `The sending agent has these tools selected: ${JSON.stringify(theirs)}. You have these tools selected: ${JSON.stringify(yours)}.`;
      const bytes = Buffer.byteLength(note);
      if (bytes > 4096 || bytes > remainingBytes) return [];
      remainingBytes -= bytes;
      return [[update.id, note]];
    }),
  );
}
