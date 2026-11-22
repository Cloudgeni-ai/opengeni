import { createHash } from "node:crypto";
import {
  APP_SERVER_BUNDLE_MAX_BYTES,
  APP_SERVER_CPU_MS,
  APP_SERVER_FETCH_RESPONSE_MAX_BYTES,
  APP_SERVER_FETCH_TIMEOUT_MS,
  APP_SERVER_HOST_CALLS_PER_RUN,
  APP_SERVER_LOG_MAX_CHARS,
  APP_SERVER_MAX_TOTAL_BYTES,
  APP_SERVER_REQUEST_BODY_MAX_BYTES,
  APP_SERVER_RESPONSE_BODY_MAX_BYTES,
  APP_SERVER_RUN_TIMEOUT_MS,
  APP_SERVER_RUNS_KEPT_DAYS,
  APP_SERVER_RUNS_PER_MINUTE,
  AppServerBundle,
  AppServerFetchRequest,
  AppServerHostRequest,
  AppServerManifest,
  AppServerOutboundRequest,
  SiteDataGetRequest,
  SiteDataQueryRequest,
  SiteDataWriteRequest,
  appServerInternalPath,
  appServerObjectKey,
  isAppServerEgressHost,
  type AccessGrant,
  type AppServerFetchResponse,
  type AppServerGatewayRunRequest,
  type AppServerGatewayRunResult,
  type AppServerRun,
  type AppServerStatus,
  type AppServerTrigger,
  type AppServerViewer,
  type ToolGatewayIdentity,
} from "@opengeni/contracts";
import {
  hasIntegrationAdminPermission,
  hasPermission,
  resolveServiceConnectionHeaders,
  ServiceConnectionCredentialError,
  type ApiRouteDeps,
  type ObjectStorageDependency,
} from "@opengeni/core";
import {
  countRecentAppServerRuns,
  getAppServerDeployment,
  getVerifiedSubjectEmail,
  getWorkspaceGrant,
  listAppServerRuns,
  recordAppServerRun,
  SiteDataError,
  subjectHasLiveWorkspaceAuthorityInScope,
  summarizeAppServerRuns,
  withWorkspaceSubjectRls,
  WorkspaceArtifactOperationError,
  type AppServerDeployment,
  type SiteDataCaller,
  type SiteDataWriteOp,
} from "@opengeni/db";
import {
  DestinationPolicyError,
  pinnedFetch,
  readResponseBodyBounded,
  ResponseBodyLimitError,
} from "@opengeni/network";
import { retryWhileMissing } from "@opengeni/storage";
import { callAppSyncToolThroughGateway, type AppSyncToolCaller } from "../app-sync/service";
import { writeSiteDataWithAccess } from "../site-data/operations";
import {
  meterSiteData,
  resolveSiteDataAccess,
  siteDataLimits,
  siteDataStore,
  validateSiteDataRecord,
  type SiteDataAccess,
  type SiteDataAuthority,
} from "../site-data/service";
import { signGatewayInternalRequest, siteSqlGatewayConfig } from "../site-sql/gateway";
import { readSiteToolAccountInventory, type SiteToolAccountInventory } from "../site-tool-routing";
import { vaultProviderRegistryFor } from "../routes/vault-providers";
import { mintAppServerRunToken, verifyAppServerRunToken } from "./token";

/**
 * App server code (docs/app-server-code.md). An app version may carry a
 * small server program. It runs in its own Cloudflare Dynamic Worker
 * isolate that the Sites gateway loads, as the app and never as the viewer:
 *
 * - Authority: the person who made the version current (its latest publish
 *   or rollback), while they are still a live member who manages the app,
 *   like a webhook's or a shared sync's owner. The code reaches only
 *   - tools the version declares, on the workspace's shared connections (or
 *     connectors without accounts), never anyone's personal connection;
 *   - the app's shared data, as its own principal `server:<appId>`;
 *   - HTTPS to the hosts the version lists, with vault secrets the version
 *     lists filled into headers under the workspace's own vault reach.
 * - The viewer's identity is passed to the code as data; their credentials
 *   never are, and no call made by the code uses them.
 * - Every run is recorded for the app's managers (status, logs, errors).
 */

export type AppServerDeps = ApiRouteDeps & {
  /** Test seams; production passes none. */
  appServerGatewayFetch?: (url: string, init: RequestInit) => Promise<Response>;
  appServerOutboundFetch?: (url: string, init: RequestInit) => Promise<Response>;
  appServerToolCaller?: AppSyncToolCaller;
  appServerToolInventory?: (
    deps: ApiRouteDeps,
    grant: AccessGrant,
  ) => Promise<SiteToolAccountInventory>;
  appServerDeployerGrant?: (deployment: AppServerDeployment) => Promise<AccessGrant | null>;
};

export type AppServerErrorCode =
  | "validation"
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "conflict";

export class AppServerError extends Error {
  constructor(
    readonly code: AppServerErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppServerError";
  }
}

const invalid = (message: string, details?: Record<string, unknown>) =>
  new AppServerError("validation", message, details);
const forbidden = (message: string, details?: Record<string, unknown>) =>
  new AppServerError("forbidden", message, details);

