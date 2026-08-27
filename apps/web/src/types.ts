// Wire shapes come from @opengeni/sdk (pinned to @opengeni/contracts by the
// SDK's contract-parity tests) — the console does not mirror them. Only the
// console-local shapes (managed auth session and drafts) live here.
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";

export type {
  AccessContext,
  AtlassianBrowseItem,
  AtlassianBrowseResponse,
  AtlassianConnectionLifecycle,
  AtlassianConnectionMetadata,
  AtlassianDisconnectRequest,
  AtlassianLifecycleActionRequest,
  AtlassianOAuthStartResponse,
  AtlassianReadPolicy,
  AtlassianSelectedSource,
  AtlassianSourceKind,
  AtlassianSyncCadence,
  AccessGrant,
  AccountGrant,
  AddWorkspaceMemberRequest,
  ApiIntegrationInstallationSummary,
  IntegrationDefinitionSummary,
  ApiIntegrationPreview,
  IntegrationSource,
  IntegrationFacetBindingSummary,
  IntegrationFacetDefinitionSummary,
  IntegrationInstanceFacetsResponse,
  InstalledSkillSummary,
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
  Channel,
  ClientConfig,
  ConnectionKind,
  ConnectionMetadata,
  ConnectionOwnership,
  ConnectionStatus,
  ConnectorDocumentDestination,
  ConnectorDocumentDestinationAuthority,
  ConnectorDocumentDestinationSelection,
  CreateConnectionRequest,
  CreateFileUploadResponse,
  CreateRigRequest,
  ProposeRigChangeRequest,
  McpServerConnectionRef,
  McpPersonalConnectionSummary,
  OAuthStartRequest,
  OAuthStartResponse,
  OrganizationPrivateSessionSettings,
  OrganizationRecoveryOverview,
  CreateWorkspaceRequest,
  Document as IndexedDocument,
  DocumentAuthorityKind,
  DocumentBase,
  DocumentCurationStatus,
  DocumentSearchMode,
  DocumentSearchResult,
  DocumentVisibility,
  EntitlementValue,
  Entitlements,
  FileAsset,
  FileDownloadUrlResponse,
  GitHubAppInfo,
  GitHubAppSetupMode,
  GitHubBindingStatus,
  GitHubInstallationBinding,
  GitHubRepository,
  GoogleDriveBrowseItem,
  GoogleDriveBrowseResponse,
  GoogleDriveConnectionLifecycle,
  GoogleDriveConnectionLifecycleState,
  GoogleDriveConnectionMetadata,
  GoogleDriveDisconnectRequest,
  GoogleDriveKnowledgeSourceConfig,
  GoogleDriveKnowledgeSourceDestination,
  GoogleDriveKnowledgeSourceItem,
  GoogleDriveLifecycleActionRequest,
  GoogleDriveOAuthStartResponse,
  GoogleDriveReadPolicy,
  GoogleDriveSelectedSource,
  GoogleDriveSyncCadence,
  GoogleDriveTargetScope,
  SaveGoogleDriveIntegrationSourceRequest,
  GoalSpec,
  CreateKnowledgeMemoryRequest,
  KnowledgeMemory,
  KnowledgeMemoryKind,
  KnowledgeMemoryStatus,
  KnowledgeSourceKind,
  PackComponentResolution,
  PackInstallation,
  PackInstallationPreview,
  PackUninstallPreview,
  PluginComponentPreview,
  PluginInstallationSummary,
  PluginPreview,
  PluginUninstallPreview,
  SkillImportPreview,
  SkillUninstallPreview,
  Permission as SdkPermission,
  LatencyMode,
  ManagedOrganizationMembership,
  ReasoningEffort,
  ResourceAuthorityScope,
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
  SocialConnection,
  SlackInstallationBinding,
  SlackUserLinkAccessRequest,
  ToolRef,
  UpdateKnowledgeMemoryRequest,
  UpdateWorkspaceMemberRequest,
  UpdateWorkspaceSettingsRequest,
  UsageEvent,
  Workspace,
  WorkspaceEnvironment,
  VariableSet,
  VariableSetSecret,
  VariableSetVariableMetadata,
  WorkspaceEnvironmentVariableMetadata,
  WorkspaceMember,
  WorkspaceMemorySearchMode,
  WorkspaceMemorySearchResponse,
  WorkspaceMemorySearchResult,
} from "@opengeni/sdk";

// Infer lifecycle leaf types from the public client rather than mirroring wire
// shapes. Organization private-session settings are exported directly because
// their request helpers live in an opt-in SDK subpath.
export type OrganizationInvitation = Awaited<
  ReturnType<OpenGeniCoreClient["listOrganizationInvitations"]>
>["invitations"][number];
export type OrganizationMember = Awaited<
  ReturnType<OpenGeniCoreClient["listOrganizationMembers"]>
>["members"][number];
export type OrganizationMembershipRole = OrganizationMember["role"];
export type OrganizationAdministrationOverview = Awaited<
  ReturnType<OpenGeniCoreClient["getOrganizationAdministrationOverview"]>
>;
export type OrganizationWorkspaceAccess = OrganizationAdministrationOverview["workspaces"][number];
export type OrganizationWorkspaceAccessMember = OrganizationWorkspaceAccess["members"][number];
export type OrganizationRetentionPolicy = Awaited<
  ReturnType<OpenGeniCoreClient["getOrganizationRetentionPolicy"]>
>;

export type WorkspaceVariableSet = VariableSet;
export type WorkspaceVariableSetSecret = VariableSetSecret;
export type WorkspaceVariableSetVariableMetadata = VariableSetVariableMetadata;
export type { CreateCapabilityCatalogItemRequest as CreateCapabilityInput } from "@opengeni/sdk";
import type {
  GoalSpec,
  LatencyMode,
  ReasoningEffort,
  ResourceRef,
  SandboxBackend,
  ToolRef,
  VariableSet,
  VariableSetSecret,
  VariableSetVariableMetadata,
} from "@opengeni/sdk";
export type { ClientModel } from "@opengeni/sdk";

export type TurnSubmission = {
  text: string;
  resources?: ResourceRef[];
  tools?: ToolRef[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  latencyMode?: LatencyMode;
  sandboxBackend?: SandboxBackend;
  variableSetIds?: string[];
  variableSetId?: string;
  /**  use variableSetId */
  environmentId?: string;
  /** The rig this session rides (resolved + frozen at create). */
  rigId?: string;
  goal?: GoalSpec;
  firstPartyMcpPermissions?: string[];
  firstPartyMcpTools?: import("@opengeni/sdk").FirstPartyMcpToolName[];
  personalResourceAttachment?: import("@opengeni/sdk").PersonalResourceAttachmentIntent;
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
