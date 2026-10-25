import type { ToolGatewayIdentity } from "./types";

export type WorkspaceArtifactSourceFile = {
  path: string;
  content: string;
};

export type WorkspaceArtifactSourceBundle = {
  entrypoint: string;
  files: WorkspaceArtifactSourceFile[];
};

export type WorkspaceArtifactVersion = {
  id: string;
  accountId: string;
  workspaceId: string;
  artifactId: string;
  revision: number;
  contentType: "text/html";
  contentSha256: string | null;
  sizeBytes: number;
  sourceSha256: string | null;
  sourceSizeBytes: number | null;
  requestedTools: ToolGatewayIdentity[];
  sourceSessionId: string | null;
  sourceTurnId: string | null;
  sourceAttemptId: string | null;
  sourceExecutionGeneration: number | null;
  createdBySubjectId: string;
  createdAt: string;
};

/** Pin or archive a Site row in this person's own sidebar; set at least one. */
export type UpdateSiteSidebarStateRequest = {
  pinned?: boolean;
  /** Hides the row (and the conversations under it) for this person only. */
  archived?: boolean;
};

/** This person's sidebar state for one Site row. */
export type SiteSidebarStateResponse = {
  siteId: string;
  pinned: boolean;
  pinnedAt: string | null;
  archived: boolean;
  archivedAt: string | null;
};

/** This person's latest recorded open of a Site, which orders its sidebar row. */
export type SiteOpenedResponse = {
  /** When the open was recorded (ISO 8601). */
  openedAt: string;
};

/** Who can see a Site: everyone in the workspace, or only its owner ("Only me"). */
export type WorkspaceArtifactVisibility = "private" | "workspace";

export type WorkspaceArtifact = {
  id: string;
  accountId: string;
  workspaceId: string;
  slug: string;
  title: string;
  description: string | null;
  status: "active" | "archived";
  /** Absent from older servers, where every Site is visible to the workspace. */
  visibility?: WorkspaceArtifactVisibility;
  /** The person the Site belongs to; only they can change its audience. */
  ownerSubjectId?: string | null;
  currentVersion: WorkspaceArtifactVersion | null;
  createdBySubjectId: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceArtifactEvent = {
  id: string;
  accountId: string;
  workspaceId: string;
  artifactId: string;
  type: "published" | "rolled_back" | "archived" | "restored";
  fromVersionId: string | null;
  toVersionId: string;
  sourceSessionId: string | null;
  sourceTurnId: string | null;
  sourceAttemptId: string | null;
  sourceExecutionGeneration: number | null;
  actorSubjectId: string;
  reason: string;
  createdAt: string;
};

export type WorkspaceArtifactListOptions = {
  sourceSessionId?: string;
  limit?: number;
  cursor?: string;
  status?: WorkspaceArtifact["status"];
};
export type WorkspaceArtifactListResponse = {
  artifacts: WorkspaceArtifact[];
  nextCursor: string | null;
  truncated: boolean;
};
export type WorkspaceArtifactDetailResponse = {
  artifact: WorkspaceArtifact;
  versions: WorkspaceArtifactVersion[];
  events: WorkspaceArtifactEvent[];
  versionsTruncated: boolean;
  eventsTruncated: boolean;
};
/**
 * A Site and its current version without its history or who made it: what an
 * open Site view checks to see whether a new version is live.
 */
export type WorkspaceArtifactCurrentResponse = {
  artifact: WorkspaceArtifact;
};
export type WorkspaceArtifactContentResponse = {
  artifactId: string;
  versionId: string;
  contentType: "text/html";
  contentSha256: string | null;
  html: string;
  source: WorkspaceArtifactSourceBundle;
  requestedTools: ToolGatewayIdentity[];
};
export type WorkspaceArtifactMutationResponse = {
  artifact: WorkspaceArtifact;
  version: WorkspaceArtifactVersion;
  event: WorkspaceArtifactEvent;
  replayed: boolean;
};
export type CreateWorkspaceArtifactRequest = {
  slug?: string;
  title: string;
  description?: string | null;
  html?: string;
  uploadId?: string;
  source?: WorkspaceArtifactSourceBundle;
  requestedTools?: ToolGatewayIdentity[];
  /** Who can see the new Site. Omitted: the whole workspace. */
  visibility?: WorkspaceArtifactVisibility;
  idempotencyKey: string;
};
export type PublishWorkspaceArtifactVersionRequest = {
  title?: string;
  description?: string | null;
  html?: string;
  uploadId?: string;
  source?: WorkspaceArtifactSourceBundle;
  requestedTools?: ToolGatewayIdentity[];
  expectedCurrentVersionId: string;
  idempotencyKey: string;
};
export type RollbackWorkspaceArtifactRequest = {
  versionId: string;
  expectedCurrentVersionId: string;
  reason: string;
  idempotencyKey: string;
};
/** A new Site from another Site's current version. Its publication and data stay behind. */
export type DuplicateWorkspaceArtifactRequest = {
  /** Omitted: the original's title followed by "(copy)". */
  title?: string;
  idempotencyKey: string;
};
export type SetWorkspaceArtifactStatusRequest = {
  status: "active" | "archived";
  expectedCurrentVersionId: string;
  reason: string;
  idempotencyKey: string;
};
export type UpdateWorkspaceArtifactVisibilityRequest = {
  visibility: WorkspaceArtifactVisibility;
};
export type UpdateWorkspaceArtifactVisibilityResponse = {
  artifact: WorkspaceArtifact;
};
