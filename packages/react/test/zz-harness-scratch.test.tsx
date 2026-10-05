// Scratch audit harness (temp worktree only): stock <OpenGeniChat baseUrl> -> real
// createSessionProxyHandler -> real server OpenGeniClient -> recording fake upstream.
import { expect, test } from "bun:test";
import { OpenGeniClient, createSessionProxyHandler } from "@opengeni/sdk";
import { OpenGeniChat } from "../src/components/open-geni-chat";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const WS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const S = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD = "aaaaaaaa-0000-4000-8000-000000000002";
const TURN = "bbbbbbbb-0000-4000-8000-000000000001";
const FILE = "cccccccc-0000-4000-8000-000000000001";
const IMG = "cccccccc-0000-4000-8000-000000000002";
const PUB = "cccccccc-0000-4000-8000-000000000003";
const API = "https://api.test";
const PRODUCT = "https://product.test";
const now = new Date().toISOString();

const browserLog: string[] = [];
const upstreamLog: string[] = [];

let seq = 0;
const events: unknown[] = [];
function push(type: string, payload: unknown, turnId: string | null = TURN) {
  seq += 1;
  events.push({
    id: `eeeeeeee-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    workspaceId: WS,
    sessionId: S,
    sequence: seq,
    type,
    payload,
    occurredAt: now,
    turnId,
  });
}
push("session.created", {}, null);
push("user.message", {
  text: "Make an image and a report",
  resources: [{ kind: "file", fileId: FILE }],
});
push("turn.started", {});
push("goal.set", { actor: "agent", goalId: "ffffffff-0000-4000-8000-000000000001", objective: "Ship the report" });
push("agent.toolCall.created", {
  id: "call-image-1",
  name: "generate_image",
  arguments: { prompt: "teal sphere" },
  raw: { type: "function_call", name: "generate_image", status: "completed" },
});
push("agent.toolCall.output", {
  id: "call-image-1",
  output: {
    type: "generated_image",
    artifact: {
      available: true,
      artifactId: IMG,
      kind: "generated_image",
      contentType: "image/png",
      originalBytes: 1024,
      sha256: "c".repeat(64),
      retainedAt: now,
      dimensions: { width: 64, height: 64 },
      retention: { policy: "workspace_file", expiresAt: null },
      retrieval: {
        method: "GET",
        path: `/v1/workspaces/${WS}/artifacts/${IMG}/content`,
        acceptRanges: "bytes",
        maxRangeBytes: 1024 * 1024,
      },
    },
    sandboxPath: `/workspace/generated-images/generated-image-${IMG}.png`,
  },
});
push("agent.message.completed", {
  phase: "final",
  text: `Here is [the report](artifact:${PUB}) and [the code](sandbox:src/app.ts).`,
});
push("agent.message.completed", {
  phase: "final",
  text: "Preview:\n\n```opengeni-site\n{\"siteId\":\"99999999-0000-4000-8000-000000000001\"}\n```\n",
});
push("session.requiresAction", {
  approvals: [
    {
      name: "acme__refund_payment",
      rawItem: { callId: "call-refund", name: "acme__refund_payment", arguments: { id: "p1" } },
    },
  ],
});
push("session.status.changed", { status: "requires_action" });

function session(id = S, status = "requires_action") {
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

function hanging(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull: () =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      }),
  });
}

