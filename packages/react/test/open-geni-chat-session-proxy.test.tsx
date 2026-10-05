// Regression: the stock `<OpenGeniChat baseUrl>` against the real
// `createSessionProxyHandler`, a real server `OpenGeniClient`, and a recording
// fake upstream. Every browser request goes through the proxy's allowlist, so a
// stock control that the default proxy cannot serve shows up here as a 404.
import { afterEach, describe, expect, test } from "bun:test";
import {
  OpenGeniClient,
  createSessionProxyHandler,
  type SessionProxyHandlerOptions,
} from "@opengeni/sdk";
import { OpenGeniChat, type OpenGeniChatProps } from "../src/components/open-geni-chat";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const WS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const S = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000009";
const TURN = "bbbbbbbb-0000-4000-8000-000000000001";
const IMG = "cccccccc-0000-4000-8000-000000000002";
const PUB = "cccccccc-0000-4000-8000-000000000003";
const SHOT = "cccccccc-0000-4000-8000-000000000004";
const VID = "cccccccc-0000-4000-8000-000000000005";
const VIDEO_OP = "ffffffff-0000-4000-8000-000000000001";
const SITE = "99999999-0000-4000-8000-000000000001";
const API = "https://api.test";
const PRODUCT = "https://product.test";
const BASE = "/api/opengeni";
const now = new Date().toISOString();

const PUB_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
const SHOT_BYTES = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
const PUB_SHA = await sha256(PUB_BYTES);
const SHOT_SHA = await sha256(SHOT_BYTES);

function retained(
  artifactId: string,
  kind: string,
  contentType: string,
  bytes: number,
  sha: string,
  path = `/v1/workspaces/${WS}/artifacts/${artifactId}/content`,
) {
  return {
    available: true,
    artifactId,
    kind,
    contentType,
    originalBytes: bytes,
    sha256: sha,
    retainedAt: now,
    ...(kind === "file" ? {} : { dimensions: { width: 64, height: 64 } }),
    retention: { policy: "workspace_file", expiresAt: null },
    retrieval: { method: "GET", path, acceptRanges: "bytes", maxRangeBytes: 1024 * 1024 },
  };
}

const screenshot = {
  ...retained(
    SHOT,
    "browser_screenshot",
    "image/jpeg",
    SHOT_BYTES.byteLength,
    SHOT_SHA,
    `/v1/workspaces/${WS}/sessions/${S}/artifacts/${SHOT}/content`,
  ),
  retention: { policy: "session_screenshot", expiresAt: "2099-01-01T00:00:00.000Z" },
};

type Event = { type: string; payload: unknown; turnId: string | null };

function conversation(): Event[] {
  const list: Event[] = [];
  const push = (type: string, payload: unknown, turnId: string | null = TURN) =>
    list.push({ type, payload, turnId });
  push("session.created", {}, null);
  push("user.message", { text: "Make an image, a screenshot, a video and a report" });
  push("turn.started", {});
  push("agent.toolCall.created", {
    id: "call-image",
    name: "generate_image",
    arguments: { prompt: "teal sphere" },
  });
  push("agent.toolCall.output", {
    id: "call-image",
    output: {
      type: "generated_image",
      artifact: retained(IMG, "generated_image", "image/png", 1024, "c".repeat(64)),
      sandboxPath: `/workspace/generated-images/generated-image-${IMG}.png`,
    },
  });
  push("agent.toolCall.created", {
    id: "call-publish",
    name: "opengeni__sandbox_file_publish",
    arguments: { path: "/workspace/report.png" },
  });
  push("agent.toolCall.output", {
    id: "call-publish",
    output: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            type: "sandbox_file",
            sandboxPath: "/workspace/report.png",
            filename: "report.png",
            artifact: retained(PUB, "file", "image/png", PUB_BYTES.byteLength, PUB_SHA),
          }),
        },
      ],
    },
  });
  push("agent.toolCall.created", { id: "call-shot", name: "interaction__browser_observe" });
  push("agent.toolCall.output", { id: "call-shot", output: screenshot });
  push("agent.message.completed", {
    phase: "final",
    text: `Preview:\n\n\`\`\`opengeni-site\n{"siteId":"${SITE}"}\n\`\`\`\n`,
  });
  push("turn.completed", {});
  push(
    "system.update.delivered",
    {
      members: [
        {
          id: "video-update",
          kind: "media_generation_result",
          classification: "success",
          sourceId: VIDEO_OP,
          summary: "The requested video is ready.",
          result: {
            type: "media_generation_result",
            schemaVersion: 1,
            status: "ready",
            operationId: VIDEO_OP,
            receipt: {
              type: "generated_video",
              schemaVersion: 1,
              operationId: VIDEO_OP,
              artifact: retained(VID, "generated_video", "video/mp4", 2_000_000, "a".repeat(64)),
              video: {
                durationSeconds: 5,
                width: 64,
                height: 64,
                fps: 24,
                hasAudio: true,
                videoCodec: "h264",
                audioCodec: "aac",
              },
              sandboxPath: `/workspace/generated-videos/generated-video-${VID}.mp4`,
            },
          },
        },
      ],
    },
    null,
  );
  push("session.status.changed", { status: "idle" }, null);
  return list;
}

