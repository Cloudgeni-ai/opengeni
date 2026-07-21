// Wire shapes come from @opengeni/sdk (pinned to @opengeni/contracts by the
// SDK's contract-parity tests) — the console does not mirror them. Only the
// console-local shapes (managed auth session and drafts) live here.
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
  ClientConfig,
  ConnectionKind,
  ConnectionMetadata,
  ConnectionStatus,
  CreateConnectionRequest,
  CreateFileUploadResponse,
  CreateRigRequest,
  ProposeRigChangeRequest,
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
  GitHubCapabilityHealth,
  GitHubInstallationBinding,
  GitHubRepository,
  GoalSpec,
  CreateKnowledgeMemoryRequest,
  KnowledgeMemory,
  KnowledgeMemoryKind,
  KnowledgeMemoryStatus,
  KnowledgeSourceKind,
  PackInstallation,
  Permission as SdkPermission,
  ReasoningEffort,
  ResourceRef,
  Rig,
  RigChange,
  RigChangeKind,
  RigChangeStatus,
  RigChangeVerification,
  RigCheck,
  RigCheckResult,
  RigVersion,
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
  UpdateKnowledgeMemoryRequest,
  UpdateWorkspaceMemberRequest,
  UpdateWorkspaceSettingsRequest,
  UsageEvent,
  Workspace,
  WorkspaceEnvironment,
  VariableSet,
  VariableSetVariableMetadata,
  WorkspaceEnvironmentVariableMetadata,
  WorkspaceMember,
  WorkspaceMemorySearchMode,
  WorkspaceMemorySearchResponse,
  WorkspaceMemorySearchResult,
} from "@opengeni/sdk";

export type WorkspaceVariableSet = VariableSet;
export type WorkspaceVariableSetVariableMetadata = VariableSetVariableMetadata;
export type { CreateCapabilityCatalogItemRequest as CreateCapabilityInput } from "@opengeni/sdk";
import type {
  GoalSpec,
  ReasoningEffort,
  ResourceRef,
  SandboxBackend,
  ToolRef,
  VariableSet,
  VariableSetVariableMetadata,
} from "@opengeni/sdk";
export type { ClientModel } from "@opengeni/sdk";

export type TurnSubmission = {
  text: string;
  resources?: ResourceRef[];
  tools?: ToolRef[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandboxBackend?: SandboxBackend;
  variableSetId?: string;
  /**  use variableSetId */
  environmentId?: string;
  /** The rig this session rides (resolved + frozen at create). */
  rigId?: string;
  goal?: GoalSpec;
  firstPartyMcpPermissions?: string[];
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