/** Server code writes and its change events count as one automated hop, like a webhook's. */
const APP_SERVER_CHAIN_DEPTH = 1;

/** First-party servers act as whoever calls them, so server code never calls them. */
const FIRST_PARTY_SERVERS = new Set(["opengeni", "files", "docs", "codex_apps"]);

/** The start of a vault reference (spelled in two parts so it is never read as one). */
const SECRET_MARK = ["{", "{secret:"].join("");
const SECRET_REFERENCE = /\{\{secret:[^{}]*\}\}/gu;

type Storage = NonNullable<ObjectStorageDependency>;

// --- deployment ------------------------------------------------------------------

/** Whether this deployment runs server code: the flag, the gateway origin and its secret. */
export function appServerAvailable(settings: ApiRouteDeps["settings"]): boolean {
  return (
    settings.sitesServerCodeEnabled === true &&
    siteSqlGatewayConfig(settings) !== null &&
    !!settings.sitesGatewaySecret
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The digest that names one version's code: main, files, egress and secrets. */
export function appServerDigest(manifest: Omit<AppServerManifest, "digest">): string {
  return sha256(
    JSON.stringify([
      manifest.main,
      manifest.files.map((file) => [file.path, file.sha256]),
      manifest.egress,
      manifest.secrets,
    ]),
  );
}

/** Parse an uploaded bundle into its files and manifest (no storage); null removes the code. */
export function appServerManifestOf(bundle: AppServerBundle): {
  manifest: AppServerManifest;
  files: Array<{ sha256: string; bytes: Uint8Array }>;
} | null {
  if (bundle.files.length === 0) return null;
  const encoder = new TextEncoder();
  let total = 0;
  const files = bundle.files.map((file) => {
    const bytes = encoder.encode(file.content);
    total += bytes.byteLength;
    return { path: file.path, sha256: sha256(bytes), sizeBytes: bytes.byteLength, bytes };
  });
  if (total > APP_SERVER_MAX_TOTAL_BYTES)
    throw invalid(
      `App server code is at most ${APP_SERVER_MAX_TOTAL_BYTES / 1024} KB in all. Bundle it smaller.`,
    );
  const base = {
    main: bundle.main!,
    files: files.map(({ path, sha256: hash, sizeBytes }) => ({ path, sha256: hash, sizeBytes })),
    egress: [...new Set(bundle.egress ?? [])].sort(),
    secrets: [...new Set(bundle.secrets ?? [])].sort(),
  };
  return {
    manifest: AppServerManifest.parse({ ...base, digest: appServerDigest(base) }),
    files: files.map((file) => ({ sha256: file.sha256, bytes: file.bytes })),
  };
}

function refuseUpload(message: string): never {
  throw new WorkspaceArtifactOperationError(message);
}

function issuesOf(error: unknown): string {
  return error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
    ? (error.issues as Array<{ path: unknown[]; message: string }>)
        .slice(0, 3)
        .map((issue) => `${issue.path.map(String).join(".") || "bundle"}: ${issue.message}`)
        .join("; ")
    : "not valid JSON";
}

/**
 * Freeze an upload's server code: undefined when nothing was uploaded (the
 * publish keeps the current version's code), null for `{"files": []}` (it
 * removes the code), else the manifest. Files are stored once per workspace
 * by content; the manifest is frozen beside the upload so a retried publish
 * of the same upload sees the same code.
 */
export async function freezeAppServerBundle(
  storage: Storage,
  workspaceId: string,
  keys: { upload: string; frozen: string; published?: boolean },
): Promise<AppServerManifest | null | undefined> {
  const readFrozen = async (): Promise<AppServerManifest | null | undefined> => {
    const frozen = await storage.getObjectBytes(keys.frozen);
    if (!frozen) return undefined;
    const value = JSON.parse(new TextDecoder().decode(frozen.bytes)) as { manifest: unknown };
    return value.manifest === null ? null : AppServerManifest.parse(value.manifest);
  };
  const existing = await readFrozen();
  if (existing !== undefined) return existing;
  if (keys.published) return undefined;
  if (!storage.headObject || !storage.putObjectStreamIfAbsent)
    throw new Error("Object storage cannot freeze app server code");
  const head = await storage.headObject(keys.upload);
  if (!head) return undefined;
  if ((head.ContentLength ?? 0) > APP_SERVER_BUNDLE_MAX_BYTES)
    refuseUpload(`The server code upload is over ${APP_SERVER_BUNDLE_MAX_BYTES / 1024 / 1024} MB.`);
  const object = await retryWhileMissing(() => storage.getObjectBytes(keys.upload));
  if (!object) refuseUpload("App server code is not available yet. Retry with the same upload.");
  let bundle: AppServerBundle;
  try {
    bundle = AppServerBundle.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)),
    );
  } catch (error) {
    refuseUpload(
      `Server code must be JSON {main, files: [{path, content}], egress?, secrets?} (${issuesOf(error)}). Correct it and prepare a new upload.`,
    );
  }
  let parsed: ReturnType<typeof appServerManifestOf>;
  try {
    parsed = appServerManifestOf(bundle);
  } catch (error) {
    if (error instanceof AppServerError) refuseUpload(error.message);
    throw error;
  }
  if (parsed) {
    await Promise.all(
      parsed.files.map(async (file) => {
        const key = appServerObjectKey(workspaceId, file.sha256);
        if (await storage.headObject!(key)) return;
        await storage.putObjectStreamIfAbsent!({
          key,
          contentType: "text/javascript; charset=utf-8",
          byteSize: file.bytes.byteLength,
          chunks: (async function* () {
            yield file.bytes;
          })(),
        });
      }),
    );
  }
  const manifest = parsed?.manifest ?? null;
  const body = new TextEncoder().encode(JSON.stringify({ manifest }));
  const created = await storage.putObjectStreamIfAbsent({
    key: keys.frozen,
    contentType: "application/json",
    byteSize: body.byteLength,
    chunks: (async function* () {
      yield body;
    })(),
  });
  if (created) return manifest;
  // A concurrent publish of the same upload froze first: use its manifest.
  const winner = await retryWhileMissing(async () => {
    const frozen = await readFrozen();
    return frozen === undefined ? null : { frozen };
  });
  if (!winner) refuseUpload("App server code is not available yet. Retry with the same upload.");
  return winner.frozen;
}

