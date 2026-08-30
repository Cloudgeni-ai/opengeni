import {
  AppAvailableRuntimeCatalogResponse as AppAvailableRuntimeCatalogResponseSchema,
  type AppAvailableRuntimeCatalogResponse,
  AppBuildMutationResponse as AppBuildMutationResponseSchema,
  type AppBuildMutationResponse,
  AppBuildUploadListQuery as AppBuildUploadListQuerySchema,
  AppBuildUploadListResponse as AppBuildUploadListResponseSchema,
  type AppBuildUploadListQuery,
  type AppBuildUploadListResponse,
  AppReleaseMutationResponse as AppReleaseMutationResponseSchema,
  type AppReleaseMutationResponse,
  AppRuntimeCatalogResponse as AppRuntimeCatalogResponseSchema,
  AppRuntimeToolCallRequest as AppRuntimeToolCallRequestSchema,
  AppRuntimeToolCallResponse as AppRuntimeToolCallResponseSchema,
  AppSourceDownloadResponse as AppSourceDownloadResponseSchema,
  type AppSourceDownloadResponse,
  ArchiveWorkspaceAppRequest as ArchiveWorkspaceAppRequestSchema,
  type ArchiveWorkspaceAppRequest,
  BeginAppSourceUploadRequest as BeginAppSourceUploadRequestSchema,
  BeginAppSourceUploadResponse as BeginAppSourceUploadResponseSchema,
  type BeginAppSourceUploadRequest,
  type BeginAppSourceUploadResponse,
  CompleteAppBuildRequest as CompleteAppBuildRequestSchema,
  type CompleteAppBuildRequest,
  CompleteAppSourceUploadRequest as CompleteAppSourceUploadRequestSchema,
  type CompleteAppSourceUploadRequest,
  CreateAppLaunchRequest as CreateAppLaunchRequestSchema,
  CreateAppLaunchResponse as CreateAppLaunchResponseSchema,
  CreateAppPreviewRequest as CreateAppPreviewRequestSchema,
  CreateAppPreviewResponse as CreateAppPreviewResponseSchema,
  type CreateAppPreviewRequest,
  type CreateAppPreviewResponse,
  CreateAppToolPolicyRequest as CreateAppToolPolicyRequestSchema,
  type CreateAppToolPolicyRequest,
  CreateWorkspaceAppRequest as CreateWorkspaceAppRequestSchema,
  type CreateWorkspaceAppRequest,
  PrepareAppBuildRequest as PrepareAppBuildRequestSchema,
  PrepareAppBuildResponse as PrepareAppBuildResponseSchema,
  type PrepareAppBuildRequest,
  type PrepareAppBuildResponse,
  PromoteAppBuildRequest as PromoteAppBuildRequestSchema,
  type PromoteAppBuildRequest,
  PublishAppReleaseRequest as PublishAppReleaseRequestSchema,
  type PublishAppReleaseRequest,
  RollbackAppReleaseRequest as RollbackAppReleaseRequestSchema,
  type RollbackAppReleaseRequest,
  UnpublishWorkspaceAppRequest as UnpublishWorkspaceAppRequestSchema,
  type UnpublishWorkspaceAppRequest,
  UpdateWorkspaceAppRequest as UpdateWorkspaceAppRequestSchema,
  type UpdateWorkspaceAppRequest,
  WorkspaceAppDetailResponse as WorkspaceAppDetailResponseSchema,
  WorkspaceAppListQuery as WorkspaceAppListQuerySchema,
  WorkspaceAppListResponse as WorkspaceAppListResponseSchema,
  WorkspaceAppMutationResponse as WorkspaceAppMutationResponseSchema,
  type AppRuntimeCatalogResponse,
  type AppRuntimeToolCallRequest,
  type AppRuntimeToolCallResponse,
  type CreateAppLaunchRequest,
  type CreateAppLaunchResponse,
  type WorkspaceAppDetailResponse,
  type WorkspaceAppListQuery,
  type WorkspaceAppListResponse,
  type WorkspaceAppMutationResponse,
} from "@opengeni/contracts/apps";

