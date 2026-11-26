import { z } from "zod";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  ApplyWorkspaceSkillRevisionRequest,
  OrganizationSkillReachResponse,
  RemoveWorkspaceSkillRequest,
  SaveOrganizationSkillRequest,
  SaveWorkspaceSkillRequest,
  UpdateOrganizationSkillReachRequest,
  type OrganizationSkillReach,
  type PreferenceRegistryScope,
  type SkillActor,
  type SkillWriteReceipt,
} from "@opengeni/contracts";
import {
  getSessionForSubject,
  readSkillRemovalScope,
  updateOrganizationSkillReach,
} from "@opengeni/db";
import {
  approveSkill,
  accountScopedApiKeyWorkspaceAuthority,
  isVerifiedOrganizationServiceAuthorization,
  rejectSkill,
  removeSkill,
  listSkills,
  outsideAgentReach,
  readSkill,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  requireAccessContext,
  restoreSkill,
  saveSkill,
  validateSkillFiles,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import { applySkillFileChanges, buildPortableSkillArtifact } from "@opengeni/runtime/skill-library";
import { authorizePreferenceRegistryScopeMutation } from "./preference-registry";
import { parseRequestBody, parseRequestQuery } from "../http/request-body";

/**
 * Workspace Skills are shared team procedures: any collaborator who can manage
 * workspace documents (the default Member preset) may author, remove and review
 * them, matching what their agents can already do under Agent learning.
 * Organization and personal scopes keep the registry rules unchanged.
 */
export function authorizeSkillScopeMutation(
  access: AccessGrantAuthorization,
  scope: PreferenceRegistryScope,
): void {
  authorizePreferenceRegistryScopeMutation(access, scope);
}

/** Every Skill write names its invalid fields with the same status and lead-in. */
const invalidSkillRequest = { status: 422, message: "Invalid Skill request" } as const;

/**
 * People see every organization Skill on their Skills page, including ones
 * that don't work in this workspace (marked `availableHere: false`), so
 * whoever manages it can change that from here. Agents' reads never do.
 */
const everywhere = { includeOrganizationElsewhere: true } as const;

function skillIdentifier(value: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success)
    throw new HTTPException(422, { message: "Invalid Skill revision or identity" });
  return parsed.data;
}

