/**
 * Browser entry for the gateway shell page, bundled into
 * `shell-script.gen.ts` by `scripts/build-shell.ts`. Runs the shared bridge
 * host for the Site frame: allowed Site operations go to `/_og/api<suffix>`,
 * tool methods to `/_og/api/tools/<method>`, and `viewer`/`auth.signIn` and
 * `location`/`location.navigate` are answered here. The Site's location is
 * this page's own address: navigation adds history entries to this page (the
 * Site frame never reloads), and Back/Forward are passed on to the Site.
 * Requests outside the allowlist never leave the page.
 *
 * It shows the platform's connect card (`#og-connect`) to signed-in
 * workspace members who still have to connect a tool the App declares: each
 * button opens the App in Opengeni with that connect dialog open, since this
 * page has no Opengeni frame. It answers the App's `site.connections.*`.
 *
 * Above it, a card (`#og-syncs`) lists the App's personal syncs the member
 * hasn't joined. Joining, from there or from the App's
 * `site.data.syncs.optIn(id)`, opens this page's own confirmation
 * (`#og-sync-confirm`) naming the tool, account and collection; only this
 * page posts the opt-in, after the member confirms.
 *
 * It also keeps one live connection (`/_og/live`) and passes its data hints
 * to the Site as `data_changed` events, and sends small batched speed
 * beacons (`/_og/timing`): app load, first data and each bridge call.
 */
