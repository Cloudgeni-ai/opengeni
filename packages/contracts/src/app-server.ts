/**
 * App server code (docs/app-server-code.md): a small server program an app
 * version can carry beside its HTML. It runs on our side, as the app and
 * never as the viewer, in its own Cloudflare Dynamic Worker isolate loaded by
 * the Sites gateway. It has no network of its own: everything it reaches
 * (the workspace's shared tools, the app's shared data, outbound HTTPS to
 * the hosts it lists, with vault secrets the API fills in) goes back
 * through the API, which checks each call against the run's token.
 *
 * - Agents upload the code as one JSON bundle (`AppServerBundle`) beside the
 *   HTML; the API stores each file content-addressed per workspace and
 *   keeps a manifest (`AppServerManifest`) on the immutable version row, so
 *   versions, rollback and duplicates carry it like the HTML.
 * - Pages call it with `site.server.fetch(path, init)`; the API checks the
 *   viewer can open the app and tells the code who is asking.
 * - Every run is recorded (trigger, status, duration, error, bounded
 *   console output) for the app's managers.
 *
 * Keep this module dependency-free apart from zod: the Sites gateway Worker
 * and the API share it.
 */
import { z } from "zod";

/** Most files one version's server code may have. */
export const APP_SERVER_MAX_FILES = 50;
/** All server code files of one version together (UTF-8 bytes). */
export const APP_SERVER_MAX_TOTAL_BYTES = 1024 * 1024;
/** The uploaded JSON bundle. */
export const APP_SERVER_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;
/** Most outbound hosts one version may list. */
export const APP_SERVER_MAX_EGRESS_HOSTS = 20;
/** Most vault secrets one version may list. */
export const APP_SERVER_MAX_SECRETS = 20;
/** Largest request body a page may send to its server code. */
export const APP_SERVER_REQUEST_BODY_MAX_BYTES = 1024 * 1024;
/** Largest response body server code may return. */
export const APP_SERVER_RESPONSE_BODY_MAX_BYTES = 4 * 1024 * 1024;
/** Longest one run may take, end to end (wall clock). */
export const APP_SERVER_RUN_TIMEOUT_MS = 30_000;
/** CPU time one run may use in its isolate. */
export const APP_SERVER_CPU_MS = 5_000;
/** Calls back to Opengeni (tools, data, outbound fetch) one run may make. */
export const APP_SERVER_HOST_CALLS_PER_RUN = 50;
/** Console output kept per run (characters). */
export const APP_SERVER_LOG_MAX_CHARS = 8_000;
/** Runs one app may start per minute (all viewers together). */
export const APP_SERVER_RUNS_PER_MINUTE = 300;
/** Largest outbound response body one fetch may read. */
export const APP_SERVER_FETCH_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
/** Outbound fetch timeout. */
export const APP_SERVER_FETCH_TIMEOUT_MS = 15_000;
/** Runs kept per app; older ones are pruned. */
export const APP_SERVER_RUNS_KEPT_DAYS = 14;

/** The gateway's internal route the API calls to run a version's code. */
export const APP_SERVER_INTERNAL_PREFIX = "/_og/internal/app-server";
/** Header carrying a run's token on calls back to Opengeni. */
export const APP_SERVER_RUN_TOKEN_HEADER = "x-opengeni-app-server-run";

/**
 * The site-runtime route (under `/v1/site-runtime`) the gateway forwards one
 * isolate's calls back to Opengeni to. The gateway signs it, so the app and
 * version in the path are the isolate's own (set by the gateway when it
 * loaded the code, never by the code), and the run's token must name them.
 */
export function appServerHostSuffix(siteId: string, versionId: string): string {
  return `/app-server/${siteId}/${versionId}/host`;
}
/** Header the gateway hands the run's context to its wrapper in (stripped before the app's code sees the request). */
export const APP_SERVER_CONTEXT_HEADER = "x-opengeni-app-server-context";
/** Largest API -> gateway run request (code, request body and context). */
export const APP_SERVER_GATEWAY_BODY_MAX_BYTES = 4 * 1024 * 1024;
/** Largest call back to Opengeni from one isolate (an outbound request with its body). */
export const APP_SERVER_HOST_BODY_MAX_BYTES = 2 * 1024 * 1024;