/** Human folder editing and the legacy Skill admin share scope authorization. */
export function registerSkillContentRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/skills/content";
  const backend = "/v1/workspaces/:workspaceId/organization-skills";
  app.get(base, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const query = parseRequestQuery(
      z.object({
        limit: z.coerce.number().int().min(1).max(250).default(100),
        cursor: z.string().max(2048).optional(),
        sessionId: z.uuid().optional(),
        scope: z.enum(["workspace", "organization", "user"]).optional(),
      }),
      c.req.query(),
      { status: 422, message: "Invalid Skill list query" },
    );
    if (query.sessionId) {
      await requireAccessGrant(c, deps, workspaceId, "sessions:read");
      const session = await getSessionForSubject(
        deps.db,
        workspaceId,
        query.sessionId,
        grant.subjectId,
      );
      if (!session) throw new HTTPException(404, { message: "Session not found" });
    }
    let after: { stableKey: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      try {
        after = z
          .object({ stableKey: z.string().min(1).max(128), id: z.uuid() })
          .strict()
          .parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
      } catch {
        throw new HTTPException(422, { message: "Invalid Skill list cursor" });
      }
    }
    const rows = await listSkills(
      deps.db,
      { accountId: grant.accountId, workspaceId, subjectId: grant.subjectId },
      {
        limit: query.limit + 1,
        metadataOnly: true,
        ...(grant.principalKind === "agent_attempt" || outsideAgentReach(grant) ? {} : everywhere),
        ...(after ? { after } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(query.scope ? { scope: query.scope } : {}),
      },
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return c.json({
      skills: page.map(({ files: _files, ...summary }) => summary),
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(JSON.stringify({ stableKey: last.stableKey, id: last.id })).toString(
              "base64url",
            )
          : null,
    });
  });
  app.get(`${base}/:skillId`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const skillId = skillIdentifier(c.req.param("skillId"));
    const revision = c.req.query("revisionId");
    const revisionId = revision === undefined ? undefined : skillIdentifier(revision);
    const skill = await readSkill(
      deps.db,
      { accountId: grant.accountId, workspaceId, subjectId: grant.subjectId },
      skillId,
      revisionId,
      grant.principalKind === "agent_attempt" || outsideAgentReach(grant) ? {} : everywhere,
    );
    if (!skill) throw new HTTPException(404, { message: "Skill not found" });
    return c.json(skill);
  });
  app.post(`${base}/save`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:read");
    const request = parseRequestBody(
      SaveWorkspaceSkillRequest,
      await c.req.json().catch(() => null),
      invalidSkillRequest,
    );
    authorizeSkillScopeMutation(access, request.scope);
    return c.json(
      await saveSkillFolder(deps, access, request, {
        kind: "human",
        principalKind: "human_session",
        subjectId: access.grant.subjectId,
      }),
    );
  });
  app.post(`${backend}/save`, async (c) => {
    const { access, actor } = await authorizeOrganizationSkillBackend(c, deps);
    const request = parseRequestBody(
      SaveOrganizationSkillRequest,
      await c.req.json().catch(() => null),
      invalidSkillRequest,
    );
    const { initialReach, ...folder } = request;
    return c.json(
      await saveSkillFolder(
        deps,
        access,
        { ...folder, scope: "organization" },
        actor,
        initialReach,
      ),
    );
  });
  app.post(`${base}/:skillId/remove`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:read");
    const skillId = skillIdentifier(c.req.param("skillId"));
    const request = parseRequestBody(
      RemoveWorkspaceSkillRequest,
      await c.req.json().catch(() => null),
      invalidSkillRequest,
    );
    const context = {
      accountId: access.grant.accountId,
      workspaceId,
      subjectId: access.grant.subjectId,
    };
    const current = await readSkill(deps.db, context, skillId, undefined, everywhere);
    const scope =
      current?.scope ??
      (await readSkillRemovalScope(deps.db, context, skillId, request.operationId));
    if (!scope) throw new HTTPException(404, { message: "Skill not found" });
    authorizeSkillScopeMutation(access, scope);
    if (scope === "organization")
      throw new HTTPException(403, { message: "Organization skills cannot be removed here." });
    return c.json(
      await skillMutation(() =>
        removeSkill(deps.db, {
          ...request,
          skillId,
          accountId: context.accountId,
          workspaceId,
          actor: { kind: "human", principalKind: "human_session", subjectId: context.subjectId },
        }),
      ),
    );
  });
  app.post(`${backend}/:skillId/remove`, async (c) => {
    const { access, actor } = await authorizeOrganizationSkillBackend(c, deps);
    const skillId = skillIdentifier(c.req.param("skillId"));
    const request = parseRequestBody(
      RemoveWorkspaceSkillRequest,
      await c.req.json().catch(() => null),
      invalidSkillRequest,
    );
    return c.json(
      await skillMutation(() =>
        removeSkill(deps.db, {
          ...request,
          skillId,
          accountId: access.grant.accountId,
          workspaceId: access.grant.workspaceId,
          actor,
        }),
      ),
    );
  });
  for (const operation of ["approve", "reject", "restore"] as const) {
    app.post(`${base}/:skillId/${operation}`, async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:read");
      // Reviewing a Skill is the person's decision: a connected agent's
      // uploads wait for it under Review first, so it can't approve them.
      if (outsideAgentReach(access.grant))
        throw new HTTPException(403, {
          message: `Connected agents can't ${operation} Skills. The person reviews them in Opengeni.`,
        });
      const skillId = skillIdentifier(c.req.param("skillId"));
      const request = parseRequestBody(
        ApplyWorkspaceSkillRevisionRequest,
        await c.req.json().catch(() => null),
        invalidSkillRequest,
      );
      const current = await readSkill(
        deps.db,
        { accountId: access.grant.accountId, workspaceId, subjectId: access.grant.subjectId },
        skillId,
        undefined,
        everywhere,
      );
      const scope =
        current?.scope ??
        (operation === "approve" && request.removalOperationId
          ? await readSkillRemovalScope(
              deps.db,
              {
                accountId: access.grant.accountId,
                workspaceId,
                subjectId: access.grant.subjectId,
              },
              skillId,
              request.operationId,
            )
          : null);
      if (!scope) throw new HTTPException(404, { message: "Skill not found" });
      authorizeSkillScopeMutation(access, scope);
      const apply =
        operation === "approve"
          ? approveSkill
          : operation === "reject"
            ? rejectSkill
            : restoreSkill;
      return c.json(
        await skillMutation(() =>
          apply(deps.db, {
            ...request,
            skillId,
            accountId: access.grant.accountId,
            workspaceId,
            actor: {
              kind: "human",
              principalKind: "human_session",
              subjectId: access.grant.subjectId,
            },
          }),
        ),
      );
    });
  }
  // Where an organization Skill works: every shared workspace or chosen ones,
  // and members' Personal workspaces when switched on. Whoever may change the
  // organization's Skills decides this, from any workspace; agents in a
  // workspace it no longer works in stop seeing it from their next turn.
  app.put(`${base}/:skillId/reach`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:read");
    const skillId = skillIdentifier(c.req.param("skillId"));
    const request = parseRequestBody(
      UpdateOrganizationSkillReachRequest,
      await c.req.json().catch(() => null),
      invalidSkillRequest,
    );
    authorizeSkillScopeMutation(access, "organization");
    return c.json(await setSkillReach(deps, access, skillId, request));
  });
  app.put(`${backend}/:skillId/reach`, async (c) => {
    const { access } = await authorizeOrganizationSkillBackend(c, deps);
    const skillId = skillIdentifier(c.req.param("skillId"));
    const request = parseRequestBody(
      UpdateOrganizationSkillReachRequest,
      await c.req.json().catch(() => null),
      invalidSkillRequest,
    );
    return c.json(await setSkillReach(deps, access, skillId, request));
  });
}