/**
 * Checks before a version with new server code is published: the deployment
 * runs server code, and a version that lists vault secrets is published by
 * someone who may bind workspace secrets to a connection (an integration
 * admin with secrets:use), and each secret resolves now under the
 * workspace's own reach, so a missing item fails here, not on first use.
 */
export async function requireAppServerPublishable(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  manifest: AppServerManifest,
): Promise<void> {
  if (!appServerAvailable(deps.settings))
    throw new WorkspaceArtifactOperationError(
      "App server code is not enabled on this deployment, so this version can't carry server code. Publish without the server upload.",
    );
  if (manifest.secrets.length === 0) return;
  if (
    !hasIntegrationAdminPermission(grant) ||
    !hasPermission(grant.permissions, "secrets:use", grant.permissionMode)
  )
    throw new WorkspaceArtifactOperationError(
      "Only a workspace admin can publish server code that uses vault secrets. Ask an admin to publish it, or remove the secrets.",
    );
  try {
    await resolveSecretHeaders(
      deps,
      { accountId: grant.accountId, workspaceId: grant.workspaceId },
      Object.fromEntries(manifest.secrets.map((secret, index) => [`x-check-${index}`, secret])),
      `https://${manifest.egress[0] ?? "example.com"}/`,
    );
  } catch (error) {
    throw new WorkspaceArtifactOperationError(
      error instanceof ServiceConnectionCredentialError
        ? `A secret the server code lists can't be used: ${error.message}`
        : "The server code's secrets couldn't be checked. Try again shortly.",
    );
  }
}

async function resolveSecretHeaders(
  deps: ApiRouteDeps,
  scope: { accountId: string; workspaceId: string },
  headers: Record<string, string>,
  destinationUrl: string,
): Promise<Record<string, string>> {
  return await resolveServiceConnectionHeaders(
    {
      db: deps.db,
      settings: deps.settings,
      providers: (vaultWorkspaceId) =>
        vaultProviderRegistryFor(deps, { workspaceId: vaultWorkspaceId, subjectId: null }),
    },
    {
      // The workspace's own reach (a shared service connection's), never a person's.
      connection: {
        id: null,
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        providerDomain: new URL(destinationUrl).hostname,
      },
      headers,
      serverId: "app_server",
      toolName: "app_server_fetch",
      destinationUrl,
    },
  );
}

// --- authority -------------------------------------------------------------------

const DEPLOYER_CANNOT_MANAGE =
  "The person who published this version can no longer manage the app, so its server code is paused. Someone who manages the app should publish it again.";

/** The deployer's own live workspace grant; null once they are gone. */
async function deployerGrant(
  deps: AppServerDeps,
  deployment: AppServerDeployment,
): Promise<AccessGrant | null> {
  if (deps.appServerDeployerGrant) return await deps.appServerDeployerGrant(deployment);
  const scope = { accountId: deployment.accountId, workspaceId: deployment.workspaceId };
  const subjectId = deployment.deployerSubjectId;
  return await withWorkspaceSubjectRls(deps.db, deployment.workspaceId, subjectId, async (tx) => {
    if (!(await subjectHasLiveWorkspaceAuthorityInScope(tx, { ...scope, subjectId }))) return null;
    return await getWorkspaceGrant(tx, subjectId, deployment.workspaceId, {
      principalKind: "human_session",
    });
  });
}

type ServerAuthority = { grant: AccessGrant; access: SiteDataAccess };

/**
 * The authority a run's calls use: the app's own principal `server:<appId>`
 * (a manager-level writer of shared data), while the deployer is still a
 * live member who manages the app.
 */
