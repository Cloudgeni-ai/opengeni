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
  contentSha256: string;
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

export type WorkspaceArtifact = {
  id: string;
  accountId: string;
  workspaceId: string;
  slug: string;
  title: string;
  description: string | null;
  status: "active" | "archived";
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
export type WorkspaceArtifactContentResponse = {
  artifactId: string;
  versionId: string;
  contentType: "text/html";
  contentSha256: string;
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
  html: string;
  source?: WorkspaceArtifactSourceBundle;
  requestedTools?: ToolGatewayIdentity[];
  idempotencyKey: string;
};
export type PublishWorkspaceArtifactVersionRequest = {
  title?: string;
  description?: string | null;
  html: string;
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
export type SetWorkspaceArtifactStatusRequest = {
  status: "active" | "archived";
  expectedCurrentVersionId: string;
  reason: string;
  idempotencyKey: string;
};
