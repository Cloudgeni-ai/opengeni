import {
  ArchiveSiteRequest,
  CreateSiteRuntimeSessionRequest,
  FirstPartyMcpToolName,
  Permission,
  PublishSiteRequest,
  RollbackSiteRequest,
  SendSiteRuntimeMessageRequest,
  type SiteCapabilityManifest,
  SiteDetailResponse,
  SiteListResponse,
  SiteMutationResponse,
  SiteRuntimeSessionReceipt,
  SiteUsageResponse,
  ToolRef,
} from "@opengeni/contracts";
import {
  SiteConflictError,
  SiteIdempotencyError,
  SiteInvariantError,
  SiteNotFoundError,
  archiveSite,
  getSite,
  getSiteUsage,
  getWorkspaceArtifactVersionIdentity,
  listSites,
  publishSite,
  recordSiteRuntimeSession,
  requireSiteRuntimeSession,
  rollbackSite,
} from "@opengeni/db";
import {
  acceptSessionUserMessage,
  createSessionForRequest,
  requireAccessGrant,
  updateSessionMcpApprovalPolicy,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";

export function assertSitesEnabled(settings: { sitesEnabled?: boolean }): void {
  if (!settings.sitesEnabled) {
    throw new HTTPException(404, { message: "Sites are not enabled for this deployment" });
  }
}

async function parseJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: "invalid Site request" });
  return parsed.data;
}

function siteHttpError(error: unknown): HTTPException {
  if (error instanceof HTTPException) return error;
  if (error instanceof SiteNotFoundError) return new HTTPException(404, { message: error.message });
  if (error instanceof SiteConflictError || error instanceof SiteIdempotencyError)
    return new HTTPException(409, { message: error.message });
  if (error instanceof SiteInvariantError)
    return new HTTPException(422, { message: error.message });
  return new HTTPException(500, { message: "Site operation failed" });
}

export function siteRuntimeFirstPartyPermissions(
  permissions: Permission[],
  firstPartyMcpTools: string[],
): Permission[] | undefined {
  // The canonical session boundary uses omission for its deployment default and
  // rejects an explicit empty signed permission set. An AI-only Site still
  // freezes an explicit empty tool catalogue, so omitting permissions here does
  // not expose a first-party tool to generated code. As soon as the release
  // requests one first-party tool it must also declare a non-empty permission
  // ceiling; session admission then intersects that ceiling with the caller.
  if (firstPartyMcpTools.length === 0) return undefined;
  if (permissions.length === 0) {
    throw new SiteInvariantError(
      "A Site release with first-party tools must declare first-party permissions",
    );
  }
  return permissions;
}

const SITE_READ_ONLY_FIRST_PARTY_TOOLS = new Set([
  "memory_search",
  "preference_registry_summary",
  "preference_registry_get",
  "task_notes_list",
  "sandboxes_list",
  "sessions_list",
  "session_get",
  "session_events",
  "variable_set_list",
  "environment_list",
  "capability_catalog_search",
  "social_connections_list",
  "social_posts_recent",
  "social_daily_analysis_context",
  "social_search_live",
  "social_mentions_live",
  "social_thread_fetch",
  "x_accounts_list",
  "x_search_live",
  "x_mentions_live",
  "x_thread_fetch",
  "reddit_accounts_list",
  "reddit_search_live",
  "reddit_mentions_live",
  "reddit_thread_fetch",
  "scheduled_tasks_list",
  "scheduled_tasks_get",
  "scheduled_task_runs_list",
  "slack_bot_list_channels",
  "slack_bot_search",
  "slack_bot_channel_history",
  "slack_bot_thread_replies",
  "slack_bot_list_users",
  "slack_bot_list_files",
  "slack_bot_file_info",
  "slack_bot_file_content",
  "fiken_companies_list",
  "fiken_contacts_list",
  "fiken_products_list",
  "fiken_invoices_list",
  "fiken_invoice_get",
  "fiken_bank_accounts_list",
  "fiken_purchases_list",
  "fiken_sales_list",
  "atlassian_sources_list",
  "atlassian_search",
  "atlassian_get",
  "artifacts_list",
  "artifacts_get_source",
  "editable_artifact_list",
  "editable_artifact_get",
  "editable_artifact_inspect",
]);