/** The gateway's internal route for one app: `<prefix>/<siteId>/run`. */
export function appServerInternalPath(siteId: string): string {
  return `${APP_SERVER_INTERNAL_PREFIX}/${siteId}/run`;
}

/** `src/index.js`, `lib/util.mjs`: relative, no `..`, JavaScript modules only. */
export function isAppServerModulePath(path: string): boolean {
  return (
    path.length <= 200 &&
    /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*\.m?js$/u.test(path) &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}

/** A host server code may call: a lowercase DNS name, no port, scheme or wildcard. */
export function isAppServerEgressHost(host: string): boolean {
  if (host.length > 253 || host !== host.toLowerCase()) return false;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/u.test(host))
    return false;
  // Names that only ever mean this machine or a private network.
  return !/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|localdomain)$/u.test(host);
}

/** A vault reference string: two braces, `secret:`, the vault and item (and field), two braces. */
export const APP_SERVER_SECRET_REFERENCE = /^\{\{secret:[^{}\s][^{}]{0,400}\}\}$/u;

const ModulePath = z
  .string()
  .min(1)
  .max(200)
  .refine(isAppServerModulePath, "must be a relative .js or .mjs path without ..");

const EgressHost = z
  .string()
  .min(1)
  .max(253)
  .refine(isAppServerEgressHost, "must be a public lowercase host name like api.example.com");

const SecretReference = z
  .string()
  .regex(APP_SERVER_SECRET_REFERENCE, "must be a vault reference to a shared vault item");

/**
 * The uploaded server code: JavaScript modules (ES modules, `export default`).
 * `{"files": []}` removes the app's server code; a publish without a server
 * upload keeps the current version's code.
 */
export const AppServerBundle = z
  .object({
    /** The module whose `export default` handles requests. */
    main: ModulePath.optional(),
    files: z
      .array(z.object({ path: ModulePath, content: z.string().max(APP_SERVER_MAX_TOTAL_BYTES) }))
      .max(APP_SERVER_MAX_FILES),
    /** Hosts outbound `fetch` may reach (HTTPS only). */
    egress: z.array(EgressHost).max(APP_SERVER_MAX_EGRESS_HOSTS).optional(),
    /** Vault references outbound request headers may carry; the API fills them in. */
    secrets: z.array(SecretReference).max(APP_SERVER_MAX_SECRETS).optional(),
  })
  .strict()
  .superRefine((bundle, context) => {
    if (bundle.files.length === 0) return;
    const paths = new Set<string>();
    for (const file of bundle.files) {
      if (paths.has(file.path))
        context.addIssue({
          code: "custom",
          path: ["files"],
          message: `${file.path} is listed twice`,
        });
      paths.add(file.path);
    }
    if (!bundle.main || !paths.has(bundle.main))
      context.addIssue({
        code: "custom",
        path: ["main"],
        message: "main must name one of the files",
      });
  });
export type AppServerBundle = z.infer<typeof AppServerBundle>;

export const AppServerFile = z.object({
  path: ModulePath,
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sizeBytes: z.number().int().nonnegative(),
});
export type AppServerFile = z.infer<typeof AppServerFile>;

