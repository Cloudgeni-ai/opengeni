import {
  WorkspaceArtifactRequestedTools,
  type ToolGatewayIdentity,
  type WorkspaceArtifact,
  type WorkspaceArtifactDetailResponse,
  type WorkspaceArtifactEvent,
  type WorkspaceArtifactMutationResponse,
  type WorkspaceArtifactVersion,
} from "@opengeni/contracts";
import { parseVerifiedAttemptToolCatalog } from "@opengeni/codemode";
import { createHash } from "node:crypto";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Database } from "./database";
import { withRlsContext, withWorkspaceRls } from "./database";
import * as schema from "./schema";

type ArtifactRow = typeof schema.workspaceArtifacts.$inferSelect;
type VersionRow = typeof schema.workspaceArtifactVersions.$inferSelect;
type EventRow = typeof schema.workspaceArtifactEvents.$inferSelect;
type ArtifactMutationToolName =
  | "artifacts_create"
  | "artifacts_publish"
  | "artifacts_rollback"
  | "artifacts_archive"
  | "artifacts_restore";

export class WorkspaceArtifactNotFoundError extends Error {
  readonly name = "WorkspaceArtifactNotFoundError";
}

export class WorkspaceArtifactConflictError extends Error {
  readonly name = "WorkspaceArtifactConflictError";
  constructor(
    message: string,
    readonly currentVersionId: string | null = null,
  ) {
    super(message);
  }
}

export class WorkspaceArtifactOperationError extends Error {
  readonly name = "WorkspaceArtifactOperationError";
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function versionFromRow(row: VersionRow): WorkspaceArtifactVersion {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    artifactId: row.artifactId,
    revision: row.revision,
    contentType: "text/html",
    contentSha256: row.contentSha256,
    sizeBytes: row.sizeBytes,
    sourceSha256: row.sourceSha256,
    sourceSizeBytes: row.sourceSizeBytes,
    requestedTools: WorkspaceArtifactRequestedTools.parse(row.requestedTools),
    sourceSessionId: row.sourceSessionId,
    sourceTurnId: row.sourceTurnId,
    sourceAttemptId: row.sourceAttemptId,
    sourceExecutionGeneration: row.sourceExecutionGeneration,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  };
}

function eventFromRow(row: EventRow): WorkspaceArtifactEvent {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    artifactId: row.artifactId,
    type: row.type,
    fromVersionId: row.fromVersionId,
    toVersionId: row.toVersionId,
    sourceSessionId: row.sourceSessionId,
    sourceTurnId: row.sourceTurnId,
    sourceAttemptId: row.sourceAttemptId,
    sourceExecutionGeneration: row.sourceExecutionGeneration,
    actorSubjectId: row.actorSubjectId,
    reason: row.reason,
    createdAt: iso(row.createdAt),
  };
}

function artifactFromRow(row: ArtifactRow, version: VersionRow | null): WorkspaceArtifact {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    currentVersion: version ? versionFromRow(version) : null,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

async function currentVersion(scopedDb: any, artifact: ArtifactRow): Promise<VersionRow | null> {
  if (!artifact.currentVersionId) return null;
  const [row] = await scopedDb
    .select()
    .from(schema.workspaceArtifactVersions)
    .where(
      and(
        eq(schema.workspaceArtifactVersions.workspaceId, artifact.workspaceId),
        eq(schema.workspaceArtifactVersions.id, artifact.currentVersionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function artifactRow(scopedDb: any, workspaceId: string, artifactId: string, lock = false) {
  let query = scopedDb
    .select()
    .from(schema.workspaceArtifacts)
    .where(
      and(
        eq(schema.workspaceArtifacts.workspaceId, workspaceId),
        eq(schema.workspaceArtifacts.id, artifactId),
      ),
    )
    .limit(1);
  if (lock) query = query.for("update");
  const [row] = await query;
  return (row as ArtifactRow | undefined) ?? null;
}

export async function listWorkspaceArtifacts(
  db: Database,
  workspaceId: string,
  options: {
    limit?: number;
    cursor?: string;
    status?: "active" | "archived";
  } = {},
): Promise<{
  artifacts: WorkspaceArtifact[];
  nextCursor: string | null;
  truncated: boolean;
}> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const cursor = options.cursor ? decodeListCursor(options.cursor) : null;
    const visibility = and(
      eq(schema.workspaceArtifacts.workspaceId, workspaceId),
      ...(options.status ? [eq(schema.workspaceArtifacts.status, options.status)] : []),
      ...(cursor
        ? [
            or(
              lt(schema.workspaceArtifacts.updatedAt, cursor.updatedAt),
              and(
                eq(schema.workspaceArtifacts.updatedAt, cursor.updatedAt),
                lt(schema.workspaceArtifacts.id, cursor.id),
              ),
            ),
          ]
        : []),
    );
    const rows = await scopedDb
      .select()
      .from(schema.workspaceArtifacts)
      .where(visibility)
      .orderBy(desc(schema.workspaceArtifacts.updatedAt), desc(schema.workspaceArtifacts.id))
      .limit(limit + 1);
    const truncated = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const artifacts = await Promise.all(
      pageRows.map(async (row) => artifactFromRow(row, await currentVersion(scopedDb, row))),
    );
    const tail = truncated ? pageRows.at(-1) : null;
    return {
      artifacts,
      nextCursor: tail ? encodeListCursor(tail) : null,
      truncated,
    };
  });
}

const artifactCursorId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeListCursor(row: ArtifactRow): string {
  return Buffer.from(JSON.stringify([iso(row.updatedAt), row.id]), "utf8").toString("base64url");
}

function decodeListCursor(value: string): { updatedAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !artifactCursorId.test(parsed[1])
    ) {
      throw new Error("invalid shape");
    }
    const updatedAt = new Date(parsed[0]);
    if (!Number.isFinite(updatedAt.getTime())) throw new Error("invalid timestamp");
    return { updatedAt, id: parsed[1] };
  } catch {
    throw new WorkspaceArtifactOperationError("Invalid artifact list cursor");
  }
}

