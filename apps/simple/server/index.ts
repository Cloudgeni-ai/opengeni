import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repaintAvatars, resumeAvatarJobs, startAvatarJob } from "./avatars";
import {
  dataDirectory,
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
  getProfile,
  listProfiles,
  recordUsage,
  releaseBlock,
  setPrefs,
  settleBlock,
  upsertProfile,
  usageSummary,
} from "./db";
import { AVATAR_THEMES, avatarTheme, DEFAULT_AVATAR_THEME } from "./themes";
import {
  api,
  applyProfileUpdate,
  asCaller,
  createAgent,
  downloadImage,
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

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} is required`);
  return value.trim();
}

const bootstrapped = new Set<string>();

const config = () => ({
  fullAppUrl: opengeniWebUrl(),
  effortLevels: Object.keys(EFFORT_LEVELS),
  defaultEffort: DEFAULT_EFFORT,
  avatarThemes: AVATAR_THEMES.map(({ id, name, blurb }) => ({ id, name, blurb })),
  defaultAvatarTheme: DEFAULT_AVATAR_THEME,
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
    resumeAvatarJobs(workspaceId);
    void listAgentSessions(workspaceId)
      .then((sessions) => refreshAgentInstructions(workspaceId, sessions))
      .catch((error) => console.warn("Instruction refresh failed", error));
    const profile = getProfile(main.id);
    if (!profile?.avatarArtifactId && profile?.avatarStatus !== "pending") {
      void startAvatarJob(
        workspaceId,
        main.id,
        "a friendly glowing genie spark, warm violet and pink light, magical but minimal",
      );
    }
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
        emoji: typeof payload.emoji === "string" ? payload.emoji.slice(0, 16) : null,
        description:
          typeof payload.description === "string" ? payload.description.slice(0, 160) : null,
        instructions:
          typeof payload.instructions === "string" ? payload.instructions.slice(0, 8000) : null,
        firstMessage:
          typeof payload.firstMessage === "string" ? payload.firstMessage.slice(0, 8000) : null,
        shared: payload.shared === true,
        idempotencyKey: `simple-app:block:${input.key}`.slice(0, 200),
      });
      void startAvatarJob(
        input.workspaceId,
        session.id,
        typeof payload.avatarPrompt === "string" ? payload.avatarPrompt.slice(0, 600) : null,
      );
      const result = { sessionId: session.id, name };
      settleBlock(input.key, "applied", result);
    } else {
      const update = input.payload as ProfileUpdate;
      const before = getProfile(input.sourceSessionId);
      const profile = await applyProfileUpdate(input.workspaceId, input.sourceSessionId, update);
      const looksChanged =
        Boolean(update.avatarPrompt) ||
        (!before?.avatarArtifactId && before?.avatarStatus !== "pending") ||
        (update.name && update.name !== before?.name);
      if (looksChanged) {
        void startAvatarJob(input.workspaceId, input.sourceSessionId, profile.avatarPrompt);
      }
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

const avatarCache = join(dataDirectory, "avatars");
mkdirSync(avatarCache, { recursive: true });

/** Avatars are immutable artifacts, so each is downloaded once and kept on disk. */
async function avatar(sessionId: string) {
  const profile = getProfile(sessionId);
  if (!profile?.avatarArtifactId) return new Response(null, { status: 404 });
  const cached = join(avatarCache, `${profile.avatarArtifactId}.png`);
  if (!existsSync(cached)) {
    const image = await downloadImage(profile.workspaceId, profile.avatarArtifactId).catch(
      () => null,
    );
    if (!image) return new Response(null, { status: 404 });
    writeFileSync(cached, image.bytes);
  }
  return new Response(Bun.file(cached), {
    headers: {
      "content-type": "image/png",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const workspaceParam = url.searchParams.get("workspaceId");

  if (path === "/app/health") return json({ ok: true });
  if (path === "/app/bootstrap" && method === "GET") {
    return json(await bootstrap(requireString(workspaceParam, "workspaceId")));
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
    if (theme && !AVATAR_THEMES.some((entry) => entry.id === theme)) {
      throw new HttpError(400, "Unknown avatar style");
    }
    const before = avatarTheme(getPrefs(workspaceId).avatarTheme).id;
    const prefs = setPrefs(workspaceId, values);
    // One house style for every agent: switching it repaints them all.
    if (theme && theme !== before) repaintAvatars(workspaceId);
    return json(prefs);
  }
  if (path === "/app/agents" && method === "POST") {
    const input = await body<{
      workspaceId: string;
      shared?: boolean;
      requestId?: string;
    }>(request);
    const workspaceId = requireString(input.workspaceId, "workspaceId");
    const session = await createAgent({
      workspaceId,
      role: "agent",
      name: "New agent",
      emoji: "🌱",
      description: null,
      blank: true,
      shared: input.shared === true,
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
  if (path === "/app/avatars/retry" && method === "POST") {
    // A model that can paint just became available (e.g. ChatGPT connected).
    const input = await body<{ workspaceId: string }>(request);
    resumeAvatarJobs(requireString(input.workspaceId, "workspaceId"), {
      retryFailed: true,
    });
    return json({ ok: true });
  }
  const avatarMatch = /^\/app\/avatar\/([0-9a-f-]{36})$/.exec(path);
  if (avatarMatch && method === "GET") return await avatar(avatarMatch[1]!);

  const agentMatch = /^\/app\/agents\/([0-9a-f-]{36})\/(profile|avatar|usage)$/.exec(path);
  if (agentMatch && method !== "GET") {
    const sessionId = agentMatch[1]!;
    const input = await body<{
      workspaceId: string;
      kind?: string;
      effort?: string | null;
      emoji?: string | null;
      hint?: string | null;
    }>(request);
    const workspaceId = requireString(input.workspaceId, "workspaceId");
    if (agentMatch[2] === "usage") {
      recordUsage(workspaceId, sessionId, input.kind ?? "open");
      return json({ ok: true });
    }
    if (agentMatch[2] === "avatar") {
      void startAvatarJob(workspaceId, sessionId, input.hint ?? null);
      return json(upsertProfile(workspaceId, sessionId, { avatarStatus: "pending" }));
    }
    if (input.effort !== undefined && input.effort !== null && !(input.effort in EFFORT_LEVELS)) {
      throw new HttpError(400, "Unknown effort");
    }
    return json(
      upsertProfile(workspaceId, sessionId, {
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
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
