import { createHash, randomUUID } from "node:crypto";
import {
  SlackTaskPolicyContent,
  canonicalizeSlackTaskPolicy,
  type SlackTaskPolicyActivationEvent,
  type SlackTaskPolicyHead,
  type SlackTaskPolicyListResponse,
  type SlackTaskPolicyMutationResponse,
  type SlackTaskPolicyRevision,
} from "@opengeni/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withRlsContext } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
import * as schema from "./schema";

type RevisionRow = typeof schema.slackTaskPolicyRevisions.$inferSelect;
type HeadRow = typeof schema.slackTaskPolicyHeads.$inferSelect;
type EventRow = typeof schema.slackTaskPolicyActivationEvents.$inferSelect;
type OriginRow = typeof schema.slackSharedTaskOrigins.$inferSelect;

export type SlackSharedTaskOrigin = {
  interactionId: string;
  accountId: string;
  workspaceId: string;
  connectionId: string;
  sessionId: string;
  slackTeamId: string;
  sourceChannelId: string;
  sourceThreadTs: string;
  initiatingSlackUserId: string;
  policyRevisionId: string;
  /**
   * Home tenancy of the frozen policy revision. The row's own
   * `accountId`/`workspaceId` are the routed task's, which is a different
   * workspace once Slack workspace routing is on. Null on rows written before
   * routing existed, where the two were always equal.
   */
  policyAccountId: string | null;
  policyWorkspaceId: string | null;
  policyHash: string;
  policyActivationVersion: number;
  publicationMode: "never" | "approval_required" | "allow";
  createdAt: Date;
};

export class SlackTaskPolicyConflictError extends Error {
  readonly name = "SlackTaskPolicyConflictError";
  readonly code = "SLACK_TASK_POLICY_CONFLICT";
  constructor(readonly currentHead: SlackTaskPolicyHead | null) {
    super("The active Slack task policy changed in another request");
  }
}

export class SlackTaskPolicyOperationReuseError extends Error {
  readonly name = "SlackTaskPolicyOperationReuseError";
  readonly code = "SLACK_TASK_POLICY_OPERATION_REUSED";
  constructor() {
    super("The Slack task-policy operation id was already used for another request");
  }
}

export class SlackTaskPolicyInvalidOperationError extends Error {
  readonly name = "SlackTaskPolicyInvalidOperationError";
}

export class SlackTaskPolicyAuthorityError extends Error {
  readonly name = "SlackTaskPolicyAuthorityError";

  constructor(message = "Slack task-policy administration requires exact workspace authority") {
    super(message);
  }
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function revisionFromRow(row: RevisionRow): SlackTaskPolicyRevision {
  return {
    id: row.id,
    operationId: row.operationId,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    revision: row.revision,
    policy: canonicalizeSlackTaskPolicy(SlackTaskPolicyContent.parse(row.policy)),
    policyHash: row.policyHash,
    supersedesRevisionId: row.supersedesRevisionId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  };
}

function headFromRow(row: HeadRow): SlackTaskPolicyHead {
  return {
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    revisionId: row.revisionId,
    revision: row.revision,
    policyHash: row.policyHash,
    activationVersion: row.activationVersion,
    activatedAt: iso(row.activatedAt),
  };
}

function eventFromRow(row: EventRow): SlackTaskPolicyActivationEvent {
  return {
    id: row.id,
    operationId: row.operationId,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    activationVersion: row.activationVersion,
    oldRevision:
      row.oldRevisionId === null
        ? null
        : { id: row.oldRevisionId, revision: row.oldRevision!, policyHash: row.oldPolicyHash! },
    newRevision: {
      id: row.newRevisionId,
      revision: row.newRevision,
      policyHash: row.newPolicyHash,
    },
    actorSubjectId: row.actorSubjectId,
    reason: row.reason,
    createdAt: iso(row.createdAt),
  };
}

async function currentSlackTaskPolicyHead(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<SlackTaskPolicyHead | null> {
  return (await getActiveSlackTaskPolicy(db, { accountId, workspaceId }))?.head ?? null;
}

export async function getActiveSlackTaskPolicy(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<{ head: SlackTaskPolicyHead; revision: SlackTaskPolicyRevision } | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        head: schema.slackTaskPolicyHeads,
        revision: schema.slackTaskPolicyRevisions,
      })
      .from(schema.slackTaskPolicyHeads)
      .innerJoin(
        schema.slackTaskPolicyRevisions,
        and(
          eq(schema.slackTaskPolicyRevisions.id, schema.slackTaskPolicyHeads.revisionId),
          eq(schema.slackTaskPolicyRevisions.workspaceId, schema.slackTaskPolicyHeads.workspaceId),
        ),
      )
      .where(
        and(
          eq(schema.slackTaskPolicyHeads.accountId, input.accountId),
          eq(schema.slackTaskPolicyHeads.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    return row ? { head: headFromRow(row.head), revision: revisionFromRow(row.revision) } : null;
  });
}

export async function listSlackTaskPolicy(
  db: Database,
  input: { accountId: string; workspaceId: string; limit?: number },
): Promise<SlackTaskPolicyListResponse> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const limit = Math.max(1, Math.min(100, input.limit ?? 50));
    const [active, revisions, events] = await Promise.all([
      getActiveSlackTaskPolicy(scopedDb, input),
      scopedDb
        .select()
        .from(schema.slackTaskPolicyRevisions)
        .where(eq(schema.slackTaskPolicyRevisions.workspaceId, input.workspaceId))
        .orderBy(desc(schema.slackTaskPolicyRevisions.revision))
        .limit(limit),
      scopedDb
        .select()
        .from(schema.slackTaskPolicyActivationEvents)
        .where(eq(schema.slackTaskPolicyActivationEvents.workspaceId, input.workspaceId))
        .orderBy(desc(schema.slackTaskPolicyActivationEvents.activationVersion))
        .limit(limit),
    ]);
    return {
      current: active?.head ?? null,
      activeRevision: active?.revision ?? null,
      revisions: revisions.map(revisionFromRow),
      activationEvents: events.map(eventFromRow),
    };
  });
}

