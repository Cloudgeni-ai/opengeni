import type { ScopedKnowledgeScope } from "@opengeni/contracts";
import {
  connectorDestinationDocumentAuthority,
  resolveConnectorDocumentDestination,
  type ConnectorDocumentDestination,
} from "@opengeni/contracts/connector-destinations";
import type { AtlassianSelectedSource } from "@opengeni/contracts/atlassian";

export const ATLASSIAN_PROVIDER_KEY = "atlassian" as const;

export type AtlassianKnowledgeSourceIdentity = {
  providerKey: typeof ATLASSIAN_PROVIDER_KEY;
  externalTenantId: string;
  externalSourceId: string;
  sourceKind: "atlassian-jira-project" | "atlassian-confluence-space";
  sourceUri: string;
  scope: ScopedKnowledgeScope;
};

export type AtlassianInventoryProviderItem = {
  id: string;
  key: string;
  title: string;
  version: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  webUrl: string;
};

export type AtlassianInventoryPage = {
  items: AtlassianInventoryProviderItem[];
  nextCursor: string | null;
};

export type AtlassianInventoryEntry = {
  externalObjectId: string;
  externalVersionId: string | null;
  sourceId: string;
  parentFolderId: string;
  driveId: null;
  title: string;
  mimeType: "text/markdown";
  modifiedTime: string | null;
  createdTime: string | null;
  sourceUri: string;
  transfer: {
    action: "download";
    contentType: "text/markdown";
    filename: string;
    declaredBytes: null;
  };
};

export type AtlassianInventoryStopReason =
  | "api_request_limit"
  | "elapsed_time_limit"
  | "item_limit"
  | "provider_error";

export type AtlassianInventoryCheckpoint = {
  version: 1;
  cloudId: string;
  sourceId: string;
  cursor: string | null;
  itemCount: number;
  apiRequestCount: number;
};

export function atlassianKnowledgeScope(
  destination: ConnectorDocumentDestination,
): ScopedKnowledgeScope {
  const authority = connectorDestinationDocumentAuthority(destination);
  if (authority.authorityKind === "organization") {
    return { kind: "organization", workspaceId: null, subjectId: null };
  }
  if (authority.authorityKind === "workspace") {
    if (!authority.authorityWorkspaceId) throw new Error("workspace authority is missing");
    return { kind: "workspace", workspaceId: authority.authorityWorkspaceId, subjectId: null };
  }
  if (!authority.authorityWorkspaceId || !authority.authoritySubjectId) {
    throw new Error("personal authority is missing");
  }
  return {
    kind: "personal",
    workspaceId: authority.authorityWorkspaceId,
    subjectId: authority.authoritySubjectId,
  };
}

export function atlassianKnowledgeSourceIdentity(input: {
  source: AtlassianSelectedSource;
  accountId: string;
  workspaceId: string;
  connectionSubjectId: string;
}): AtlassianKnowledgeSourceIdentity {
  const destination = resolveConnectorDocumentDestination(input.source.destination, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    connectionSubjectId: input.connectionSubjectId,
  });
  const siteUrl = new URL(input.source.siteUrl);
  const sourceUri =
    input.source.kind === "jira_project"
      ? new URL(`/jira/software/c/projects/${encodeURIComponent(input.source.key)}`, siteUrl)
      : new URL(`/wiki/spaces/${encodeURIComponent(input.source.key)}`, siteUrl);
  return {
    providerKey: ATLASSIAN_PROVIDER_KEY,
    externalTenantId: bounded(input.source.cloudId, 256, "cloudId"),
    externalSourceId: bounded(input.source.id, 300, "source.id"),
    sourceKind:
      input.source.kind === "jira_project"
        ? "atlassian-jira-project"
        : "atlassian-confluence-space",
    sourceUri: sourceUri.toString(),
    scope: atlassianKnowledgeScope(destination),
  };
}