/** What a version row keeps: the files (content-addressed), egress, secrets and a digest of it all. */
export const AppServerManifest = z.object({
  main: ModulePath,
  files: z.array(AppServerFile).min(1).max(APP_SERVER_MAX_FILES),
  egress: z.array(EgressHost).max(APP_SERVER_MAX_EGRESS_HOSTS),
  secrets: z.array(SecretReference).max(APP_SERVER_MAX_SECRETS),
  /** SHA-256 over main, files, egress and secrets: the code's identity in the gateway's cache. */
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type AppServerManifest = z.infer<typeof AppServerManifest>;

/** Where a server code file is stored: once per workspace, by content. */
export function appServerObjectKey(workspaceId: string, sha256: string): string {
  return `workspaces/${workspaceId}/app-server-files/${sha256}`;
}

// --- calling it ---------------------------------------------------------------------

/** A page's request to its server code (`site.server.fetch`). */
export const AppServerFetchRequest = z
  .object({
    /** Path and query the code sees, starting with "/". */
    path: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^\/[^\s#]*$/u, "must start with / and contain no spaces or #"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().default("GET"),
    headers: z.record(z.string().max(128), z.string().max(4096)).optional(),
    /** A text body. */
    body: z.string().nullable().optional(),
    /** A binary body, base64 (instead of body). */
    bodyBase64: z.string().nullable().optional(),
  })
  .strict();
export type AppServerFetchRequest = z.input<typeof AppServerFetchRequest>;

/** What the page gets back. Text bodies stay text; anything else is base64. */
export type AppServerFetchResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: "utf8" | "base64";
  runId: string;
};

/** Who the code serves: trustworthy, filled in by Opengeni (null for runs nobody started from a page). */
export type AppServerViewer = {
  /** `user:<subject>` for a signed-in person, `guest:<visitor>` for an anonymous visitor (like `site.viewer.id`). */
  id: string;
  email: string | null;
  name: string | null;
  /** How they reach the app: a workspace member, an invited person, another signed-in user, or a guest. */
  kind: "member" | "invited" | "user" | "guest";
};

export type AppServerTrigger = "request" | "manual";

/** The run context the gateway hands the isolate with each request (never cached with the code). */
export type AppServerRunContext = {
  runId: string;
  appId: string;
  versionId: string;
  trigger: AppServerTrigger;
  viewer: AppServerViewer | null;
  /** Capability for this run's calls back to Opengeni; valid until the run's deadline. */
  token: string;
  hostCallLimit: number;
  logLimit: number;
};

/** API -> gateway: run one request through a version's code. */
export type AppServerGatewayRunRequest = {
  requestId: string;
  versionId: string;
  digest: string;
  main: string;
  /** The code, path -> source (the gateway caches the loaded isolate by app, version and digest). */
  modules: Record<string, string>;
  context: AppServerRunContext;
  request: { method: string; path: string; headers: Array<[string, string]>; bodyBase64: string };
  limits: { timeoutMs: number; cpuMs: number; responseBytes: number };
};

/** Gateway -> API: how the run ended. */
export type AppServerGatewayRunResult = {
  status: number;
  headers: Array<[string, string]>;
  bodyBase64: string;
  logs: string;
  /** The code threw, timed out or answered too much; null when it answered. */
  error: string | null;
};

// --- calls back to Opengeni (host operations) ----------------------------------------

export const APP_SERVER_HOST_OPERATIONS = [
  "tools.call",
  "data.query",
  "data.get",
  "data.write",
  "fetch",
] as const;
export type AppServerHostOperation = (typeof APP_SERVER_HOST_OPERATIONS)[number];

export const AppServerHostRequest = z
  .object({
    op: z.enum(APP_SERVER_HOST_OPERATIONS),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AppServerHostRequest = z.infer<typeof AppServerHostRequest>;

/** An outbound request (`fetch` host operation). Headers may carry listed vault references. */
export const AppServerOutboundRequest = z
  .object({
    url: z.string().min(1).max(8192),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    headers: z
      .array(z.tuple([z.string().max(128), z.string().max(8192)]))
      .max(100)
      .default([]),
    bodyBase64: z.string().nullable().optional(),
  })
  .strict();
export type AppServerOutboundRequest = z.infer<typeof AppServerOutboundRequest>;

// --- runs and status -----------------------------------------------------------------

export type AppServerRun = {
  id: string;
  appId: string;
  versionId: string;
  trigger: AppServerTrigger;
  /** The request's method and path. */
  target: string;
  status: "ok" | "error";
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
  logs: string;
  viewerSubjectId: string | null;
  createdAt: string;
};

/** The one status line: whether the current version has code, and how it has been doing today. */
export type AppServerStatus = {
  /** The app's current version has server code. */
  hasCode: boolean;
  /** This deployment can run server code. */
  available: boolean;
  errorsToday: number;
  runsToday: number;
  lastError: { message: string; at: string } | null;
  /** What the code may reach, for managers. */
  egress: string[];
  secrets: string[];
};
