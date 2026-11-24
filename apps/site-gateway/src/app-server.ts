import {
  APP_SERVER_CONTEXT_HEADER,
  APP_SERVER_GATEWAY_BODY_MAX_BYTES,
  APP_SERVER_GATEWAY_RESULT_MAX_BYTES,
  APP_SERVER_HOST_BODY_MAX_BYTES,
  APP_SERVER_INTERNAL_PREFIX,
  APP_SERVER_RUN_TOKEN_HEADER,
  appServerHostSuffix,
  isAppServerModulePath,
  type AppServerGatewayRunRequest,
  type AppServerGatewayRunResult,
} from "@opengeni/contracts";
import { readBodyCapped } from "./api";
import { gatewayConfig, type GatewayConfig, type GatewayEnv } from "./env";
import { jsonError } from "./headers";
import { signedApiRequest } from "./signing";
import { precheckSiteDbSignature, verifySiteDbSignature } from "./site-db";

/**
 * App server code (docs/app-server-code.md): the gateway runs an app
 * version's server code in its own Cloudflare Dynamic Worker isolate.
 *
 * `POST /_og/internal/app-server/<siteId>/run`, signed by the API exactly
 * like the internal Site database route (no viewer fields, the gateway's
 * host, the body digest, within 30 s). The API has already checked who may
 * call the app; the gateway only loads and runs the code.
 *
 * - `LOADER.get("<siteId>:<versionId>:<digest>")` loads the code once per
 *   isolate and caches it; each app version is its own isolate, so one
 *   app's code never shares memory with another's.
 * - The limits inside the isolate (calls, logs, response size) are
 *   advisory: the app's own code runs there. The API counts each call back
 *   on the live run, and the gateway and the API read the result bounded.
 * - The isolate has no network (`globalOutbound: null`). Its only binding is
 *   `HOST`, a loopback to this Worker's `AppServerHost` entrypoint whose
 *   props (the app and version) the gateway fixes when it loads the code.
 *   Everything the code reaches goes through `HOST` to the API, signed by
 *   the gateway with the app and version in the signed path, carrying the
 *   run's token, which the API checks names the same app and version.
 * - Without the `LOADER` binding the route answers 404.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const COMPATIBILITY_DATE = "2026-07-01";
/** The wrapper module the loaded isolate starts in; the app's own modules live under `app/`. */
const WRAPPER_MODULE = "__opengeni_app_server.js";
/**
 * Set up before any of the app's modules load (the wrapper imports it
 * first, and ES modules evaluate in import order), so a library that keeps
 * a reference to `fetch` or `console` at load time gets the routed ones.
 */
const SETUP_MODULE = "__opengeni_app_server_setup.js";

/** The slice of the Worker Loader binding the gateway uses. */
export type WorkerLoaderLike = {
  get(
    id: string,
    load: () => Promise<WorkerLoaderCode>,
  ): { getEntrypoint(): { fetch(request: Request): Promise<Response> } };
};

export type WorkerLoaderCode = {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  env: Record<string, unknown>;
  globalOutbound: null;
  limits?: { cpuMs?: number };
};

/** The Worker's own loopback entrypoints (`ctx.exports`), available at compatibility date 2026-07-01. */
export type LoopbackExports = {
  AppServerHost?: (options: { props: AppServerHostProps }) => unknown;
};

export type AppServerHostProps = { siteId: string; versionId: string };

export function isAppServerInternalPath(pathname: string): boolean {
  return (
    pathname === APP_SERVER_INTERNAL_PREFIX || pathname.startsWith(`${APP_SERVER_INTERNAL_PREFIX}/`)
  );
}

/** `<siteId>` from `/_og/internal/app-server/<siteId>/run`, or null. */
export function parseAppServerPath(pathname: string): string | null {
  const match = /^\/_og\/internal\/app-server\/([^/]+)\/run$/u.exec(pathname);
  return match && UUID.test(match[1]!) ? match[1]! : null;
}

/**
 * The first module the isolate evaluates: it routes `console` and the global
 * `fetch` to the request being served (AsyncLocalStorage, so concurrent
 * requests never see each other's logs or token).
 */
export const APP_SERVER_SETUP_SOURCE = `import { AsyncLocalStorage } from "node:async_hooks";
export const runs = new AsyncLocalStorage();
export const text = (value) => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
};
export const parseJson = JSON.parse;
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...args) => { const run = runs.getStore(); if (run) run.log(level, args.map(text).join(" ")); };
}
globalThis.fetch = (input, init) => {
  const run = runs.getStore();
  if (!run) return Promise.reject(new Error("fetch works only while the app's server code handles a request"));
  return run.fetch(input, init);
};
`;

