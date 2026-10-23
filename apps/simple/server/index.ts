import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  opengeniApiKey,
  opengeniApiUrl,
  opengeniWebUrl,
  SIMPLE_SERVER_PORT,
  SIMPLE_WEB_PORT,
} from "./config";
import {
  claimBlock,
  getAppliedBlock,
  getPrefs,
  listProfiles,
  recordUsage,
  releaseBlock,
  setPrefs,
  settleBlock,
  upsertProfile,
  usageSummary,
} from "./db";
import { isAgentIcon } from "../src/lib/agent-icons";
import { AVATAR_STYLES, DEFAULT_AVATAR_STYLE } from "../src/lib/avatar-styles";
import {
  api,
  applyProfileUpdate,
  asCaller,
  createAgent,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  ensureMainAgent,
  listAgentSessions,
  refreshAgentInstructions,
  type ProfileUpdate,
} from "./opengeni";

const serveDist = process.argv.includes("--serve-dist");
const distDirectory = resolve(
  process.env.OPENGENI_SIMPLE_DIST_DIR ?? join(import.meta.dirname, "../dist"),
);
const apiUrl = opengeniApiUrl();
const apiKey = opengeniApiKey();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
}

/**
 * Where a provider sign-in lands. The Mac app opens sign-in in the person's
 * browser (Google refuses embedded windows), so the browser tab ends here with
 * a note to go back; the app itself sees the connection through polling.
 */