export type OpenGeniAppsControlOperationMap = {
  "apps.list": {
    input: {
      workspaceId: string;
      query: Partial<WorkspaceAppListQuery>;
    };
    output: WorkspaceAppListResponse;
  };
  "apps.get": {
    input: {
      workspaceId: string;
      appId: string;
    };
    output: WorkspaceAppDetailResponse;
  };
  "apps.create": {
    input: {
      workspaceId: string;
      request: CreateWorkspaceAppRequest;
    };
    output: WorkspaceAppMutationResponse;
  };
  "apps.update": {
    input: {
      workspaceId: string;
      appId: string;
      request: UpdateWorkspaceAppRequest;
    };
    output: WorkspaceAppMutationResponse;
  };
  "apps.toolPolicy.create": {
    input: {
      workspaceId: string;
      appId: string;
      request: CreateAppToolPolicyRequest;
    };
    output: WorkspaceAppDetailResponse;
  };
  "apps.source.begin": {
    input: {
      workspaceId: string;
      appId: string;
      request: BeginAppSourceUploadRequest;
    };
    output: BeginAppSourceUploadResponse;
  };
  "apps.source.complete": {
    input: {
      workspaceId: string;
      appId: string;
      sourceRevisionId: string;
      request: CompleteAppSourceUploadRequest;
    };
    output: WorkspaceAppDetailResponse;
  };
  "apps.source.download": {
    input: {
      workspaceId: string;
      appId: string;
      sourceRevisionId: string;
    };
    output: AppSourceDownloadResponse;
  };
  "apps.build.prepare": {
    input: {
      workspaceId: string;
      appId: string;
      request: PrepareAppBuildRequest;
    };
    output: PrepareAppBuildResponse;
  };
  "apps.build.uploads.list": {
    input: {
      workspaceId: string;
      appId: string;
      buildId: string;
      query: Partial<AppBuildUploadListQuery>;
    };
    output: AppBuildUploadListResponse;
  };
  "apps.build.complete": {
    input: {
      workspaceId: string;
      appId: string;
      buildId: string;
      request: CompleteAppBuildRequest;
    };
    output: AppBuildMutationResponse;
  };
  "apps.release.promote": {
    input: {
      workspaceId: string;
      appId: string;
      request: PromoteAppBuildRequest;
    };
    output: AppReleaseMutationResponse;
  };
  "apps.preview.create": {
    input: {
      workspaceId: string;
      appId: string;
      request: CreateAppPreviewRequest;
    };
    output: CreateAppPreviewResponse;
  };
  "apps.publish": {
    input: {
      workspaceId: string;
      appId: string;
      request: PublishAppReleaseRequest;
    };
    output: AppReleaseMutationResponse;
  };
  "apps.rollback": {
    input: {
      workspaceId: string;
      appId: string;
      request: RollbackAppReleaseRequest;
    };
    output: AppReleaseMutationResponse;
  };
  "apps.unpublish": {
    input: {
      workspaceId: string;
      appId: string;
      request: UnpublishWorkspaceAppRequest;
    };
    output: WorkspaceAppMutationResponse;
  };
  "apps.archive": {
    input: {
      workspaceId: string;
      appId: string;
      request: ArchiveWorkspaceAppRequest;
    };
    output: WorkspaceAppMutationResponse;
  };
  "apps.runtime.catalog": {
    input: {
      workspaceId: string;
      appId: string;
      releaseId: string;
    };
    output: AppRuntimeCatalogResponse;
  };
  "apps.runtime.availableCatalog": {
    input: {
      workspaceId: string;
      appId: string;
    };
    output: AppAvailableRuntimeCatalogResponse;
  };
  "apps.launch.create": {
    input: {
      workspaceId: string;
      appId: string;
      request: CreateAppLaunchRequest;
    };
    output: CreateAppLaunchResponse;
  };
  "apps.runtime.tool.call": {
    input: {
      workspaceId: string;
      appId: string;
      releaseId: string;
      launchId: string;
      authorityGeneration: string;
      launchNonce: string;
      request: AppRuntimeToolCallRequest;
    };
    output: AppRuntimeToolCallResponse;
  };
};

export type OpenGeniAppsControlOperation = keyof OpenGeniAppsControlOperationMap;

export type OpenGeniAppsControlRequestOptions = {
  signal?: AbortSignal | undefined;
};

/**
 * Product-owned Apps control seam.
 *
 * An OpenGeni deployment may implement these operations with HTTP, Code Mode,
 * an in-process router, or a test double. The SDK deliberately does not invent
 * routes or move a privileged credential into the browser.
 */