async function serverAuthority(
  deps: AppServerDeps,
  deployment: AppServerDeployment,
): Promise<ServerAuthority> {
  const grant = await deployerGrant(deps, deployment);
  if (!grant) throw forbidden(DEPLOYER_CANNOT_MANAGE, { reason: "deployer_cannot_manage" });
  let deployer: SiteDataAccess;
  try {
    deployer = await resolveSiteDataAccess(deps, grant, deployment.siteId);
  } catch (error) {
    if (
      error instanceof SiteDataError &&
      (error.code === "forbidden" || error.code === "not_found")
    )
      throw forbidden(DEPLOYER_CANNOT_MANAGE, { reason: "deployer_cannot_manage" });
    throw error;
  }
  if (deployer.caller.role !== "manager")
    throw forbidden(DEPLOYER_CANNOT_MANAGE, { reason: "deployer_cannot_manage" });
  if (deployer.site.status !== "active") throw forbidden("This app is archived");
  const scope = { accountId: deployment.accountId, workspaceId: deployment.workspaceId };
  const principal = `server:${deployment.siteId}`;
  const caller: SiteDataCaller = {
    ...scope,
    siteId: deployment.siteId,
    role: "manager",
    principal,
    actor: principal,
    framed: false,
    chainDepth: APP_SERVER_CHAIN_DEPTH,
  };
  const limits = siteDataLimits(deps.settings);
  return {
    grant,
    access: {
      site: deployer.site,
      caller,
      subjectId: null,
      store: siteDataStore(deps.db, deps.settings),
      limits,
      writeOptions: {
        limits,
        validate: validateSiteDataRecord,
        afterWrite: (tx, summary) => meterSiteData(tx, scope, caller, null, "write", summary),
      },
    },
  };
}

// --- running ---------------------------------------------------------------------

const moduleCache = new Map<string, string>();
const MODULE_CACHE_MAX_CHARS = 32 * 1024 * 1024;
let moduleCacheChars = 0;

async function loadModules(
  storage: Storage,
  workspaceId: string,
  manifest: AppServerManifest,
): Promise<Record<string, string>> {
  const modules: Record<string, string> = {};
  await Promise.all(
    manifest.files.map(async (file) => {
      const key = appServerObjectKey(workspaceId, file.sha256);
      let source = moduleCache.get(key);
      if (source === undefined) {
        const object = await retryWhileMissing(() => storage.getObjectBytes(key));
        if (!object)
          throw new AppServerError("unavailable", "The app's server code can't be read right now");
        if (sha256(object.bytes) !== file.sha256)
          throw new AppServerError(
            "unavailable",
            "The app's server code doesn't match what was published",
          );
        source = new TextDecoder().decode(object.bytes);
        if (moduleCacheChars + source.length > MODULE_CACHE_MAX_CHARS) {
          moduleCache.clear();
          moduleCacheChars = 0;
        }
        moduleCache.set(key, source);
        moduleCacheChars += source.length;
      }
      modules[file.path] = source;
    }),
  );
  return modules;
}

const TEXT_TYPE =
  /^(?:text\/|application\/(?:json|javascript|xml|[a-z0-9.+-]+\+(?:json|xml))(?:\s*;|$))/iu;
/** Response headers server code may not set for the page. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function runError(result: AppServerGatewayRunResult | null, fallback: string): string | null {
  if (!result) return fallback;
  if (result.error) return result.error;
  return result.status >= 500 ? `Answered HTTP ${result.status}` : null;
}

function issueText(issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>) {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join(".") || "input"}: ${issue.message}`)
    .join("; ");
}

export type AppServerRunInput = {
  scope: { accountId: string; workspaceId: string };
  siteId: string;
  viewer: AppServerViewer | null;
  trigger: AppServerTrigger;
  request: unknown;
};

/**
 * Run one request through the app's current server code and record the run.
 * The caller has already checked that the viewer may open the app.
 */
