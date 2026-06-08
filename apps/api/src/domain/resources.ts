import type { Settings } from "@opengeni/config";
import {
  mergeResourceRefs as mergeContractResourceRefs,
  mergeToolRefs,
  resourceIdentityKey,
  ResourceRefConflictError,
  stableJson,
  type ResourceRef,
  type ToolRef,
} from "@opengeni/contracts";
import { requireFile, type Database } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

export function validateToolRefs(tools: ToolRef[], settings: Settings): ToolRef[] {
  const mcpServerIds = new Set(settings.mcpServers.map((server) => server.id));
  const selected = new Set<string>();
  const out: ToolRef[] = [];
  for (const tool of tools) {
    if (tool.kind !== "mcp") {
      throw new HTTPException(422, { message: `unsupported tool kind: ${(tool as { kind?: string }).kind}` });
    }
    if (!mcpServerIds.has(tool.id)) {
      throw new HTTPException(422, { message: `unknown MCP server id: ${tool.id}` });
    }
    if (selected.has(tool.id)) {
      continue;
    }
    selected.add(tool.id);
    out.push(tool);
  }
  return out;
}

type McpSettings = Pick<Settings, "mcpServers">;

export function enabledCapabilityMcpToolRefs(settings: McpSettings, runtimeSettings: McpSettings): ToolRef[] {
  const configuredIds = new Set(settings.mcpServers.map((server) => server.id));
  return runtimeSettings.mcpServers
    .filter((server) => !configuredIds.has(server.id))
    .map((server) => ({ kind: "mcp", id: server.id }));
}

export function withDefaultEnabledCapabilityMcpTools(tools: ToolRef[], settings: McpSettings, runtimeSettings: McpSettings): ToolRef[] {
  return mergeToolRefs(tools, enabledCapabilityMcpToolRefs(settings, runtimeSettings));
}

export function normalizeResources(resources: ResourceRef[]): ResourceRef[] {
  const mountPaths = new Map<string, string>();
  const identities = new Map<string, string>();
  const seenResources = new Set<string>();
  const out: ResourceRef[] = [];
  for (const resource of resources) {
    let normalized: ResourceRef;
    if (resource.kind === "file") {
      const mountPath = normalizeMountPath(resource.mountPath ?? `files/${resource.fileId}`);
      normalized = {
        kind: "file",
        fileId: resource.fileId,
        mountPath,
      };
    } else {
      const url = parseResourceUrl(resource.uri);
      if (url.protocol !== "https:" || !url.hostname) {
        throw new HTTPException(422, { message: "repository resources must use HTTPS Git URLs" });
      }
      const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
      const parts = path.split("/").filter(Boolean);
      if (parts.length < 2) {
        throw new HTTPException(422, { message: "repository URL must include owner and repo" });
      }
      const repo = parts.join("/");
      const mountPath = normalizeMountPath(resource.mountPath ?? `repos/${repo}`);
      normalized = {
        kind: "repository",
        uri: `https://${url.hostname.toLowerCase()}/${repo}.git`,
        ref: resource.ref.trim(),
        mountPath,
        ...(resource.subpath ? { subpath: normalizeMountPath(resource.subpath) } : {}),
        ...(resource.githubInstallationId ? { githubInstallationId: resource.githubInstallationId } : {}),
        ...(resource.githubRepositoryId ? { githubRepositoryId: resource.githubRepositoryId } : {}),
      };
    }
    const key = stableJson(normalized);
    const mounted = normalized.mountPath ? mountPaths.get(normalized.mountPath) : undefined;
    if (mounted && mounted !== key) {
      throw new HTTPException(422, { message: `duplicate resource mount path: ${normalized.mountPath}` });
    }
    if (normalized.mountPath) {
      mountPaths.set(normalized.mountPath, key);
    }
    const identity = resourceIdentityKey(normalized);
    const seenIdentity = identities.get(identity);
    if (seenIdentity && seenIdentity !== key) {
      throw new HTTPException(422, { message: `duplicate resource with different settings: ${identity}` });
    }
    identities.set(identity, key);
    if (!seenResources.has(key)) {
      seenResources.add(key);
      out.push(normalized);
    }
  }
  return out;
}

export function mergeResourceRefs(existing: ResourceRef[], additions: ResourceRef[]): ResourceRef[] {
  try {
    return mergeContractResourceRefs(existing, additions, { rejectConflicts: true });
  } catch (error) {
    if (error instanceof ResourceRefConflictError) {
      throw new HTTPException(422, { message: error.message });
    }
    throw error;
  }
}

export function validateGitHubRepositorySelection(resources: ResourceRef[]): void {
  const selected = resources.flatMap((resource) => {
    if (resource.kind !== "repository") {
      return [];
    }
    const installationRaw = resource.githubInstallationId;
    const repositoryRaw = resource.githubRepositoryId;
    if (installationRaw === null && repositoryRaw === null) {
      return [];
    }
    if (installationRaw === undefined && repositoryRaw === undefined) {
      return [];
    }
    const installationId = positiveInteger(installationRaw);
    const repositoryId = positiveInteger(repositoryRaw);
    if (!installationId || !repositoryId) {
      throw new HTTPException(422, {
        message: "GitHub App repository resources require positive github_installation_id and github_repository_id",
      });
    }
    return [{ installationId, repositoryId }];
  });
  if (selected.length === 0) {
    return;
  }
  const installationId = selected[0]!.installationId;
  if (selected.some((item) => item.installationId !== installationId)) {
    throw new HTTPException(422, {
      message: "GitHub App repository resources must belong to one installation",
    });
  }
}

export async function validateFileResources(db: Database, resources: ResourceRef[]): Promise<void> {
  const fileIds = new Set<string>();
  for (const resource of resources) {
    if (resource.kind !== "file") {
      continue;
    }
    if (fileIds.has(resource.fileId)) {
      throw new HTTPException(422, { message: `duplicate file resource: ${resource.fileId}` });
    }
    fileIds.add(resource.fileId);
    const file = await requireFile(db, resource.fileId).catch(() => null);
    if (!file) {
      throw new HTTPException(422, { message: `unknown file resource: ${resource.fileId}` });
    }
    if (file.status !== "ready") {
      throw new HTTPException(422, { message: `file resource ${resource.fileId} is ${file.status}` });
    }
  }
}

function normalizeMountPath(path: string): string {
  const normalized = path.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..")) {
    throw new HTTPException(422, { message: `invalid resource mount path: ${path}` });
  }
  return normalized;
}

function parseResourceUrl(uri: string): URL {
  try {
    return new URL(uri);
  } catch {
    throw new HTTPException(422, { message: "repository resources must use valid URLs" });
  }
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  return null;
}

export { mergeToolRefs, stableJson };
