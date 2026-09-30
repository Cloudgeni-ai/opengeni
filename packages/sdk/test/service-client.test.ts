import { describe, expect, test } from "bun:test";
import { OpenGeniClient, type OpenGeniClientOptions, type ServiceContext } from "../src/index";
import { OpenGeniBrowserClient as BrowserClient } from "../src/browser";

function fixture(options: Partial<OpenGeniClientOptions> = {}) {
  const calls: { url: string; init: RequestInit | undefined; headers: Headers }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://test.invalid/",
    apiKey: "synthetic-key",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init, headers: new Headers(init?.headers) });
      return Response.json([]);
    },
    ...options,
  });
  return { client, calls };
}

describe("asService", () => {
  test("isolates service headers and context without changing the original client", async () => {
    const { client, calls } = fixture();
    const context: ServiceContext = { job: "daily", retry: 2, automatic: true };
    const first = client.asService("acme:reports.daily", context);
    const second = client.asService("other");
    context.job = "changed";
    expect(first).not.toBe(client);
    expect(first).toBeInstanceOf(OpenGeniClient);
    expect(first.getIdentityLink).toBeFunction();
    expect(first.createWorkspaceArtifact).toBeFunction();
    await Promise.all([first.listWorkspaces(), second.listWorkspaces(), client.listWorkspaces()]);
    expect(calls.map(({ headers }) => headers.get("x-opengeni-service-initiator"))).toEqual([
      "acme:reports.daily",
      "other",
      null,
    ]);
    expect(JSON.parse(calls[0]!.headers.get("x-opengeni-service-context")!)).toEqual({
      job: "daily",
      retry: 2,
      automatic: true,
    });
    expect(calls[1]!.headers.get("x-opengeni-service-context")).toBeNull();
    expect(calls[2]!.headers.get("x-opengeni-service-context")).toBeNull();
    expect(calls.every(({ headers }) => !headers.has("x-opengeni-external-actor"))).toBe(true);
    expect(
      calls.every(({ headers }) => headers.get("authorization") === "Bearer synthetic-key"),
    ).toBe(true);
  });

  test("retains subclasses, options, lazy headers, cancellation, and strict contract mode", async () => {
    class ProductClient extends OpenGeniClient {
      productMethod() {
        return "product";
      }
    }
    let headerReads = 0;
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const original = new ProductClient({
      baseUrl: "https://test.invalid/prefix/",
      apiKey: "synthetic-key",
      apiContract: "strict",
      sessionCommandTimeoutMs: 4321,
      onDeprecation: false,
      headers: () => ({ "X-Product-Request": String(++headerReads) }),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json([]);
      },
    });
    const service = original.asService("jobs");
    expect(service).toBeInstanceOf(ProductClient);
    expect(service.productMethod()).toBe("product");
    expect(headerReads).toBe(0);
    const controller = new AbortController();
    await service.requestJsonResponse("/probe", { page: "2" }, { signal: controller.signal });
    await service.requestJsonResponse("/probe");
    expect(calls[0]!.url).toBe("https://test.invalid/prefix/probe?page=2");
    expect(calls[0]!.init?.signal).toBe(controller.signal);
    expect(new Headers(calls[0]!.init?.headers).get("x-product-request")).toBe("1");
    expect(new Headers(calls[1]!.init?.headers).get("x-product-request")).toBe("2");
    const strict = fixture({
      apiContract: "strict",
      fetch: async () =>
        Response.json([], { headers: { "x-opengeni-api-contract": "different-contract" } }),
    }).client.asService("jobs");
    await expect(strict.listWorkspaces()).rejects.toThrow("contract");
  });

  test("uses service headers on session creates, messages, void mutations, and SSE", async () => {
    const calls: { url: string; init: RequestInit | undefined; headers: Headers }[] = [];
    const service = new OpenGeniClient({
      baseUrl: "https://test.invalid",
      apiKey: "synthetic-key",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init, headers: new Headers(init?.headers) });
        if (String(url).endsWith("/stream"))
          return new Response("", { headers: { "Content-Type": "text/event-stream" } });
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({ session: { id: "session" } });
      },
    }).asService("jobs", { jobId: "job-1" });
    await service.createSession("workspace", {
      initialMessage: "Run the report",
      idempotencyKey: "job-1",
    });
    await service.sendMessage("workspace", "session", "Continue");
    await service.requestVoid("DELETE", "/probe");
    const stream = await service.openEventStream("workspace", "session");
    await stream.cancel();
    expect(calls).toHaveLength(4);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      initialMessage: "Run the report",
      idempotencyKey: "job-1",
    });
    expect(
      calls.every(({ headers }) => headers.get("x-opengeni-service-initiator") === "jobs"),
    ).toBe(true);
    expect(
      calls.every(
        ({ headers }) => headers.get("x-opengeni-service-context") === '{"jobId":"job-1"}',
      ),
    ).toBe(true);
    expect(calls.every(({ headers }) => !headers.has("x-opengeni-external-actor"))).toBe(true);
  });

  test("reapplying service attribution replaces it and clears omitted context", async () => {
    const { client, calls } = fixture({
      headers: {
        "X-OpenGeni-Service-Initiator": "configured",
        "X-OpenGeni-Service-Context": '{"configured":true}',
        "X-Product": "preserved",
      },
    });
    const first = client.asService("first", { first: true });
    const second = first.asService("second", { second: true });
    const third = second.asService("third");
    await first.listWorkspaces();
    await second.listWorkspaces();
    await third.listWorkspaces();
    expect(calls.map(({ headers }) => headers.get("x-opengeni-service-initiator"))).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(calls.map(({ headers }) => headers.get("x-opengeni-service-context"))).toEqual([
      '{"first":true}',
      '{"second":true}',
      null,
    ]);
    expect(calls.every(({ headers }) => headers.get("x-product") === "preserved")).toBe(true);
  });

  test("overrides case-variant service headers computed per request", async () => {
    const { client, calls } = fixture({
      headers: () => ({
        "X-OpenGeni-Service-Initiator": "wrong",
        "X-OpenGeni-Service-Context": '{"wrong":true}',
      }),
    });
    await client.asService("correct", {}).listWorkspaces();
    await client.asService("correct").listWorkspaces();
    expect(calls[0]!.headers.get("x-opengeni-service-initiator")).toBe("correct");
    expect(calls[0]!.headers.get("x-opengeni-service-context")).toBe("{}");
    expect(calls[1]!.headers.get("x-opengeni-service-context")).toBeNull();
  });

  test("rejects asUser and linked-user chaining in either direction", () => {
    const { client, calls } = fixture();
    const link = { linkId: crypto.randomUUID(), expectedLinkRevision: 1 };
    expect(() => client.asUser("alice").asService("jobs")).toThrow("mutually exclusive");
    expect(() => client.asLinkedUser("alice", link).asService("jobs")).toThrow(
      "mutually exclusive",
    );
    expect(() => client.asService("jobs").asUser("alice")).toThrow("mutually exclusive");
    expect(() => client.asService("jobs").asLinkedUser("alice", link)).toThrow(
      "mutually exclusive",
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects conflicting static and dynamic custom attribution before fetch", async () => {
    expect(() =>
      fixture({ headers: { "X-OpenGeni-External-Actor": "configured" } }).client.asService("jobs"),
    ).toThrow("mutually exclusive");
    for (const name of ["X-OpenGeni-Service-Initiator", "X-OpenGeni-Service-Context"]) {
      expect(() => fixture({ headers: { [name]: "configured" } }).client.asUser("alice")).toThrow(
        "mutually exclusive",
      );
    }
    const service = fixture({ headers: () => ({ "X-OpenGeni-External-Actor": "configured" }) });
    await expect(service.client.asService("jobs").listWorkspaces()).rejects.toThrow(
      "mutually exclusive",
    );
    await expect(
      service.client.asService("jobs").createSession("workspace", { initialMessage: "Run" }),
    ).rejects.toThrow("mutually exclusive");
    await expect(service.client.asService("jobs").requestVoid("DELETE", "/probe")).rejects.toThrow(
      "mutually exclusive",
    );
    expect(service.calls).toHaveLength(0);
    for (const name of ["X-OpenGeni-Service-Initiator", "X-OpenGeni-Service-Context"]) {
      const user = fixture({ headers: () => ({ [name]: "configured" }) });
      await expect(user.client.asUser("alice").listWorkspaces()).rejects.toThrow(
        "mutually exclusive",
      );
      expect(user.calls).toHaveLength(0);
    }
  });

  test("validates the full name including the 64-character limit and header injection", () => {
    const { client, calls } = fixture();
    for (const name of ["a", "0", "jobs:daily.report_1-v2", "a".repeat(64)])
      expect(() => client.asService(name)).not.toThrow();
    for (const name of [
      "",
      "a".repeat(65),
      "Jobs",
      "_jobs",
      "jobs daily",
      " jobs",
      "jobs/",
      "jobs\n",
      "jobs\r\nInjected: yes",
      "jobs\0",
      "😀",
    ])
      expect(() => client.asService(name)).toThrow("Invalid service initiator name");
    expect(() => client.asService(42 as unknown as string)).toThrow(
      "Invalid service initiator name",
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects non-object contexts, nested values, non-JSON scalars and non-finite numbers", () => {
    const { client, calls } = fixture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const context of [
      null,
      [],
      "text",
      1,
      true,
      new Date(),
      new Map(),
      Object.create({ inherited: true }),
      { nested: {} },
      { list: [] },
      { value: null },
      { value: undefined },
      { value: 1n },
      { value: () => "text" },
      { value: Symbol("text") },
      { value: NaN },
      { value: Infinity },
      { value: -Infinity },
      { toJSON: () => ({ different: true }) },
      cyclic,
    ])
      expect(() => client.asService("jobs", context as ServiceContext)).toThrow(
        "Invalid service context",
      );
    expect(calls).toHaveLength(0);
  });

  test("bounds serialized wire JSON to 2048 bytes and round-trips Unicode safely", async () => {
    const { client, calls } = fixture();
    const boundary = { data: "x".repeat(2037) };
    expect(new TextEncoder().encode(JSON.stringify(boundary)).byteLength).toBe(2048);
    await client.asService("jobs", boundary).listWorkspaces();
    expect(() => client.asService("jobs", { data: "x".repeat(2038) })).toThrow("2 KiB");
    expect(() => client.asService("jobs", { data: "😀".repeat(171) })).toThrow("2 KiB");
    const unicode = { 任务: "résumé/😀\n", count: 1.5, ok: false };
    await client.asService("jobs", unicode).listWorkspaces();
    const header = calls[1]!.headers.get("x-opengeni-service-context")!;
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(header)).toEqual(unicode);
    await client
      .asService("jobs", Object.assign(Object.create(null), { ok: true }))
      .listWorkspaces();
    expect(calls[2]!.headers.get("x-opengeni-service-context")).toBe('{"ok":true}');
  });

  test("is unavailable on the browser entry and refuses browser execution", () => {
    expect("asService" in new BrowserClient({ baseUrl: "/api/opengeni" })).toBe(false);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    try {
      expect(() => fixture().client.asService("jobs")).toThrow("server-side API");
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