export function validateSiteManifestRuntimeAuthority(manifest: SiteCapabilityManifest) {
  const parsedPermissions = Permission.array().safeParse(
    manifest.integrations.firstPartyPermissions,
  );
  const parsedFirstPartyMcpTools = FirstPartyMcpToolName.array().safeParse(
    manifest.integrations.firstPartyTools,
  );
  const parsedTools = ToolRef.array().safeParse(manifest.integrations.mcpServers);
  if (!parsedPermissions.success || !parsedFirstPartyMcpTools.success || !parsedTools.success) {
    throw new SiteInvariantError("Site capability manifest contains an unsupported capability");
  }
  const permissions = parsedPermissions.data;
  const firstPartyMcpTools = parsedFirstPartyMcpTools.data;
  const tools = parsedTools.data;
  const firstPartyMcpPermissions = siteRuntimeFirstPartyPermissions(
    permissions,
    firstPartyMcpTools,
  );
  const declaredMcpServers = new Set(tools.map((tool) => tool.id));
  if (
    manifest.integrations.allowedPersonalConnectionServerIds.some(
      (serverId) => !declaredMcpServers.has(serverId),
    )
  ) {
    throw new SiteInvariantError(
      "Personal Connection server allowlist must be a subset of the declared MCP servers",
    );
  }
  const writeTools = firstPartyMcpTools.filter(
    (tool) => !SITE_READ_ONLY_FIRST_PARTY_TOOLS.has(tool),
  );
  if (manifest.approvals.writeActions === "deny" && (writeTools.length > 0 || tools.length > 0)) {
    throw new SiteInvariantError(
      "This Site release denies write-capable and external integration tools",
    );
  }
  return { permissions, firstPartyMcpPermissions, firstPartyMcpTools, tools, writeTools };
}

function validateReleaseRuntimeAuthority(detail: Awaited<ReturnType<typeof getSite>>) {
  const release = detail.currentRelease;
  if (!release || detail.site.status !== "active") {
    throw new SiteInvariantError("Site has no active release");
  }
  return { release, ...validateSiteManifestRuntimeAuthority(release.manifest) };
}

