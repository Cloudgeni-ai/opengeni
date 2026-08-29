import {
  AppRuntimeCatalogResponse as AppRuntimeCatalogResponseSchema,
  AppRuntimeToolCallRequest as AppRuntimeToolCallRequestSchema,
  AppRuntimeToolCallResponse as AppRuntimeToolCallResponseSchema,
  CreateAppLaunchRequest as CreateAppLaunchRequestSchema,
  CreateAppLaunchResponse as CreateAppLaunchResponseSchema,
  WorkspaceAppDetailResponse as WorkspaceAppDetailResponseSchema,
  WorkspaceAppListQuery as WorkspaceAppListQuerySchema,
  WorkspaceAppListResponse as WorkspaceAppListResponseSchema,
  type AppRuntimeCatalogResponse,
  type AppRuntimeToolCallRequest,
  type AppRuntimeToolCallResponse,
  type CreateAppLaunchRequest,
  type CreateAppLaunchResponse,
  type WorkspaceAppDetailResponse,
  type WorkspaceAppListQuery,
  type WorkspaceAppListResponse,
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
  "apps.runtime.catalog": {
    input: {
      workspaceId: string;
      appId: string;
      releaseId: string;
    };
    output: AppRuntimeCatalogResponse;
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
