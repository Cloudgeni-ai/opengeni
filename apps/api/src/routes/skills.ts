import {
  InstallLibrarySkillRequest,
  InstallSkillRequest,
  InstalledSkill,
  ListInstalledSkillsResponse,
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
  listInstalledSkills,
  PortableSkillInstallationVersionConflictError,
  PortableSkillInstallationVersionRequiredError,
  uninstallPortableSkill,
} from "@opengeni/db";
import { loadSkillLibrarySkill, skillLibraryRepositoryUrl } from "@opengeni/runtime/skill-library";
import { createHash } from "node:crypto";
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

  app.get("/v1/workspaces/:workspaceId/skills", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json(
      ListInstalledSkillsResponse.parse({
        skills: await listInstalledSkills(deps.db, workspaceId),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/skills/library/:libraryId/install", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const libraryId = decodeURIComponent(c.req.param("libraryId"));
    const payload = InstallLibrarySkillRequest.parse(await c.req.json());
    let loaded: ReturnType<typeof loadSkillLibrarySkill>;
    try {
      loaded = loadSkillLibrarySkill(libraryId, payload.expectedVersion);
    } catch {
      throw new HTTPException(404, { message: "Skill library entry not found" });
    }
    if (loaded.entry.contentSha256 !== payload.expectedContentSha256) {
      throw new HTTPException(409, {
        message:
          "The curated Skill changed after review. Review the current version before installing.",
      });
    }
    const files = loaded.skill.files.map((file) => {
      const bytes = new TextEncoder().encode(file.content);
      return {
        path: file.path,
        content: file.content,
        byteSize: bytes.byteLength,
        contentSha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    try {
      const installed = await installPortableSkill(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        capabilityId: `skill:${loaded.entry.id}`,
        pluginKey: `skill/library/${loaded.entry.id}`,
        source: "library",
        version: loaded.entry.version,
        sourceUrl: loaded.entry.sourceUrl,
        repositoryUrl: skillLibraryRepositoryUrl(loaded.entry.sourceUrl),
        sourceCommit: loaded.entry.sourceCommit,
        sourcePath: loaded.entry.relativePath,
        name: loaded.entry.name,
        description: loaded.entry.description,
        category: loaded.entry.category,
        tags: [...loaded.entry.tags],
        provenance: "platform",
        sourceProvenance: loaded.entry.provenance,
        contentSha256: loaded.entry.contentSha256,
        totalBytes: files.reduce((total, file) => total + file.byteSize, 0),
        license: loaded.entry.license,
        files,
        ...(payload.expectedInstallationVersion !== undefined
          ? { expectedInstallationVersion: payload.expectedInstallationVersion }
          : {}),
      });
      return c.json(
        InstalledSkill.parse({ ...installed, status: "installed" }),
        installed.created ? 201 : 200,
      );
    } catch (error) {
      throw portableSkillMutationHttpError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/skills/preview", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const payload = PreviewSkillImportRequest.parse(await c.req.json());
    const resolved = await resolveForRoute(payload.url, github);
    const installed = await getPortableSkillUninstallPreview(
      deps.db,
      workspaceId,
      portableSkillCapabilityId(resolved.preview),
    );
    return c.json(
      SkillImportPreview.parse({
        ...resolved.preview,
        installed: installed.installed,
        installationVersion: installed.installationVersion,
      }),
    );
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
    try {
      const installed = await installPortableSkill(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        capabilityId: portableSkillCapabilityId(resolved.preview),
        pluginKey: portableSkillPluginKey(resolved.preview),
        source: resolved.preview.source,
        sourceUrl: resolved.preview.sourceUrl,
        repositoryUrl: resolved.preview.repositoryUrl,
        version: resolved.preview.sourceCommit,
        sourceCommit: resolved.preview.sourceCommit,
        sourcePath: resolved.preview.sourcePath,
        name: resolved.preview.name,
        description: resolved.preview.description,
        contentSha256: resolved.preview.contentSha256,
        totalBytes: resolved.preview.totalBytes,
        ...(payload.expectedInstallationVersion !== undefined
          ? { expectedInstallationVersion: payload.expectedInstallationVersion }
          : {}),
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
      return c.json(
        InstalledSkill.parse({ ...installed, status: "installed" }),
        installed.created ? 201 : 200,
      );
    } catch (error) {
      throw portableSkillMutationHttpError(error);
    }
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

function portableSkillMutationHttpError(error: unknown): Error {
  if (error instanceof PortableSkillInstallationVersionRequiredError) {
    return new HTTPException(400, { message: error.message });
  }
  if (error instanceof PortableSkillInstallationVersionConflictError) {
    return new HTTPException(409, {
      message: "The Skill changed after review. Review the current installation again.",
    });
  }
  return error instanceof Error ? error : new Error(String(error));
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