export async function getWorkspaceArtifact(
  db: Database,
  workspaceId: string,
  artifactId: string,
): Promise<WorkspaceArtifactDetailResponse> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const artifact = await artifactRow(scopedDb, workspaceId, artifactId);
    if (!artifact) throw new WorkspaceArtifactNotFoundError("Artifact not found");
    const [versionRows, eventRows, current] = await Promise.all([
      scopedDb
        .select()
        .from(schema.workspaceArtifactVersions)
        .where(
          and(
            eq(schema.workspaceArtifactVersions.workspaceId, workspaceId),
            eq(schema.workspaceArtifactVersions.artifactId, artifactId),
          ),
        )
        .orderBy(desc(schema.workspaceArtifactVersions.revision))
        .limit(101),
      scopedDb
        .select()
        .from(schema.workspaceArtifactEvents)
        .where(
          and(
            eq(schema.workspaceArtifactEvents.workspaceId, workspaceId),
            eq(schema.workspaceArtifactEvents.artifactId, artifactId),
          ),
        )
        .orderBy(desc(schema.workspaceArtifactEvents.createdAt))
        .limit(101),
      currentVersion(scopedDb, artifact),
    ]);
    return {
      artifact: artifactFromRow(artifact, current),
      versions: versionRows.slice(0, 100).map(versionFromRow),
      events: eventRows.slice(0, 100).map(eventFromRow),
      versionsTruncated: versionRows.length > 100,
      eventsTruncated: eventRows.length > 100,
    };
  });
}

export async function getWorkspaceArtifactContentRef(
  db: Database,
  workspaceId: string,
  artifactId: string,
  versionId?: string,
): Promise<{
  artifactId: string;
  version: WorkspaceArtifactVersion;
  contentKey: string;
  sourceKey: string | null;
}> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const artifact = await artifactRow(scopedDb, workspaceId, artifactId);
    if (!artifact) throw new WorkspaceArtifactNotFoundError("Artifact not found");
    const targetId = versionId ?? artifact.currentVersionId;
    if (!targetId) throw new WorkspaceArtifactNotFoundError("Artifact has no published version");
    const [version] = await scopedDb
      .select()
      .from(schema.workspaceArtifactVersions)
      .where(
        and(
          eq(schema.workspaceArtifactVersions.workspaceId, workspaceId),
          eq(schema.workspaceArtifactVersions.artifactId, artifactId),
          eq(schema.workspaceArtifactVersions.id, targetId),
        ),
      )
      .limit(1);
    if (!version) throw new WorkspaceArtifactNotFoundError("Artifact version not found");
    return {
      artifactId,
      version: versionFromRow(version),
      contentKey: version.contentKey,
      sourceKey: version.sourceKey,
    };
  });
}

type PublishMetadata = {
  accountId: string;
  workspaceId: string;
  contentKey: string;
  contentSha256: string;
  sizeBytes: number;
  sourceKey: string;
  sourceSha256: string;
  sourceSizeBytes: number;
  requestedTools?: ToolGatewayIdentity[];
  operationKey: string;
  actorSubjectId: string;
  sourceSessionId: string | null;
  sourceTurnId: string | null;
  sourceAttemptId: string | null;
  sourceExecutionGeneration: number | null;
  sourceToolName: ArtifactMutationToolName | null;
  persistContent: () => Promise<void>;
  discardContent: () => Promise<void>;
};

async function discardPersistedArtifactContent(
  input: Pick<PublishMetadata, "discardContent">,
  error: unknown,
): Promise<never> {
  await input.discardContent().catch(() => undefined);
  throw error;
}

