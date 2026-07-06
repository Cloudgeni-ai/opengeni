// Wire shapes come from @opengeni/sdk (pinned to @opengeni/contracts by the
// SDK's contract-parity tests) — the console does not mirror them. Only the
// console-local shapes (client config, managed auth session, drafts) live here.
export type {
  AccessContext,
  AccessGrant,
  AccountGrant,
  AddWorkspaceMemberRequest,
  ApiKey,
  BillingBalance,
  BillingEntitlementsResponse,
  BillingSummary,
  CapabilityCatalogItem,
  CapabilityCatalogResponse,
  CapabilityInstallation,
  CapabilityKind,
  CapabilityPack,
  CapabilitySource,
  ConnectionKind,
  ConnectionMetadata,
  ConnectionStatus,
  CreateConnectionRequest,
  CreateFileUploadResponse,
  McpServerConnectionRef,
  OAuthStartRequest,
  OAuthStartResponse,
  CreateWorkspaceRequest,
  Document as IndexedDocument,
  DocumentBase,
  DocumentSearchMode,
  DocumentSearchResult,
  EntitlementValue,
  Entitlements,
  FileAsset,
  FileDownloadUrlResponse,
  GitHubAppInfo,
  GitHubRepository,
  GoalSpec,
  KnowledgeMemory,
  KnowledgeMemoryKind,
  KnowledgeMemoryStatus,
  KnowledgeSourceKind,
  PackInstallation,
  Permission as SdkPermission,
  ReasoningEffort,
  ResourceRef,
  SandboxBackend,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  ScheduledTaskRun,
  ScheduledTaskScheduleSpec,
  Session,
  SessionEvent,
  SessionGoal,
  SessionStatus,
  SessionTurn,
  ToolRef,
  UpdateWorkspaceMemberRequest,
  UsageEvent,
  Workspace,
  WorkspaceEnvironment,
  WorkspaceEnvironmentVariableMetadata,
  WorkspaceMember,
} from "@opengeni/sdk";
export type { CreateCapabilityCatalogItemRequest as CreateCapabilityInput } from "@opengeni/sdk";
import type { ClientModel, GoalSpec, ReasoningEffort, ResourceRef, SandboxBackend, ToolRef } from "@opengeni/sdk";
export type { ClientModel } from "@opengeni/sdk";

export type TurnSubmission = {
  text: string;
  resources?: ResourceRef[];
  tools?: ToolRef[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandboxBackend?: SandboxBackend;
  environmentId?: string;
  goal?: GoalSpec;
  firstPartyMcpPermissions?: string[];
};

export type ClientConfig = {
  deploymentRevision: string;
  defaultModel: string;
  allowedModels: string[];
  // Richer provider-grouped model list the host exposes for the picker (labels +
  // provider grouping). Empty on older hosts, where the picker falls back to the
  // flat `allowedModels` id list. Mirrors the SDK's `ClientConfig.models`.
  models: ClientModel[];
  defaultReasoningEffort: ReasoningEffort;
  allowedReasoningEfforts: ReasoningEffort[];
  mcpServers: Array<{
    id: string;
    name: string;
  }>;
  fileUploads: {
    enabled: boolean;
    maxSizeBytes: number;
  };
  productAccessMode: "local" | "configured" | "managed";
  auth:
    | { mode: "none" }
    | { mode: "deploymentKey"; headerName: "x-opengeni-access-key" }
    | { mode: "configuredToken"; headerName: "authorization"; scheme: "bearer" }
    | { mode: "managedSession"; session: "cookie" };
};

export type AuthSession = {
  session: {
    id: string;
    userId: string;
    expiresAt: string;
  };
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified?: boolean;
    image?: string | null;
  };
};