export type OpenGeniAppsControlTransport = {
  request<K extends OpenGeniAppsControlOperation>(
    operation: K,
    input: OpenGeniAppsControlOperationMap[K]["input"],
    options?: OpenGeniAppsControlRequestOptions,
  ): Promise<OpenGeniAppsControlOperationMap[K]["output"]>;
};

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  if (normalized.length > 1_024) throw new RangeError(`${label} exceeds 1,024 characters.`);
  return normalized;
}

function launchNonce(value: string): string {
  if (value.length < 32 || value.length > 256) {
    throw new RangeError("launchNonce must contain 32-256 characters.");
  }
  return value;
}

/** Optional Apps client isolated from the eager session/browser client graph. */
export class OpenGeniAppsClient {
  constructor(private readonly transport: OpenGeniAppsControlTransport) {}

  async listApps(
    workspaceId: string,
    query: Partial<WorkspaceAppListQuery> = {},
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<WorkspaceAppListResponse> {
    const parsedQuery = WorkspaceAppListQuerySchema.partial().parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const normalizedQuery: Partial<WorkspaceAppListQuery> = {
      ...(parsedQuery.limit === undefined ? {} : { limit: parsedQuery.limit }),
      ...(parsedQuery.cursor === undefined ? {} : { cursor: parsedQuery.cursor }),
    };
    return WorkspaceAppListResponseSchema.parse(
      await this.transport.request(
        "apps.list",
        { workspaceId: requiredId(workspaceId, "workspaceId"), query: normalizedQuery },
        options,
      ),
    );
  }

  async getApp(
    workspaceId: string,
    appId: string,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<WorkspaceAppDetailResponse> {
    return WorkspaceAppDetailResponseSchema.parse(
      await this.transport.request(
        "apps.get",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
        },
        options,
      ),
    );
  }

  async createApp(
    workspaceId: string,
    request: CreateWorkspaceAppRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<WorkspaceAppMutationResponse> {
    return WorkspaceAppMutationResponseSchema.parse(
      await this.transport.request(
        "apps.create",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          request: CreateWorkspaceAppRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async updateApp(
    workspaceId: string,
    appId: string,
    request: UpdateWorkspaceAppRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<WorkspaceAppMutationResponse> {
    return WorkspaceAppMutationResponseSchema.parse(
      await this.transport.request(
        "apps.update",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          request: UpdateWorkspaceAppRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async createToolPolicy(
    workspaceId: string,
    appId: string,
    request: CreateAppToolPolicyRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<WorkspaceAppDetailResponse> {
    return WorkspaceAppDetailResponseSchema.parse(
      await this.transport.request(
        "apps.toolPolicy.create",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          request: CreateAppToolPolicyRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async beginSourceUpload(
    workspaceId: string,
    appId: string,
    request: BeginAppSourceUploadRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<BeginAppSourceUploadResponse> {
    return BeginAppSourceUploadResponseSchema.parse(
      await this.transport.request(
        "apps.source.begin",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          request: BeginAppSourceUploadRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async completeSourceUpload(
    workspaceId: string,
    appId: string,
    sourceRevisionId: string,
    request: CompleteAppSourceUploadRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<WorkspaceAppDetailResponse> {
    return WorkspaceAppDetailResponseSchema.parse(
      await this.transport.request(
        "apps.source.complete",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          sourceRevisionId: requiredId(sourceRevisionId, "sourceRevisionId"),
          request: CompleteAppSourceUploadRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async getSourceDownload(
    workspaceId: string,
    appId: string,
    sourceRevisionId: string,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<AppSourceDownloadResponse> {
    return AppSourceDownloadResponseSchema.parse(
      await this.transport.request(
        "apps.source.download",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          sourceRevisionId: requiredId(sourceRevisionId, "sourceRevisionId"),
        },
        options,
      ),
    );
  }

  async prepareBuild(
    workspaceId: string,
    appId: string,
    request: PrepareAppBuildRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<PrepareAppBuildResponse> {
    return PrepareAppBuildResponseSchema.parse(
      await this.transport.request(
        "apps.build.prepare",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          request: PrepareAppBuildRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async listBuildUploads(
    workspaceId: string,
    appId: string,
    buildId: string,
    query: Partial<AppBuildUploadListQuery> = {},
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<AppBuildUploadListResponse> {
    const parsedQuery = AppBuildUploadListQuerySchema.partial().parse(query);
    const normalizedQuery: Partial<AppBuildUploadListQuery> = {
      ...(parsedQuery.limit === undefined ? {} : { limit: parsedQuery.limit }),
      ...(parsedQuery.cursor === undefined ? {} : { cursor: parsedQuery.cursor }),
    };
    return AppBuildUploadListResponseSchema.parse(
      await this.transport.request(
        "apps.build.uploads.list",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          buildId: requiredId(buildId, "buildId"),
          query: normalizedQuery,
        },
        options,
      ),
    );
  }

  async completeBuild(
    workspaceId: string,
    appId: string,
    buildId: string,
    request: CompleteAppBuildRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<AppBuildMutationResponse> {
    return AppBuildMutationResponseSchema.parse(
      await this.transport.request(
        "apps.build.complete",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          buildId: requiredId(buildId, "buildId"),
          request: CompleteAppBuildRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async promoteBuild(
    workspaceId: string,
    appId: string,
    request: PromoteAppBuildRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<AppReleaseMutationResponse> {
    return AppReleaseMutationResponseSchema.parse(
      await this.transport.request(
        "apps.release.promote",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          request: PromoteAppBuildRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async createPreview(
    workspaceId: string,
    appId: string,
    request: CreateAppPreviewRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<CreateAppPreviewResponse> {
    return CreateAppPreviewResponseSchema.parse(
      await this.transport.request(
        "apps.preview.create",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          request: CreateAppPreviewRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async publish(
    workspaceId: string,
    appId: string,
    request: PublishAppReleaseRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<AppReleaseMutationResponse> {
    return AppReleaseMutationResponseSchema.parse(
      await this.transport.request(
        "apps.publish",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          request: PublishAppReleaseRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async rollback(
    workspaceId: string,
    appId: string,
    request: RollbackAppReleaseRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<AppReleaseMutationResponse> {
    return AppReleaseMutationResponseSchema.parse(
      await this.transport.request(
        "apps.rollback",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          request: RollbackAppReleaseRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async unpublish(
    workspaceId: string,
    appId: string,
    request: UnpublishWorkspaceAppRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<WorkspaceAppMutationResponse> {
    return WorkspaceAppMutationResponseSchema.parse(
      await this.transport.request(
        "apps.unpublish",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          request: UnpublishWorkspaceAppRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async archive(
    workspaceId: string,
    appId: string,
    request: ArchiveWorkspaceAppRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<WorkspaceAppMutationResponse> {
    return WorkspaceAppMutationResponseSchema.parse(
      await this.transport.request(
        "apps.archive",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          request: ArchiveWorkspaceAppRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async getRuntimeCatalog(
    workspaceId: string,
    appId: string,
    releaseId: string,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<AppRuntimeCatalogResponse> {
    return AppRuntimeCatalogResponseSchema.parse(
      await this.transport.request(
        "apps.runtime.catalog",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          releaseId: requiredId(releaseId, "releaseId"),
        },
        options,
      ),
    );
  }

  async getAvailableRuntimeCatalog(
    workspaceId: string,
    appId: string,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<AppAvailableRuntimeCatalogResponse> {
    return AppAvailableRuntimeCatalogResponseSchema.parse(
      await this.transport.request(
        "apps.runtime.availableCatalog",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
        },
        options,
      ),
    );
  }

  async createLaunch(
    workspaceId: string,
    appId: string,
    request: CreateAppLaunchRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<CreateAppLaunchResponse> {
    return CreateAppLaunchResponseSchema.parse(
      await this.transport.request(
        "apps.launch.create",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          request: CreateAppLaunchRequestSchema.parse(request),
        },
        options,
      ),
    );
  }

  async callRuntimeTool(
    workspaceId: string,
    appId: string,
    releaseId: string,
    launchId: string,
    authorityGeneration: string,
    nonce: string,
    request: AppRuntimeToolCallRequest,
    options: OpenGeniAppsControlRequestOptions = {},
  ): Promise<AppRuntimeToolCallResponse> {
    return AppRuntimeToolCallResponseSchema.parse(
      await this.transport.request(
        "apps.runtime.tool.call",
        {
          workspaceId: requiredId(workspaceId, "workspaceId"),
          appId: requiredId(appId, "appId"),
          releaseId: requiredId(releaseId, "releaseId"),
          launchId: requiredId(launchId, "launchId"),
          authorityGeneration: requiredId(authorityGeneration, "authorityGeneration"),
          launchNonce: launchNonce(nonce),
          request: AppRuntimeToolCallRequestSchema.parse(request),
        },
        options,
      ),
    );
  }
}