type ArtifactOperationReplay = NonNullable<Awaited<ReturnType<typeof replayForOperation>>>;

function persistedArtifactContentIsReferenced(
  replay: ArtifactOperationReplay,
  input: Pick<PublishMetadata, "contentKey" | "sourceKey">,
): boolean {
  return (
    replay.version.contentKey === input.contentKey || replay.version.sourceKey === input.sourceKey
  );
}

async function reconcilePersistedArtifactMutation(
  db: Database,
  input: PublishMetadata,
  error: unknown,
  validateReplay: (replay: ArtifactOperationReplay) => void,
): Promise<WorkspaceArtifactMutationResponse> {
  let replay: ArtifactOperationReplay | null;
  try {
    replay = await withRlsContext(
      db,
      { accountId: input.accountId, workspaceId: input.workspaceId },
      async (scopedDb) => {
        await lockOperation(scopedDb, input.workspaceId, input.operationKey);
        return await replayForOperation(scopedDb, input.workspaceId, input.operationKey);
      },
    );
  } catch {
    // The transaction outcome is still unknown. Leaking an unreferenced object
    // is recoverable; deleting content that may have committed is not.
    throw error;
  }
  if (!replay) return await discardPersistedArtifactContent(input, error);
  try {
    validateReplay(replay);
  } catch (replayError) {
    if (!persistedArtifactContentIsReferenced(replay, input)) {
      await input.discardContent().catch(() => undefined);
    }
    throw replayError;
  }
  if (!persistedArtifactContentIsReferenced(replay, input)) {
    await input.discardContent().catch(() => undefined);
  }
  return mutationResult(
    replay.artifact,
    replay.version,
    replay.event,
    true,
    replay.current ?? replay.version,
  );
}

async function assertAttemptAuthority(
  scopedDb: any,
  input: Pick<
    PublishMetadata,
    | "accountId"
    | "workspaceId"
    | "actorSubjectId"
    | "sourceSessionId"
    | "sourceTurnId"
    | "sourceAttemptId"
    | "sourceExecutionGeneration"
    | "sourceToolName"
  >,
): Promise<void> {
  const provenance = [
    input.sourceSessionId,
    input.sourceTurnId,
    input.sourceAttemptId,
    input.sourceExecutionGeneration,
  ];
  if (provenance.every((value) => value === null)) return;
  if (provenance.some((value) => value === null) || input.sourceToolName === null) {
    throw new WorkspaceArtifactOperationError("Artifact attempt provenance is incomplete");
  }
  const rows = (await scopedDb.execute(sql`
    WITH locked_workspace AS MATERIALIZED (
      SELECT workspace.id, workspace.account_id
      FROM workspaces workspace
      WHERE workspace.id = ${input.workspaceId}::uuid
        AND workspace.account_id = ${input.accountId}::uuid
      FOR KEY SHARE OF workspace
    ), locked_session AS MATERIALIZED (
      SELECT session.id, session.account_id, session.workspace_id, session.active_turn_id,
        session.first_party_mcp_tools, session.first_party_mcp_permissions
      FROM sessions session
      JOIN locked_workspace workspace
        ON workspace.id = session.workspace_id
        AND workspace.account_id = session.account_id
      WHERE session.id = ${input.sourceSessionId}::uuid
        AND session.active_turn_id = ${input.sourceTurnId}::uuid
        AND session.first_party_mcp_tools @> jsonb_build_array(${input.sourceToolName}::text)
        AND (
          session.first_party_mcp_permissions IS NULL
          OR session.first_party_mcp_permissions @> '["artifacts:publish"]'::jsonb
        )
      FOR NO KEY UPDATE OF session
    ), locked_turn AS MATERIALIZED (
      SELECT turn.id, turn.account_id, turn.workspace_id, turn.session_id,
        turn.active_attempt_id, turn.execution_generation, turn.initiator_subject_id
      FROM session_turns turn
      JOIN locked_session session
        ON session.id = turn.session_id
        AND session.workspace_id = turn.workspace_id
        AND session.account_id = turn.account_id
      WHERE turn.id = ${input.sourceTurnId}::uuid
        AND turn.active_attempt_id = ${input.sourceAttemptId}::uuid
        AND turn.execution_generation = ${input.sourceExecutionGeneration}
        AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
        AND turn.initiator_kind = 'subject'
        AND length(btrim(turn.initiator_subject_id)) BETWEEN 1 AND 1024
      FOR UPDATE OF turn
    ), locked_attempt AS MATERIALIZED (
      SELECT attempt.id, attempt.account_id, attempt.workspace_id,
        attempt.session_id, attempt.turn_id, attempt.execution_generation
      FROM session_turn_attempts attempt
      JOIN locked_turn turn
        ON turn.id = attempt.turn_id
        AND turn.session_id = attempt.session_id
        AND turn.workspace_id = attempt.workspace_id
        AND turn.account_id = attempt.account_id
      WHERE attempt.id = ${input.sourceAttemptId}::uuid
        AND attempt.execution_generation = ${input.sourceExecutionGeneration}
        AND attempt.state IN ('claimed', 'running')
        AND NOT EXISTS (
          SELECT 1 FROM session_attempt_interruptions interruption
          WHERE interruption.workspace_id = attempt.workspace_id
            AND interruption.attempt_id = attempt.id
            AND interruption.state IN ('pending', 'delivered', 'acknowledged')
        )
      FOR UPDATE OF attempt
    )
    SELECT attempt.id
    FROM locked_session session
    JOIN locked_turn turn ON true
    JOIN locked_attempt attempt ON true
  `)) as unknown as Array<{ id: string }>;
  if (!rows[0]) {
    throw new WorkspaceArtifactOperationError(
      "Artifact mutation requires the exact active attempt and execution generation",
    );
  }
}

