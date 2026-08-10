import {
  InstallSkillRequest,
  InstalledSkill,
  PreviewSkillImportRequest,
  SkillImportPreview,
  SkillUninstallPreview,
  UninstallSkillRequest,
  UninstallSkillResult,
} from "@opengeni/contracts";
import {
  portableSkillCapabilityId,
  portableSkillPluginKey,
  requireAccessGrant,
  resolveSkillImport,
  type ApiRouteDeps,
  type GitHubSkillSourceClient,
} from "@opengeni/core";
import {
  getPortableSkillUninstallPreview,
  installPortableSkill,
  PortableSkillInstallationVersionConflictError,
  uninstallPortableSkill,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";

import { createGitHubSkillSourceClient } from "../integrations/github-skill-source";

export type SkillRouteOverrides = Readonly<{
  github?: GitHubSkillSourceClient;
}>;

export function registerSkillRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  overrides: SkillRouteOverrides = {},
): void {
  const github = overrides.github ?? createGitHubSkillSourceClient(deps.settings);

  app.post("/v1/workspaces/:workspaceId/skills/preview", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const payload = PreviewSkillImportRequest.parse(await c.req.json());
    const resolved = await resolveForRoute(payload.url, github);
    return c.json(SkillImportPreview.parse(resolved.preview));
  });

  app.post("/v1/workspaces/:workspaceId/skills/install", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = InstallSkillRequest.parse(await c.req.json());
    const resolved = await resolveForRoute(payload.url, github);
    if (
      resolved.preview.sourceCommit !== payload.expectedSourceCommit ||
      resolved.preview.contentSha256 !== payload.expectedContentSha256
    ) {
      throw new HTTPException(409, {
        message:
          "The Skill source changed after preview. Review the new commit and contents before installing.",
      });
    }
    const fileSummaryByPath = new Map(
      resolved.preview.files.map((file) => [file.path, file] as const),
    );
    const installed = await installPortableSkill(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      capabilityId: portableSkillCapabilityId(resolved.preview),
      pluginKey: portableSkillPluginKey(resolved.preview),
      source: resolved.preview.source,
      sourceUrl: resolved.preview.sourceUrl,
      repositoryUrl: resolved.preview.repositoryUrl,
      sourceCommit: resolved.preview.sourceCommit,
      sourcePath: resolved.preview.sourcePath,
      name: resolved.preview.name,
      description: resolved.preview.description,
      contentSha256: resolved.preview.contentSha256,
      totalBytes: resolved.preview.totalBytes,
      files: resolved.files.map((file) => {
        const summary = fileSummaryByPath.get(file.path);
        if (!summary) throw new Error(`Skill preview omitted ${file.path}`);
        return {
          path: file.path,
          content: file.content,
          byteSize: summary.byteSize,
          contentSha256: summary.contentSha256,
        };
      }),
    });
    return c.json(InstalledSkill.parse({ ...installed, status: "installed" }), 201);
  });

  app.get("/v1/workspaces/:workspaceId/skills/:capabilityId/uninstall-preview", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const capabilityId = decodeURIComponent(c.req.param("capabilityId"));
    return c.json(
      SkillUninstallPreview.parse(
        await getPortableSkillUninstallPreview(deps.db, workspaceId, capabilityId),
      ),
    );
  });

  app.delete("/v1/workspaces/:workspaceId/skills/:capabilityId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const capabilityId = decodeURIComponent(c.req.param("capabilityId"));
    const payload = UninstallSkillRequest.parse(await c.req.json());
    try {
      return c.json(
        UninstallSkillResult.parse(
          await uninstallPortableSkill(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            capabilityId,
            expectedInstallationVersion: payload.expectedInstallationVersion,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof PortableSkillInstallationVersionConflictError) {
        throw new HTTPException(409, {
          message: "The Skill changed after preview. Review uninstall impact again.",
        });
      }
      throw error;
    }
  });
}

async function resolveForRoute(
  url: string,
  github: Parameters<typeof resolveSkillImport>[1],
): ReturnType<typeof resolveSkillImport> {
  try {
    return await resolveSkillImport(url, github);
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(502, {
      message: error instanceof Error ? error.message : "The Skill source could not be read",
    });
  }
}