import {
  SITE_GATEWAY_API_PREFIX,
  SITE_GATEWAY_LIVE_PATH,
  SITE_GATEWAY_LOGIN_PATH,
  SITE_GATEWAY_TIMING_PATH,
  matchSiteOperation,
  type SiteLiveHint,
  type SiteTimingBeacon,
  type SiteToolMethod,
  type SiteViewer,
} from "@opengeni/contracts";
import {
  SiteBridgeHost,
  siteConnectCardDismissals,
  siteConnectCardItemActionable,
  siteConnectCardLabel,
  type OpenGeniSiteDataChange,
  openGeniSiteLocationHref,
  openGeniSitePath,
  type OpenGeniSiteLocationValue,
  type SiteBridgeLocationHandlers,
  type SiteBridgeToolHandlers,
  type SiteBridgeViewerHandlers,
  type SiteHttpRequest,
} from "@opengeni/sdk/site-bridge-host";
import type {
  AppSyncOptInReview,
  AppSyncStatusResponse,
  ToolGatewaySiteSetupItem,
  ToolGatewaySiteSetupResponse,
} from "@opengeni/sdk";
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
      typeof envelope.message === "string" ? envelope.message : `App request failed (${status})`,
    ),
    {
      code: typeof envelope.code === "string" ? envelope.code : "site_request_failed",
      retryable: envelope.retryable === true,
      // A gateway status without the API's own answer may follow a dispatch;
      // the API's explicit `outcomeUnknown: false` (nothing was sent) stands.
      outcomeUnknown:
        envelope.outcomeUnknown === true ||
        (mutating && status >= 502 && status <= 504 && envelope.outcomeUnknown !== false),
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

type Timing = SiteTimingBeacon["timings"][number];

/** Measurements waiting for the next beacon; bounded, oldest dropped. */
const timings: Timing[] = [];
const MAX_PENDING_TIMINGS = 50;
const TIMING_FLUSH_MS = 30_000;
let firstDataSeen = false;
/** The live connection, started when the Site first follows data changes. */
let live: { start(): void } | null = null;
let timingTimer: ReturnType<typeof setTimeout> | null = null;

function measure(timing: Timing): void {
  if (!Number.isFinite(timing.ms) || timing.ms < 0) return;
  if (timings.length >= MAX_PENDING_TIMINGS) timings.shift();
  timings.push({ ...timing, ms: Math.min(Math.round(timing.ms), 600_000) });
  timingTimer ??= setTimeout(flushTimings, TIMING_FLUSH_MS);
}

/** Time one bridge call; the first data or SQL call also counts as first data. */
async function timed<T>(op: string, data: boolean, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  let outcome: "ok" | "error" = "error";
  try {
    const result = await run();
    if (!(result instanceof Response) || result.ok) outcome = "ok";
    return result;
  } finally {
    const ended = performance.now();
    measure({ kind: "bridge", op, ms: ended - started, outcome });
    if (data && !firstDataSeen) {
      firstDataSeen = true;
      measure({ kind: "first_data", ms: ended, outcome });
    }
  }
}

/** Send what was measured; best effort, never retried. */
function flushTimings(): void {
  if (timingTimer) clearTimeout(timingTimer);
  timingTimer = null;
  if (timings.length === 0) return;
  const body = JSON.stringify({ timings: timings.splice(0) } satisfies SiteTimingBeacon);
  try {
    if (navigator.sendBeacon?.(SITE_GATEWAY_TIMING_PATH, body)) return;
  } catch {
    // Fall through to fetch.
  }
  void fetch(SITE_GATEWAY_TIMING_PATH, {
    method: "POST",
    body,
    credentials: "same-origin",
    keepalive: true,
  }).catch(() => undefined);
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
        message: "This operation is not available to apps",
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

function timedTool<T>(method: SiteToolMethod, payload: unknown, signal: AbortSignal): Promise<T> {
  return timed(method, false, () => tool<T>(method, payload, signal));
}

function timedSiteHttp(request: SiteHttpRequest, signal: AbortSignal): Promise<Response> {
  const match = matchSiteOperation(
    request.method,
    new URL(request.path, "https://site.invalid").pathname,
  );
  const op = match?.operation.id ?? "other";
  return timed(op, op.startsWith("data.") || op.startsWith("sql."), () =>
    siteHttp(request, signal),
  );
}

/**
 * The connect card: what this member still has to connect for the App's
 * declared tools, one button each (opening the App in Opengeni), and a close
 * button that hides those items on this address until something new is
 * missing. Nothing for guests and people outside the workspace: the API
 * answers them with a refusal, and the card stays empty.
 */
function createConnectCard(onReturn: () => void) {
  const dismissals = siteConnectCardDismissals(location.host);
  let items: ToolGatewaySiteSetupItem[] | null = null;
  let loading: Promise<ToolGatewaySiteSetupItem[] | null> | null = null;
  let forced = false;
  let awaitingReturn = false;
  const load = (signal?: AbortSignal): Promise<ToolGatewaySiteSetupItem[] | null> =>
    (loading ??= (async () => {
      try {
        const known = await currentViewer(signal ?? new AbortController().signal).catch(() => null);
        if (known && known.kind !== "member") return (items = null);
        const response = await timedTool<ToolGatewaySiteSetupResponse>(
          "setup",
          {},
          signal ?? new AbortController().signal,
        );
        // Items this page can act on (each opens the App in Opengeni), and
        // shared keys only a workspace admin can add, shown as plain text.
        items = response.items.filter(
          (item) => typeof item.openUrl === "string" || !siteConnectCardItemActionable(item),
        );
      } catch {
        items = null;
      }
      return items;
    })().finally(() => {
      loading = null;
    }));
  const render = () => {
    document.getElementById("og-connect")?.remove();
    const visible = items ? (forced ? items : dismissals.visible(items)) : [];
    if (visible.length === 0) return false;
    const card = document.createElement("div");
    card.id = "og-connect";
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", "Connect tools for this app");
    const list = document.createElement("div");
    for (const item of visible) {
      if (!siteConnectCardItemActionable(item)) {
        const note = document.createElement("span");
        note.className = "og-connect-note";
        note.textContent = siteConnectCardLabel(item);
        list.append(note);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = siteConnectCardLabel(item);
      if (item.account) button.title = item.account;
      button.addEventListener("click", () => {
        open(item);
      });
      list.append(button);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "og-connect-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\u00d7";
    close.addEventListener("click", () => {
      dismissals.dismiss(visible.map((item) => item.key));
      forced = false;
      render();
    });
    card.append(list, close);
    document.body.append(card);
    return true;
  };
  const open = (item: ToolGatewaySiteSetupItem): boolean => {
    if (!item.openUrl) return false;
    awaitingReturn = true;
    window.open(item.openUrl, "_blank", "noopener");
    return true;
  };
  // Back from connecting in Opengeni: read again and tell the App.
  const back = () => {
    if (!awaitingReturn || document.visibilityState === "hidden") return;
    awaitingReturn = false;
    void load().then(() => {
      render();
      onReturn();
    });
  };
  window.addEventListener("focus", back);
  document.addEventListener("visibilitychange", back);
  return {
    start: () => void load().then(render),
    handlers: {
      items: ({ signal }) => (items && !loading ? Promise.resolve(items) : load(signal)),
      // Opengeni finishes the connect in its own tab; the App hears the change on return.
      connect: async (item) => {
        open(item);
        return false;
      },
      show: async ({ signal }) => {
        dismissals.reset();
        forced = true;
        await load(signal);
        return render();
      },
    } satisfies NonNullable<SiteBridgeToolHandlers["connections"]>,
  };
}

/**
 * Personal syncs: the join card and the confirmation. The confirmation is
 * this page's own DOM, outside the App's frame, so the App can ask but never
 * opt the member in by itself. Leaving needs no confirmation.
 */
function createSyncOptIn() {
  const dismissals = siteConnectCardDismissals(`${location.host}:syncs`);
  let joinable: { key: string; id: string; name: string }[] = [];
  let pending: { resolve: (optedIn: boolean) => void } | null = null;
  const load = async (): Promise<void> => {
    try {
      const known = await currentViewer(new AbortController().signal).catch(() => null);
      if (!known || known.kind !== "member") {
        joinable = [];
        return;
      }
      const response = await gatewayFetch(
        "/published-artifacts/current/data/syncs",
        { method: "GET", headers: { accept: "application/json" } },
        new AbortController().signal,
      );
      const body = (await response.json().catch(() => null)) as AppSyncStatusResponse | null;
      joinable =
        response.ok && Array.isArray(body?.syncs)
          ? body.syncs
              .filter((sync) => sync.mode === "personal" && sync.active && sync.optedIn === false)
              .map((sync) => ({ key: `sync:${sync.id}`, id: sync.id, name: sync.name }))
          : [];
    } catch {
      joinable = [];
    }
  };
  const render = () => {
    document.getElementById("og-syncs")?.remove();
    const visible = dismissals.visible(joinable);
    if (visible.length === 0) return;
    const card = document.createElement("div");
    card.id = "og-syncs";
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", "Personal syncs for this app");
    const list = document.createElement("div");
    for (const sync of visible) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Join ${sync.name}`;
      button.addEventListener("click", () => void confirm(sync.id, new AbortController().signal));
      list.append(button);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "og-connect-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\u00d7";
    close.addEventListener("click", () => {
      dismissals.dismiss(visible.map((sync) => sync.key));
      render();
    });
    card.append(list, close);
    // Stack above the connect card when both show.
    const connect = document.getElementById("og-connect");
    if (connect) card.style.bottom = `${32 + connect.offsetHeight + 8}px`;
    document.body.append(card);
  };
  const refresh = () => void load().then(render);
  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const show = (review: AppSyncOptInReview): Promise<boolean> =>
    new Promise((resolve) => {
      pending?.resolve(false);
      document.getElementById("og-sync-confirm")?.remove();
      const overlay = element("div");
      overlay.id = "og-sync-confirm";
      const dialog = element("div");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "og-sync-confirm-title");
      const title = element("h2", `Join ${review.name}?`);
      title.id = "og-sync-confirm-title";
      const connector = review.tool.connector;
      const text = element(
        "p",
        `It reads ${review.tool.toolName}${connector ? ` from your ${connector} account` : ""} and fills your own records in ${review.collection}.`,
      );
      dialog.append(title, text);
      let select: HTMLSelectElement | null = null;
      if (review.accounts.length > 1) {
        const label = element("label", "Account");
        select = element("select");
        for (const choice of review.accounts) {
          const option = element("option", choice.label);
          option.value = choice.id;
          if (choice.id === review.account) option.selected = true;
          select.append(option);
        }
        label.append(select);
        dialog.append(label);
      } else if (review.accounts[0]) {
        dialog.append(element("p", `Account: ${review.accounts[0].label}`));
      }
      const note = element("p", review.blocked ?? "");
      note.className = "og-sync-note";
      note.setAttribute("role", "alert");
      const actions = element("div");
      actions.className = "og-sync-actions";
      const cancel = element("button", "Cancel");
      cancel.type = "button";
      const join = element("button", "Join");
      join.type = "button";
      join.className = "og-sync-join";
      join.disabled = review.blocked !== null;
      actions.append(cancel, join);
      dialog.append(note, actions);
      overlay.append(dialog);
      const done = (optedIn: boolean) => {
        if (pending !== entry) return;
        pending = null;
        overlay.remove();
        resolve(optedIn);
      };
      const entry = { resolve: done };
      pending = entry;
      cancel.addEventListener("click", () => done(false));
      overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") done(false);
      });
      join.addEventListener("click", () => {
        join.disabled = true;
        cancel.disabled = true;
        const account = select?.value ?? review.accounts[0]?.id;
        timedTool(
          "sync-opt-in",
          { syncId: review.syncId, optedIn: true, ...(account ? { account } : {}) },
          new AbortController().signal,
        ).then(
          () => done(true),
          (error: unknown) => {
            note.textContent = error instanceof Error ? error.message : "Couldn't join this sync.";
            join.disabled = false;
            cancel.disabled = false;
          },
        );
      });
      document.body.append(overlay);
      (join.disabled ? cancel : join).focus();
    });
  const confirm = async (syncId: string, signal: AbortSignal): Promise<boolean> => {
    const review = await timedTool<AppSyncOptInReview>("sync-review", { syncId }, signal);
    if (review.optedIn) return true;
    const optedIn = await show(review);
    if (optedIn) refresh();
    return optedIn;
  };
  return {
    start: refresh,
    refresh,
    handlers: {
      optIn: async ({ syncId, optedIn }, { signal }) => {
        if (!optedIn) {
          await timedTool("sync-opt-in", { syncId, optedIn: false }, signal);
          refresh();
          return { optedIn: false };
        }
        return { optedIn: await confirm(syncId, signal) };
      },
    } satisfies NonNullable<SiteBridgeToolHandlers["syncs"]>,
  };
}

let notifyConnectionsChanged = () => {};
const syncOptIn = createSyncOptIn();
const connectCard = createConnectCard(() => {
  notifyConnectionsChanged();
  syncOptIn.refresh();
});

const tools: SiteBridgeToolHandlers = {
  catalog: ({ signal }) => timedTool("catalog", {}, signal),
  declarations: ({ signal }) => timedTool("declarations", {}, signal),
  call: (request, { signal }) => timedTool("call", request, signal),
  resolve: (request, { signal }) => timedTool("resolve", request, signal),
  invoke: (request, { signal }) => timedTool("invoke", request, signal),
  readiness: (request, { signal }) => timedTool("readiness", request, signal),
  fetch: timedSiteHttp,
  siteData: true,
  dataChanges: true,
  // Only Sites that follow data changes open the live connection.
  watchDataChanges: () => live?.start(),
  connections: connectCard.handlers,
  syncs: syncOptIn.handlers,
};

/**
 * One live connection for data hints, opened once the Site follows data
 * changes (`site.data.onChange`; pages that never do cost nothing) and
 * closed while the page is hidden. Reconnects with backoff (also when the gateway has no live
 * updates: the Site then just never hears a hint), and before its admission
 * ends. After a reconnect that missed changes, the Site hears "anything may
 * have changed".
 */
function createLive(notify: (change: OpenGeniSiteDataChange) => void): { start(): void } {
  let wanted = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let hiding: ReturnType<typeof setTimeout> | null = null;
  let lastSeq: number | null = null;
  let failures = 0;
  const visible = () => document.visibilityState !== "hidden";
  const later = (ms: number) => {
    if (retry) clearTimeout(retry);
    retry = setTimeout(
      () => {
        retry = null;
        open();
      },
      ms * (0.75 + Math.random() * 0.5),
    );
  };
  const open = () => {
    if (!wanted || socket || !visible() || typeof WebSocket !== "function") return;
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${SITE_GATEWAY_LIVE_PATH}`;
    let current: WebSocket;
    try {
      current = new WebSocket(url);
    } catch {
      return;
    }
    socket = current;
    let admitted = false;
    let planned = false;
    let refresh: ReturnType<typeof setTimeout> | null = null;
    current.addEventListener("message", (event) => {
      let hint: SiteLiveHint;
      try {
        hint = JSON.parse(String(event.data)) as SiteLiveHint;
      } catch {
        return;
      }
      if (hint.type === "hello") {
        admitted = true;
        failures = 0;
        if (lastSeq !== null && hint.seq > lastSeq) notify({ collections: null, seq: hint.seq });
        lastSeq = Math.max(lastSeq ?? 0, hint.seq);
        // Reconnect shortly before the admission ends.
        if (refresh) clearTimeout(refresh);
        refresh = setTimeout(
          () => {
            planned = true;
            current.close(1000);
          },
          Math.max(30, hint.ttlSeconds - 30) * 1000,
        );
      } else if (hint.type === "data") {
        // Notices can arrive out of order: always pass them on.
        lastSeq = Math.max(lastSeq ?? 0, hint.seq);
        notify({ collections: hint.collections, seq: hint.seq });
      }
    });
    current.addEventListener("close", () => {
      if (refresh) clearTimeout(refresh);
      if (socket === current) socket = null;
      if (!wanted || !visible()) return;
      if (!admitted) failures += 1;
      // Live hints are off in this deployment: stop asking until a reload.
      if (failures >= 5) {
        wanted = false;
        return;
      }
      // A planned refresh comes back at once; a dropped connection (a
      // gateway deploy drops them all) spreads its return over 30 seconds; a
      // refused or missing live route backs off.
      later(planned ? 1_000 : admitted ? 1_000 + Math.random() * 29_000 : 5_000 * 2 ** failures);
    });
  };
  document.addEventListener("visibilitychange", () => {
    if (visible()) {
      if (hiding) clearTimeout(hiding);
      hiding = null;
      if (!retry) open();
      return;
    }
    // A briefly hidden tab keeps its connection; a page left in the background lets it go.
    hiding ??= setTimeout(() => {
      hiding = null;
      const current = socket;
      socket = null;
      current?.close(1000);
    }, 30_000);
  });
  return {
    start: () => {
      if (wanted) return;
      wanted = true;
      open();
    },
  };
}

const viewerHandlers: SiteBridgeViewerHandlers = {
  viewer: ({ signal }) => currentViewer(signal),
  signIn: async ({ signal }) => {
    const known = await currentViewer(signal).catch(() => null);
    if (known?.signedIn) return { started: false };
    const back = `${location.pathname}${location.search}${location.hash}`;
    location.assign(`${SITE_GATEWAY_LOGIN_PATH}?return=${encodeURIComponent(back)}`);
    return { started: true };
  },
};

/** This page's address as the Site's location; `//x` reads as `/x`, never as another origin. */
function pageLocation(): OpenGeniSiteLocationValue {
  return {
    path: openGeniSitePath(location.pathname || "/"),
    search: location.search,
    hash: location.hash,
  };
}

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
  const locationHandlers: SiteBridgeLocationHandlers = {
    get: pageLocation,
    origin: location.origin,
    // The bridge has already refused other origins and /_og addresses.
    navigate: (to, { replace }) => {
      const href = openGeniSiteLocationHref(to);
      if (replace) history.replaceState(history.state, "", href);
      else history.pushState(null, "", href);
      const now = pageLocation();
      host.notifyLocation(now);
      return now;
    },
  };
  const host = new SiteBridgeHost({
    tools: () => tools,
    viewer: () => viewerHandlers,
    location: () => locationHandlers,
  });
  frame.addEventListener("load", () => {
    const frameWindow = frame.contentWindow;
    if (frameWindow) host.load(frameWindow);
    measure({ kind: "app_load", ms: performance.now(), outcome: "ok" });
  });
  // Back/Forward and edits to the #hash in the address bar.
  window.addEventListener("popstate", () => host.notifyLocation(pageLocation()));
  window.addEventListener("pagehide", () => {
    flushTimings();
    host.close();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushTimings();
  });
  live = createLive((change) => host.notifyDataChanged(change));
  notifyConnectionsChanged = () => host.notifyToolReadiness();
  connectCard.start();
  syncOptIn.start();
}
