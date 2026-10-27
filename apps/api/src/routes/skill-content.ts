import { z } from "zod";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  ApplyWorkspaceSkillRevisionRequest,
  RemoveWorkspaceSkillRequest,
  SaveWorkspaceSkillRequest,
  type PreferenceRegistryScope,
  type SkillWriteReceipt,
} from "@opengeni/contracts";
import { getSessionForSubject, readSkillRemovalScope } from "@opengeni/db";
import {
  approveSkill,
  rejectSkill,
  removeSkill,
  listSkills,
  readSkill,
  requireAccessGrant,
  requireAccessGrantAuthorization,
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

function skillIdentifier(value: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success)
    throw new HTTPException(422, { message: "Invalid Skill revision or identity" });
  return parsed.data;
}

/** Human folder editing and the legacy Skill admin share scope authorization. */
export function registerSkillContentRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/skills/content";
  app.get(base, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const query = parseRequestQuery(
      z.object({
        limit: z.coerce.number().int().min(1).max(250).default(100),
        cursor: z.string().max(2048).optional(),
        sessionId: z.uuid().optional(),
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
        ...(after ? { after } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
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
    const context = {
      accountId: access.grant.accountId,
      workspaceId,
      subjectId: access.grant.subjectId,
    };
    const skillId = request.skillId;
    const current = await readSkill(
      deps.db,
      context,
      skillId,
      request.expectedRevisionId ?? undefined,
    );
    if (request.expectedRevisionId && !current)
      throw new HTTPException(404, { message: "Skill not found" });
    if (current) {
      authorizeSkillScopeMutation(access, current.scope);
      if (current.scope !== request.scope)
        throw new HTTPException(409, {
          message: "Move Skill scope through the existing scope-management workflow.",
        });
    }
    let files;
    try {
      files = validateSkillFiles(
        applySkillFileChanges(
          request.expectedRevisionId ? (current?.files ?? []) : [],
          request.files,
          request.deletions,
        ),
      );
      buildPortableSkillArtifact(files);
    } catch {
      throw new HTTPException(400, {
        message:
          "Invalid Skill folder. SKILL.md requires valid YAML frontmatter with a name and description. Use unique relative text-file paths and respect the file and folder size limits.",
      });
    }
    const receipt = await skillMutation(() =>
      saveSkill(deps.db, {
        accountId: context.accountId,
        workspaceId,
        actor: { kind: "human", principalKind: "human_session", subjectId: context.subjectId },
        operationId: request.operationId,
        skillId,
        expectedRevisionId: request.expectedRevisionId,
        expectedScopeVersion: request.expectedScopeVersion,
        scope: request.scope,
        stableKey: current?.stableKey ?? request.stableKey,
        files,
        reason: request.reason,
      }),
    );
    return c.json(receipt);
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
    const current = await readSkill(deps.db, context, skillId);
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
  for (const operation of ["approve", "reject", "restore"] as const) {
    app.post(`${base}/:skillId/${operation}`, async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:read");
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
      if (candidate.code === "22023" || candidate.code === "23514")
        throw new HTTPException(400, { message: "Skill content or revision request is invalid." });
      current = candidate.cause;
    }
    throw error;
  }
}
