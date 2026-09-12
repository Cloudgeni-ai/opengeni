import { z } from "zod";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { SkillFile, type SkillWriteReceipt } from "@opengeni/contracts";
import {
  approveSkill,
  rejectSkill,
  listSkills,
  readSkill,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  restoreSkill,
  saveSkill,
  validateSkillFiles,
  type ApiRouteDeps,
} from "@opengeni/core";
import { applySkillFileChanges, buildPortableSkillArtifact } from "@opengeni/runtime/skill-library";
import { authorizePreferenceRegistryScopeMutation } from "./preference-registry";

const scopeSchema = z.enum(["workspace", "organization", "user"]);
const saveRequest = z
  .object({
    operationId: z.uuid(),
    skillId: z.uuid(),
    expectedRevisionId: z.uuid().nullable(),
    expectedScopeVersion: z.number().int().nonnegative(),
    scope: scopeSchema.default("workspace"),
    stableKey: z.string().min(1).max(96),
    files: z.array(SkillFile).max(128),
    deletions: z.array(z.string().min(1).max(512)).max(128).default([]),
    reason: z.string().min(1).max(2000),
  })
  .strict();
const revisionRequest = z
  .object({
    operationId: z.uuid(),
    revisionId: z.uuid(),
    expectedRevisionId: z.uuid().nullable(),
    expectedScopeVersion: z.number().int().nonnegative(),
    reason: z.string().min(1).max(2000),
  })
  .strict();

async function parseSkillRequest<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(422, { message: "Invalid Skill request" });
  return parsed.data;
}

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
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(250).default(100),
        cursor: z.string().max(2048).optional(),
      })
      .safeParse(c.req.query());
    if (!query.success) throw new HTTPException(422, { message: "Invalid Skill list query" });
    let after: { stableKey: string; id: string } | undefined;
    if (query.data.cursor !== undefined) {
      try {
        after = z
          .object({ stableKey: z.string().min(1).max(128), id: z.uuid() })
          .strict()
          .parse(JSON.parse(Buffer.from(query.data.cursor, "base64url").toString("utf8")));
      } catch {
        throw new HTTPException(422, { message: "Invalid Skill list cursor" });
      }
    }
    const rows = await listSkills(
      deps.db,
      { accountId: grant.accountId, workspaceId, subjectId: grant.subjectId },
      { limit: query.data.limit + 1, metadataOnly: true, ...(after ? { after } : {}) },
    );
    const page = rows.slice(0, query.data.limit);
    const last = page.at(-1);
    return c.json({
      skills: page.map(({ files: _files, ...summary }) => summary),
      nextCursor:
        rows.length > query.data.limit && last
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
    const request = await parseSkillRequest(c, saveRequest);
    authorizePreferenceRegistryScopeMutation(access, request.scope);
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
      authorizePreferenceRegistryScopeMutation(access, current.scope);
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
  for (const operation of ["approve", "reject", "restore"] as const) {
    app.post(`${base}/:skillId/${operation}`, async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:read");
      const skillId = skillIdentifier(c.req.param("skillId"));
      const request = await parseSkillRequest(c, revisionRequest);
      const current = await readSkill(
        deps.db,
        { accountId: access.grant.accountId, workspaceId, subjectId: access.grant.subjectId },
        skillId,
      );
      if (!current) throw new HTTPException(404, { message: "Skill not found" });
      authorizePreferenceRegistryScopeMutation(access, current.scope);
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
      if (candidate.code === "23505" || candidate.code === "40001")
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