export async function updateSlackTaskPolicy(
  db: Database,
  input: {
    operationId?: string;
    accountId: string;
    workspaceId: string;
    policy: SlackTaskPolicyContent;
    expectedCurrentRevisionId: string | null;
    expectedActivationVersion: number;
    actorSubjectId: string;
    principalKind: "human_session" | undefined;
    reason: string;
  },
): Promise<SlackTaskPolicyMutationResponse> {
  if (input.principalKind !== "human_session" || input.actorSubjectId.trim().length === 0) {
    throw new SlackTaskPolicyAuthorityError(
      "Slack task-policy changes require an exact authenticated human actor",
    );
  }
  const operationId = input.operationId ?? randomUUID();
  const policy = canonicalizeSlackTaskPolicy(input.policy);
  const requestFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "slack_task_policy_operation",
        1,
        input.accountId,
        input.workspaceId,
        policy,
        input.expectedCurrentRevisionId,
        input.expectedActivationVersion,
        input.actorSubjectId,
        input.reason,
      ]),
      "utf8",
    )
    .digest("hex");

  try {
    return await withRlsContext(db, input, async (scopedDb) => {
      await scopedDb.execute(
        sql`select set_config('opengeni.subject_id', ${input.actorSubjectId}, true)`,
      );
      await scopedDb.execute(
        sql`select set_config('opengeni.principal_kind', 'human_session', true)`,
      );
      const [receipt] = await rawRows<{ revisionId: string; eventId: string }>(
        scopedDb,
        sql`select revision_id as "revisionId", event_id as "eventId"
            from slack_task_policy_update(
              ${operationId}::uuid,
              ${requestFingerprint},
              ${input.accountId}::uuid,
              ${input.workspaceId}::uuid,
              ${JSON.stringify(policy)}::jsonb,
              ${input.expectedCurrentRevisionId}::uuid,
              ${input.expectedActivationVersion}::bigint,
              ${input.actorSubjectId},
              ${input.reason}
            )`,
      );
      if (!receipt) throw new Error("Slack task-policy update returned no lifecycle receipt");
      const [[revision], [head], [event]] = await Promise.all([
        scopedDb
          .select()
          .from(schema.slackTaskPolicyRevisions)
          .where(eq(schema.slackTaskPolicyRevisions.id, receipt.revisionId))
          .limit(1),
        scopedDb
          .select()
          .from(schema.slackTaskPolicyHeads)
          .where(eq(schema.slackTaskPolicyHeads.workspaceId, input.workspaceId))
          .limit(1),
        scopedDb
          .select()
          .from(schema.slackTaskPolicyActivationEvents)
          .where(eq(schema.slackTaskPolicyActivationEvents.id, receipt.eventId))
          .limit(1),
      ]);
      if (!revision || !head || !event) {
        throw new Error("Slack task-policy lifecycle receipt was incomplete");
      }
      return {
        revision: revisionFromRow(revision),
        head: headFromRow(head),
        event: eventFromRow(event),
      };
    });
  } catch (error) {
    const state = nestedPostgresSqlState(error);
    if (state === "P1471") throw new SlackTaskPolicyOperationReuseError();
    if (state === "40001") {
      throw new SlackTaskPolicyConflictError(
        await currentSlackTaskPolicyHead(db, input.accountId, input.workspaceId),
      );
    }
    if (state === "42501") {
      throw new SlackTaskPolicyAuthorityError(error instanceof Error ? error.message : undefined);
    }
    if (state === "22023") throw new SlackTaskPolicyInvalidOperationError();
    throw error;
  }
}

function originFromRow(row: OriginRow): SlackSharedTaskOrigin {
  return { ...row };
}

export async function saveSlackSharedTaskOrigin(
  db: Database,
  input: Omit<SlackSharedTaskOrigin, "createdAt">,
): Promise<SlackSharedTaskOrigin> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [created] = await scopedDb
      .insert(schema.slackSharedTaskOrigins)
      .values(input)
      .onConflictDoNothing({ target: schema.slackSharedTaskOrigins.interactionId })
      .returning();
    if (created) return originFromRow(created);
    const [existing] = await scopedDb
      .select()
      .from(schema.slackSharedTaskOrigins)
      .where(eq(schema.slackSharedTaskOrigins.interactionId, input.interactionId))
      .limit(1);
    if (!existing) throw new Error("Slack shared-task origin conflict could not be resolved");
    for (const [key, value] of Object.entries(input)) {
      if (existing[key as keyof OriginRow] !== value) {
        throw new SlackTaskPolicyInvalidOperationError(
          "Slack shared-task origin identity conflicted with immutable evidence",
        );
      }
    }
    return originFromRow(existing);
  });
}

export async function getSlackSharedTaskOrigin(
  db: Database,
  input: { accountId: string; workspaceId: string; interactionId: string },
): Promise<SlackSharedTaskOrigin | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.slackSharedTaskOrigins)
      .where(
        and(
          eq(schema.slackSharedTaskOrigins.accountId, input.accountId),
          eq(schema.slackSharedTaskOrigins.workspaceId, input.workspaceId),
          eq(schema.slackSharedTaskOrigins.interactionId, input.interactionId),
        ),
      )
      .limit(1);
    return row ? originFromRow(row) : null;
  });
}