/**
 * The wrapper the isolate starts in. It hands the app's code a fresh `env`
 * per request (viewer, app, tools, data, fetch), keeps the request's logs,
 * stops waiting at the run's deadline (answering with the logs so far), and
 * answers the gateway with one JSON envelope.
 */
export function appServerWrapperSource(main: string): string {
  if (!isAppServerModulePath(main)) throw new Error("Invalid main module");
  return `import { runs, text, parseJson } from ${JSON.stringify(`./${SETUP_MODULE}`)};
import * as appModule from ${JSON.stringify(`./app/${main}`)};
const CONTEXT_HEADER = ${JSON.stringify(APP_SERVER_CONTEXT_HEADER)};
const TOKEN_HEADER = ${JSON.stringify(APP_SERVER_RUN_TOKEN_HEADER)};
const toBase64 = (bytes) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};
const fromBase64 = (value) => Uint8Array.from(atob(value || ""), (char) => char.charCodeAt(0));
function newRun(context, host) {
  let logs = "";
  const run = {
    log(level, line) {
      if (logs.length >= context.logLimit) return;
      logs += (level === "log" || level === "info" ? "" : level + ": ") + line + "\\n";
      if (logs.length > context.logLimit) logs = logs.slice(0, context.logLimit);
    },
    logs: () => logs,
    async call(op, input) {
      const response = await host.fetch("https://host.internal/", {
        method: "POST",
        headers: { "content-type": "application/json", [TOKEN_HEADER]: context.token },
        body: JSON.stringify({ op, input }),
      });
      let value = null;
      try { value = await response.json(); } catch {}
      if (response.ok && value && "result" in value) return value.result;
      const error = value && value.error ? value.error : {};
      const failure = new Error(error.message || "Opengeni refused the call (HTTP " + response.status + ")");
      failure.code = (error.details && error.details.reason) || error.code || "failed";
      failure.status = response.status;
      throw failure;
    },
    async fetch(input, init) {
      const request = new Request(input, init);
      const body = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
      const result = await run.call("fetch", {
        url: request.url,
        method: request.method,
        headers: [...request.headers],
        bodyBase64: body && body.byteLength > 0 ? toBase64(body) : null,
      });
      return new Response(request.method === "HEAD" || [101, 204, 205, 304].includes(result.status) ? null : fromBase64(result.bodyBase64), {
        status: result.status,
        headers: result.headers,
      });
    },
  };
  return run;
}
function appEnv(context, run) {
  const data = Object.freeze({
    query: (collection, query = {}) => run.call("data.query", { ...query, collection }),
    get: (collection, idOrKey) => run.call("data.get", { collection, ...(typeof idOrKey === "string" ? { id: idOrKey } : idOrKey) }),
    write: (operations) => run.call("data.write", { operations }),
    put: (collection, key, value) => run.call("data.write", { operations: [{ op: "put", collection, key, data: value }] }),
    insert: (collection, value) => run.call("data.write", { operations: [{ op: "insert", collection, data: value }] }),
    delete: (collection, id) => run.call("data.write", { operations: [{ op: "delete", collection, id }] }),
  });
  return Object.freeze({
    viewer: context.viewer,
    app: Object.freeze({ id: context.appId, versionId: context.versionId }),
    trigger: context.trigger,
    runId: context.runId,
    tools: Object.freeze({
      call: (tool, args = {}, options = {}) =>
        run.call("tools.call", { tool, arguments: args, ...(options && options.raw === true ? { raw: true } : {}) }),
    }),
    data,
    fetch: (input, init) => run.fetch(input, init),
  });
}
async function handle(request, context, run, limits) {
  const app = appModule.default;
  if (!app || typeof app.fetch !== "function")
    throw new Error("The main module must export default { async fetch(request, env) { ... } }");
  const headers = new Headers(request.headers);
  headers.delete(CONTEXT_HEADER);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const inner = new Request(request.url, { method: request.method, headers, body: hasBody ? await request.arrayBuffer() : null });
  const response = await app.fetch(inner, appEnv(context, run), { waitUntil(promise) { Promise.resolve(promise).catch(() => {}); }, passThroughOnException() {} });
  if (!(response instanceof Response)) throw new Error("fetch must return a Response");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limits.responseBytes)
    throw new Error("The response is over " + limits.responseBytes + " bytes");
  return { status: response.status, headers: [...response.headers], bodyBase64: toBase64(bytes), logs: run.logs(), error: null };
}
export default {
  async fetch(request, env) {
    const { context, limits } = parseJson(request.headers.get(CONTEXT_HEADER));
    const run = newRun(context, env.HOST);
    const failed = (message) => ({ status: 500, headers: [], bodyBase64: "", logs: run.logs(), error: message });
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve(failed("The server code did not answer within " + Math.round(limits.timeoutMs / 1000) + " seconds")),
        Math.max(1000, limits.timeoutMs - 1500),
      );
    });
    const envelope = await Promise.race([
      runs.run(run, async () => {
        try {
          return await handle(request, context, run, limits);
        } catch (error) {
          run.log("error", text(error));
          return failed((error && error.message) || String(error));
        }
      }),
      deadline,
    ]);
    clearTimeout(timer);
    return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json" } });
  },
};
`;
}