export function registerSiteRoutes(app: Hono, deps: ApiRouteDeps): void {
  async function readGrant(
    c: Context,
    permission: "artifacts:read" | "sessions:control" = "artifacts:read",
  ) {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) throw new HTTPException(404, { message: "workspace not found" });
    const grant = await requireAccessGrant(c, deps, workspaceId, permission);
    assertSitesEnabled(deps.settings);
    return grant;
  }

  app.get("/v1/workspaces/:workspaceId/sites", async (c) => {
    await readGrant(c);
    try {
      return c.json(
        SiteListResponse.parse({ sites: await listSites(deps.db, c.req.param("workspaceId")) }),
      );
    } catch (error) {
      throw siteHttpError(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/sites/:siteId", async (c) => {
    await readGrant(c);
    try {
      return c.json(
        SiteDetailResponse.parse(
          await getSite(deps.db, c.req.param("workspaceId"), c.req.param("siteId")),
        ),
      );
    } catch (error) {
      throw siteHttpError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/sites/:siteId/releases", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrant(c, deps, workspaceId, "artifacts:publish");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    assertSitesEnabled(deps.settings);
    const request = await parseJson(c, PublishSiteRequest);
    try {
      validateSiteManifestRuntimeAuthority(request.manifest);
      const artifact = await getWorkspaceArtifactVersionIdentity(
        deps.db,
        workspaceId,
        request.artifactVersionId,
      );
      if (artifact !== c.req.param("siteId"))
        throw new SiteInvariantError("Site id must equal the published artifact id");
      return c.json(
        SiteMutationResponse.parse(
          await publishSite(deps.db, { workspaceId, actorSubjectId: access.subjectId, request }),
        ),
        201,
      );
    } catch (error) {
      throw siteHttpError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/sites/:siteId/rollback", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrant(c, deps, workspaceId, "artifacts:publish");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    assertSitesEnabled(deps.settings);
    const request = await parseJson(c, RollbackSiteRequest);
    try {
      const detail = await getSite(deps.db, workspaceId, c.req.param("siteId"));
      const targetRelease = detail.releases.find((release) => release.id === request.releaseId);
      if (!targetRelease) throw new SiteNotFoundError("Site release not found");
      validateSiteManifestRuntimeAuthority(targetRelease.manifest);
      return c.json(
        SiteMutationResponse.parse(
          await rollbackSite(deps.db, {
            workspaceId,
            siteId: c.req.param("siteId"),
            actorSubjectId: access.subjectId,
            request,
          }),
        ),
      );
    } catch (error) {
      throw siteHttpError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/sites/:siteId/archive", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrant(c, deps, workspaceId, "artifacts:publish");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    assertSitesEnabled(deps.settings);
    const request = await parseJson(c, ArchiveSiteRequest);
    try {
      return c.json(
        SiteDetailResponse.parse(
          await archiveSite(deps.db, {
            workspaceId,
            siteId: c.req.param("siteId"),
            actorSubjectId: access.subjectId,
            request,
          }),
        ),
      );
    } catch (error) {
      throw siteHttpError(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/sites/:siteId/usage", async (c) => {
    await readGrant(c);
    try {
      return c.json(
        SiteUsageResponse.parse(
          await getSiteUsage(deps.db, c.req.param("workspaceId"), c.req.param("siteId")),
        ),
      );
    } catch (error) {
      throw siteHttpError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/sites/:siteId/runtime/sessions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const siteId = c.req.param("siteId");
    const access = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    assertSitesEnabled(deps.settings);
    const request = await parseJson(c, CreateSiteRuntimeSessionRequest);
    try {
      const detail = await getSite(deps.db, workspaceId, siteId);
      const { release, firstPartyMcpPermissions, firstPartyMcpTools, tools, writeTools } =
        validateReleaseRuntimeAuthority(detail);
      if (!release.manifest.ai.enabled)
        throw new SiteInvariantError("AI is disabled for this Site release");
      const usage = await getSiteUsage(deps.db, workspaceId, siteId);
      if (usage.budgetMicros !== null && usage.costMicros >= usage.budgetMicros)
        throw new HTTPException(429, { message: "Site monthly AI budget is exhausted" });
      const requestedModel = request.model ?? release.manifest.ai.defaultModel ?? undefined;
      if (
        requestedModel &&
        release.manifest.ai.allowedModels.length > 0 &&
        !release.manifest.ai.allowedModels.includes(requestedModel)
      )
        throw new SiteInvariantError("Requested model is not allowed by this Site release");
      const allowedServers = new Set(
        release.manifest.integrations.allowedPersonalConnectionServerIds,
      );
      const connectionAuthorities = request.connectionAuthorities ?? [];
      if (connectionAuthorities.some((selection) => !allowedServers.has(selection.serverId)))
        throw new SiteInvariantError("Connection authority is not allowed by this Site release");
      // Create a durable shell first. Approval policy is frozen before the
      // initial user message can enqueue a turn, avoiding a policy-update race.
      const session = await createSessionForRequest(deps, access, workspaceId, {
        startMode: "realtime",
        instructions: release.manifest.ai.instructions,
        ...(requestedModel ? { model: requestedModel } : {}),
        reasoningEffort: release.manifest.ai.reasoningEffort,
        idempotencyKey: `site-runtime:${siteId}:${request.operationId}`,
        metadata: {
          siteId,
          siteReleaseId: release.id,
          siteArtifactVersionId: release.artifactVersionId,
          siteManifestHash: release.manifestHash,
        },
        ...(firstPartyMcpPermissions ? { firstPartyMcpPermissions } : {}),
        firstPartyMcpTools,
        tools,
      });
      if (release.manifest.approvals.writeActions === "platform_prompt") {
        if (writeTools.length > 0) {
          await updateSessionMcpApprovalPolicy(deps, access, session.id, "opengeni", writeTools);
        }
        for (const tool of tools) {
          await updateSessionMcpApprovalPolicy(deps, access, session.id, tool.id, true);
        }
      }
      const runtimeSession = await recordSiteRuntimeSession(deps.db, {
        workspaceId,
        siteId,
        releaseId: release.id,
        sessionId: session.id,
        operationId: request.operationId,
        request,
        actorSubjectId: access.subjectId,
      });
      await acceptSessionUserMessage(deps, access, workspaceId, session.id, {
        text: request.initialMessage,
        modelContext: request.modelContext ?? null,
        connectionAuthorities,
        clientEventId: request.operationId,
      });
      return c.json(
        SiteRuntimeSessionReceipt.parse({
          runtimeSession,
          sessionId: session.id,
          eventsPath: `/v1/workspaces/${workspaceId}/sessions/${session.id}/events/stream`,
        }),
        202,
      );
    } catch (error) {
      throw siteHttpError(error);
    }
  });

  app.post(
    "/v1/workspaces/:workspaceId/sites/:siteId/runtime/sessions/:runtimeSessionId/messages",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const access = await readGrant(c, "sessions:control");
      const request = await parseJson(c, SendSiteRuntimeMessageRequest);
      try {
        const runtimeSession = await requireSiteRuntimeSession(
          deps.db,
          workspaceId,
          c.req.param("siteId"),
          c.req.param("runtimeSessionId"),
        );
        const detail = await getSite(deps.db, workspaceId, runtimeSession.siteId);
        if (
          detail.site.status !== "active" ||
          detail.site.currentReleaseId !== runtimeSession.releaseId
        )
          throw new SiteConflictError(
            "Site runtime is no longer attached to an active current release",
          );
        const usage = await getSiteUsage(deps.db, workspaceId, runtimeSession.siteId);
        if (usage.budgetMicros !== null && usage.costMicros >= usage.budgetMicros)
          throw new HTTPException(429, { message: "Site monthly AI budget is exhausted" });
        const result = await acceptSessionUserMessage(
          deps,
          access,
          workspaceId,
          runtimeSession.sessionId,
          {
            text: request.text,
            ...(request.clientEventId ? { clientEventId: request.clientEventId } : {}),
          },
        );
        return c.json(result, 202);
      } catch (error) {
        throw siteHttpError(error);
      }
    },
  );
}