async function upstream(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const path = url.pathname;
  upstreamLog.push(`${request.method} ${path}${url.search}`);
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", ...headers },
    });
  const ws = `/v1/workspaces/${WS}`;
  const ss = `${ws}/sessions/${S}`;
  if (path === "/v1/config/client")
    return json({
      deploymentRevision: "t",
      apiContractRevision: "x",
      defaultModel: "m",
      allowedModels: ["m"],
      models: [],
      fileUploads: { enabled: true, maxSizeBytes: 10_000_000 },
      voiceInput: { available: true, enabled: true, maxSizeBytes: 1_000_000, maxDurationSeconds: 600, resumable: { maxSizeBytes: 1, maxDurationSeconds: 1, maxChunkSizeBytes: 1 } },
    });
  if (path === "/v1/access/me")
    return json({ subjectId: "sub-1", workspaceGrants: [{ workspaceId: WS, subjectId: "sub-1", accountId: "acc", permissions: [] }] });
  if (path === ws) return json({ id: WS, name: "W" });
  if (path.endsWith("/live-events/stream") || path.endsWith("/events/stream"))
    return new Response(hanging(request.signal), { headers: { "Content-Type": "text/event-stream" } });
  if (path === `${ws}/sessions` && request.method === "GET")
    return json({ pinned: [], sessions: [session()], nextCursor: null, sortBy: url.searchParams.get("sortBy") ?? undefined, archiveStatus: url.searchParams.get("archiveStatus") ?? undefined });
  if (path === ss && request.method === "GET") return json(session());
  if (path === `${ws}/sessions/${CHILD}`) return json(session(CHILD, "idle"));
  if (path === `${ss}/events` && request.method === "GET")
    return json(events, { "X-OpenGeni-Covered-First": "1", "X-OpenGeni-Covered-Last": String(seq) });
  if (path === `${ss}/events` && request.method === "POST")
    return json({ ...(events[0] as object), sequence: ++seq, type: "user.approvalDecision" });
  if (path === `${ss}/queue`)
    return json({ version: 1, effectiveControl: control, items: [], pendingInputs: [] });
  if (path === `${ss}/composer-draft`)
    return json({ text: "", resources: [], revision: 0, model: "m", reasoningEffort: "medium", latencyMode: "standard", annotations: [] });
  if (path === `${ss}/human-input-requests`) return json({ requests: [] });
  if (path === `${ss}/control`) return json({ ok: true, effectiveControl: control });
  if (path.startsWith(`${ws}/files/`) && path.endsWith("/download-url"))
    return json({ url: "https://objects.test/x?sig=1", expiresAt: now, filename: "x.png", contentType: "image/png" });
  if (path === `${ws}/model-catalog`) return json({ models: [], defaultModel: "m" });
  return new Response(JSON.stringify({ error: { code: "upstream_fixture_missing", message: path } }), {
    status: 599 - 100,
    headers: { "Content-Type": "application/json" },
  });
}

