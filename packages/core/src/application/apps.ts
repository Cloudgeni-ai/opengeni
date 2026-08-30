import type {
  AppBuildMutationResponse,
  AppBuildUploadListQuery,
  AppBuildUploadListResponse,
  AppReleaseMutationResponse,
  AppRuntimeCatalogResponse,
  AppRuntimeToolCallRequest,
  AppRuntimeToolCallResponse,
  AppSourceDownloadResponse,
  ArchiveWorkspaceAppRequest,
  BeginAppSourceUploadRequest,
  BeginAppSourceUploadResponse,
  CompleteAppBuildRequest,
  CompleteAppSourceUploadRequest,
  CreateAppLaunchRequest,
  CreateAppLaunchResponse,
  CreateAppPreviewRequest,
  CreateAppPreviewResponse,
  CreateAppToolPolicyRequest,
  CreateWorkspaceAppRequest,
  PrepareAppBuildRequest,
  PrepareAppBuildResponse,
  PromoteAppBuildRequest,
  PublishAppReleaseRequest,
  RollbackAppReleaseRequest,
  UnpublishWorkspaceAppRequest,
  UpdateWorkspaceAppRequest,
  WorkspaceAppDetailResponse,
  WorkspaceAppListQuery,
  WorkspaceAppListResponse,
  WorkspaceAppMutationResponse,
} from "@opengeni/contracts/apps";
import type { Permission } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import {
  requireResolvedAccessGrantAuthorization,
  type AccessGrantAuthorization,
} from "../access";
import { getManagedAuthRequestActorAdmissionStamp } from "../managed-session";

/**
 * Server-owned authority passed into the Apps application layer.
 *
 * appId is intentionally absent: a route may use appId only as a resource
 * selector after this current-human authority has been established. It can
 * never widen this authority or substitute another subject.
 */
export type AppControlAuthority = Readonly<{
  accountId: string;
  workspaceId: string;
  subjectId: string;
  principalKind: string | null;
  canonicalManagedHumanSession: boolean;
  canonicalLocalHumanSession: boolean;
  permissions: readonly Permission[];
  sourceSessionId: string | null;
  sourceTurnId: string | null;
  sourceAttemptId: string | null;
  sourceExecutionGeneration: number | null;
}>;

export type AppCurrentHumanAuthority = AppControlAuthority &
  Readonly<{
    managedActorEpoch: string | null;
    managedSessionSetAuthorityHash: string | null;
    currentHuman: true;
  }>;

export type AppApplicationCallOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type AppHostResolvedObject = Readonly<{
  path: string;
  /** Exact digest-addressed frozen object key. Staging keys are forbidden. */
  objectKey: string;
}>;

export type AppHostLaunchResolution = Readonly<{
  appId: string;
  releaseId: string;
  launchId: string;
  previewId: string | null;
  publicationId: string | null;
  expiresAt: string;
  spaFallback: boolean;
  requestedObject: AppHostResolvedObject | null;
  entryObject: AppHostResolvedObject;
}>;

type AppResourceInput = Readonly<{
  authority: AppControlAuthority;
  appId: string;
}>;

type AppCurrentHumanResourceInput = Readonly<{
  authority: AppCurrentHumanAuthority;
  appId: string;
}>;

/**
 * Product-owned Apps control plane.
 *
 * This is deliberately independent of agent attempts, Code Mode journals,
 * owning-worker dispatch, and AttemptToolEnvironment. Implementations receive
 * only resolved caller authority plus explicit workspace/App selectors.
 */