export async function runAppServer(
  deps: AppServerDeps,
  input: AppServerRunInput,
): Promise<AppServerFetchResponse> {
  const parsed = AppServerFetchRequest.safeParse(input.request ?? {});
  if (!parsed.success) throw invalid(issueText(parsed.error.issues));
  const request = parsed.data;
  const deployment = await getAppServerDeployment(deps.db, input.scope.workspaceId, input.siteId);
  if (!deployment?.manifest)
    throw new AppServerError("not_found", "This app has no server code", {
      reason: "no_server_code",
    });
  if (deployment.status !== "active") throw forbidden("This app is archived");
  const gateway = siteSqlGatewayConfig(deps.settings);
  if (!appServerAvailable(deps.settings) || !gateway || !deps.objectStorage)
    throw new AppServerError("unavailable", "App server code is not available on this deployment", {
      reason: "app_server_unavailable",
    });
  const body =
    request.bodyBase64 != null
      ? Buffer.from(request.bodyBase64, "base64")
      : Buffer.from(request.body ?? "", "utf8");
  if (body.byteLength > APP_SERVER_REQUEST_BODY_MAX_BYTES)
    throw invalid(`The request body is over ${APP_SERVER_REQUEST_BODY_MAX_BYTES / 1024 / 1024} MB`);
  if (
    (await countRecentAppServerRuns(deps.db, input.scope, input.siteId)) >=
    APP_SERVER_RUNS_PER_MINUTE
  )
    throw new AppServerError(
      "rate_limited",
      `This app's server code runs at most ${APP_SERVER_RUNS_PER_MINUTE} times a minute. Try again shortly.`,
    );
  const manifest = deployment.manifest;
  const modules = await loadModules(deps.objectStorage, input.scope.workspaceId, manifest);
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  const token = mintAppServerRunToken(deps.settings.sitesGatewaySecret!, {
    runId,
    accountId: input.scope.accountId,
    workspaceId: input.scope.workspaceId,
    siteId: input.siteId,
    versionId: deployment.versionId,
    expiresAt: startedAt + APP_SERVER_RUN_TIMEOUT_MS + 5_000,
  });
  const headers = Object.entries(request.headers ?? {})
    .filter(([name]) => !/^(?:host|cookie|authorization|content-length|x-opengeni-)/iu.test(name))
    .map(([name, value]) => [name.toLowerCase(), value] as [string, string]);
  const payload: AppServerGatewayRunRequest = {
    requestId: crypto.randomUUID(),
    versionId: deployment.versionId,
    digest: manifest.digest,
    main: manifest.main,
    modules,
    context: {
      runId,
      appId: input.siteId,
      versionId: deployment.versionId,
      trigger: input.trigger,
      viewer: input.viewer,
      token,
      hostCallLimit: APP_SERVER_HOST_CALLS_PER_RUN,
      logLimit: APP_SERVER_LOG_MAX_CHARS,
    },
    request: { method: request.method, path: request.path, headers, bodyBase64: base64(body) },
    limits: {
      timeoutMs: APP_SERVER_RUN_TIMEOUT_MS,
      cpuMs: APP_SERVER_CPU_MS,
      responseBytes: APP_SERVER_RESPONSE_BODY_MAX_BYTES,
    },
  };
  const json = JSON.stringify(payload);
  const signed = signGatewayInternalRequest(gateway, appServerInternalPath(input.siteId), json);
  let result: AppServerGatewayRunResult | null = null;
  let failure = "The app's server code could not be reached";
  try {
    const response = await (deps.appServerGatewayFetch ?? fetch)(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: json,
      redirect: "manual",
      signal: AbortSignal.timeout(APP_SERVER_RUN_TIMEOUT_MS + 5_000),
    });
    if (response.ok) result = (await response.json()) as AppServerGatewayRunResult;
    else {
      await response.body?.cancel();
      failure =
        response.status === 404
          ? "App server code is not set up on this deployment's app gateway"
          : `The app gateway answered HTTP ${response.status}`;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError")
      failure = "The app's server code did not answer in time";
  }
  const error = runError(result, failure);
  await recordAppServerRun(
    deps.db,
    input.scope,
    {
      id: runId,
      siteId: input.siteId,
      versionId: deployment.versionId,
      trigger: input.trigger,
      target: `${request.method} ${request.path}`,
      status: error ? "error" : "ok",
      httpStatus: result?.status ?? null,
      durationMs: Date.now() - startedAt,
      error,
      logs: result?.logs ?? "",
      viewerSubjectId: input.viewer?.id ?? null,
    },
    APP_SERVER_RUNS_KEPT_DAYS,
  ).catch((recordError: unknown) =>
    console.warn("[app-server] could not record a run", {
      siteId: input.siteId,
      error: recordError instanceof Error ? recordError.message : String(recordError),
    }),
  );
  if (!result) throw new AppServerError("unavailable", failure, { runId, retryable: true });
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of result.headers) {
    const lower = name.toLowerCase();
    if (!DROPPED_RESPONSE_HEADERS.has(lower)) responseHeaders[lower] = value;
  }
  const bytes = Buffer.from(result.bodyBase64, "base64");
  const contentType = responseHeaders["content-type"] ?? "";
  let text: string | null = null;
  if (TEXT_TYPE.test(contentType) || (!contentType && bytes.byteLength === 0)) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = null;
    }
  }
  return {
    status: result.status,
    headers: responseHeaders,
    body: text ?? bytes.toString("base64"),
    bodyEncoding: text === null ? "base64" : "utf8",
    runId,
  };
}

/** The viewer the code sees for a workspace grant (a member in the console, or their agent). */
export async function appServerViewerForGrant(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
): Promise<AppServerViewer> {
  return {
    id: `user:${grant.subjectId}`,
    email: await getVerifiedSubjectEmail(deps.db, grant.subjectId).catch(() => null),
    name: null,
    kind: "member",
  };
}

/**
 * Someone who may open the app calls its server code: a member in the
 * console (or their agent), or a published app's viewer. A Site frame may
 * call only its own app. Only who they are reaches the code.
 */
export async function runAppServerAs(
  deps: AppServerDeps,
  authority: SiteDataAuthority,
  siteId: string,
  request: unknown,
  options: { frameSiteId?: string | null; viewer?: AppServerViewer | null } = {},
): Promise<AppServerFetchResponse> {
  let access: SiteDataAccess;
  try {
    access = await resolveSiteDataAccess(
      deps,
      authority,
      siteId,
      options.frameSiteId === undefined ? {} : { frameSiteId: options.frameSiteId },
    );
  } catch (error) {
    if (error instanceof SiteDataError)
      throw new AppServerError(
        error.code === "not_found" ? "not_found" : "forbidden",
        error.message,
      );
    throw error;
  }
  const viewer =
    options.viewer !== undefined
      ? options.viewer
      : (authority as { kind?: unknown }).kind === "published_viewer"
        ? null
        : await appServerViewerForGrant(deps, authority as AccessGrant);
  return await runAppServer(deps, {
    scope: { accountId: access.caller.accountId, workspaceId: access.caller.workspaceId },
    siteId: access.site.id,
    viewer,
    trigger: "request",
    request,
  });
}