function connectedPage() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected</title><style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#fafaf9;--muted:#a8a29e}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:16px}
.check{width:56px;height:56px;border-radius:50%;background:#10b981;color:#fff;display:grid;place-items:center;font-size:28px;margin:0 auto 16px}
h1{font-size:20px;margin:0 0 4px}p{margin:0;color:var(--muted)}</style></head>
<body><main><div class="check">&#10003;</div><h1>You're connected</h1><p>You can close this tab and go back to Opengeni.</p></main>
<script>setTimeout(function(){window.close()},1500)</script></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} is required`);
  return value.trim();
}

const bootstrapped = new Set<string>();

const config = () => ({
  fullAppUrl: opengeniWebUrl(),
  effortLevels: Object.keys(EFFORT_LEVELS),
  defaultEffort: DEFAULT_EFFORT,
  avatarThemes: AVATAR_STYLES,
  defaultAvatarTheme: DEFAULT_AVATAR_STYLE,
});

/** Opengeni refuses new chats until some model can run them. */
function isNoModelError(error: unknown) {
  return (
    error instanceof Error &&
    /model is not selectable|no model|model.*not (available|configured)/i.test(error.message)
  );
}

async function bootstrap(workspaceId: string) {
  let main;
  try {
    main = await ensureMainAgent(workspaceId);
  } catch (error) {
    if (!isNoModelError(error)) throw error;
    return {
      mainSessionId: null,
      needsModel: true,
      ...state(workspaceId),
      config: config(),
    };
  }
  if (!bootstrapped.has(workspaceId)) {
    bootstrapped.add(workspaceId);
    void listAgentSessions(workspaceId)
      .then((sessions) => refreshAgentInstructions(workspaceId, sessions))
      .catch((error) => console.warn("Instruction refresh failed", error));
  }
  return {
    mainSessionId: main.id,
    needsModel: false,
    ...state(workspaceId),
    config: config(),
  };
}

function state(workspaceId: string) {
  return {
    profiles: listProfiles(workspaceId),
    usage: usageSummary(workspaceId),
    prefs: getPrefs(workspaceId),
  };
}

type BlockRequest = {
  workspaceId: string;
  key: string;
  kind: "agent" | "profile";
  sourceSessionId: string;
  payload: Record<string, unknown>;
};

async function applyBlock(input: BlockRequest) {
  const existing = getAppliedBlock(input.key);
  if (existing) return existing;
  if (!claimBlock(input.key, input.workspaceId, input.kind)) return getAppliedBlock(input.key);
  try {
    if (input.kind === "agent") {
      const payload = input.payload;
      const name = requireString(payload.name, "name").slice(0, 40);
      const session = await createAgent({
        workspaceId: input.workspaceId,
        role: "agent",
        name,
        icon: isAgentIcon(payload.icon) ? payload.icon : null,
        description:
          typeof payload.description === "string" ? payload.description.slice(0, 160) : null,
        instructions:
          typeof payload.instructions === "string" ? payload.instructions.slice(0, 8000) : null,
        firstMessage:
          typeof payload.firstMessage === "string" ? payload.firstMessage.slice(0, 8000) : null,
        shared: payload.shared === true,
        idempotencyKey: `simple-app:block:${input.key}`.slice(0, 200),
      });
      const result = { sessionId: session.id, name };
      settleBlock(input.key, "applied", result);
    } else {
      const update = input.payload as ProfileUpdate;
      const profile = await applyProfileUpdate(input.workspaceId, input.sourceSessionId, update);
      settleBlock(input.key, "applied", {
        sessionId: input.sourceSessionId,
        name: profile.name,
      });
    }
  } catch (error) {
    console.warn("Applying a block failed", error);
    releaseBlock(input.key);
    throw new HttpError(502, error instanceof Error ? error.message : String(error));
  }
  return getAppliedBlock(input.key);
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const workspaceParam = url.searchParams.get("workspaceId");

  if (path === "/app/health") return json({ ok: true });
  if (path === "/app/connected" && method === "GET") return connectedPage();
  if (path === "/app/bootstrap" && method === "GET") {
    return json(await bootstrap(requireString(workspaceParam, "workspaceId")));
  }
  if (path === "/app/agents" && method === "GET") {
    return json(await listAgentSessions(requireString(workspaceParam, "workspaceId")));
  }
  if (path === "/app/state" && method === "GET") {
    return json(state(requireString(workspaceParam, "workspaceId")));
  }
  if (path === "/app/prefs" && method === "PUT") {
    const input = await body<{
      workspaceId: string;
      values: Record<string, string | null>;
    }>(request);
    const workspaceId = requireString(input.workspaceId, "workspaceId");
    const values = input.values ?? {};
    const theme = values.avatarTheme;
    if (theme && !AVATAR_STYLES.some((entry) => entry.id === theme)) {
      throw new HttpError(400, "Unknown avatar style");
    }
    // Styles are colors the app fills in, so switching one repaints nothing.
    return json(setPrefs(workspaceId, values));
  }
  if (path === "/app/agents" && method === "POST") {
    const input = await body<{
      workspaceId: string;
      shared?: boolean;
      requestId?: string;
      firstMessage?: string;
      modelContext?: string;
    }>(request);
    const workspaceId = requireString(input.workspaceId, "workspaceId");
    // A new agent exists only once someone tells it what to do.
    const firstMessage = requireString(input.firstMessage?.trim(), "firstMessage");
    const session = await createAgent({
      workspaceId,
      role: "agent",
      name: "New agent",
      description: null,
      blank: true,
      shared: input.shared === true,
      firstMessage,
      modelContext: input.modelContext ?? null,
      idempotencyKey: `simple-app:new:${input.requestId ?? crypto.randomUUID()}`,
    });
    return json({ sessionId: session.id });
  }
  if (path === "/app/blocks/apply" && method === "POST") {
    const input = await body<BlockRequest>(request);
    requireString(input.workspaceId, "workspaceId");
    requireString(input.key, "key");
    requireString(input.sourceSessionId, "sourceSessionId");
    if (input.kind !== "agent" && input.kind !== "profile")
      throw new HttpError(400, "Unknown block");
    return json(await applyBlock(input));
  }
  const blockMatch = /^\/app\/blocks\/([^/]+)$/.exec(path);
  if (blockMatch && method === "GET") {
    return json(getAppliedBlock(decodeURIComponent(blockMatch[1]!)));
  }
  const agentMatch = /^\/app\/agents\/([0-9a-f-]{36})\/(profile|usage)$/.exec(path);
  if (agentMatch && method !== "GET") {
    const sessionId = agentMatch[1]!;
    const input = await body<{
      workspaceId: string;
      kind?: string;
      effort?: string | null;
      icon?: string | null;
    }>(request);
    const workspaceId = requireString(input.workspaceId, "workspaceId");
    if (agentMatch[2] === "usage") {
      recordUsage(workspaceId, sessionId, input.kind ?? "open");
      return json({ ok: true });
    }
    if (input.effort !== undefined && input.effort !== null && !(input.effort in EFFORT_LEVELS)) {
      throw new HttpError(400, "Unknown effort");
    }
    return json(
      upsertProfile(workspaceId, sessionId, {
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.icon === null || isAgentIcon(input.icon) ? { icon: input.icon } : {}),
      }),
    );
  }
  throw new HttpError(404, "Not found");
}

async function proxyToApi(request: Request, url: URL) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  if (apiKey) {
    headers.delete("cookie");
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  const upstream = await fetch(`${apiUrl}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
    // @ts-expect-error Bun streams request bodies with this flag.
    duplex: "half",
  });
  // fetch has already decoded the body, so its encoding and length no longer apply.
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

function staticFile(pathname: string) {
  const candidate = join(distDirectory, pathname === "/" ? "index.html" : pathname);
  if (candidate.startsWith(distDirectory) && existsSync(candidate) && !candidate.endsWith("/")) {
    const file = Bun.file(candidate);
    if (file.size > 0) return new Response(file);
  }
  return new Response(Bun.file(join(distDirectory, "index.html")));
}

const port = serveDist ? SIMPLE_WEB_PORT : SIMPLE_SERVER_PORT;
Bun.serve({
  port,
  hostname: process.env.OPENGENI_SIMPLE_HOST ?? (serveDist ? "0.0.0.0" : "127.0.0.1"),
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/app/")) return await asCaller(request, () => route(request));
      if (serveDist && url.pathname.startsWith("/v1/")) return await proxyToApi(request, url);
      if (serveDist) return staticFile(url.pathname);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: error instanceof Error ? error.message : "Internal error" }, 500);
    }
  },
});
console.log(`Opengeni simple ${serveDist ? "app" : "companion server"} on :${port} -> ${apiUrl}`);
void api;
