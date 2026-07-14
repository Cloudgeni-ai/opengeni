import { describe, expect, test } from "bun:test";
import {
  AccessContext as ContractAccessContext,
  ApiKey as ContractApiKey,
  BillingBalance as ContractBillingBalance,
  CapabilityCatalogItem as ContractCapabilityCatalogItem,
  CapabilityInstallation as ContractCapabilityInstallation,
  CapabilityKind as ContractCapabilityKind,
  CapabilityPack as ContractCapabilityPack,
  CapabilitySource as ContractCapabilitySource,
  CreateApiKeyRequest as ContractCreateApiKeyRequest,
  CreateCapabilityCatalogItemRequest as ContractCreateCapabilityCatalogItemRequest,
  CreateCheckoutRequest as ContractCreateCheckoutRequest,
  CreateCheckoutResponse as ContractCreateCheckoutResponse,
  CreateDocumentBaseRequest as ContractCreateDocumentBaseRequest,
  CreateFileUploadRequest as ContractCreateFileUploadRequest,
  CreateFileUploadResponse as ContractCreateFileUploadResponse,
  CreateScheduledTaskRequest as ContractCreateScheduledTaskRequest,
  CreateWorkspaceEnvironmentRequest as ContractCreateWorkspaceEnvironmentRequest,
  CreateWorkspaceRequest as ContractCreateWorkspaceRequest,
  Document as ContractDocument,
  DocumentBase as ContractDocumentBase,
  DocumentSearchResult as ContractDocumentSearchResult,
  DocumentStatus as ContractDocumentStatus,
  EnableCapabilityRequest as ContractEnableCapabilityRequest,
  EnablePackRequest as ContractEnablePackRequest,
  FileAsset as ContractFileAsset,
  FileStatus as ContractFileStatus,
  GitHubAppManifestCreate as ContractGitHubAppManifestCreate,
  GitHubRepository as ContractGitHubRepository,
  PackInstallation as ContractPackInstallation,
  PackInstallationStatus as ContractPackInstallationStatus,
  Permission as ContractPermission,
  ProductAccessMode as ContractProductAccessMode,
  RegisterCapabilityPackRequest as ContractRegisterCapabilityPackRequest,
  ScheduledTaskRun as ContractScheduledTaskRun,
  ScheduledTaskRunStatus as ContractScheduledTaskRunStatus,
  ScheduledTaskTriggerType as ContractScheduledTaskTriggerType,
  SessionGoal as ContractSessionGoal,
  SessionGoalCreatedBy as ContractSessionGoalCreatedBy,
  SessionGoalStatus as ContractSessionGoalStatus,
  SetWorkspaceEnvironmentVariableRequest as ContractSetVariableRequest,
  UpdateScheduledTaskRequest as ContractUpdateScheduledTaskRequest,
  UpdateSessionGoalRequest as ContractUpdateSessionGoalRequest,
  UpdateWorkspaceEnvironmentRequest as ContractUpdateWorkspaceEnvironmentRequest,
  UpdateWorkspaceRequest as ContractUpdateWorkspaceRequest,
  UsageEvent as ContractUsageEvent,
  UsageEventType as ContractUsageEventType,
  Workspace as ContractWorkspace,
  WorkspaceEnvironment as ContractWorkspaceEnvironment,
  WorkspaceRegisteredPack as ContractWorkspaceRegisteredPack,
} from "@opengeni/contracts";
import type { z } from "zod";
import { KNOWN_PERMISSIONS, KNOWN_USAGE_EVENT_TYPES } from "../src/types";
import type {
  AccessContext,
  ApiKey,
  BillingBalance,
  CapabilityCatalogItem,
  CapabilityInstallation,
  CapabilityKind,
  CapabilityPack,
  CapabilitySource,
  CreateApiKeyRequest,
  CreateCapabilityCatalogItemRequest,
  CreateCheckoutRequest,
  CreateCheckoutResponse,
  CreateDocumentBaseRequest,
  CreateFileUploadRequest,
  CreateFileUploadResponse,
  CreateGitHubAppManifestRequest,
  CreateScheduledTaskRequest,
  CreateWorkspaceEnvironmentRequest,
  CreateWorkspaceRequest,
  Document,
  DocumentBase,
  DocumentSearchResult,
  DocumentStatus,
  EnableCapabilityRequest,
  EnablePackRequest,
  FileAsset,
  FileStatus,
  GitHubRepository,
  PackInstallation,
  PackInstallationStatus,
  ProductAccessMode,
  RegisterCapabilityPackRequest,
  ScheduledTaskRun,
  ScheduledTaskRunStatus,
  ScheduledTaskTriggerType,
  SessionGoal,
  SessionGoalCreatedBy,
  SessionGoalStatus,
  UpdateScheduledTaskRequest,
  UpdateSessionGoalRequest,
  UpdateWorkspaceEnvironmentRequest,
  UpdateWorkspaceRequest,
  UsageEvent,
  Workspace,
  WorkspaceEnvironment,
  WorkspaceRegisteredPack,
} from "../src/types";