async function assertArtifactRequestedToolAuthority(
  scopedDb: any,
  input: Pick<
    PublishMetadata,
    | "accountId"
    | "workspaceId"
    | "sourceSessionId"
    | "sourceTurnId"
    | "sourceAttemptId"
    | "sourceExecutionGeneration"
  >,
  requestedTools: readonly ToolGatewayIdentity[],
): Promise<void> {
  if (input.sourceAttemptId === null || requestedTools.length === 0) return;
  if (
    input.sourceSessionId === null ||
    input.sourceTurnId === null ||
    input.sourceExecutionGeneration === null
  ) {
    throw new WorkspaceArtifactOperationError("Artifact attempt provenance is incomplete");
  }
  const [row] = await scopedDb
    .select({ catalog: schema.sessionAttemptToolCatalogs.catalog })
    .from(schema.sessionAttemptToolCatalogs)
    .where(
      and(
        eq(schema.sessionAttemptToolCatalogs.accountId, input.accountId),
        eq(schema.sessionAttemptToolCatalogs.workspaceId, input.workspaceId),
        eq(schema.sessionAttemptToolCatalogs.sessionId, input.sourceSessionId),
        eq(schema.sessionAttemptToolCatalogs.turnId, input.sourceTurnId),
        eq(schema.sessionAttemptToolCatalogs.attemptId, input.sourceAttemptId),
        eq(schema.sessionAttemptToolCatalogs.executionGeneration, input.sourceExecutionGeneration),
      ),
    )
    .limit(1);
  let allowed: Map<string, "none" | "human" | "policy">;
  try {
    const catalog = parseVerifiedAttemptToolCatalog(row?.catalog);
    allowed = new Map(
      catalog.entries.map((entry): [string, "none" | "human" | "policy"] => [
        toolIdentityKey(entry.identity),
        entry.approval,
      ]),
    );
  } catch {
    throw new WorkspaceArtifactOperationError(
      "Artifact requested tool authority is unavailable for the exact attempt",
    );
  }
  if (requestedTools.some((identity) => !allowed.has(toolIdentityKey(identity)))) {
    throw new WorkspaceArtifactOperationError(
      "Artifact requested tools must be present in the exact attempt tool catalog",
    );
  }
  if (requestedTools.some((identity) => allowed.get(toolIdentityKey(identity)) !== "none")) {
    throw new WorkspaceArtifactOperationError(
      "Agent-authored Site versions cannot activate tools requiring policy or current-human approval",
    );
  }
}

function toolIdentityKey(identity: ToolGatewayIdentity): string {
  return `${identity.serverId}\u0000${identity.toolName}`;
}

async function replayForOperation(scopedDb: any, workspaceId: string, operationKey: string) {
  const [event] = await scopedDb
    .select()
    .from(schema.workspaceArtifactEvents)
    .where(
      and(
        eq(schema.workspaceArtifactEvents.workspaceId, workspaceId),
        eq(schema.workspaceArtifactEvents.operationKey, operationKey),
      ),
    )
    .limit(1);
  if (!event) return null;
  const artifact = await artifactRow(scopedDb, workspaceId, event.artifactId);
  if (!artifact) return null;
  const [version] = await scopedDb
    .select()
    .from(schema.workspaceArtifactVersions)
    .where(
      and(
        eq(schema.workspaceArtifactVersions.workspaceId, workspaceId),
        eq(schema.workspaceArtifactVersions.id, event.toVersionId),
      ),
    )
    .limit(1);
  if (!version) return null;
  let fromVersion: VersionRow | null = null;
  if (event.fromVersionId) {
    const [row] = await scopedDb
      .select()
      .from(schema.workspaceArtifactVersions)
      .where(
        and(
          eq(schema.workspaceArtifactVersions.workspaceId, workspaceId),
          eq(schema.workspaceArtifactVersions.id, event.fromVersionId),
        ),
      )
      .limit(1);
    fromVersion = row ?? null;
  }
  return {
    artifact,
    version,
    fromVersion,
    event,
    current: await currentVersion(scopedDb, artifact),
  } as const;
}