function sessionRecord(id = S, status = "idle") {
  return {
    id,
    workspaceId: WS,
    title: "Audit chat",
    titleSource: "user",
    status,
    initialMessage: "Make an image",
    createdAt: now,
    updatedAt: now,
    createdBy: { kind: "subject", subjectId: "sub-1" },
    mcpServers: [],
  };
}

const control = {
  state: "active",
  directState: "active",
  controlVersion: 1,
  controlEtag: "e1",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};

function hanging(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull: () =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      }),
  });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function range(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
  header: string | null,
): Response {
  const match = /^bytes=(\d+)-(\d+)$/.exec(header ?? "");
  if (!match) return json({ error: { code: "range_required", message: "range" } }, { status: 416 });
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), bytes.byteLength - 1);
  const page = bytes.slice(start, end + 1);
  return new Response(page, {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(page.byteLength),
      "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
      "Accept-Ranges": "bytes",
    },
  });
}

type Mounted = {
  container: HTMLElement;
  /** `<status> <METHOD> <path>` as the browser saw it, ids kept. */
  browser: string[];
  /** `<METHOD> <path>?<query>` as the upstream API saw it. */
  upstream: string[];
  click: (label: RegExp) => Promise<boolean>;
  buttons: () => string[];
};

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function mountStockChat(
  proxy: Partial<SessionProxyHandlerOptions> = {},
  props: Partial<OpenGeniChatProps> = {},
  rewriteConfig: (config: Record<string, unknown>) => Record<string, unknown> = (config) => config,
): Promise<Mounted> {
  const events = conversation().map((event, index) => ({
    id: `eeeeeeee-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    workspaceId: WS,
    sessionId: S,
    sequence: index + 1,
    occurredAt: now,
    ...event,
  }));
  const browser: string[] = [];
  const upstream: string[] = [];
  const ws = `/v1/workspaces/${WS}`;
  const ss = `${ws}/sessions/${S}`;
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    upstream.push(`${method} ${path}${url.search}`);
    if (path === "/v1/config/client") {
      return json({
        deploymentRevision: "t",
        apiContractRevision: "x",
        defaultModel: "m",
        allowedModels: ["m"],
        models: [],
        fileUploads: { enabled: true, maxSizeBytes: 10_000_000 },
        voiceInput: {
          available: true,
          enabled: true,
          maxSizeBytes: 1_000_000,
          maxDurationSeconds: 600,
          resumable: { maxSizeBytes: 1, maxDurationSeconds: 1, maxChunkSizeBytes: 1 },
        },
      });
    }
    if (path === "/v1/access/me") {
      return json({
        subjectId: "sub-1",
        workspaceGrants: [
          { workspaceId: WS, subjectId: "sub-1", accountId: "acc", permissions: [] },
        ],
      });
    }
    if (path === ws) return json({ id: WS, name: "W", settings: {} });
    if (path.endsWith("/events/stream") || path.endsWith("/live-events/stream")) {
      return new Response(hanging(request.signal), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (path === `${ws}/sessions` && method === "GET") {
      return json({
        pinned: [],
        sessions: [sessionRecord()],
        nextCursor: null,
        sortBy: url.searchParams.get("sortBy") ?? undefined,
        archiveStatus: url.searchParams.get("archiveStatus") ?? undefined,
      });
    }
    if (path === ss && method === "GET") return json(sessionRecord());
    if (path === `${ss}/events` && method === "GET") {
      return json(events, {
        headers: {
          "X-OpenGeni-Covered-First": "1",
          "X-OpenGeni-Covered-Last": String(events.length),
        },
      });
    }
    if (path === `${ss}/queue`) {
      return json({ version: 1, effectiveControl: control, items: [], pendingInputs: [] });
    }
    if (path === `${ss}/composer-draft`) {
      return json({
        text: "",
        resources: [],
        revision: 0,
        model: "m",
        reasoningEffort: "medium",
        latencyMode: "standard",
        annotations: [],
      });
    }
    if (path === `${ss}/human-input-requests`) return json({ requests: [] });
    if (path === `${ss}/archive`) return json(sessionRecord());
    if (path === `${ws}/model-catalog`) return json({ models: [], defaultModel: "m" });
    if (path.startsWith(`${ws}/files/`) && path.endsWith("/download-url")) {
      return json({
        url: "https://objects.test/generated.png?sig=1",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        filename: "generated.png",
        contentType: "image/png",
      });
    }
    // Retained associations: only this conversation produced these artifacts.
    const association =
      /^\/v1\/workspaces\/[^/]+\/sessions\/([^/]+)\/artifact-associations\/([^/]+)$/.exec(path);
    if (association) {
      const [, sourceId, artifactId] = association;
      if (sourceId !== S || ![IMG, PUB, VID].includes(artifactId!)) {
        return json({ error: { code: "not_found", message: "no" } }, { status: 404 });
      }
      return json({ sessionId: sourceId, artifactId, kind: url.searchParams.get("kind") });
    }
    if (path === `${ws}/artifacts/${PUB}/content`) {
      return range(PUB_BYTES, "image/png", request.headers.get("range"));
    }
    if (path === `${ws}/artifacts/${VID}/playback-source` && method === "POST") {
      return json({
        schemaVersion: 1,
        artifactId: VID,
        url: "https://objects.test/generated.mp4?sig=1",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        contentType: "video/mp4",
        sizeBytes: 2_000_000,
        sha256: "a".repeat(64),
        acceptRanges: "bytes",
      });
    }
    if (path === `${ss}/artifacts/${SHOT}`) return json(screenshot);
    if (path === `${ss}/artifacts/${SHOT}/content`) {
      return range(SHOT_BYTES, "image/jpeg", request.headers.get("range"));
    }
    return json({ error: { code: "upstream_fixture_missing", message: path } }, { status: 499 });
  };

  // The server SDK refuses to run with a browser `window`; the proxy runs server-side.
  const service = new OpenGeniClient({ baseUrl: API, apiKey: "og_key", fetch: fake });
  const g = globalThis as { window?: unknown };
  const serverSide = new Proxy(service, {
    get(target, key) {
      if (key === "asUser") {
        return (...args: unknown[]) => {
          const previous = g.window;
          delete g.window;
          try {
            return (target.asUser as (...input: unknown[]) => unknown)(...args);
          } finally {
            g.window = previous;
          }
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const handler = createSessionProxyHandler(serverSide, {
    resolve: () => ({ workspaceId: WS, user: "u_42" }),
    ...proxy,
  });

  const previousFetch = globalThis.fetch;
  const createObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:media" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, PRODUCT);
    if (!url.pathname.startsWith(`${BASE}/`)) {
      browser.push(`EXTERNAL ${init?.method ?? "GET"} ${url.href}`);
      return new Response("", { status: 200 });
    }
    let response = await handler(new Request(url, init));
    const path = url.pathname.slice(BASE.length);
    if (path === "/v1/config/client" && response.ok) {
      response = json(rewriteConfig(await response.json()));
    }
    let code = "";
    if (response.status >= 400) {
      code = ((await response.clone().json()) as { error?: { code?: string } }).error?.code ?? "";
    }
    browser.push(`${response.status} ${init?.method ?? "GET"} ${path} ${code}`.trim());
    return response;
  }) as typeof fetch;

  const view = await renderComponent(
    <OpenGeniChat baseUrl={BASE} defaultSessionId={S} {...props} />,
  );
  cleanup = async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
    if (createObjectURL) Object.defineProperty(URL, "createObjectURL", createObjectURL);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (revokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", revokeObjectURL);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
  };
  await flush(400);
  const buttons = () =>
    [...view.container.querySelectorAll("button")].map(
      (button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
    );
  const click = async (label: RegExp) => {
    const target = [...view.container.querySelectorAll<HTMLElement>("button,[role=button]")].find(
      (element) => label.test(element.getAttribute("aria-label") ?? element.textContent ?? ""),
    );
    if (!target) return false;
    await actRun(() => target.click());
    await flush(200);
    return true;
  };
  return { container: view.container, browser, upstream, click, buttons };
}

function failures(log: readonly string[]): string[] {
  return log.filter((line) => /^[45]\d\d /.test(line));
}

describe("stock OpenGeniChat behind the default session proxy", () => {
  test("media the session produced displays through the proxy; Sites are unavailable without a request", async () => {
    const chat = await mountStockChat({ createSession: (input) => input });
    // Expand the browser screenshot so its retained bytes load.
    await chat.click(/Observed browser/);
    await flush(300);
    const text = chat.container.textContent ?? "";
    expect(text).not.toContain("retrieval is not configured");
    expect(text).not.toContain("retrieval failed");

    // 1. The proxy serves no Sites by default: a static card, no request.
    expect(chat.container.querySelector("[data-og-site-preview-unavailable]")?.textContent).toBe(
      "Site preview unavailable",
    );
    expect(chat.browser.some((line) => line.includes("published-artifacts"))).toBe(false);
    expect(chat.buttons().some((label) => /Load Site preview/.test(label))).toBe(false);

    // 2. Generated image, published file, screenshot and video all load.
    expect(chat.browser).toContain(`200 POST /v1/workspaces/${WS}/files/${IMG}/download-url`);
    expect(chat.browser).toContain(`206 GET /v1/workspaces/${WS}/artifacts/${PUB}/content`);
    expect(chat.browser).toContain(`200 GET /v1/workspaces/${WS}/sessions/${S}/artifacts/${SHOT}`);
    expect(chat.browser).toContain(
      `206 GET /v1/workspaces/${WS}/sessions/${S}/artifacts/${SHOT}/content`,
    );
    expect(chat.browser).toContain(
      `200 POST /v1/workspaces/${WS}/artifacts/${VID}/playback-source`,
    );
    // Workspace-level reads are proven to come from this session first.
    for (const artifactId of [PUB, VID]) {
      expect(chat.upstream).toContain(
        `GET /v1/workspaces/${WS}/sessions/${S}/artifact-associations/${artifactId}?kind=retained`,
      );
    }
    expect(
      chat.container.querySelector('img[src="https://objects.test/generated.png?sig=1"]'),
    ).not.toBeNull();
    expect(chat.container.querySelector("video")).not.toBeNull();

    // 3. The composer microphone appears when the deployment can transcribe.
    expect(chat.container.querySelector("[data-og-composer-dictate]")).not.toBeNull();

    // 4. A proxy with a createSession hook and archive on offers both.
    expect(chat.buttons()).toContain("New chat");
    expect(chat.buttons().some((label) => /^Archive:/.test(label))).toBe(true);
    expect(failures(chat.browser)).toEqual([]);
  });

  test("an artifact from another session is refused by the proxy", async () => {
    const chat = await mountStockChat();
    const before = chat.upstream.length;
    const response = await fetch(`${BASE}/v1/workspaces/${WS}/artifacts/${PUB}/content`, {
      headers: { "x-opengeni-session-id": OTHER, range: "bytes=0-3" },
    });
    expect(response.status).toBe(404);
    // The association check refused it; the bytes were never read upstream.
    expect(chat.upstream.slice(before)).toEqual([
      `GET /v1/workspaces/${WS}/sessions/${OTHER}/artifact-associations/${PUB}?kind=retained`,
    ]);
  });

  test("voice input opts out per conversation and per proxy", async () => {
    const optedOut = await mountStockChat({}, { conversationProps: { voiceInput: false } });
    expect(optedOut.container.querySelector("textarea")).not.toBeNull();
    expect(optedOut.container.querySelector("[data-og-composer-dictate]")).toBeNull();
    await cleanup?.();
    cleanup = null;
    const proxyOff = await mountStockChat({ voiceInput: false });
    expect(proxyOff.container.querySelector("[data-og-composer-dictate]")).toBeNull();
  });

  test("a proxy without createSession and with archive off hides both actions", async () => {
    const chat = await mountStockChat({ archive: false }, { defaultSessionId: undefined });
    expect(chat.buttons()).not.toContain("New chat");
    expect(chat.buttons().some((label) => /^Archive:/.test(label))).toBe(false);
    expect(chat.container.querySelector("[data-og-new-chat-unavailable]")?.textContent).toBe(
      "New chats are not enabled for this product.",
    );
    expect(chat.container.querySelector("[data-og-composer-dictate]")).toBeNull();
    expect(
      chat.browser.some((line) => line.includes("POST /v1/workspaces/" + WS + "/sessions")),
    ).toBe(false);
  });

  test("an older proxy that refuses chat creation reads as unavailable, not as an error", async () => {
    // An older proxy reports no capability flags; its create route still refuses.
    const chat = await mountStockChat({}, { defaultSessionId: undefined }, (config) => {
      const { sessionCreation: _created, ...rest } = config;
      return rest;
    });
    const textarea = chat.container.querySelector("textarea") as HTMLTextAreaElement;
    await actRun(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "hello",
      );
      const props = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
      (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[
        props
      ]!.onChange({ target: textarea });
    });
    await flush(50);
    expect(await chat.click(/^Send/)).toBe(true);
    await flush(200);
    expect(chat.browser).toContain(`404 POST /v1/workspaces/${WS}/sessions route_not_allowed`);
    expect(
      [...chat.container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent),
    ).toEqual(["New chats are not enabled for this product."]);
  });
});
