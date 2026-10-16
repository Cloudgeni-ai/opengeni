import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JevCircuitBreaker, type JevFetch } from "@opengeni/jev";
import { createObservability } from "@opengeni/observability";
import { SandboxChannelAService, type ChannelASession } from "@opengeni/runtime/sandbox";
import { testSettings } from "@opengeni/testing";
import type {
  CodeSearchFetchWrapper,
  CodeSearchTransportInvocation,
} from "../src/activities/agent-turn/code-search";

// Run the identical contracts against the actual bundled factory as well as source.
const subject = process.env.CODE_SEARCH_TRANSPORT_BUNDLE
  ? await import(resolve(process.env.CODE_SEARCH_TRANSPORT_BUNDLE))
  : await import("../src/activities/agent-turn/code-search");
const { codeSearchToolDefinitions, codeSearchWorkspaceFromChannel } =
  subject as typeof import("../src/activities/agent-turn/code-search");
const baseline = process.env.CODE_SEARCH_BASE_BUNDLE
  ? await import(resolve(process.env.CODE_SEARCH_BASE_BUNDLE))
  : null;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const settings = {
  jevApiKey: "synthetic-test-only",
  jevBaseUrl: "https://jev.test",
  jevModel: "jev-test-pinned",
  jevRequestTimeoutMs: 5_000,
};
const observability = createObservability(testSettings(), { component: "worker" });
const scope = {
  accountId: "account",
  workspaceId: "workspace",
  sessionId: "session",
  turnId: "turn",
  attemptId: "attempt",
  executionGeneration: 7,
};
const args = {
  question: "Where does resolveWidgetPolicy decide the widget default?",
  keywords: ["resolveWidgetPolicy"],
};
const context = (operationId: string, signal?: AbortSignal) => ({
  operationId,
  caller: { kind: "model" as const, subjectId: "synthetic-subject" },
  ...(signal ? { signal } : {}),
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "code-search-transport-"));
  roots.push(root);
  writeFileSync(
    join(root, "policy.ts"),
    [
      "// Decides the widget default.",
      "export function resolveWidgetPolicy(enabled: boolean) {",
      "  return enabled ? 'on' : 'off';",
      "}",
    ].join("\n"),
  );
  const session = {
    exec: async (a: { cmd: string; workdir?: string }) => {
      const proc = Bun.spawn(["/bin/sh", "-c", a.cmd], {
        cwd: resolve(root, a.workdir ?? "."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
    readFile: async (a: { path: string }) => Bun.file(resolve(root, a.path)).bytes(),
  } as ChannelASession;
  return codeSearchWorkspaceFromChannel(new SandboxChannelAService({ session }));
}

function success(init: RequestInit) {
  const payload = JSON.parse(String(init.body));
  const answers = Object.fromEntries(
    Object.entries(payload.questions).map(([id]) => [id, { type: "noul", noul: 0.9 }]),
  );
  return new Response(
    JSON.stringify({
      answers,
      model: "jev-test-pinned",
      usage: { input_tokens: 1000, output_tokens: 7 },
    }),
    { headers: { "content-type": "application/json", "x-request-id": "synthetic" } },
  );
}
function factory(
  fetch: JevFetch,
  wrapFetch?: CodeSearchFetchWrapper,
  extra: Partial<typeof settings> = {},
) {
  const source = workspace();
  const definition = codeSearchToolDefinitions({
    enabled: true,
    settings: { ...settings, ...extra },
    backend: "docker",
    observability,
    workspace: async () => source,
    fetch: fetch as typeof globalThis.fetch,
    breaker: new JevCircuitBreaker(),
    ...(wrapFetch ? { transport: { scope, wrapFetch } } : {}),
  })[0]!;
  return definition;
}
const pass: CodeSearchFetchWrapper = (_identity, next) => (url, init) => next(url, init);

describe("normal code_search transport seam", () => {
  test("outer factory forwards fetch and no-hook result/schema/payload parity is exact", async () => {
    const clock = spyOn(performance, "now").mockReturnValue(100);
    try {
      const requests: string[][] = [[], []];
      const responses: unknown[] = [];
      for (let i = 0; i < 2; i++) {
        const definition = factory(
          async (_url, init) => {
            if (init.method === "GET") return new Response("ok");
            requests[i]!.push(String(init.body));
            return success(init);
          },
          i ? pass : undefined,
        );
        responses.push({
          result: await definition.execute(args, context("parity")),
          identity: definition.identity,
          description: definition.description,
          inputSchema: definition.inputSchema,
          annotations: definition.annotations,
        });
      }
      expect(requests[0]!.length).toBeGreaterThan(1);
      expect(requests[1]).toEqual(requests[0]);
      expect(responses[1]).toEqual(responses[0]);
    } finally {
      clock.mockRestore();
    }
  });

  for (const retry of ["network", "429", "503", "body-error"] as const) {
    test(`every physical ${retry} retry retains invocation identity and original payload`, async () => {
      const receipts: {
        identity: CodeSearchTransportInvocation;
        method: string | undefined;
        body: unknown;
      }[] = [];
      const physical: { url: string; init: RequestInit }[] = [];
      let firstBody: unknown;
      let retries = 0;
      const definition = factory(
        async (url, init) => {
          physical.push({ url, init });
          if (init.method === "GET") return new Response("ok");
          firstBody ??= init.body;
          if (init.body === firstBody && retries++ < 2) {
            if (retry === "network") throw new TypeError("synthetic connection lost");
            if (retry === "body-error")
              return new Response(
                new ReadableStream({
                  start(c) {
                    c.error(new Error("synthetic body failure"));
                  },
                }),
              );
            return new Response("retry", {
              status: Number(retry),
              headers: { "retry-after": "0" },
            });
          }
          return success(init);
        },
        (identity, next) => async (url, init) => {
          receipts.push({ identity, method: init.method, body: init.body });
          return next(url, init);
        },
      );
      const result = await definition.execute(args, context("retry-op"));
      expect(result.isError).toBe(false);
      expect(receipts.length).toBe(physical.length);
      expect(receipts.filter((r) => r.body === firstBody)).toHaveLength(3);
      expect(receipts.some((r) => r.method === "GET")).toBe(true);
      expect(receipts.every((r) => r.identity.operationId === "retry-op")).toBe(true);
      expect(receipts.every((r) => Object.isFrozen(r.identity))).toBe(true);
      expect(receipts[0]!.identity).toEqual({ ...scope, operationId: "retry-op" });
    });
  }

  test("concurrent invocations and detached warmup work never borrow another operation", async () => {
    const events: { op: string; body: string; method: string | undefined }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const definition = factory(
      async (_url, init) => {
        await gate;
        if (init.method === "GET") return new Response("ok");
        return success(init);
      },
      (identity, next) => async (url, init) => {
        events.push({
          op: identity.operationId,
          body: String(init.body ?? ""),
          method: init.method,
        });
        return next(url, init);
      },
    );
    const a = definition.execute(
      { ...args, question: args.question + " ALPHA_MARKER" },
      context("alpha"),
    );
    const b = definition.execute(
      { ...args, question: args.question + " BETA_MARKER" },
      context("beta"),
    );
    await Bun.sleep(25);
    release();
    const results = await Promise.all([a, b]);
    expect(results.every((r) => !r.isError)).toBe(true);
    for (const op of ["alpha", "beta"]) {
      expect(events.filter((r) => r.op === op && r.method === "POST").length).toBeGreaterThan(1);
    }
    for (const event of events.filter((r) => r.method === "POST")) {
      expect(event.body).toContain(event.op === "alpha" ? "ALPHA_MARKER" : "BETA_MARKER");
      expect(event.body).not.toContain(event.op === "alpha" ? "BETA_MARKER" : "ALPHA_MARKER");
    }
  });

  test("headers are observable without consuming/buffering the original response body", async () => {
    let release!: () => void;
    const bodyGate = new Promise<void>((r) => {
      release = r;
    });
    let headersSeen!: () => void;
    const headers = new Promise<void>((r) => {
      headersSeen = r;
    });
    let stalled = false;
    const observed: boolean[] = [];
    const definition = factory(
      async (_url, init) => {
        if (init.method === "GET") return new Response("ok");
        if (stalled) return success(init);
        stalled = true;
        const bytes = await success(init).text();
        return new Response(
          new ReadableStream({
            async start(c) {
              await bodyGate;
              c.enqueue(new TextEncoder().encode(bytes));
              c.close();
            },
          }),
          { headers: { "x-request-id": "headers-only" } },
        );
      },
      (_identity, next) => async (url, init) => {
        const response = await next(url, init);
        if (response.headers.get("x-request-id") === "headers-only") {
          observed.push(response.bodyUsed);
          headersSeen();
        }
        return response;
      },
    );
    let done = false;
    const run = Promise.resolve(definition.execute(args, context("body"))).then((r) => {
      done = true;
      return r;
    });
    await headers;
    expect(observed).toEqual([false]);
    expect(done).toBe(false);
    release();
    expect((await run).isError).toBe(false);
  });

  test("native abort reason remains authoritative; no wrapper retry or false completion", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic caller cancellation");
    const events: string[] = [];
    let dispatched!: () => void;
    const dispatch = new Promise<void>((r) => {
      dispatched = r;
    });
    const definition = factory(
      async (_url, init) => {
        if (init.method === "GET") return new Response("ok");
        dispatched();
        return new Promise<Response>((_resolve, reject) =>
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
        );
      },
      (identity, next) => async (url, init) => {
        if (init.method === "POST") events.push(identity.operationId);
        return next(url, init);
      },
    );
    const run = Promise.resolve(definition.execute(args, context("cancel-op", controller.signal)));
    await dispatch;
    controller.abort(reason);
    expect(await run.catch((e) => e)).toBe(reason);
    expect(events).toEqual(["cancel-op"]);
  });

  test("timeout stays failed/uncertain and retains each physical retry", async () => {
    let posts = 0;
    const failed: unknown[] = [];
    const reasons: unknown[] = [];
    const definition = factory(
      async (_url, init) => {
        if (init.method === "GET") return new Response("ok");
        posts++;
        return new Promise<Response>((_resolve, reject) =>
          init.signal!.addEventListener(
            "abort",
            () => {
              reasons.push(init.signal!.reason);
              reject(init.signal!.reason);
            },
            { once: true },
          ),
        );
      },
      (_identity, next) => async (url, init) => {
        try {
          return await next(url, init);
        } catch (e) {
          failed.push(e);
          throw e;
        }
      },
      { jevRequestTimeoutMs: 10 },
    );
    const result = await definition.execute(args, context("timeout-op"));
    expect(result.isError).toBe(true);
    expect(posts).toBe(3);
    expect(failed).toHaveLength(3);
    expect(failed).toEqual(reasons);
    for (let i = 0; i < reasons.length; i++) expect(failed[i]).toBe(reasons[i]);
    expect(failed.every((e) => e instanceof Error && e.name === "JevUnavailableError")).toBe(true);
  });

  test("default transport is forwarded without replacing the normal client", async () => {
    let physical = 0;
    const captured: CodeSearchTransportInvocation[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
      physical++;
      return init?.method === "GET" ? new Response("ok") : success(init!);
    }) as typeof fetch);
    try {
      const source = workspace();
      const [definition] = codeSearchToolDefinitions({
        enabled: true,
        settings,
        backend: "docker",
        observability,
        workspace: async () => source,
        breaker: new JevCircuitBreaker(),
        transport: {
          scope,
          wrapFetch: (identity, next) => async (url, init) => {
            captured.push(identity);
            return next(url, init);
          },
        },
      });
      expect((await definition!.execute(args, context("default-fetch"))).isError).toBe(false);
      expect(physical).toBeGreaterThan(1);
      expect(captured).toHaveLength(physical);
      expect(captured.every((i) => i.operationId === "default-fetch")).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("hook construction error is not swallowed or converted to a successful search", async () => {
    let physical = 0;
    const denied = new Error("synthetic observer failure");
    const definition = factory(
      async (_url, init) => {
        physical++;
        return success(init);
      },
      () => {
        throw denied;
      },
    );
    expect(await Promise.resolve(definition.execute(args, context("denied"))).catch((e) => e)).toBe(
      denied,
    );
    expect(physical).toBe(0);
    // No missing/unknown result is manufactured by the seam.
  });

  test("scope is snapshotted from the trusted factory, not model arguments or later mutation", async () => {
    const captured: CodeSearchTransportInvocation[] = [];
    const ownedScope = { ...scope };
    const source = workspace();
    const [definition] = codeSearchToolDefinitions({
      enabled: true,
      settings,
      backend: "docker",
      observability,
      workspace: async () => source,
      breaker: new JevCircuitBreaker(),
      fetch: (async (_url, init) =>
        init?.method === "GET" ? new Response("ok") : success(init!)) as typeof fetch,
      transport: {
        scope: ownedScope,
        wrapFetch: (identity, next) => {
          captured.push(identity);
          return next;
        },
      },
    });
    ownedScope.sessionId = "mutated-after-construction";
    expect((await definition!.execute(args, context("scope-op"))).isError).toBe(false);
    expect(captured).toEqual([{ ...scope, operationId: "scope-op" }]);
    const invalid = await definition!.execute(
      { ...args, operationId: "model-spoof" },
      context("real-op"),
    );
    expect(invalid.isError).toBe(true);
    expect(captured).toHaveLength(1);
  });

  for (const failure of ["http401", "malformed", "missing-usage", "other-model"] as const) {
    test(`raw ${failure} outcome remains visible without rewriting provider response`, async () => {
      let posts = 0;
      const bodies: string[] = [];
      const statuses: number[] = [];
      const definition = factory(
        async (_url, init) => {
          if (init.method === "GET") return new Response("ok");
          posts++;
          if (failure === "http401") return new Response("unauthorized", { status: 401 });
          if (failure === "malformed") return new Response("not json");
          const response = JSON.parse(await success(init).text());
          if (failure === "missing-usage") delete response.usage;
          if (failure === "other-model") response.model = "unexpected-model";
          return Response.json(response);
        },
        (_identity, next) => async (url, init) => {
          const response = await next(url, init);
          if (init.method === "POST") {
            expect(response.bodyUsed).toBe(false);
            statuses.push(response.status);
            bodies.push(await response.clone().text());
          }
          return response;
        },
      );
      const result = await definition.execute(args, context("raw-op"));
      expect(statuses).toHaveLength(posts);
      if (failure === "http401" || failure === "malformed") {
        expect(result.isError).toBe(true);
        expect(posts).toBe(1);
      } else {
        // Detection/policy belongs to the supplied observer, not a new algorithm gate.
        expect(result.isError).toBe(false);
        expect(
          bodies.every((b) =>
            failure === "other-model" ? b.includes("unexpected-model") : !b.includes('"usage"'),
          ),
        ).toBe(true);
      }
    });
  }

  test.skipIf(!baseline)("no-hook factory preserves frozen-base payloads and results", async () => {
    const clock = spyOn(performance, "now").mockReturnValue(100);
    try {
      const payloads: string[][] = [[], []];
      const results: unknown[] = [];
      for (let i = 0; i < 2; i++) {
        const source = workspace();
        const create = i
          ? subject.createCodeSearchAttemptToolDefinition
          : baseline.createCodeSearchAttemptToolDefinition;
        const definition = create({
          settings,
          apiKey: settings.jevApiKey,
          observability,
          workspace: async () => source,
          breaker: new JevCircuitBreaker(),
          fetch: async (_url: string, init: RequestInit) => {
            if (init.method === "GET") return new Response("ok");
            payloads[i]!.push(String(init.body));
            return success(init);
          },
        });
        results.push(await definition.execute(args, context("base-parity")));
      }
      expect(payloads[0]!.length).toBeGreaterThan(1);
      expect(payloads[1]).toEqual(payloads[0]);
      expect(results[1]).toEqual(results[0]);
    } finally {
      clock.mockRestore();
    }
  });
});