async function lockOperation(scopedDb: any, workspaceId: string, operationKey: string) {
  await scopedDb.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${operationKey}`}, 0))`,
  );
}

function assertCreateReplay(replay: Awaited<ReturnType<typeof replayForOperation>>) {
  if (
    !replay ||
    replay.event.type !== "published" ||
    replay.event.fromVersionId !== null ||
    replay.version.revision !== 1
  ) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used for a different operation",
    );
  }
}

function assertCreateReplayMatchesInput(
  replay: ArtifactOperationReplay,
  input: PublishMetadata & {
    slug: string;
    title: string;
    description: string | null;
    requestedSlug?: string | null;
  },
): void {
  assertCreateReplay(replay);
  const requestDigest = createArtifactRequestDigest(input);
  if (replay.event.requestDigest !== null && replay.event.requestDigest !== requestDigest) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used with different artifact metadata",
    );
  }
  if (replay.version.contentSha256 !== input.contentSha256) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used with different content",
    );
  }
  assertReplayVersionMetadata(replay.version, input, input.requestedTools ?? []);
}

function assertPublishReplay(
  replay: Awaited<ReturnType<typeof replayForOperation>>,
  artifactId: string,
  expectedCurrentVersionId: string,
) {
  if (
    !replay ||
    replay.event.type !== "published" ||
    replay.event.artifactId !== artifactId ||
    replay.event.fromVersionId !== expectedCurrentVersionId
  ) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used for a different operation",
    );
  }
}

function assertPublishReplayMatchesInput(
  replay: ArtifactOperationReplay,
  input: PublishMetadata & {
    artifactId: string;
    expectedCurrentVersionId: string;
  },
): void {
  assertPublishReplay(replay, input.artifactId, input.expectedCurrentVersionId);
  const expectedRequestedTools = input.requestedTools ?? replay.fromVersion?.requestedTools;
  if (!expectedRequestedTools) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used for a publication with missing source authority",
    );
  }
  const requestDigest = publishArtifactRequestDigest(input, expectedRequestedTools);
  if (replay.event.requestDigest !== null && replay.event.requestDigest !== requestDigest) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used with different publication metadata",
    );
  }
  if (replay.version.contentSha256 !== input.contentSha256) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used with different content",
    );
  }
  assertReplayVersionMetadata(replay.version, input, expectedRequestedTools);
}

function hashArtifactRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function createArtifactRequestDigest(
  input: PublishMetadata & {
    slug: string;
    title: string;
    description: string | null;
    requestedSlug?: string | null;
  },
): string {
  return hashArtifactRequest({
    version: 1,
    operation: "create",
    requestedSlug: input.requestedSlug === undefined ? input.slug : input.requestedSlug,
    title: input.title,
    description: input.description,
    contentSha256: input.contentSha256,
    sourceSha256: input.sourceSha256,
    requestedTools: input.requestedTools ?? [],
  });
}

function publishArtifactRequestDigest(
  input: PublishMetadata & {
    artifactId: string;
    expectedCurrentVersionId: string;
    title?: string;
    description?: string | null;
  },
  requestedTools: readonly ToolGatewayIdentity[],
): string {
  return hashArtifactRequest({
    version: 1,
    operation: "publish",
    artifactId: input.artifactId,
    expectedCurrentVersionId: input.expectedCurrentVersionId,
    title: input.title === undefined ? { present: false } : { present: true, value: input.title },
    description:
      input.description === undefined
        ? { present: false }
        : { present: true, value: input.description },
    contentSha256: input.contentSha256,
    sourceSha256: input.sourceSha256,
    requestedTools,
  });
}

function assertRollbackReplay(
  replay: Awaited<ReturnType<typeof replayForOperation>>,
  artifactId: string,
  versionId: string,
  expectedCurrentVersionId: string,
  reason: string,
) {
  if (
    !replay ||
    replay.event.type !== "rolled_back" ||
    replay.event.artifactId !== artifactId ||
    replay.event.toVersionId !== versionId ||
    replay.event.fromVersionId !== expectedCurrentVersionId ||
    replay.event.reason !== reason
  ) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used for a different operation",
    );
  }
}

function assertStatusReplay(
  replay: Awaited<ReturnType<typeof replayForOperation>>,
  artifactId: string,
  status: "active" | "archived",
  expectedCurrentVersionId: string,
  reason: string,
) {
  const expectedType = status === "archived" ? "archived" : "restored";
  if (
    !replay ||
    replay.event.type !== expectedType ||
    replay.event.artifactId !== artifactId ||
    replay.event.fromVersionId !== expectedCurrentVersionId ||
    replay.event.toVersionId !== expectedCurrentVersionId ||
    replay.event.reason !== reason
  ) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used for a different operation",
    );
  }
}