// --- calls back to Opengeni ------------------------------------------------------

function containsSecretReference(value: unknown, depth = 0): boolean {
  if (depth > 40) return true;
  if (typeof value === "string") return value.includes(SECRET_MARK);
  if (Array.isArray(value)) return value.some((item) => containsSecretReference(item, depth + 1));
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([key, item]) => key.includes(SECRET_MARK) || containsSecretReference(item, depth + 1),
    );
  return false;
}

const sameTool = (left: ToolGatewayIdentity, right: ToolGatewayIdentity) =>
  left.serverId === right.serverId && left.toolName === right.toolName;

function toolNotDeclared(tool: ToolGatewayIdentity): AppServerError {
  return forbidden(
    `The app doesn't declare ${tool.serverId}/${tool.toolName}. Add it to the version's requestedTools and publish again.`,
    { reason: "tool_not_declared" },
  );
}

/**
 * The identity a tool call from server code runs: only tools the version
 * declares, and only on a workspace-shared account of their connector (or a
 * remote connector without accounts), never a person's own connection.
 */
export function routeAppServerTool(
  inventory: SiteToolAccountInventory,
  declared: readonly ToolGatewayIdentity[],
  tool: ToolGatewayIdentity,
): ToolGatewayIdentity {
  const viaConnector = (canonicalServerId: string): ToolGatewayIdentity => {
    const [shared] = inventory.accounts
      .filter(
        (account) => account.canonicalServerId === canonicalServerId && account.shared === true,
      )
      .sort((left, right) => left.serverId.localeCompare(right.serverId));
    if (shared) return { serverId: shared.serverId, toolName: tool.toolName };
    const name = inventory.canonical.get(canonicalServerId)?.name ?? "this tool's connector";
    throw forbidden(
      `Server code uses only the workspace's shared accounts, and no shared ${name} account is connected. A workspace admin can connect one and share it with the workspace.`,
      { reason: "shared_account_required", connector: name },
    );
  };
  const declares = (identity: ToolGatewayIdentity) =>
    declared.some((item) => sameTool(item, identity));
  const own = inventory.accounts.find((account) => account.serverId === tool.serverId);
  if (own) {
    const canonical = { serverId: own.canonicalServerId, toolName: tool.toolName };
    if (!declares(tool) && !declares(canonical)) throw toolNotDeclared(tool);
    // A shared account route runs as itself; a personal one goes to the shared account.
    return own.shared === true ? tool : viaConnector(own.canonicalServerId);
  }
  if (!declares(tool)) throw toolNotDeclared(tool);
  if (inventory.canonical.has(tool.serverId)) return viaConnector(tool.serverId);
  if (inventory.plain.has(tool.serverId)) {
    if (FIRST_PARTY_SERVERS.has(tool.serverId) || !inventory.servers?.get(tool.serverId)?.url)
      throw forbidden(`Server code can't call ${tool.serverId} tools: they act as a person.`, {
        reason: "tool_acts_as_person",
      });
    return tool;
  }
  // Another member's account route: through the connector the version declares for the same tool.
  const candidates = declared.filter(
    (item) => item.toolName === tool.toolName && inventory.canonical.has(item.serverId),
  );
  if (candidates.length === 1) return viaConnector(candidates[0]!.serverId);
  throw forbidden("This tool isn't available to the app's server code here.", {
    reason: "tool_unavailable",
  });
}

function toolIdentityOf(value: unknown): ToolGatewayIdentity {
  if (typeof value === "string") {
    const at = value.indexOf("/");
    if (at > 0) return { serverId: value.slice(0, at), toolName: value.slice(at + 1) };
  }
  if (value && typeof value === "object") {
    const { serverId, toolName } = value as Partial<ToolGatewayIdentity>;
    if (typeof serverId === "string" && typeof toolName === "string") return { serverId, toolName };
  }
  throw invalid('tool must be {serverId, toolName} or "serverId/toolName"');
}

type Schema<T> = {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
};

function parseWith<T>(schema: Schema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw invalid(issueText(parsed.error.issues));
}

async function requireSharedCollection(access: SiteDataAccess, name: string): Promise<void> {
  const collection = await access.store.getCollection(
    {
      accountId: access.caller.accountId,
      workspaceId: access.caller.workspaceId,
      siteId: access.site.id,
    },
    name,
  );
  if (!collection)
    throw invalid(`The app has no collection named "${name}". Define it first.`, {
      code: "collection_not_found",
    });
  if (collection.accessMode === "per_viewer")
    throw forbidden(
      `"${name}" keeps each person's records separately, so server code can't use it. Use a shared, shared_read or append_only collection.`,
      { reason: "collection_per_viewer" },
    );
}

const DROPPED_OUTBOUND_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-authorization",
  "te",
  "trailer",
]);

