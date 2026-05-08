export type SessionStatus = "queued" | "running" | "idle" | "requires_action" | "failed" | "cancelled";

export type ResourceRef =
  | {
      kind: "repository";
      uri: string;
      ref: string;
      mountPath?: string;
      subpath?: string;
      githubInstallationId?: number;
      githubRepositoryId?: number;
    }
  | {
      kind: "file";
      fileId: string;
      mountPath?: string;
    };

export type ToolRef = {
  kind: "mcp";
  id: string;
};

export type FileAsset = {
  id: string;
  status: "pending_upload" | "ready" | "failed" | "expired" | "deleted";
  filename: string;
  safeFilename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string | null;
  bucket: string;
  objectKey: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateFileUploadResponse = {
  fileId: string;
  uploadId: string;
  putUrl: string;
  requiredHeaders: Record<string, string>;
  expiresAt: string;
  maxSizeBytes: number;
};

export type FileDownloadUrlResponse = {
  url: string;
  expiresAt: string;
};

export type DocumentBase = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IndexedDocument = {
  id: string;
  baseId: string;
  fileId: string;
  status: "queued" | "indexing" | "ready" | "failed";
  title: string;
  parser: string;
  chunkCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentSearchResult = {
  chunkId: string;
  documentId: string;
  baseId: string;
  fileId: string;
  title: string;
  text: string;
  score: number;
  chunkIndex: number;
  metadata: Record<string, unknown>;
};

export type TurnSubmission = {
  text: string;
  resources?: ResourceRef[];
  tools?: ToolRef[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ClientConfig = {
  defaultModel: string;
  allowedModels: string[];
  defaultReasoningEffort: ReasoningEffort;
  allowedReasoningEfforts: ReasoningEffort[];
  fileUploads: {
    enabled: boolean;
    maxSizeBytes: number;
  };
};

export type Session = {
  id: string;
  status: SessionStatus;
  initialMessage: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  metadata: Record<string, unknown>;
  model: string;
  sandboxBackend: "docker" | "modal" | "local" | "none";
  temporalWorkflowId: string | null;
  activeTurnId: string | null;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
};

export type SessionEvent = {
  id: string;
  sessionId: string;
  sequence: number;
  type: string;
  payload: unknown;
  occurredAt: string;
  clientEventId?: string | null;
  turnId?: string | null;
};

export type GitHubRepository = {
  id: number;
  installationId: number;
  fullName: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  accountLogin: string;
  accountType: string | null;
};