function mutationResult(
  artifact: ArtifactRow,
  version: VersionRow,
  event: EventRow,
  replayed: boolean,
  displayedCurrentVersion: VersionRow = version,
): WorkspaceArtifactMutationResponse {
  return {
    artifact: artifactFromRow(artifact, displayedCurrentVersion),
    version: versionFromRow(version),
    event: eventFromRow(event),
    replayed,
  };
}

export async function createWorkspaceArtifact(
  db: Database,
  input: PublishMetadata & {
    artifactId: string;
    slug: string;
    title: string;
    description: string | null;
    requestedSlug?: string | null;
  },
): Promise<WorkspaceArtifactMutationResponse> {
  let contentPersisted = false;
  try {
    return await withRlsContext(
      db,
      { accountId: input.accountId, workspaceId: input.workspaceId },
      async (scopedDb) => {
        return await scopedDb.transaction(async (tx) => {
          await lockOperation(tx, input.workspaceId, input.operationKey);
          const replay = await replayForOperation(tx, input.workspaceId, input.operationKey);
          if (replay) {
            assertCreateReplayMatchesInput(replay, input);
            return mutationResult(
              replay.artifact,
              replay.version,
              replay.event,
              true,
              replay.current ?? replay.version,
            );
          }
          await assertAttemptAuthority(tx, input);
          await assertArtifactRequestedToolAuthority(tx, input, input.requestedTools ?? []);
          await input.persistContent();
          contentPersisted = true;
          const [artifact] = await tx
            .insert(schema.workspaceArtifacts)
            .values({
              id: input.artifactId,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              slug: input.slug,
              title: input.title,
              description: input.description,
              createdBySubjectId: input.actorSubjectId,
            })
            .returning();
          const [version] = await tx
            .insert(schema.workspaceArtifactVersions)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              artifactId: input.artifactId,
              revision: 1,
              contentKey: input.contentKey,
              contentSha256: input.contentSha256,
              sizeBytes: input.sizeBytes,
              sourceKey: input.sourceKey,
              sourceSha256: input.sourceSha256,
              sourceSizeBytes: input.sourceSizeBytes,
              requestedTools: input.requestedTools ?? [],
              operationKey: input.operationKey,
              sourceSessionId: input.sourceSessionId,
              sourceTurnId: input.sourceTurnId,
              sourceAttemptId: input.sourceAttemptId,
              sourceExecutionGeneration: input.sourceExecutionGeneration,
              createdBySubjectId: input.actorSubjectId,
            })
            .returning();
          const [updated] = await tx
            .update(schema.workspaceArtifacts)
            .set({
              currentVersionId: version!.id,
              updatedAt: new Date(),
            })
            .where(eq(schema.workspaceArtifacts.id, artifact!.id))
            .returning();
          const [event] = await tx
            .insert(schema.workspaceArtifactEvents)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              artifactId: input.artifactId,
              type: "published",
              fromVersionId: null,
              toVersionId: version!.id,
              operationKey: input.operationKey,
              requestDigest: createArtifactRequestDigest(input),
              sourceSessionId: input.sourceSessionId,
              sourceTurnId: input.sourceTurnId,
              sourceAttemptId: input.sourceAttemptId,
              sourceExecutionGeneration: input.sourceExecutionGeneration,
              actorSubjectId: input.actorSubjectId,
              reason: "Initial publication",
            })
            .returning();
          return mutationResult(updated!, version!, event!, false);
        });
      },
    );
  } catch (error) {
    if (contentPersisted) {
      return await reconcilePersistedArtifactMutation(db, input, error, (replay) => {
        assertCreateReplayMatchesInput(replay, input);
      });
    }
    throw error;
  }
}

