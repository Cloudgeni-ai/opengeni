/**
 * Integration: the built Worker loads app server code into Dynamic Worker
 * isolates (Miniflare's Worker Loader) and forwards the code's calls back to
 * a fake API. Requests to the internal route are signed here independently
 * (node:crypto) the way the API signs them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  APP_SERVER_RUN_TOKEN_HEADER,
  SITE_GATEWAY_SIGNATURE_HEADER,
  SITE_GATEWAY_TIMESTAMP_HEADER,
  appServerInternalPath,
  siteGatewayCanonicalString,
  type AppServerGatewayRunRequest,
  type AppServerGatewayRunResult,
} from "@opengeni/contracts";
import { Miniflare } from "miniflare";
import { TEST_SECRET, verifyGatewayHeaders } from "./helpers";

const ORIGIN = "https://internal.sites.test";
const SITE_A = "33333333-3333-4333-8333-333333333333";
const SITE_B = "44444444-4444-4444-8444-444444444444";
const VERSION_A = "55555555-5555-4555-8555-555555555555";
const VERSION_B = "66666666-6666-4666-8666-666666666666";

type HostCall = { path: string; token: string | null; body: unknown; signed: boolean };
const hostCalls: HostCall[] = [];
let api: ReturnType<typeof Bun.serve> | null = null;
let mf: Miniflare | null = null;
let bare: Miniflare | null = null;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function runRequest(
  siteId: string,
  versionId: string,
  modules: Record<string, string>,
  request: Partial<AppServerGatewayRunRequest["request"]> = {},
  main = "index.js",
): AppServerGatewayRunRequest {
  return {
    requestId: crypto.randomUUID(),
    versionId,
    digest: digest(JSON.stringify(modules)),
    main,
    modules: Object.fromEntries(
      Object.entries(modules).map(([path, source]) => [
        path,
        Buffer.from(source, "utf8").toString("base64"),
      ]),
    ),
    context: {
      runId: crypto.randomUUID(),
      appId: siteId,
      versionId,
      trigger: "request",
      viewer: { id: "user:user-1", email: "a@example.com", name: "A", kind: "member" },
      token: `token-for-${siteId}`,
      hostCallLimit: 3,
      logLimit: 200,
    },
    request: { method: "GET", path: "/hello?x=1", headers: [], bodyBase64: "", ...request },
    limits: { timeoutMs: 3000, cpuMs: 1000, responseBytes: 1024 },
  };
}

async function call(
  siteId: string,
  payload: unknown,
  options: { tamper?: boolean; instance?: Miniflare } = {},
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const path = appServerInternalPath(siteId);
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const canonical = siteGatewayCanonicalString({
    method: "POST",
    pathWithQuery: path,
    timestamp,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    host: new URL(ORIGIN).host,
    session: "",
    visitor: "",
    clientIp: "",
    human: "",
  });
  const signature = `v1=${createHmac("sha256", options.tamper ? "x".repeat(40) : TEST_SECRET)
    .update(canonical)
    .digest("base64url")}`;
  const url = `${ORIGIN}${path}`;
  return await (options.instance ?? mf!).dispatchFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SITE_GATEWAY_TIMESTAMP_HEADER]: String(timestamp),
      [SITE_GATEWAY_SIGNATURE_HEADER]: signature,
      "MF-Original-URL": url,
    },
    body,
  });
}

async function run(payload: AppServerGatewayRunRequest): Promise<AppServerGatewayRunResult> {
  const response = await call(payload.context.appId, payload);
  expect(response.status).toBe(200);
  return (await response.json()) as AppServerGatewayRunResult;
}

const text = (result: AppServerGatewayRunResult) =>
  new TextDecoder().decode(Uint8Array.from(atob(result.bodyBase64), (c) => c.charCodeAt(0)));

async function startWorker(loader: boolean): Promise<Miniflare> {
  const buildDir = mkdtempSync(join(tmpdir(), "site-gateway-app-server-test-"));
  try {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../src/index.ts")],
      outdir: buildDir,
      target: "browser",
      format: "esm",
      naming: "worker.js",
    });
    if (!build.success) throw new AggregateError(build.logs, "Worker build failed");
    const instance = new Miniflare({
      modules: true,
      scriptPath: join(buildDir, "worker.js"),
      modulesRoot: buildDir,
      compatibilityDate: "2026-07-01",
      bindings: {
        SITES_DOMAIN: "sites.test",
        API_ORIGIN: `http://127.0.0.1:${api!.port}`,
        APP_ORIGIN: "https://app.test",
        GATEWAY_SECRET: TEST_SECRET,
        ENVIRONMENT: "test",
      },
      ...(loader ? { workerLoaders: { LOADER: {} } } : {}),
    });
    await instance.ready;
    return instance;
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  api = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      hostCalls.push({
        path: url.pathname,
        token: request.headers.get(APP_SERVER_RUN_TOKEN_HEADER),
        body: body ? JSON.parse(body) : null,
        signed: verifyGatewayHeaders(TEST_SECRET, request),
      });
      const parsed = body
        ? (JSON.parse(body) as { op: string; input: Record<string, unknown> })
        : null;
      if (parsed?.op === "fetch")
        return Response.json({
          result: { status: 201, headers: [["x-up", "1"]], bodyBase64: btoa("upstream") },
        });
      if (parsed?.op === "tools.call") return Response.json({ result: { echoed: parsed.input } });
      return Response.json(
        {
          error: {
            code: "forbidden",
            message: "nope",
            details: { reason: "collection_per_viewer" },
          },
        },
        { status: 403 },
      );
    },
  });
  mf = await startWorker(true);
  bare = await startWorker(false);
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  await bare?.dispose();
  api?.stop(true);
});

describe("app server code in the gateway", () => {
  test("runs the app's code with the viewer, request and captured logs", async () => {
    const result = await run(
      runRequest(SITE_A, VERSION_A, {
        "index.js":
          "import { greet } from './lib/greet.js'; export default { async fetch(request, env) { console.log('serving', new URL(request.url).pathname); return Response.json({ text: greet(env.viewer.name), app: env.app.id, path: new URL(request.url).pathname + new URL(request.url).search, sawContext: request.headers.has('x-opengeni-app-server-context') }, { status: 202 }); } };",
        "lib/greet.js": "export const greet = (name) => 'hello ' + name;",
      }),
    );
    expect(result.error).toBeNull();
    expect(result.status).toBe(202);
    expect(JSON.parse(text(result))).toEqual({
      text: "hello A",
      app: SITE_A,
      path: "/hello?x=1",
      sawContext: false,
    });
    expect(result.logs).toContain("serving /hello");
  });

  test("calls back to Opengeni only through the signed host route of its own app and version", async () => {
    hostCalls.length = 0;
    const result = await run(
      runRequest(SITE_A, VERSION_B, {
        "index.js":
          "export default { async fetch(request, env) { const tool = await env.tools.call({ serverId: 's', toolName: 't' }, { q: 1 }); const raw = await env.tools.call('s/t', {}, { raw: true }); const up = await fetch('https://api.example.com/x', { method: 'POST', body: 'hi' }); return Response.json({ tool, raw, up: up.status, upBody: await up.text(), header: up.headers.get('x-up') }); } };",
      }),
    );
    expect(result.error).toBeNull();
    expect(JSON.parse(text(result))).toEqual({
      tool: { echoed: { tool: { serverId: "s", toolName: "t" }, arguments: { q: 1 } } },
      raw: { echoed: { tool: "s/t", arguments: {}, raw: true } },
      up: 201,
      upBody: "upstream",
      header: "1",
    });
    expect(hostCalls).toHaveLength(3);
    for (const hostCall of hostCalls) {
      expect(hostCall.path).toBe(`/v1/site-runtime/app-server/${SITE_A}/${VERSION_B}/host`);
      expect(hostCall.token).toBe(`token-for-${SITE_A}`);
      expect(hostCall.signed).toBe(true);
    }
    expect(hostCalls[2]!.body).toMatchObject({
      op: "fetch",
      input: { url: "https://api.example.com/x", method: "POST", bodyBase64: btoa("hi") },
    });
  });

  test("reports a refused call with its reason as the error's code", async () => {
    const result = await run(
      runRequest(SITE_A, VERSION_A, {
        "index.js":
          "export default { async fetch(request, env) { try { await env.data.query('things'); return new Response('ran'); } catch (e) { return new Response(e.code + ':' + e.message); } } };",
      }),
    );
    expect(text(result)).toBe("collection_per_viewer:nope");
  });

  test("a library that keeps fetch from load time still goes through Opengeni", async () => {
    const result = await run(
      runRequest(SITE_A, "88888888-8888-4888-8888-888888888888", {
        "index.js":
          "import { get } from './lib/client.js'; export default { async fetch() { const up = await get(); return new Response(String(up.status)); } };",
        "lib/client.js":
          "const keptFetch = globalThis.fetch; export const get = () => keptFetch('https://api.example.com/x');",
      }),
    );
    expect(result.error).toBeNull();
    expect(text(result)).toBe("201");
  });

  test("a run that overruns its time keeps the logs it wrote", async () => {
    const result = await run(
      runRequest(SITE_B, "99999999-9999-4999-8999-999999999999", {
        "index.js":
          "export default { async fetch() { console.log('started'); await new Promise(() => {}); } };",
      }),
    );
    expect(result.status).toBe(500);
    expect(result.error).toContain("did not answer");
    expect(result.logs).toContain("started");
  });

  test("reads the isolate's answer bounded, whatever the code does inside it", async () => {
    const result = await run(
      runRequest(SITE_B, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
        "index.js":
          "JSON.stringify = () => 'x'.repeat(7 * 1024 * 1024); export default { async fetch() { return new Response('small'); } };",
      }),
    );
    expect(result.status).toBe(500);
    expect(result.error).toContain("more than it may");
  });

  test("keeps each app's isolate to itself", async () => {
    const code = {
      "index.js":
        "let seen = globalThis.__seen ?? null; export default { async fetch(request, env) { const before = globalThis.__seen ?? null; globalThis.__seen = env.app.id; return Response.json({ before, seen }); } };",
    };
    const first = await run(runRequest(SITE_A, VERSION_A, code));
    const other = await run(runRequest(SITE_B, VERSION_A, code));
    const again = await run(runRequest(SITE_A, VERSION_A, code));
    expect(JSON.parse(text(first)).before).toBeNull();
    // Another app never sees what the first app's code left behind.
    expect(JSON.parse(text(other)).before).toBeNull();
    expect(JSON.parse(text(again)).before).toBe(SITE_A);
  });

  test("reports a code error, a thrown error and an oversized response", async () => {
    const syntax = await run(runRequest(SITE_B, VERSION_B, { "index.js": "export default {" }));
    expect(syntax.status).toBe(500);
    expect(syntax.error).toBeTruthy();
    const thrown = await run(
      runRequest(SITE_B, VERSION_A, {
        "index.js": "export default { async fetch() { throw new Error('boom'); } };",
      }),
    );
    expect(thrown.status).toBe(500);
    expect(thrown.error).toBe("boom");
    expect(thrown.logs).toContain("boom");
    const large = await run(
      runRequest(SITE_B, "77777777-7777-4777-8777-777777777777", {
        "index.js": "export default { async fetch() { return new Response('x'.repeat(5000)); } };",
      }),
    );
    expect(large.error).toContain("over 1024 bytes");
  });

  test("refuses unsigned requests, mismatched apps and a gateway without the binding", async () => {
    const payload = runRequest(SITE_A, VERSION_A, { "index.js": "export default {}" });
    expect((await call(SITE_A, payload, { tamper: true })).status).toBe(401);
    expect((await call(SITE_B, payload)).status).toBe(400);
    expect((await call(SITE_A, payload, { instance: bare! })).status).toBe(404);
  });
});