async function authorizeOrganizationSkillBackend(c: Context, deps: ApiRouteDeps) {
  const access = await requireAccessGrantAuthorization(
    c,
    deps,
    c.req.param("workspaceId")!,
    "workspace:read",
  );
  const key = accountScopedApiKeyWorkspaceAuthority(await requireAccessContext(c, deps));
  const { grant, accountGrant } = access;
  if (
    !isVerifiedOrganizationServiceAuthorization(access) ||
    key?.workspaceScope.kind !== "all" ||
    !accountGrant?.permissions.includes("account:admin") ||
    grant.serviceInitiator ||
    grant.serviceInitiatorContext
  ) {
    throw new HTTPException(403, {
      message:
        "Organization Skill management requires a direct organization API key with account:admin and all shared workspaces in scope.",
    });
  }
  return {
    access,
    actor: {
      kind: "organization_api_key",
      principalKind: "api_key",
      subjectId: grant.subjectId,
    } as const,
  };
}

async function saveSkillFolder(
  deps: ApiRouteDeps,
  access: AccessGrantAuthorization,
  request: SaveWorkspaceSkillRequest,
  actor: Exclude<SkillActor, { kind: "agent" }>,
  initialReach?: OrganizationSkillReach,
): Promise<SkillWriteReceipt> {
  const { accountId, workspaceId, subjectId } = access.grant;
  const { skillId, expectedRevisionId, expectedScopeVersion, scope } = request;
  const current = await readSkill(
    deps.db,
    { accountId, workspaceId, subjectId },
    skillId,
    expectedRevisionId ?? undefined,
    everywhere,
  );
  if (expectedRevisionId && !current) throw new HTTPException(404, { message: "Skill not found" });
  if (current) {
    if (actor.kind === "human") authorizeSkillScopeMutation(access, current.scope);
    if (current.scope !== scope)
      throw new HTTPException(409, {
        message: "Move Skill scope through the existing scope-management workflow.",
      });
  }
  let files;
  try {
    files = validateSkillFiles(
      applySkillFileChanges(
        expectedRevisionId ? (current?.files ?? []) : [],
        request.files,
        request.deletions,
      ),
    );
    buildPortableSkillArtifact(files);
  } catch (error) {
    const reason =
      error instanceof Error && error.message ? ` (${error.message.slice(0, 300)})` : "";
    throw new HTTPException(400, {
      message: `Invalid Skill folder${reason}. SKILL.md requires valid YAML frontmatter with a name and description. Use unique relative text-file paths and respect the file and folder size limits.`,
    });
  }
  return await skillMutation(() =>
    saveSkill(deps.db, {
      accountId,
      workspaceId,
      actor,
      operationId: request.operationId,
      skillId,
      expectedRevisionId,
      expectedScopeVersion,
      scope,
      stableKey: current?.stableKey ?? request.stableKey,
      files,
      reason: request.reason,
      // A connected outside agent's upload follows Agent learning.
      ...(outsideAgentReach(access.grant) ? { learningPolicy: "follow" as const } : {}),
      ...(initialReach ? { initialReach } : {}),
    }),
  );
}

function unknownReachWorkspaces(ids: string[]): HTTPException {
  return new HTTPException(422, {
    message: `These aren't shared workspaces of this organization: ${ids.join(", ")}`,
  });
}

async function setSkillReach(
  deps: ApiRouteDeps,
  { grant }: AccessGrantAuthorization,
  skillId: string,
  request: OrganizationSkillReach,
) {
  const result = await updateOrganizationSkillReach(deps.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    skillId,
    ...request,
  });
  if (result.status === "not_found") throw new HTTPException(404, { message: "Skill not found" });
  if (result.status === "not_organization")
    throw new HTTPException(409, {
      message:
        "Only an organization Skill works in chosen workspaces. A workspace Skill works in its workspace, and a personal one wherever its owner works.",
    });
  if (result.status === "unknown_workspaces") throw unknownReachWorkspaces(result.workspaceIds);
  return OrganizationSkillReachResponse.parse({ reach: result.reach });
}

async function skillMutation(run: () => Promise<SkillWriteReceipt>): Promise<SkillWriteReceipt> {
  try {
    return await run();
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
      const candidate = current as { code?: unknown; cause?: unknown };
      if (candidate.code === "23505" || candidate.code === "40001" || candidate.code === "55P03")
        throw new HTTPException(409, {
          message:
            "Skill changed or this operation key was reused. Reload and reconcile the change.",
        });
      if (candidate.code === "42501")
        throw new HTTPException(403, {
          message: "Skill change is not permitted for this actor or scope.",
        });
      if (candidate.code === "PT422")
        throw new HTTPException(422, {
          message: "Initial reach must name shared workspaces of this organization.",
        });
      if (candidate.code === "P0002") throw new HTTPException(404, { message: "Skill not found" });
      if (candidate.code === "22023" || candidate.code === "23514")
        throw new HTTPException(400, { message: "Skill content or revision request is invalid." });
      current = candidate.cause;
    }
    throw error;
  }
}
