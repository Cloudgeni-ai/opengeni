/** Optional OpenGeni Apps client; the host injects its HTTP/Code Mode transport. */
export { OpenGeniAppsClient } from "./apps-client";
export type {
  OpenGeniAppsControlOperation,
  OpenGeniAppsControlOperationMap,
  OpenGeniAppsControlRequestOptions,
  OpenGeniAppsControlTransport,
} from "./apps-client";
export type {
  AppRelease,
  AppRuntimeCatalogResponse,
  AppRuntimeToolCallError,
  AppRuntimeToolCallRequest,
  AppRuntimeToolCallResponse,
  AppToolDescriptor,
  AppToolPolicyRevision,
  CreateAppLaunchRequest,
  CreateAppLaunchResponse,
  WorkspaceApp,
  WorkspaceAppDetailResponse,
  WorkspaceAppListQuery,
  WorkspaceAppListResponse,
} from "@opengeni/contracts/apps";