export async function publishWorkspaceArtifactVersion(
  db: Database,
  input: PublishMetadata & {
    artifactId: string;
    expectedCurrentVersionId: string;
    title?: string;
    description?: string | null;
  },
): Promise<WorkspaceArtifactMutationResponse> {
  let contentPersisted = false;
  try {
    return await withRlsContext(
      db,
      { accountId: input.accountId, workspaceId: input.workspaceId },
      async (scopedDb) => {
        return await scopedDb.transaction(async (tx) => {
          await lockOperation(tx, input.workspaceId, input.operationKey);
          const replay = await replayForOperation(tx, input.workspaceId, input.operationKey);
          if (replay) {
            assertPublishReplayMatchesInput(replay, input);
            return mutationResult(
              replay.artifact,
              replay.version,
              replay.event,
              true,
              replay.current ?? replay.version,
            );
          }
          await assertAttemptAuthority(tx, input);
          const artifact = await artifactRow(tx, input.workspaceId, input.artifactId, true);
          if (!artifact) throw new WorkspaceArtifactNotFoundError("Artifact not found");
          if (artifact.status !== "active") {
            throw new WorkspaceArtifactOperationError("Archived artifacts cannot be published");
          }
          if (artifact.currentVersionId !== input.expectedCurrentVersionId) {
            throw new WorkspaceArtifactConflictError(
              "Artifact changed in another request",
              artifact.currentVersionId,
            );
          }
          const current = await currentVersion(tx, artifact);
          if (!current) throw new WorkspaceArtifactNotFoundError("Artifact has no current version");
          await assertArtifactRequestedToolAuthority(
            tx,
            input,
            input.requestedTools ?? current.requestedTools,
          );
          const [latest] = await tx
            .select()
            .from(schema.workspaceArtifactVersions)
            .where(
              and(
                eq(schema.workspaceArtifactVersions.workspaceId, input.workspaceId),
                eq(schema.workspaceArtifactVersions.artifactId, input.artifactId),
              ),
            )
            .orderBy(desc(schema.workspaceArtifactVersions.revision))
            .limit(1);
          await input.persistContent();
          contentPersisted = true;
          const [version] = await tx
            .insert(schema.workspaceArtifactVersions)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              artifactId: input.artifactId,
              revision: (latest?.revision ?? 0) + 1,
              contentKey: input.contentKey,
              contentSha256: input.contentSha256,
              sizeBytes: input.sizeBytes,
              sourceKey: input.sourceKey,
              sourceSha256: input.sourceSha256,
              sourceSizeBytes: input.sourceSizeBytes,
              requestedTools: input.requestedTools ?? current.requestedTools,
              operationKey: input.operationKey,
              sourceSessionId: input.sourceSessionId,
              sourceTurnId: input.sourceTurnId,
              sourceAttemptId: input.sourceAttemptId,
              sourceExecutionGeneration: input.sourceExecutionGeneration,
              createdBySubjectId: input.actorSubjectId,
            })
            .returning();
          const update: Partial<typeof schema.workspaceArtifacts.$inferInsert> = {
            currentVersionId: version!.id,
            updatedAt: new Date(),
          };
          if (input.title !== undefined) update.title = input.title;
          if (input.description !== undefined) update.description = input.description;
          const [updated] = await tx
            .update(schema.workspaceArtifacts)
            .set(update)
            .where(eq(schema.workspaceArtifacts.id, artifact.id))
            .returning();
          const [event] = await tx
            .insert(schema.workspaceArtifactEvents)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              artifactId: input.artifactId,
              type: "published",
              fromVersionId: artifact.currentVersionId,
              toVersionId: version!.id,
              operationKey: input.operationKey,
              requestDigest: publishArtifactRequestDigest(
                input,
                input.requestedTools ?? current.requestedTools,
              ),
              sourceSessionId: input.sourceSessionId,
              sourceTurnId: input.sourceTurnId,
              sourceAttemptId: input.sourceAttemptId,
              sourceExecutionGeneration: input.sourceExecutionGeneration,
              actorSubjectId: input.actorSubjectId,
              reason: `Published revision ${version!.revision}`,
            })
            .returning();
          return mutationResult(updated!, version!, event!, false);
        });
      },
    );
  } catch (error) {
    if (contentPersisted) {
      return await reconcilePersistedArtifactMutation(db, input, error, (replay) => {
        assertPublishReplayMatchesInput(replay, input);
      });
    }
    throw error;
  }
}