/** What the gateway loads for one version: the wrapper, the app's modules under `app/`, only `HOST`. */
export function appServerWorkerCode(
  run: Pick<AppServerGatewayRunRequest, "main" | "modules" | "limits">,
  host: unknown,
): WorkerLoaderCode {
  const modules: Record<string, string> = {
    [WRAPPER_MODULE]: appServerWrapperSource(run.main),
    [SETUP_MODULE]: APP_SERVER_SETUP_SOURCE,
  };
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (const [path, source] of Object.entries(run.modules)) {
    if (!isAppServerModulePath(path)) throw new Error(`Invalid module path ${path}`);
    modules[`app/${path}`] = utf8.decode(decodeBase64(source));
  }
  if (!modules[`app/${run.main}`]) throw new Error("The main module is missing");
  return {
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_als"],
    mainModule: WRAPPER_MODULE,
    modules,
    env: { HOST: host },
    globalOutbound: null,
    limits: { cpuMs: run.limits.cpuMs },
  };
}

function isRunRequest(value: unknown): value is AppServerGatewayRunRequest {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<AppServerGatewayRunRequest>;
  return (
    typeof run.versionId === "string" &&
    UUID.test(run.versionId) &&
    typeof run.digest === "string" &&
    DIGEST.test(run.digest) &&
    typeof run.main === "string" &&
    isAppServerModulePath(run.main) &&
    !!run.modules &&
    typeof run.modules === "object" &&
    !!run.context &&
    typeof run.context === "object" &&
    !!run.request &&
    typeof run.request.path === "string" &&
    run.request.path.startsWith("/") &&
    typeof run.request.method === "string" &&
    Array.isArray(run.request.headers) &&
    typeof run.request.bodyBase64 === "string" &&
    !!run.limits &&
    Number.isFinite(run.limits.timeoutMs) &&
    Number.isFinite(run.limits.cpuMs) &&
    Number.isFinite(run.limits.responseBytes)
  );
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function timeoutResult(timeoutMs: number): AppServerGatewayRunResult {
  return {
    status: 504,
    headers: [],
    bodyBase64: "",
    logs: "",
    error: `The server code did not answer within ${Math.round(timeoutMs / 1000)} seconds (its logs are lost when it overruns this way)`,
  };
}

export async function handleAppServerInternal(
  request: Request,
  url: URL,
  env: GatewayEnv,
  config: GatewayConfig,
  exports: LoopbackExports | undefined,
): Promise<Response> {
  const security = { noindex: true, hsts: !config.development };
  const loader = env.LOADER as WorkerLoaderLike | undefined;
  const makeHost = exports?.AppServerHost;
  if (!loader || !makeHost)
    return jsonError(404, { code: "not_found", message: "Not found" }, security);
  if (!config.development && url.protocol !== "https:")
    return jsonError(400, { code: "https_required", message: "Use https" }, security);
  const siteId = parseAppServerPath(url.pathname);
  if (!siteId || url.search)
    return jsonError(404, { code: "not_found", message: "Not found" }, security);
  if (request.method !== "POST")
    return jsonError(405, { code: "method_not_allowed", message: "Use POST" }, security);
  const unauthorized = () =>
    jsonError(401, { code: "unauthorized", message: "Invalid or expired signature" }, security);
  if (precheckSiteDbSignature(request) === null) return unauthorized();
  const body = await readBodyCapped(request, APP_SERVER_GATEWAY_BODY_MAX_BYTES);
  if (body === "too_large")
    return jsonError(
      413,
      { code: "too_large", message: "The request body is too large" },
      security,
    );
  const secrets = [config.secret, ...(config.previousSecret ? [config.previousSecret] : [])];
  if (!(await verifySiteDbSignature(secrets, request, url, body))) return unauthorized();
  let run: unknown;
  try {
    run = JSON.parse(new TextDecoder().decode(body));
  } catch {
    run = null;
  }
  if (!isRunRequest(run) || run.context.appId !== siteId || run.context.versionId !== run.versionId)
    return jsonError(400, { code: "invalid_request", message: "Invalid run request" }, security);
  const runRequest = run;
  let result: AppServerGatewayRunResult;
  try {
    // The cache key names the app, the version and the code itself.
    const worker = loader.get(`${siteId}:${runRequest.versionId}:${runRequest.digest}`, async () =>
      appServerWorkerCode(
        runRequest,
        makeHost({ props: { siteId, versionId: runRequest.versionId } }),
      ),
    );
    const headers = new Headers();
    for (const [name, value] of runRequest.request.headers)
      if (name.toLowerCase() !== APP_SERVER_CONTEXT_HEADER) headers.append(name, value);
    headers.set(
      APP_SERVER_CONTEXT_HEADER,
      JSON.stringify({ context: runRequest.context, limits: runRequest.limits }),
    );
    const method = runRequest.request.method.toUpperCase();
    const inner = new Request(`https://app.internal${runRequest.request.path}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { body: decodeBase64(runRequest.request.bodyBase64) }),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), runRequest.limits.timeoutMs);
    });
    try {
      const response = await Promise.race([worker.getEntrypoint().fetch(inner), timedOut]);
      if (response === null) result = timeoutResult(runRequest.limits.timeoutMs);
      else {
        // Bounded: the isolate's own limits are advisory, since the app's code runs there.
        const answer = await readBodyCapped(response, APP_SERVER_GATEWAY_RESULT_MAX_BYTES);
        result =
          answer === "too_large"
            ? {
                status: 500,
                headers: [],
                bodyBase64: "",
                logs: "",
                error: "The server code answered more than it may",
              }
            : (JSON.parse(new TextDecoder().decode(answer)) as AppServerGatewayRunResult);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (error) {
    // The code would not load (a syntax error, a missing import) or its isolate failed.
    result = {
      status: 500,
      headers: [],
      bodyBase64: "",
      logs: "",
      error: error instanceof Error ? error.message.slice(0, 2000) : "The server code failed",
    };
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The loopback entrypoint each loaded isolate's `HOST` binding reaches. Its
 * props (app and version) were fixed by the gateway when it loaded the code;
 * the code cannot choose them. It forwards one call back to Opengeni, signed
 * on the Sites domain apex with the app and version in the signed path.
 */
export const AppServerHost = {
  async fetch(
    request: Request,
    env: GatewayEnv,
    ctx: { props?: Partial<AppServerHostProps> },
  ): Promise<Response> {
    const props = ctx.props ?? {};
    const refuse = (status: number, code: string, message: string) =>
      new Response(JSON.stringify({ error: { code, message } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (
      !props.siteId ||
      !props.versionId ||
      !UUID.test(props.siteId) ||
      !UUID.test(props.versionId)
    )
      return refuse(500, "misconfigured", "This server code has no app");
    if (request.method !== "POST") return refuse(405, "method_not_allowed", "Use POST");
    const token = request.headers.get(APP_SERVER_RUN_TOKEN_HEADER) ?? "";
    if (!token) return refuse(401, "unauthorized", "Missing run token");
    const body = await readBodyCapped(request, APP_SERVER_HOST_BODY_MAX_BYTES);
    if (body === "too_large") return refuse(413, "too_large", "The call is too large");
    let config: GatewayConfig;
    try {
      config = gatewayConfig(env);
    } catch {
      return refuse(500, "misconfigured", "The app gateway is not configured");
    }
    try {
      const response = await fetch(
        await signedApiRequest(
          config,
          { host: config.sitesDomain, session: "", visitor: "", clientIp: "", human: false },
          {
            method: "POST",
            suffix: appServerHostSuffix(props.siteId, props.versionId),
            body,
            headers: new Headers({
              "content-type": "application/json",
              [APP_SERVER_RUN_TOKEN_HEADER]: token,
            }),
          },
        ),
      );
      return new Response(response.body, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    } catch {
      return refuse(502, "unavailable", "Opengeni could not be reached. Try again shortly");
    }
  },
};