test("stock OpenGeniChat behind default createSessionProxyHandler", async () => {
  const service = new OpenGeniClient({ baseUrl: API, apiKey: "og_key", fetch: upstream });
  const g = globalThis as any;
  const serverSide = new Proxy(service, {
    get(target, key) {
      if (key === "asUser")
        return (...args: unknown[]) => {
          const w = g.window;
          delete g.window;
          try {
            return (target as any).asUser(...args);
          } finally {
            g.window = w;
          }
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const handler = createSessionProxyHandler(serverSide as never, {
    resolve: () => ({ workspaceId: WS, user: "u_42" }),
    createSession: (input) => input,
  });
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, PRODUCT);
    if (!url.pathname.startsWith("/api/opengeni/")) {
      browserLog.push(`EXTERNAL ${init?.method ?? "GET"} ${url.href}`);
      return new Response("", { status: 200 });
    }
    const response = await handler(new Request(url, init));
    let code = "";
    if (response.status >= 400) {
      try {
        code = (await response.clone().json()).error?.code ?? "";
      } catch {}
    }
    browserLog.push(`${response.status} ${init?.method ?? "GET"} ${url.pathname.replace("/api/opengeni", "")}${url.search} ${code}`);
    return response;
  }) as typeof fetch;
  const view = await renderComponent(<OpenGeniChat baseUrl="/api/opengeni" defaultSessionId={S} />);
  try {
    await flush(600);
    const text = view.container.textContent ?? "";
    console.log("RENDER has 'retrieval is not configured':", text.includes("retrieval is not configured"));
    console.log("RENDER has goal text:", text.includes("Ship the report"));
    console.log("RENDER has Approve:", /Approve/.test(text));
    const buttons = [...view.container.querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
    );
    console.log("BUTTONS:", JSON.stringify(buttons));
    const links = [...view.container.querySelectorAll("a")].map((a) => `${a.textContent}=>${a.getAttribute("href")}`);
    console.log("LINKS:", JSON.stringify(links));
    for (const b of [...view.container.querySelectorAll("button")]) {
      if (/step/.test(b.textContent ?? "")) { await actRun(() => (b as HTMLElement).click()); await flush(300); }
    }
    for (const b of [...view.container.querySelectorAll("button")]) {
      if (/image|Generate/i.test(b.textContent ?? "")) { await actRun(() => (b as HTMLElement).click()); await flush(300); }
    }
    for (const el of [...view.container.querySelectorAll("*")]) {
      if (el.children.length === 0 && (el.textContent ?? "").trim() === "Generate image") {
        const target = (el.closest("button,[role=button],summary,[aria-expanded]") ?? el) as HTMLElement;
        console.log("CLICK target", target.tagName, target.getAttribute("aria-expanded"));
        await actRun(() => target.click());
        await flush(400);
      }
    }
    const t2 = view.container.textContent ?? "";
    console.log("AFTER EXPAND has 'retrieval is not configured':", t2.includes("retrieval is not configured"), "| has 'image':", (t2.match(/.{0,60}image.{0,60}/gi) ?? []).slice(0,4));
    console.log("FULLTEXT:", t2.slice(0, 5000));
    console.log("BUTTONS2:", JSON.stringify([...view.container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())));
    // Click the artifact link, sandbox link.
    for (const a of [...view.container.querySelectorAll("a, button")]) {
      const label = a.textContent ?? "";
      if (label.includes("the report") || label.includes("the code")) {
        await actRun(() => (a as HTMLElement).click());
        await flush(100);
      }
    }
    for (const b of [...view.container.querySelectorAll("button")]) {
      if (/preview|Load/i.test(b.textContent ?? b.getAttribute("aria-label") ?? "")) { console.log("CLICK preview", b.textContent); await actRun(() => (b as HTMLElement).click()); await flush(400); }
    }
    console.log("SITE TEXT:", ((view.container.textContent ?? "").match(/Preview:[\s\S]{0,300}/) ?? [])[0]);
    const before = browserLog.length;
    const vfd = [...view.container.querySelectorAll("button")].find((b) => /View full details/.test(b.textContent ?? ""));
    if (vfd) { await actRun(() => vfd.click()); await flush(300); }
    console.log("VFD new requests:", browserLog.slice(before), "dialog:", Boolean(document.querySelector('[role="dialog"]')));
    // Approve.
    const approve = [...view.container.querySelectorAll("button")].find((b) => /^Approve/.test(b.textContent?.trim() ?? ""));
    if (approve) {
      await actRun(() => approve.click());
      await flush(200);
    }
    // Stop button (pause).
    const stop = [...view.container.querySelectorAll("button")].find((b) => /stop|pause/i.test(b.getAttribute("aria-label") ?? ""));
    if (stop) {
      await actRun(() => stop.click());
      await flush(200);
    }
    // Slash commands: type "/" in the composer.
    const textarea = view.container.querySelector("textarea");
    console.log("TEXTAREA present:", Boolean(textarea));
    console.log("MIC present:", Boolean(view.container.querySelector('[aria-label="Start voice input"]')));
  } finally {
    await view.unmount();
    globalThis.fetch = previous;
  }
  console.log("BROWSER REQUESTS:\n" + [...new Set(browserLog)].join("\n"));
  console.log("UPSTREAM REQUESTS:\n" + [...new Set(upstreamLog)].join("\n"));
  expect(true).toBe(true);
});

test("running session: Stop, send, rename, archive, new chat", async () => {
  browserLog.length = 0;
  upstreamLog.length = 0;
  events.splice(7);
  seq = 7;
  push("session.status.changed", { status: "running" });
  const service = new OpenGeniClient({ baseUrl: API, apiKey: "og_key", fetch: async (i: any, init?: any) => {
    const req = new Request(i, init);
    const p = new URL(req.url).pathname;
    if (p.endsWith(`/sessions/${S}`) && req.method === "GET") {
      upstreamLog.push(`GET ${p}`);
      return new Response(JSON.stringify({ ...session(S, "running") }), { headers: { "Content-Type": "application/json" } });
    }
    if (p.endsWith(`/sessions/${S}`) && req.method === "PATCH") { upstreamLog.push(`PATCH ${p}`); return new Response(JSON.stringify(session(S, "running")), { headers: { "Content-Type": "application/json" } }); }
    if (p.endsWith(`/archive`)) { upstreamLog.push(`PUT ${p}`); return new Response(JSON.stringify(session(S, "running")), { headers: { "Content-Type": "application/json" } }); }
    return await upstream(req);
  } });
  const g = globalThis as any;
  const serverSide = new Proxy(service, {
    get(target, key) {
      if (key === "asUser")
        return (...args: unknown[]) => { const w = g.window; delete g.window; try { return (target as any).asUser(...args); } finally { g.window = w; } };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const handler = createSessionProxyHandler(serverSide as never, { resolve: () => ({ workspaceId: WS, user: "u_42" }), createSession: (input) => input });
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, PRODUCT);
    if (!url.pathname.startsWith("/api/opengeni/")) { browserLog.push(`EXTERNAL ${url.href}`); return new Response("", { status: 200 }); }
    const response = await handler(new Request(url, init));
    let code = "";
    if (response.status >= 400) { try { code = (await response.clone().json()).error?.code ?? ""; } catch {} }
    browserLog.push(`${response.status} ${init?.method ?? "GET"} ${url.pathname.replace("/api/opengeni", "").replace(/[0-9a-f-]{36}/g, ":id")} ${code}`);
    return response;
  }) as typeof fetch;
  const view = await renderComponent(<OpenGeniChat baseUrl="/api/opengeni" defaultSessionId={S} />);
  try {
    await flush(600);
    console.log("RUN BUTTONS:", JSON.stringify([...view.container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())));
    const click = async (re: RegExp) => {
      const b = [...view.container.querySelectorAll("button")].find((x) => re.test(x.getAttribute("aria-label") ?? x.textContent ?? ""));
      console.log("CLICK", re, Boolean(b));
      if (b) { await actRun(() => (b as HTMLElement).click()); await flush(300); }
    };
    await click(/^(Stop|Pause)/i);
    console.log("AFTER STOP BUTTONS:", JSON.stringify([...view.container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())));
    await click(/^Archive:/);
  } finally {
    await view.unmount();
    globalThis.fetch = previous;
  }
  console.log("RUN BROWSER:\n" + [...new Set(browserLog)].join("\n"));
});

test("proxy without createSession / archive:false: what the stock chat shows", async () => {
  browserLog.length = 0;
  const service = new OpenGeniClient({ baseUrl: API, apiKey: "og_key", fetch: upstream });
  const g = globalThis as any;
  const serverSide = new Proxy(service, {
    get(target, key) {
      if (key === "asUser")
        return (...args: unknown[]) => { const w = g.window; delete g.window; try { return (target as any).asUser(...args); } finally { g.window = w; } };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const handler = createSessionProxyHandler(serverSide as never, { resolve: () => ({ workspaceId: WS, user: "u_42" }), archive: false });
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, PRODUCT);
    if (!url.pathname.startsWith("/api/opengeni/")) return new Response("", { status: 200 });
    const response = await handler(new Request(url, init));
    let code = "";
    if (response.status >= 400) { try { code = (await response.clone().json()).error?.code ?? ""; } catch {} }
    browserLog.push(`${response.status} ${init?.method ?? "GET"} ${url.pathname.replace("/api/opengeni", "").replace(/[0-9a-f-]{36}/g, ":id")} ${code}`);
    return response;
  }) as typeof fetch;
  const view = await renderComponent(<OpenGeniChat baseUrl="/api/opengeni" />);
  try {
    await flush(500);
    const ta = view.container.querySelector("textarea") as HTMLTextAreaElement;
    await actRun(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "hello");
      const key = Object.keys(ta).find((n) => n.startsWith("__reactProps$"))!;
      (ta as any)[key].onChange({ target: ta });
    });
    await flush(100);
    const send = [...view.container.querySelectorAll("button")].find((b) => /Send/.test(b.getAttribute("aria-label") ?? ""));
    if (send) { await actRun(() => send.click()); await flush(300); }
    const archive = [...view.container.querySelectorAll("button")].find((b) => /^Archive:/.test(b.getAttribute("aria-label") ?? ""));
    console.log("NOHOOK archive button shown:", Boolean(archive));
    if (archive) { await actRun(() => archive.click()); await flush(300); }
    console.log("NOHOOK TEXT:", (view.container.textContent ?? "").slice(0, 400));
  } finally {
    await view.unmount();
    globalThis.fetch = previous;
  }
  console.log("NOHOOK BROWSER:\n" + [...new Set(browserLog)].join("\n"));
});