export interface AppsApplicationPort {
  /** Internal app-host lookup; implementation may return frozen Build rows only. */
  resolveHostLaunch(
    input: Readonly<{
      host: string;
      launchTokenDigest: string;
      requestedPath: string | null;
    }>,
    options?: AppApplicationCallOptions,
  ): Promise<AppHostLaunchResolution | null>;
  list(
    input: Readonly<{
      authority: AppControlAuthority;
      query: WorkspaceAppListQuery;
    }>,
    options?: AppApplicationCallOptions,
  ): Promise<WorkspaceAppListResponse>;
  create(
    input: Readonly<{
      authority: AppControlAuthority;
      request: CreateWorkspaceAppRequest;
    }>,
    options?: AppApplicationCallOptions,
  ): Promise<WorkspaceAppMutationResponse>;
  get(input: AppResourceInput, options?: AppApplicationCallOptions): Promise<WorkspaceAppDetailResponse>;
  update(
    input: AppResourceInput & Readonly<{ request: UpdateWorkspaceAppRequest }>,
    options?: AppApplicationCallOptions,
  ): Promise<WorkspaceAppMutationResponse>;
  createToolPolicy(
    input: AppResourceInput & Readonly<{ request: CreateAppToolPolicyRequest }>,
    options?: AppApplicationCallOptions,
  ): Promise<WorkspaceAppDetailResponse>;
  beginSourceUpload(
    input: AppResourceInput & Readonly<{ request: BeginAppSourceUploadRequest }>,
    options?: AppApplicationCallOptions,
  ): Promise<BeginAppSourceUploadResponse>;
  completeSourceUpload(
    input: AppResourceInput &
      Readonly<{
        sourceRevisionId: string;
        request: CompleteAppSourceUploadRequest;
      }>,
    options?: AppApplicationCallOptions,
  ): Promise<WorkspaceAppDetailResponse>;
  getSourceDownload(
    input: AppResourceInput & Readonly<{ sourceRevisionId: string }>,
    options?: AppApplicationCallOptions,
  ): Promise<AppSourceDownloadResponse>;
  prepareBuild(
    input: AppResourceInput & Readonly<{ request: PrepareAppBuildRequest }>,
    options?: AppApplicationCallOptions,
  ): Promise<PrepareAppBuildResponse>;
  listBuildUploads(
    input: AppResourceInput &
      Readonly<{
        buildId: string;
        query: AppBuildUploadListQuery;
      }>,
    options?: AppApplicationCallOptions,
  ): Promise<AppBuildUploadListResponse>;
  completeBuild(
    input: AppResourceInput &
      Readonly<{
        buildId: string;
        request: CompleteAppBuildRequest;
      }>,
    options?: AppApplicationCallOptions,
  ): Promise<AppBuildMutationResponse>;
  promoteBuild(
    input: AppResourceInput & Readonly<{ request: PromoteAppBuildRequest }>,
    options?: AppApplicationCallOptions,
  ): Promise<AppReleaseMutationResponse>;
  createPreview(
    input: AppResourceInput & Readonly<{ request: CreateAppPreviewRequest }>,
    options?: AppApplicationCallOptions,
  ): Promise<CreateAppPreviewResponse>;
  publish(
    input: AppResourceInput & Readonly<{ request: PublishAppReleaseRequest }>,
    options?: AppApplicationCallOptions,
  ): Promise<AppReleaseMutationResponse>;
  rollback(
    input: AppResourceInput & Readonly<{ request: RollbackAppReleaseRequest }>,
    options?: AppApplicationCallOptions,
  ): Promise<AppReleaseMutationResponse>;
  unpublish(
    input: AppResourceInput & Readonly<{ request: UnpublishWorkspaceAppRequest }>,
    options?: AppApplicationCallOptions,
  ): Promise<WorkspaceAppMutationResponse>;
  archive(
    input: AppResourceInput & Readonly<{ request: ArchiveWorkspaceAppRequest }>,
    options?: AppApplicationCallOptions,
  ): Promise<WorkspaceAppMutationResponse>;
  createLaunch(
    input: AppCurrentHumanResourceInput & Readonly<{ request: CreateAppLaunchRequest }>,
    options?: AppApplicationCallOptions,
  ): Promise<CreateAppLaunchResponse>;
  getRuntimeCatalog(
    input: AppCurrentHumanResourceInput & Readonly<{ releaseId: string }>,
    options?: AppApplicationCallOptions,
  ): Promise<AppRuntimeCatalogResponse>;
  callRuntimeTool(
    input: AppCurrentHumanResourceInput &
      Readonly<{
        releaseId: string;
        launchId: string;
        authorityGeneration: string;
        launchNonce: string;
        request: AppRuntimeToolCallRequest;
      }>,
    options?: AppApplicationCallOptions,
  ): Promise<AppRuntimeToolCallResponse>;
}

/**
 * Establish the sole MVP Apps runtime principal: the exact direct managed or
 * local human that owns the resolved workspace grant. Shape-compatible
 * delegated grants, API keys, service initiators, and agent attempts fail
 * closed.
 */
export function requireAppCurrentHumanAuthority(
  access: AccessGrantAuthorization,
  request: Request,
): AppCurrentHumanAuthority {
  requireResolvedAccessGrantAuthorization(access);
  const { grant } = access;
  if (
    (!access.canonicalManagedHumanSession && !access.canonicalLocalHumanSession) ||
    grant.principalKind !== "human_session" ||
    grant.serviceInitiator ||
    grant.serviceInitiatorContext ||
    grant.metadata?.delegated === true ||
    grant.subjectId.startsWith("api_key:")
  ) {
    throw new HTTPException(403, {
      message: "Apps runtime requires the currently logged-in human",
    });
  }
  const actorAdmission = getManagedAuthRequestActorAdmissionStamp(request);
  return Object.freeze({
    ...appControlAuthority(access),
    managedActorEpoch: actorAdmission?.actorEpoch ?? null,
    managedSessionSetAuthorityHash: actorAdmission?.authorityHash ?? null,
    currentHuman: true,
  });
}

/** Management and authoring authority, including exact attempt provenance for audit only. */
export function appControlAuthority(access: AccessGrantAuthorization): AppControlAuthority {
  requireResolvedAccessGrantAuthorization(access);
  const { grant } = access;
  const metadata = grant.metadata ?? {};
  const sessionId = metadata["sessionId"];
  const turnId = metadata["turnId"];
  const attemptId = metadata["attemptId"];
  const executionGeneration = metadata["executionGeneration"];
  const exactAttempt =
    typeof sessionId === "string" &&
    typeof turnId === "string" &&
    typeof attemptId === "string" &&
    typeof executionGeneration === "number" &&
    Number.isSafeInteger(executionGeneration) &&
    executionGeneration > 0;
  return Object.freeze({
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    principalKind: grant.principalKind ?? null,
    canonicalManagedHumanSession: access.canonicalManagedHumanSession,
    canonicalLocalHumanSession: access.canonicalLocalHumanSession,
    permissions: Object.freeze([...grant.permissions]),
    sourceSessionId: exactAttempt ? sessionId : null,
    sourceTurnId: exactAttempt ? turnId : null,
    sourceAttemptId: exactAttempt ? attemptId : null,
    sourceExecutionGeneration: exactAttempt ? executionGeneration : null,
  });
}