export async function rollbackWorkspaceArtifact(
  db: Database,
  input: Omit<
    PublishMetadata,
    | "contentKey"
    | "contentSha256"
    | "sizeBytes"
    | "sourceKey"
    | "sourceSha256"
    | "sourceSizeBytes"
    | "requestedTools"
    | "persistContent"
    | "discardContent"
  > & {
    artifactId: string;
    versionId: string;
    expectedCurrentVersionId: string;
    reason: string;
  },
): Promise<WorkspaceArtifactMutationResponse> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      return await scopedDb.transaction(async (tx) => {
        await lockOperation(tx, input.workspaceId, input.operationKey);
        const replay = await replayForOperation(tx, input.workspaceId, input.operationKey);
        if (replay) {
          assertRollbackReplay(
            replay,
            input.artifactId,
            input.versionId,
            input.expectedCurrentVersionId,
            input.reason,
          );
          return mutationResult(
            replay.artifact,
            replay.version,
            replay.event,
            true,
            replay.current ?? replay.version,
          );
        }
        await assertAttemptAuthority(tx, input);
        const artifact = await artifactRow(tx, input.workspaceId, input.artifactId, true);
        if (!artifact) throw new WorkspaceArtifactNotFoundError("Artifact not found");
        if (artifact.status !== "active") {
          throw new WorkspaceArtifactOperationError("Archived artifacts cannot be rolled back");
        }
        if (artifact.currentVersionId !== input.expectedCurrentVersionId)
          throw new WorkspaceArtifactConflictError(
            "Artifact changed in another request",
            artifact.currentVersionId,
          );
        const [target] = await tx
          .select()
          .from(schema.workspaceArtifactVersions)
          .where(
            and(
              eq(schema.workspaceArtifactVersions.workspaceId, input.workspaceId),
              eq(schema.workspaceArtifactVersions.artifactId, input.artifactId),
              eq(schema.workspaceArtifactVersions.id, input.versionId),
            ),
          )
          .limit(1);
        if (!target) throw new WorkspaceArtifactNotFoundError("Artifact version not found");
        await assertArtifactRequestedToolAuthority(tx, input, target.requestedTools);
        const [updated] = await tx
          .update(schema.workspaceArtifacts)
          .set({ currentVersionId: target.id, updatedAt: new Date() })
          .where(eq(schema.workspaceArtifacts.id, artifact.id))
          .returning();
        const [event] = await tx
          .insert(schema.workspaceArtifactEvents)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            artifactId: input.artifactId,
            type: "rolled_back",
            fromVersionId: artifact.currentVersionId,
            toVersionId: target.id,
            operationKey: input.operationKey,
            sourceSessionId: input.sourceSessionId,
            sourceTurnId: input.sourceTurnId,
            sourceAttemptId: input.sourceAttemptId,
            sourceExecutionGeneration: input.sourceExecutionGeneration,
            actorSubjectId: input.actorSubjectId,
            reason: input.reason,
          })
          .returning();
        return mutationResult(updated!, target, event!, false);
      });
    },
  );
}

export async function setWorkspaceArtifactStatus(
  db: Database,
  input: Omit<
    PublishMetadata,
    | "contentKey"
    | "contentSha256"
    | "sizeBytes"
    | "sourceKey"
    | "sourceSha256"
    | "sourceSizeBytes"
    | "requestedTools"
    | "persistContent"
    | "discardContent"
  > & {
    artifactId: string;
    status: "active" | "archived";
    expectedCurrentVersionId: string;
    reason: string;
  },
): Promise<WorkspaceArtifactMutationResponse> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await lockOperation(tx, input.workspaceId, input.operationKey);
        const replay = await replayForOperation(tx, input.workspaceId, input.operationKey);
        if (replay) {
          assertStatusReplay(
            replay,
            input.artifactId,
            input.status,
            input.expectedCurrentVersionId,
            input.reason,
          );
          return mutationResult(
            replay.artifact,
            replay.version,
            replay.event,
            true,
            replay.current ?? replay.version,
          );
        }
        await assertAttemptAuthority(tx, input);
        const artifact = await artifactRow(tx, input.workspaceId, input.artifactId, true);
        if (!artifact) throw new WorkspaceArtifactNotFoundError("Artifact not found");
        if (artifact.currentVersionId !== input.expectedCurrentVersionId) {
          throw new WorkspaceArtifactConflictError(
            "Artifact changed in another request",
            artifact.currentVersionId,
          );
        }
        const current = await currentVersion(tx, artifact);
        if (!current) throw new WorkspaceArtifactNotFoundError("Artifact has no current version");
        if (input.status === "active") {
          await assertArtifactRequestedToolAuthority(tx, input, current.requestedTools);
        }
        if (artifact.status === input.status) {
          throw new WorkspaceArtifactOperationError(
            input.status === "archived"
              ? "Artifact is already archived"
              : "Artifact is already active",
          );
        }
        const [updated] = await tx
          .update(schema.workspaceArtifacts)
          .set({ status: input.status, updatedAt: new Date() })
          .where(eq(schema.workspaceArtifacts.id, artifact.id))
          .returning();
        const [event] = await tx
          .insert(schema.workspaceArtifactEvents)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            artifactId: input.artifactId,
            type: input.status === "archived" ? "archived" : "restored",
            fromVersionId: current.id,
            toVersionId: current.id,
            operationKey: input.operationKey,
            sourceSessionId: input.sourceSessionId,
            sourceTurnId: input.sourceTurnId,
            sourceAttemptId: input.sourceAttemptId,
            sourceExecutionGeneration: input.sourceExecutionGeneration,
            actorSubjectId: input.actorSubjectId,
            reason: input.reason,
          })
          .returning();
        return mutationResult(updated!, current, event!, false);
      }),
  );
}

function assertReplayVersionMetadata(
  version: VersionRow,
  input: PublishMetadata,
  expectedRequestedTools: ToolGatewayIdentity[],
): void {
  if (
    version.sourceSha256 !== input.sourceSha256 ||
    JSON.stringify(version.requestedTools) !== JSON.stringify(expectedRequestedTools)
  ) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used with different source or requested tools",
    );
  }
}