/** One outbound request: HTTPS to a listed host, listed secrets only, public addresses only. */
export async function appServerOutboundFetch(
  deps: AppServerDeps,
  scope: { accountId: string; workspaceId: string },
  manifest: AppServerManifest,
  input: unknown,
): Promise<{ status: number; headers: Array<[string, string]>; bodyBase64: string }> {
  const request = parseWith(AppServerOutboundRequest, input);
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw invalid("fetch needs an absolute https:// URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw invalid(
      "Server code fetches only https:// URLs on the default port, without credentials",
    );
  const host = url.hostname.toLowerCase();
  if (!isAppServerEgressHost(host) || !manifest.egress.includes(host))
    throw forbidden(
      `Server code may only fetch the hosts its version lists in egress, and ${host} isn't one. Add it to egress and publish again.`,
      { reason: "egress_not_listed", host },
    );
  if (request.url.includes(SECRET_MARK))
    throw invalid("Put secrets in request headers, not the URL");
  const headers: Record<string, string> = {};
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (DROPPED_OUTBOUND_HEADERS.has(lower)) continue;
    if (lower.includes(SECRET_MARK)) throw invalid("Put secrets in header values");
    for (const reference of value.match(SECRET_REFERENCE) ?? [])
      if (!manifest.secrets.includes(reference))
        throw forbidden(
          "Server code may only use the vault secrets its version lists. Add the secret to the version's secrets and publish again.",
          { reason: "secret_not_listed" },
        );
    headers[lower] = headers[lower] === undefined ? value : `${headers[lower]}, ${value}`;
  }
  const body = request.bodyBase64 ? Buffer.from(request.bodyBase64, "base64") : null;
  if (body && body.includes(SECRET_MARK))
    throw invalid("Put secrets in request headers, not the body");
  let resolved: Record<string, string>;
  try {
    resolved = Object.values(headers).some((value) => value.includes(SECRET_MARK))
      ? await resolveSecretHeaders(deps, scope, headers, url.toString())
      : headers;
  } catch (error) {
    if (error instanceof ServiceConnectionCredentialError)
      throw forbidden(error.message, { reason: "secret_unavailable" });
    throw error;
  }
  const init: RequestInit = {
    method: request.method,
    headers: resolved,
    ...(body && request.method !== "GET" && request.method !== "HEAD" ? { body } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(APP_SERVER_FETCH_TIMEOUT_MS),
  };
  let response: Response;
  try {
    response = deps.appServerOutboundFetch
      ? await deps.appServerOutboundFetch(url.toString(), init)
      : await pinnedFetch(
          url.toString(),
          init,
          // Never private networks from app code, whatever integrations allow.
          { environment: deps.settings.environment, integrationsAllowPrivateNetworkTargets: false },
          { label: "App server fetch", requireHttpsOutsideLocalTest: true },
        );
  } catch (error) {
    if (error instanceof DestinationPolicyError)
      throw forbidden(error.message, { reason: error.reason });
    throw new AppServerError(
      "unavailable",
      error instanceof DOMException && error.name === "TimeoutError"
        ? `${host} did not answer within ${APP_SERVER_FETCH_TIMEOUT_MS / 1000} seconds`
        : `${host} could not be reached`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await readResponseBodyBounded(
      response,
      APP_SERVER_FETCH_RESPONSE_MAX_BYTES,
      "App server fetch response",
    );
  } catch (error) {
    if (error instanceof ResponseBodyLimitError)
      throw invalid(
        `The response from ${host} is over ${APP_SERVER_FETCH_RESPONSE_MAX_BYTES / 1024 / 1024} MB`,
      );
    throw new AppServerError("unavailable", `${host} could not be read`);
  }
  return {
    status: response.status,
    headers: [...response.headers].filter(([name]) => name.toLowerCase() !== "set-cookie") as Array<
      [string, string]
    >,
    bodyBase64: base64(bytes),
  };
}

/**
 * One call back to Opengeni from a run, forwarded and signed by the gateway
 * for the isolate's own app and version. The run's token must name the same
 * app and version, the version must still be the app's current one, and the
 * deployer must still manage the app.
 */
export async function handleAppServerHostCall(
  deps: AppServerDeps,
  input: { siteId: string; versionId: string; token: string; body: unknown },
): Promise<{ result: unknown }> {
  const claims = verifyAppServerRunToken(
    [deps.settings.sitesGatewaySecret, deps.settings.sitesGatewaySecretPrevious],
    input.token,
  );
  if (!claims || claims.siteId !== input.siteId || claims.versionId !== input.versionId)
    throw forbidden("This run's token is not valid for this app", { reason: "invalid_run_token" });
  const call = parseWith(AppServerHostRequest, input.body);
  const deployment = await getAppServerDeployment(
    deps.db,
    claims.workspaceId,
    claims.siteId,
    claims.versionId,
  );
  if (!deployment?.manifest || deployment.accountId !== claims.accountId)
    throw new AppServerError("conflict", "This version is no longer the app's current version", {
      reason: "version_replaced",
    });
  const scope = { accountId: deployment.accountId, workspaceId: deployment.workspaceId };
  // Even an outbound fetch stops once the deployer can no longer manage the app.
  const authority = await serverAuthority(deps, deployment);
  switch (call.op) {
    case "fetch":
      return { result: await appServerOutboundFetch(deps, scope, deployment.manifest, call.input) };
    case "tools.call": {
      const tool = toolIdentityOf(call.input.tool);
      const args = call.input.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw invalid("arguments must be an object");
      if (containsSecretReference(args))
        throw forbidden("Tool arguments from server code can't carry vault references", {
          reason: "secret_in_arguments",
        });
      let inventory: SiteToolAccountInventory;
      try {
        inventory = await (deps.appServerToolInventory ?? readSiteToolAccountInventory)(
          deps,
          authority.grant,
        );
      } catch {
        throw new AppServerError(
          "unavailable",
          "The workspace's connections can't be read right now. Try again shortly.",
        );
      }
      const identity = routeAppServerTool(inventory, deployment.requestedTools, tool);
      try {
        const result = await (deps.appServerToolCaller ?? callAppSyncToolThroughGateway)({
          deps,
          grant: authority.grant,
          identity,
          arguments: args as Record<string, unknown>,
        });
        return { result };
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        const message = error instanceof Error ? error.message : "";
        if (status === 409 || message.includes("approval_required"))
          throw forbidden(
            "This tool asks for approval before each use, so server code can't call it. A workspace admin can allow it without asking.",
            { reason: "approval_required" },
          );
        if (status === 404 || status === 403)
          throw forbidden("This tool isn't available to the app's server code here.", {
            reason: "tool_unavailable",
          });
        throw new AppServerError("unavailable", "The tool call failed. Try again shortly.");
      }
    }
    case "data.query": {
      const query = parseWith(SiteDataQueryRequest, call.input);
      await requireSharedCollection(authority.access, query.collection);
      return {
        result: await authority.access.store.query(authority.access.caller, {
          collection: query.collection,
          ...(query.where ? { where: query.where } : {}),
          ...(query.sort ? { sort: query.sort } : {}),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.count ? { count: true } : {}),
        }),
      };
    }
    case "data.get": {
      const get = parseWith(SiteDataGetRequest, call.input);
      await requireSharedCollection(authority.access, get.collection);
      return {
        result: await authority.access.store.get(
          authority.access.caller,
          get.collection,
          get.id !== undefined ? { id: get.id } : { key: get.key! },
        ),
      };
    }
    case "data.write": {
      const write = parseWith(SiteDataWriteRequest, call.input);
      for (const name of new Set(write.operations.map((operation) => operation.collection)))
        await requireSharedCollection(authority.access, name);
      return {
        result: await writeSiteDataWithAccess(
          deps,
          authority.access,
          write.operations as SiteDataWriteOp[],
        ),
      };
    }
  }
}