export async function inventoryAtlassianSource(input: {
  cloudId: string;
  source: AtlassianSelectedSource;
  limits: { maxItems: number; maxApiRequests: number; maxElapsedMs: number; pageSize: number };
  checkpoint: Record<string, unknown> | null;
  listPage: (cursor: string | null, pageSize: number) => Promise<AtlassianInventoryPage>;
}): Promise<{
  status: "complete" | "paused";
  stopReason: AtlassianInventoryStopReason | null;
  entries: AtlassianInventoryEntry[];
  checkpoint: AtlassianInventoryCheckpoint | null;
  providerRequests: number;
  elapsedMs: number;
}> {
  const startedAt = Date.now();
  const restored = parseCheckpoint(input.checkpoint, input.cloudId, input.source.id);
  let cursor = restored?.cursor ?? null;
  let itemCount = restored?.itemCount ?? 0;
  let apiRequestCount = restored?.apiRequestCount ?? 0;
  const entries: AtlassianInventoryEntry[] = [];

  while (true) {
    if (Date.now() - startedAt >= input.limits.maxElapsedMs) return paused("elapsed_time_limit");
    if (apiRequestCount >= input.limits.maxApiRequests) return paused("api_request_limit");
    if (itemCount >= input.limits.maxItems) return paused("item_limit");

    let page: AtlassianInventoryPage;
    try {
      page = await input.listPage(
        cursor,
        Math.min(input.limits.pageSize, input.limits.maxItems - itemCount),
      );
    } catch {
      return paused("provider_error");
    }
    apiRequestCount += 1;
    for (const item of page.items) {
      if (itemCount >= input.limits.maxItems) return paused("item_limit");
      entries.push(atlassianEntry(input.source, item));
      itemCount += 1;
    }
    cursor = page.nextCursor;
    if (!cursor) {
      return {
        status: "complete",
        stopReason: null,
        entries,
        checkpoint: null,
        providerRequests: apiRequestCount - (restored?.apiRequestCount ?? 0),
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  function paused(stopReason: AtlassianInventoryStopReason) {
    return {
      status: "paused" as const,
      stopReason,
      entries,
      checkpoint: {
        version: 1 as const,
        cloudId: input.cloudId,
        sourceId: input.source.id,
        cursor,
        itemCount,
        apiRequestCount,
      },
      providerRequests: apiRequestCount - (restored?.apiRequestCount ?? 0),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

function atlassianEntry(
  source: AtlassianSelectedSource,
  item: AtlassianInventoryProviderItem,
): AtlassianInventoryEntry {
  const title = bounded(item.title, 1024, "title");
  return {
    externalObjectId: bounded(`${source.kind}:${item.id}`, 512, "item.id"),
    externalVersionId: item.version,
    sourceId: source.id,
    parentFolderId: source.resourceId,
    driveId: null,
    title,
    mimeType: "text/markdown",
    modifiedTime: item.updatedAt,
    createdTime: item.createdAt,
    sourceUri: new URL(item.webUrl).toString(),
    transfer: {
      action: "download",
      contentType: "text/markdown",
      filename: `${safeFilename(item.key || title)}.md`,
      declaredBytes: null,
    },
  };
}

function parseCheckpoint(
  value: Record<string, unknown> | null,
  cloudId: string,
  sourceId: string,
): AtlassianInventoryCheckpoint | null {
  if (!value) return null;
  if (
    value.version !== 1 ||
    value.cloudId !== cloudId ||
    value.sourceId !== sourceId ||
    (value.cursor !== null && typeof value.cursor !== "string") ||
    !Number.isSafeInteger(value.itemCount) ||
    !Number.isSafeInteger(value.apiRequestCount)
  ) {
    throw new Error("invalid Atlassian inventory checkpoint");
  }
  return value as AtlassianInventoryCheckpoint;
}

function bounded(value: string, max: number, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`invalid ${label}`);
  return normalized;
}

function safeFilename(value: string): string {
  return (
    value
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|\0-\x1f]/g, "_")
      .trim()
      .slice(0, 220) || "item"
  );
}
