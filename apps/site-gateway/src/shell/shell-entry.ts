/**
 * Browser entry for the gateway shell page, bundled into
 * `shell-script.gen.ts` by `scripts/build-shell.ts`. Runs the shared bridge
 * host for the Site frame: allowed Site operations go to `/_og/api<suffix>`,
 * tool methods to `/_og/api/tools/<method>`, and `viewer`/`auth.signIn` are
 * answered here. Requests outside the allowlist never leave the page.
 */
import {
  SITE_GATEWAY_API_PREFIX,
  SITE_GATEWAY_LOGIN_PATH,
  matchSiteOperation,
  type SiteToolMethod,
  type SiteViewer,
} from "@opengeni/contracts";
import {
  SiteBridgeHost,
  type SiteBridgeToolHandlers,
  type SiteBridgeViewerHandlers,
  type SiteHttpRequest,
} from "@opengeni/sdk/site-bridge-host";
import {
  SITE_GATEWAY_HUMAN_PATH,
  SITE_HUMAN_CHECK_REQUIRED,
  type ShellConfig,
} from "./shell-config";

/** Site request headers the shell passes on; the gateway filters again. */
const FORWARD_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "idempotency-key",
  "if-match",
  "if-none-match",
  "last-event-id",
  "range",
]);

type TurnstileApi = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback"?: () => void;
    },
  ): string;
  remove(widgetId: string): void;
};

const nonce = document.currentScript?.nonce ?? "";
const config = readConfig();
let viewer: SiteViewer | null = config.viewer;
let humanCheck: Promise<void> | null = null;

function readConfig(): ShellConfig {
  try {
    const parsed = JSON.parse(document.getElementById("og-shell-config")?.textContent ?? "{}");
    return {
      viewer: parsed.viewer ?? null,
      turnstileSiteKey:
        typeof parsed.turnstileSiteKey === "string" ? parsed.turnstileSiteKey : null,
    };
  } catch {
    return { viewer: null, turnstileSiteKey: null };
  }
}

function gatewayError(status: number, body: unknown, mutating: boolean): Error {
  const envelope = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
  return Object.assign(
    new Error(
      typeof envelope.message === "string" ? envelope.message : `Site request failed (${status})`,
    ),
    {
      code: typeof envelope.code === "string" ? envelope.code : "site_request_failed",
      retryable: envelope.retryable === true,
      outcomeUnknown:
        envelope.outcomeUnknown === true || (mutating && status >= 502 && status <= 504),
      ...(envelope.details && typeof envelope.details === "object"
        ? { details: envelope.details }
        : {}),
    },
  );
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

/** Same-origin call to the gateway API; runs the optional human check once and retries. */
async function gatewayFetch(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  const request = (): Promise<Response> =>
    fetch(`${SITE_GATEWAY_API_PREFIX}${path}`, {
      ...init,
      signal,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  const response = await request();
  if (
    response.status === 403 &&
    config.turnstileSiteKey &&
    (await errorCode(response)) === SITE_HUMAN_CHECK_REQUIRED
  ) {
    await (humanCheck ??= runHumanCheck(config.turnstileSiteKey).finally(() => {
      humanCheck = null;
    }));
    return await request();
  }
  return response;
}

async function tool<T>(method: SiteToolMethod, payload: unknown, signal: AbortSignal): Promise<T> {
  const response = await gatewayFetch(
    `/tools/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload ?? {}),
    },
    signal,
  );
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw gatewayError(response.status, body, method === "call" || method === "invoke");
  return body as T;
}

function refused(): Response {
  return Response.json(
    {
      error: {
        status: 403,
        code: "site_operation_not_allowed",
        message: "This operation is not available to Sites",
        retryable: false,
        outcomeUnknown: false,
      },
    },
    { status: 403 },
  );
}

async function siteHttp(request: SiteHttpRequest, signal: AbortSignal): Promise<Response> {
  const url = new URL(request.path, "https://site.invalid");
  const match = matchSiteOperation(request.method, url.pathname);
  if (!match) return refused();
  const headers = new Headers();
  for (const [name, value] of request.headers)
    if (FORWARD_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  const method = request.method.toUpperCase();
  return await gatewayFetch(
    `${match.suffix}${url.search}`,
    {
      method,
      headers,
      ...(method !== "GET" && method !== "HEAD" && request.body !== undefined
        ? { body: request.body }
        : {}),
    },
    signal,
  );
}

async function currentViewer(signal: AbortSignal): Promise<SiteViewer> {
  if (viewer) return viewer;
  const response = await gatewayFetch(
    "/site/config",
    { method: "GET", headers: { accept: "application/json" } },
    signal,
  );
  const body = (await response.json().catch(() => null)) as { viewer?: SiteViewer } | null;
  if (!response.ok || !body?.viewer) throw gatewayError(response.status, body, false);
  viewer = body.viewer;
  return viewer;
}

const tools: SiteBridgeToolHandlers = {
  catalog: ({ signal }) => tool("catalog", {}, signal),
  declarations: ({ signal }) => tool("declarations", {}, signal),
  call: (request, { signal }) => tool("call", request, signal),
  resolve: (request, { signal }) => tool("resolve", request, signal),
  invoke: (request, { signal }) => tool("invoke", request, signal),
  fetch: siteHttp,
  siteData: true,
};

const viewerHandlers: SiteBridgeViewerHandlers = {
  viewer: ({ signal }) => currentViewer(signal),
  signIn: async ({ signal }) => {
    const known = await currentViewer(signal).catch(() => null);
    if (known?.signedIn) return { started: false };
    const back = `${location.pathname}${location.search}`;
    location.assign(`${SITE_GATEWAY_LOGIN_PATH}?return=${encodeURIComponent(back)}`);
    return { started: true };
  },
};

function loadTurnstile(): Promise<TurnstileApi> {
  const existing = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.nonce = nonce;
    script.onload = () => {
      const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (api) resolve(api);
      else reject(new Error("Human check unavailable"));
    };
    script.onerror = () => reject(new Error("Human check unavailable"));
    document.head.append(script);
  });
}

async function runHumanCheck(siteKey: string): Promise<void> {
  const overlay = document.getElementById("og-human");
  const container = document.getElementById("og-human-widget");
  if (!overlay || !container) throw new Error("Human check unavailable");
  const turnstile = await loadTurnstile();
  overlay.hidden = false;
  let widget = "";
  try {
    const token = await new Promise<string>((resolve, reject) => {
      widget = turnstile.render(container, {
        sitekey: siteKey,
        callback: resolve,
        "error-callback": () => reject(new Error("Human check failed")),
        "expired-callback": () => reject(new Error("Human check expired")),
      });
    });
    const response = await fetch(SITE_GATEWAY_HUMAN_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Human check failed");
  } finally {
    if (widget) turnstile.remove(widget);
    overlay.hidden = true;
  }
}

const frame = document.getElementById("og-site") as HTMLIFrameElement | null;
if (frame) {
  const host = new SiteBridgeHost({ tools: () => tools, viewer: () => viewerHandlers });
  frame.addEventListener("load", () => {
    const frameWindow = frame.contentWindow;
    if (frameWindow) host.load(frameWindow);
  });
  window.addEventListener("pagehide", () => host.close());
}