// --- status and runs (managers) ------------------------------------------------

async function managerScope(deps: AppServerDeps, grant: AccessGrant, siteId: string) {
  let access: SiteDataAccess;
  try {
    access = await resolveSiteDataAccess(deps, grant, siteId, { management: true });
  } catch (error) {
    if (error instanceof SiteDataError)
      throw new AppServerError(
        error.code === "not_found" ? "not_found" : "forbidden",
        error.code === "not_found"
          ? error.message
          : "Only the app's managers can see its server code",
      );
    throw error;
  }
  return { access, scope: { accountId: grant.accountId, workspaceId: grant.workspaceId } };
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The one status line's data: whether the current version has code, and today's errors. */
export async function appServerStatus(
  deps: AppServerDeps,
  grant: AccessGrant,
  siteId: string,
): Promise<AppServerStatus> {
  const { access, scope } = await managerScope(deps, grant, siteId);
  const deployment = await getAppServerDeployment(deps.db, grant.workspaceId, access.site.id);
  const summary = await summarizeAppServerRuns(deps.db, scope, access.site.id, startOfUtcDay());
  return {
    hasCode: !!deployment?.manifest,
    available: appServerAvailable(deps.settings),
    errorsToday: summary.errors,
    runsToday: summary.runs,
    lastError: summary.lastError,
    egress: deployment?.manifest?.egress ?? [],
    secrets: deployment?.manifest?.secrets ?? [],
  };
}

export async function appServerRuns(
  deps: AppServerDeps,
  grant: AccessGrant,
  siteId: string,
  options: { limit?: number; status?: "ok" | "error"; before?: string },
): Promise<{ runs: AppServerRun[] }> {
  const { access, scope } = await managerScope(deps, grant, siteId);
  return {
    runs: await listAppServerRuns(deps.db, scope, access.site.id, {
      limit: options.limit ?? 20,
      ...(options.status ? { status: options.status } : {}),
      ...(options.before ? { before: options.before } : {}),
    }),
  };
}

/** A manager (or their agent) tries the app's server code: a recorded `manual` run as themselves. */
export async function testAppServer(
  deps: AppServerDeps,
  grant: AccessGrant,
  siteId: string,
  request: unknown,
): Promise<AppServerFetchResponse> {
  const { access, scope } = await managerScope(deps, grant, siteId);
  return await runAppServer(deps, {
    scope,
    siteId: access.site.id,
    viewer: await appServerViewerForGrant(deps, grant),
    trigger: "manual",
    request,
  });
}