// Parity pins for the full-coverage SDK types, in the same style as
// `contract-parity.test.ts`: enum literals are compared value-level, response
// shapes are checked server->client (contract output assignable to SDK type),
// and request shapes are checked client->server (SDK type assignable to
// contract z.input). Permission-bearing request fields are open string unions
// in the SDK (forward compatible) and are validated by the server at runtime,
// so they are omitted from the compile-time client->server checks.

describe("SDK / contracts parity (full coverage)", () => {
  test("permission and usage-event literals match the contracts enums", () => {
    expect([...KNOWN_PERMISSIONS].sort()).toEqual([...ContractPermission.options].sort());
    expect([...KNOWN_USAGE_EVENT_TYPES].sort()).toEqual([...ContractUsageEventType.options].sort());
  });

  test("status/enum literals match the contracts", () => {
    const accessModes: readonly ProductAccessMode[] = ContractProductAccessMode.options;
    const goalStatuses: readonly SessionGoalStatus[] = ContractSessionGoalStatus.options;
    const goalCreators: readonly SessionGoalCreatedBy[] = ContractSessionGoalCreatedBy.options;
    const runStatuses: readonly ScheduledTaskRunStatus[] = ContractScheduledTaskRunStatus.options;
    const triggerTypes: readonly ScheduledTaskTriggerType[] =
      ContractScheduledTaskTriggerType.options;
    const fileStatuses: readonly FileStatus[] = ContractFileStatus.options;
    const documentStatuses: readonly DocumentStatus[] = ContractDocumentStatus.options;
    const packStatuses: readonly PackInstallationStatus[] = ContractPackInstallationStatus.options;
    const capabilityKinds: readonly CapabilityKind[] = ContractCapabilityKind.options;
    const capabilitySources: readonly CapabilitySource[] = ContractCapabilitySource.options;
    expect(accessModes).toEqual(ContractProductAccessMode.options);
    expect(goalStatuses).toEqual(ContractSessionGoalStatus.options);
    expect(goalCreators).toEqual(ContractSessionGoalCreatedBy.options);
    expect(runStatuses).toEqual(ContractScheduledTaskRunStatus.options);
    expect(triggerTypes).toEqual(ContractScheduledTaskTriggerType.options);
    expect(fileStatuses).toEqual(ContractFileStatus.options);
    expect(documentStatuses).toEqual(ContractDocumentStatus.options);
    expect(packStatuses).toEqual(ContractPackInstallationStatus.options);
    expect(capabilityKinds).toEqual(ContractCapabilityKind.options);
    expect(capabilitySources).toEqual(ContractCapabilitySource.options);
  });

  test("contract-parsed responses are assignable to SDK types (compile-time)", () => {
    const acceptAccessContext = (value: z.infer<typeof ContractAccessContext>): AccessContext =>
      value;
    const acceptWorkspace = (value: z.infer<typeof ContractWorkspace>): Workspace => value;
    const acceptApiKey = (value: z.infer<typeof ContractApiKey>): ApiKey => value;
    const acceptGoal = (value: z.infer<typeof ContractSessionGoal>): SessionGoal => value;
    const acceptRun = (value: z.infer<typeof ContractScheduledTaskRun>): ScheduledTaskRun => value;
    const acceptEnvironment = (
      value: z.infer<typeof ContractWorkspaceEnvironment>,
    ): WorkspaceEnvironment => value;
    const acceptFile = (value: z.infer<typeof ContractFileAsset>): FileAsset => value;
    const acceptUploadBegin = (
      value: z.infer<typeof ContractCreateFileUploadResponse>,
    ): CreateFileUploadResponse => value;
    const acceptDocumentBase = (value: z.infer<typeof ContractDocumentBase>): DocumentBase => value;
    const acceptDocument = (value: z.infer<typeof ContractDocument>): Document => value;
    const acceptSearchResult = (
      value: z.infer<typeof ContractDocumentSearchResult>,
    ): DocumentSearchResult => value;
    const acceptPack = (value: z.infer<typeof ContractCapabilityPack>): CapabilityPack => value;
    const acceptRegisteredPack = (
      value: z.infer<typeof ContractWorkspaceRegisteredPack>,
    ): WorkspaceRegisteredPack => value;
    const acceptPackInstallation = (
      value: z.infer<typeof ContractPackInstallation>,
    ): PackInstallation => value;
    const acceptCatalogItem = (
      value: z.infer<typeof ContractCapabilityCatalogItem>,
    ): CapabilityCatalogItem => value;
    const acceptCapabilityInstallation = (
      value: z.infer<typeof ContractCapabilityInstallation>,
    ): CapabilityInstallation => value;
    const acceptRepository = (value: z.infer<typeof ContractGitHubRepository>): GitHubRepository =>
      value;
    const acceptBalance = (value: z.infer<typeof ContractBillingBalance>): BillingBalance => value;
    const acceptUsageEvent = (value: z.infer<typeof ContractUsageEvent>): UsageEvent => value;
    const acceptCheckout = (
      value: z.infer<typeof ContractCreateCheckoutResponse>,
    ): CreateCheckoutResponse => value;
    const checks = [
      acceptAccessContext,
      acceptWorkspace,
      acceptApiKey,
      acceptGoal,
      acceptRun,
      acceptEnvironment,
      acceptFile,
      acceptUploadBegin,
      acceptDocumentBase,
      acceptDocument,
      acceptSearchResult,
      acceptPack,
      acceptRegisteredPack,
      acceptPackInstallation,
      acceptCatalogItem,
      acceptCapabilityInstallation,
      acceptRepository,
      acceptBalance,
      acceptUsageEvent,
      acceptCheckout,
    ];
    expect(checks.every((fn) => typeof fn === "function")).toBe(true);
  });

  test("SDK-built requests are assignable to contract inputs (compile-time)", () => {
    const acceptCreateWorkspace = (
      value: CreateWorkspaceRequest,
    ): z.input<typeof ContractCreateWorkspaceRequest> => value;
    const acceptUpdateWorkspace = (
      value: UpdateWorkspaceRequest,
    ): z.input<typeof ContractUpdateWorkspaceRequest> => value;
    // Permissions are open string unions in the SDK; the server validates them.
    const ContractCreateApiKeyBody = ContractCreateApiKeyRequest.omit({
      workspaceId: true,
      permissions: true,
    });
    const acceptCreateApiKey = (
      value: Omit<CreateApiKeyRequest, "permissions">,
    ): z.input<typeof ContractCreateApiKeyBody> => value;
    const acceptUpdateGoal = (
      value: UpdateSessionGoalRequest,
    ): z.input<typeof ContractUpdateSessionGoalRequest> => value;
    const acceptCreateTask = (
      value: CreateScheduledTaskRequest,
    ): z.input<typeof ContractCreateScheduledTaskRequest> => value;
    const acceptUpdateTask = (
      value: UpdateScheduledTaskRequest,
    ): z.input<typeof ContractUpdateScheduledTaskRequest> => value;
    const acceptCreateEnvironment = (
      value: CreateWorkspaceEnvironmentRequest,
    ): z.input<typeof ContractCreateWorkspaceEnvironmentRequest> => value;
    const acceptUpdateEnvironment = (
      value: UpdateWorkspaceEnvironmentRequest,
    ): z.input<typeof ContractUpdateWorkspaceEnvironmentRequest> => value;
    const acceptSetVariable = (value: {
      value: string;
    }): z.input<typeof ContractSetVariableRequest> => value;
    const acceptBeginUpload = (
      value: CreateFileUploadRequest,
    ): z.input<typeof ContractCreateFileUploadRequest> => value;
    const acceptCreateBase = (
      value: CreateDocumentBaseRequest,
    ): z.input<typeof ContractCreateDocumentBaseRequest> => value;
    const acceptRegisterPack = (
      value: RegisterCapabilityPackRequest,
    ): z.input<typeof ContractRegisterCapabilityPackRequest> => value;
    const acceptEnablePack = (
      value: EnablePackRequest,
    ): z.input<typeof ContractEnablePackRequest> => value;
    const acceptCreateCapability = (
      value: CreateCapabilityCatalogItemRequest,
    ): z.input<typeof ContractCreateCapabilityCatalogItemRequest> => value;
    const acceptEnableCapability = (
      value: EnableCapabilityRequest,
    ): z.input<typeof ContractEnableCapabilityRequest> => value;
    const acceptAppManifest = (
      value: CreateGitHubAppManifestRequest,
    ): z.input<typeof ContractGitHubAppManifestCreate> => value;
    const acceptCheckout = (
      value: CreateCheckoutRequest,
    ): z.input<typeof ContractCreateCheckoutRequest> => value;
    const checks = [
      acceptCreateWorkspace,
      acceptUpdateWorkspace,
      acceptCreateApiKey,
      acceptUpdateGoal,
      acceptCreateTask,
      acceptUpdateTask,
      acceptCreateEnvironment,
      acceptUpdateEnvironment,
      acceptSetVariable,
      acceptBeginUpload,
      acceptCreateBase,
      acceptRegisterPack,
      acceptEnablePack,
      acceptCreateCapability,
      acceptEnableCapability,
      acceptAppManifest,
      acceptCheckout,
    ];
    expect(checks.every((fn) => typeof fn === "function")).toBe(true);
  });

  test("SDK-built requests parse under the contracts schemas (runtime)", () => {
    const task: CreateScheduledTaskRequest = {
      name: "drift check",
      schedule: { type: "calendar", timeZone: "UTC", hour: 9, minute: 0 },
      agentConfig: { prompt: "Check for infrastructure drift", goal: { text: "stay drift-free" } },
    };
    expect(ContractCreateScheduledTaskRequest.safeParse(task).success).toBe(true);

    const environment: CreateWorkspaceEnvironmentRequest = {
      name: "staging",
      variables: [{ name: "EXAMPLE_TOKEN", value: "example-value" }],
    };
    expect(ContractCreateWorkspaceEnvironmentRequest.safeParse(environment).success).toBe(true);

    const manifest: RegisterCapabilityPackRequest = {
      id: "acme-devops",
      name: "Acme DevOps",
      description: "Acme's autonomous DevOps pack",
      role: "devops",
      category: "infrastructure",
      version: "1.0.0",
      skills: [{ name: "runbooks", files: [{ path: "SKILL.md", content: "# Runbooks" }] }],
    };
    expect(ContractRegisterCapabilityPackRequest.safeParse(manifest).success).toBe(true);

    const goalUpdate: UpdateSessionGoalRequest = { status: "paused", rationale: "manual review" };
    expect(ContractUpdateSessionGoalRequest.safeParse(goalUpdate).success).toBe(true);
  });
});
