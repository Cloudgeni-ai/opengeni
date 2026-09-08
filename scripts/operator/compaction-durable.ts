import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  isSessionCompactionRequested,
  getActiveSessionHistoryItems,
  getSession,
  requestSessionCompaction,
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { acquireSharedTestDatabase } from "@opengeni/testing";
import { maybeCompactContext } from "../../apps/worker/src/activities/context-compaction";
import type { Settings } from "@opengeni/config";

import { CompactionVerificationError } from "./compaction-verification-errors";

type Item = Record<string, unknown>;

/** Exercise the real fenced checkpoint on disposable PostgreSQL, never customer data. */
export async function compactDurableFixture(
  settings: Settings,
  history: Item[],
  summarize: (settings: Settings, input: Item[]) => Promise<string>,
) {
  const shared = await acquireSharedTestDatabase("portable-compaction-live");
  if (!shared) throw new CompactionVerificationError("Disposable PostgreSQL unavailable");
  const client = createDb(shared.appUrl);
  try {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: suffix,
      accountName: "Compaction fixture",
      workspaceExternalSource: "test",
      workspaceExternalId: suffix,
      workspaceName: "Compaction fixture",
      subjectId: `fixture-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "Synthetic checkpoint verification",
      resources: [],
      metadata: {},
      model: settings.openaiModel,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await withWorkspaceSessionActivityRls(client.db, workspaceId, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(
        history.map((item, position) => ({
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          position,
          item,
        })),
      );
      await db
        .update(schema.sessions)
        .set({ lastInputTokens: 244_098 })
        .where(eq(schema.sessions.id, session.id));
    });
    await requestSessionCompaction(client.db, workspaceId, session.id);
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed")
      throw new CompactionVerificationError("Synthetic compaction claim failed");
    const outcome = await maybeCompactContext(
      client.db,
      {
        ...settings,
        contextWindowTokens: 272_000,
        contextAutoCompactThresholdTokens: 244_800,
      },
      {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        turnId: claim.turn.id,
        executionGeneration: claim.turn.executionGeneration,
        attemptId,
      },
      244_098,
      summarize,
      { force: true, trigger: "operator", clearRequestedCompaction: true },
    );
    if (!outcome.compacted) {
      const knownReasons = [
        "below_threshold",
        "no_history",
        "summarization_failed",
        "empty_summary",
        "replacement_not_smaller",
        "stale_attempt",
        "interrupted",
        "no_replacement_history",
      ];
      const reason = knownReasons.includes(outcome.reason) ? outcome.reason : "unrecognized_reason";
      throw new CompactionVerificationError(
        `Durable synthetic compaction did not install a checkpoint (${reason}).`,
      );
    }
    const rows = await withWorkspaceRls(client.db, workspaceId, (db) =>
      db
        .select()
        .from(schema.sessionHistoryItems)
        .where(eq(schema.sessionHistoryItems.sessionId, session.id))
        .orderBy(schema.sessionHistoryItems.position),
    );
    const inactive = rows.filter((row) => !row.active).map((row) => row.item);
    if (!isDeepStrictEqual(inactive, history))
      throw new CompactionVerificationError("Archived canonical history changed");
    const replacement = (
      await getActiveSessionHistoryItems(client.db, workspaceId, session.id)
    ).map((row) => row.item as Item);
    const persisted = await getSession(client.db, workspaceId, session.id);
    if (
      persisted?.lastInputTokens !== null ||
      (await isSessionCompactionRequested(client.db, workspaceId, session.id))
    )
      throw new CompactionVerificationError("Checkpoint token/request settlement failed");
    if (!outcome.events.some((event) => event.type === "session.context.compacted"))
      throw new CompactionVerificationError("Durable checkpoint event missing");
    return {
      replacement,
      proof: {
        sessionId: session.id,
        turnId: claim.turn.id,
        archivedItems: inactive.length,
        activeItems: replacement.length,
        archivedHistoryUnchanged: true,
        tokenSignalCleared: true,
        compactionRequestConsumed: true,
        durableCompactionEvent: true,
        compactionEvent: outcome.events.find((event) => event.type === "session.context.compacted")
          ?.payload,
      },
    };
  } finally {
    try {
      await client.close();
    } finally {
      await shared.release();
    }
  }
}
