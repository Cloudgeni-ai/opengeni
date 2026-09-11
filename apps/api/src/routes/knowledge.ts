import { retryWhileMissing } from "@opengeni/storage";
import { allowedFirstPartyMcpToolsForSession } from "@opengeni/config";
import {
  type FirstPartyMcpToolName,
  AgentLearningContext,
  AgentLearningOverridePatch,
  KnowledgeEntryListRequest,
  KnowledgeReviewBatchListRequest,
  KnowledgeEntryBatchReviewRequest,
  AgentInstructionReviewRequest,
  KnowledgeEntryReviewRequest,
  KnowledgeEntryRestoreRequest,
  KnowledgeEntrySaveRequest,
  KnowledgeOriginalFileDownload,
} from "@opengeni/contracts";
import {
  prepareKnowledgeFile,
  searchKnowledgeEntries,
  hasPermission,
  knowledgeContextForAccess,
  requireAccessGrantAuthorization,
  requireSessionAuthorization,
  requireWorkspaceSettingsGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  getKnowledgeOriginalFile,
  recordAuditEvent,
  archiveKnowledgeEntry,
  getAgentLearningSettings,
  getKnowledgeEntry,
  listAgentLearningOverrides,
  listKnowledgeEntryHistory,
  listKnowledgeReviewBatches,
  nestedPostgresSqlState,
  restoreKnowledgeEntry,
  reviewKnowledgeEntry,
  saveAgentLearningSettings,
  saveKnowledgeEntry,
  reviewKnowledgeEntries,
  reviewAgentInstruction,
  listAgentInstructionReviews,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { withAccessGrantSessionRlsContext } from "../access-grant-rls";

const ReadSettings = z
  .object({
    scope: z.enum(["workspace", "personal", "context"]).default("workspace"),
    source: AgentLearningContext.optional(),
  })
  .strict();
const WriteSettings = ReadSettings.extend({
  scope: z.enum(["workspace", "personal"]).default("workspace"),
  operationId: z.uuid(),
  expectedVersion: z.number().int().nonnegative(),
  settings: AgentLearningOverridePatch,
});
const Id = z.uuid();
function knowledgeHttpError(error: unknown): never {
  if (error instanceof HTTPException) throw error;
  if (error instanceof z.ZodError)
    throw new HTTPException(422, {
      message: error.issues[0]?.message ?? "Invalid Knowledge request",
    });
  const state = nestedPostgresSqlState(error);
  if (state === "40001" || state === "23505")
    throw new HTTPException(409, { message: "This item changed. Refresh it and try again." });
  if (state === "42501")
    throw new HTTPException(403, {
      message: "This Knowledge operation is not available with your access or learning settings.",
    });
  if (state === "22023" || state === "23514")
    throw new HTTPException(422, { message: "Invalid Knowledge operation or reference." });
  throw error;
}

export function registerKnowledgeRoutes(app: Hono, deps: ApiRouteDeps) {
  const base = "/v1/workspaces/:workspaceId/knowledge/entries";
  async function run<T>(
    c: Context,
    write: boolean,
    fn: (context: Awaited<ReturnType<typeof knowledgeContextForAccess>>) => Promise<T>,
  ) {
    try {
      const access = await requireAccessGrantAuthorization(
        c,
        deps,
        c.req.param("workspaceId")!,
        write ? "documents:manage" : "documents:search",
      );
      return await withAccessGrantSessionRlsContext(deps, access.grant, async () => {
        const context = await knowledgeContextForAccess(
          deps,
          access,
          write ? "documents:manage" : "documents:search",
        );
        c.header("cache-control", "private, no-store");
        return fn(context);
      });
    } catch (error) {
      knowledgeHttpError(error);
    }
  }
  app.post("/v1/workspaces/:workspaceId/knowledge/files/:fileId/prepare", (c) =>
    run(c, false, async (context) => {
      const access = await requireAccessGrantAuthorization(
        c,
        deps,
        context.workspaceId,
        "files:read",
      );
      const selected = access.grant.metadata?.firstPartyMcpTools as
        | FirstPartyMcpToolName[]
        | undefined;
      if (
        context.actor.kind !== "agent" ||
        !selected ||
        !allowedFirstPartyMcpToolsForSession(deps.settings, selected).includes(
          "knowledge_retain_file",
        )
      )
        throw new HTTPException(403, {
          message: "Source preparation is unavailable for this task",
        });
      return c.json(await prepareKnowledgeFile(deps, context, Id.parse(c.req.param("fileId"))));
    }),
  );
  app.post(`${base}/:entryId/file/download-url`, (c) =>
    run(c, false, async (context) => {
      const access = await requireAccessGrantAuthorization(
        c,
        deps,
        context.workspaceId,
        "files:read",
      );
      const { revisionId } = z
        .object({ revisionId: z.uuid().optional() })
        .strict()
        .parse(await c.req.json());
      const entryId = Id.parse(c.req.param("entryId"));
      const file = await getKnowledgeOriginalFile(deps.db, context, entryId, revisionId);
      if (!file) throw new HTTPException(404, { message: "Original file unavailable" });
      if (!deps.objectStorage)
        throw new HTTPException(503, { message: "File storage is unavailable" });
      if (
        !(await retryWhileMissing(async () =>
          (await deps.objectStorage!.fileExists(file)) ? true : null,
        ))
      )
        throw new HTTPException(410, { message: "Original file bytes are unavailable" });
      const signed = await deps.objectStorage.createGetUrl({ key: file.objectKey });
      await recordAuditEvent(deps.db, {
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        subjectId: access.grant.subjectId,
        action: "file.signed_url.issued",
        targetType: "knowledge_entry",
        targetId: entryId,
        metadata: { fileId: file.id, kind: "download", expiresAt: signed.expiresAt.toISOString() },
      });
      return c.json(
        KnowledgeOriginalFileDownload.parse({
          url: signed.url,
          expiresAt: signed.expiresAt.toISOString(),
          fileId: file.id,
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
        }),
      );
    }),
  );
  app.post(`${base}/search`, (c) =>
    run(c, false, async (context) =>
      c.json(
        await searchKnowledgeEntries(
          deps.db,
          context,
          KnowledgeEntryListRequest.parse(await c.req.json()),
          () => deps.getDocumentServices().embedder,
        ),
      ),
    ),
  );
  app.get("/v1/workspaces/:workspaceId/knowledge/review-groups", (c) =>
    run(c, true, async (context) => {
      const query = c.req.query();
      return c.json(
        await listKnowledgeReviewBatches(
          deps.db,
          context,
          KnowledgeReviewBatchListRequest.parse({
            ...query,
            ...(query.limit ? { limit: Number(query.limit) } : {}),
          }),
        ),
      );
    }),
  );
  app.post(`${base}/review`, (c) =>
    run(c, true, async (context) =>
      c.json(
        await reviewKnowledgeEntries(
          deps.db,
          context,
          KnowledgeEntryBatchReviewRequest.parse(await c.req.json()),
        ),
      ),
    ),
  );
  app.get(base, (c) =>
    run(c, false, async (context) => {
      const query = c.req.query();
      return c.json(
        await searchKnowledgeEntries(
          deps.db,
          context,
          KnowledgeEntryListRequest.parse({
            ...query,
            ...(query.limit ? { limit: Number(query.limit) } : {}),
          }),
          () => deps.getDocumentServices().embedder,
        ),
      );
    }),
  );
  app.post(base, (c) =>
    run(c, true, async (context) => {
      const result = await saveKnowledgeEntry(
        deps.db,
        context,
        KnowledgeEntrySaveRequest.parse(await c.req.json()),
      );
      return c.json(result, result.replayed ? 200 : 201);
    }),
  );
  app.get(`${base}/:entryId/history`, (c) =>
    run(c, false, async (context) =>
      c.json(
        await listKnowledgeEntryHistory(
          deps.db,
          context,
          Id.parse(c.req.param("entryId")),
          c.req.query("beforeRevision")
            ? z.coerce.number().int().positive().parse(c.req.query("beforeRevision"))
            : undefined,
        ),
      ),
    ),
  );
  app.get(`${base}/:entryId`, (c) =>
    run(c, false, async (context) => {
      const options = z
        .object({
          revisionId: Id.optional(),
          view: z.enum(["published", "needs_review", "archived", "rejected"]).optional(),
        })
        .strict()
        .parse(c.req.query());
      const entry = await getKnowledgeEntry(
        deps.db,
        context,
        Id.parse(c.req.param("entryId")),
        options,
      );
      if (!entry) throw new HTTPException(404, { message: "Knowledge entry not found" });
      return c.json(entry);
    }),
  );
  app.post(`${base}/:entryId/review`, (c) =>
    run(c, true, async (context) => {
      const request = KnowledgeEntryReviewRequest.parse({
        ...(await c.req.json()),
        entryId: c.req.param("entryId"),
      });
      return c.json(await reviewKnowledgeEntry(deps.db, context, request));
    }),
  );
  app.post(`${base}/:entryId/restore`, (c) =>
    run(c, true, async (context) => {
      const request = KnowledgeEntryRestoreRequest.parse({
        ...(await c.req.json()),
        entryId: c.req.param("entryId"),
      });
      return c.json(await restoreKnowledgeEntry(deps.db, context, request));
    }),
  );
  app.post(`${base}/:entryId/archive`, (c) =>
    run(c, true, async (context) => {
      const request = z
        .object({ operationId: Id, expectedVersion: z.number().int().positive() })
        .strict()
        .parse(await c.req.json());
      return c.json(
        await archiveKnowledgeEntry(deps.db, context, {
          ...request,
          entryId: Id.parse(c.req.param("entryId")),
        }),
      );
    }),
  );

  const learning = "/v1/workspaces/:workspaceId/agent-learning";
  async function instructionReviewContext(
    c: Context,
    context: Awaited<ReturnType<typeof knowledgeContextForAccess>>,
  ) {
    if (context.actor.kind !== "human")
      throw new HTTPException(403, {
        message: "Instruction review requires an authenticated person",
      });
    await requireWorkspaceSettingsGrant(c, deps, context.workspaceId);
    context.actor.settingsScopes = ["workspace"];
    return context;
  }
  app.get(`${learning}/instructions/reviews`, (c) =>
    run(c, false, async (context) =>
      c.json(
        await listAgentInstructionReviews(
          deps.db,
          await instructionReviewContext(c, context),
          c.req.query("cursor"),
        ),
      ),
    ),
  );
  app.post(`${learning}/instructions/review`, (c) =>
    run(c, false, async (context) =>
      c.json(
        await reviewAgentInstruction(
          deps.db,
          await instructionReviewContext(c, context),
          AgentInstructionReviewRequest.parse(await c.req.json()),
        ),
      ),
    ),
  );
  app.post(`${learning}/read`, (c) =>
    run(c, false, async (context) => {
      const request = ReadSettings.parse(await c.req.json());
      return c.json(
        await getAgentLearningSettings(deps.db, context, request.scope, request.source),
      );
    }),
  );
  app.get(`${learning}/overrides`, (c) =>
    run(c, false, async (context) => {
      const scope = z
        .enum(["workspace", "personal"])
        .default("workspace")
        .parse(c.req.query("scope"));
      return c.json(await listAgentLearningOverrides(deps.db, context, scope));
    }),
  );
  app.post(learning, (c) =>
    run(c, false, async (context) => {
      const request = WriteSettings.parse(await c.req.json());
      if (context.actor.kind !== "human")
        throw new HTTPException(403, { message: "Agents cannot change learning settings" });
      const access = await requireAccessGrantAuthorization(c, deps, context.workspaceId);
      if (request.source?.kind === "chat") {
        if (!hasPermission(access.grant.permissions, "sessions:control"))
          throw new HTTPException(403, { message: "Chat settings require session control" });
        await requireSessionAuthorization(deps, access.grant, {
          sessionId: request.source.id,
          operation: "session.context.write",
          surface: "http",
        });
        context.actor.settingsScopes = [request.scope];
      } else if (request.source?.kind === "scheduled_task") {
        if (!hasPermission(access.grant.permissions, "scheduled_tasks:manage"))
          throw new HTTPException(403, {
            message: "Scheduled task settings require task management",
          });
        context.actor.settingsScopes = [request.scope];
      } else if (request.scope === "workspace") {
        await requireWorkspaceSettingsGrant(c, deps, context.workspaceId);
        context.actor.settingsScopes = ["workspace"];
      }
      return c.json(await saveAgentLearningSettings(deps.db, context, request));
    }),
  );
}
