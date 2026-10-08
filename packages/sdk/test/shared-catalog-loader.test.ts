import { describe, expect, test } from "bun:test";
import { createSharedCatalogLoader } from "../src/shared-catalog-loader";
import { createSiteToolBridge } from "../src/site";
import { OpenGeniClient } from "../src/index";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "../src/types";
import type { ToolGatewayCatalog } from "../src/types";

type Catalog = { digest: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** A fetcher whose every request is held until the test settles it. */
function controlledFetcher() {
  const requests: Array<
    { refresh: boolean; signal: AbortSignal } & ReturnType<typeof deferred<Catalog>>
  > = [];
  return {
    requests,
    fetch: (refresh: boolean, signal: AbortSignal) => {
      const request = { refresh, signal, ...deferred<Catalog>() };
      signal.addEventListener("abort", () => request.reject(signal.reason), { once: true });
      requests.push(request);
      return request.promise;
    },
  };
}

describe("shared catalog loader", () => {
  test("concurrent cold callers share one request and later callers use the snapshot", async () => {
    const fetcher = controlledFetcher();
    const loader = createSharedCatalogLoader(fetcher.fetch);
    const waiters = Array.from({ length: 9 }, () => loader.load());
    expect(fetcher.requests).toHaveLength(1);
    fetcher.requests[0]!.resolve({ digest: "d1" });
    expect((await Promise.all(waiters)).map((catalog) => catalog.digest)).toEqual(
      Array(9).fill("d1"),
    );
    expect((await loader.load()).digest).toBe("d1");
    expect(fetcher.requests).toHaveLength(1);
  });

  test("one waiter's abort rejects only that waiter", async () => {
    const fetcher = controlledFetcher();
    const loader = createSharedCatalogLoader(fetcher.fetch);
    const aborted = new AbortController();
    const cancelled = loader.load({ signal: aborted.signal });
    const sibling = loader.load({ signal: new AbortController().signal });
    aborted.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    fetcher.requests[0]!.resolve({ digest: "d1" });
    expect((await sibling).digest).toBe("d1");
    expect(fetcher.requests).toHaveLength(1);
    expect(fetcher.requests[0]!.signal.aborted).toBe(false);
    const already = new AbortController();
    already.abort(new Error("caller gone"));
    await expect(loader.load({ signal: already.signal })).rejects.toThrow("caller gone");
  });

  test("a request abandoned by every waiter is cancelled and never captures later callers", async () => {
    const fetcher = controlledFetcher();
    const loader = createSharedCatalogLoader(fetcher.fetch);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const waiting = loader.load({ signal: controller.signal });
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      expect(fetcher.requests[attempt]!.signal.aborted).toBe(true);
    }
    expect(fetcher.requests).toHaveLength(3);
    // A waiter without a signal keeps the shared request alive for itself.
    const controller = new AbortController();
    const abandoned = loader.load({ signal: controller.signal });
    const kept = loader.load();
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher.requests[3]!.signal.aborted).toBe(false);
    fetcher.requests[3]!.resolve({ digest: "d1" });
    expect((await kept).digest).toBe("d1");
  });

  test("an abandoned stale reload is cancelled and a later rejection reloads again", async () => {
    const fetcher = controlledFetcher();
    const loader = createSharedCatalogLoader(fetcher.fetch);
    const initial = loader.load();
    fetcher.requests[0]!.resolve({ digest: "d1" });
    await initial;
    const cancelled = new AbortController();
    const abandonedReload = loader.reloadAfterStale("d1", cancelled.signal);
    const sibling = loader.reloadAfterStale("d1", new AbortController().signal);
    cancelled.abort();
    await expect(abandonedReload).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher.requests[1]!.signal.aborted).toBe(false);
    fetcher.requests[1]!.resolve({ digest: "d2" });
    expect((await sibling).digest).toBe("d2");

    const alone = new AbortController();
    const lonely = loader.reloadAfterStale("d2", alone.signal);
    alone.abort();
    await expect(lonely).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher.requests[2]!.signal.aborted).toBe(true);
    const retry = loader.reloadAfterStale("d2");
    expect(fetcher.requests).toHaveLength(4);
    expect(fetcher.requests[3]!.refresh).toBe(true);
    fetcher.requests[3]!.resolve({ digest: "d3" });
    expect((await retry).digest).toBe("d3");
  });

  test("a running stale reload superseded by a newer catalog is never joined", async () => {
    const fetcher = controlledFetcher();
    const loader = createSharedCatalogLoader(fetcher.fetch);
    const initial = loader.load();
    fetcher.requests[0]!.resolve({ digest: "d1" });
    await initial;
    const first = loader.reloadAfterStale("d1");
    const explicit = loader.load({ refresh: true });
    fetcher.requests[2]!.resolve({ digest: "d3" });
    expect((await explicit).digest).toBe("d3");
    const late = loader.reloadAfterStale("d1");
    expect(fetcher.requests).toHaveLength(4);
    fetcher.requests[1]!.resolve({ digest: "d2" });
    expect((await first).digest).toBe("d2");
    fetcher.requests[3]!.resolve({ digest: "d4" });
    expect((await late).digest).toBe("d4");
    expect((await loader.load()).digest).toBe("d4");
  });

  test("a failed load is shared by its waiters but never cached", async () => {
    const fetcher = controlledFetcher();
    const loader = createSharedCatalogLoader(fetcher.fetch);
    const waiters = Promise.allSettled([loader.load(), loader.load()]);
    fetcher.requests[0]!.reject(new Error("unavailable"));
    expect(
      (await waiters).map((settled) =>
        settled.status === "rejected" ? (settled.reason as Error).message : "fulfilled",
      ),
    ).toEqual(["unavailable", "unavailable"]);
    const retry = loader.load();
    expect(fetcher.requests).toHaveLength(2);
    fetcher.requests[1]!.resolve({ digest: "d1" });
    expect((await retry).digest).toBe("d1");
  });

  test("callers rejected on one stale digest share one post-rejection refresh", async () => {
    const fetcher = controlledFetcher();
    const loader = createSharedCatalogLoader(fetcher.fetch);
    const initial = loader.load();
    fetcher.requests[0]!.resolve({ digest: "d1" });
    await initial;
    const reloads = Array.from({ length: 4 }, () => loader.reloadAfterStale("d1"));
    expect(fetcher.requests).toHaveLength(2);
    expect(fetcher.requests[1]!.refresh).toBe(true);
    fetcher.requests[1]!.resolve({ digest: "d2" });
    expect((await Promise.all(reloads)).map((catalog) => catalog.digest)).toEqual(
      Array(4).fill("d2"),
    );
    // A late caller rejected on the same digest reuses the still-current result.
    expect((await loader.reloadAfterStale("d1")).digest).toBe("d2");
    expect(fetcher.requests).toHaveLength(2);
    // A refresh that returned the same digest proves nothing newer.
    const again = loader.reloadAfterStale("d2");
    fetcher.requests[2]!.resolve({ digest: "d2" });
    await again;
    const next = loader.reloadAfterStale("d2");
    expect(fetcher.requests).toHaveLength(4);
    fetcher.requests[3]!.resolve({ digest: "d3" });
    expect((await next).digest).toBe("d3");
  });

  test("a stale rejection never joins a load that started before it", async () => {
    const fetcher = controlledFetcher();
    const loader = createSharedCatalogLoader(fetcher.fetch);
    const initial = loader.load();
    fetcher.requests[0]!.resolve({ digest: "d1" });
    await initial;
    const explicit = loader.load({ refresh: true });
    const stale = loader.reloadAfterStale("d1");
    expect(fetcher.requests).toHaveLength(3);
    // The older explicit refresh completes late with an outdated catalog; it
    // is returned to its own caller but never replaces the newer state.
    fetcher.requests[2]!.resolve({ digest: "d3" });
    expect((await stale).digest).toBe("d3");
    fetcher.requests[1]!.resolve({ digest: "d1-late" });
    expect((await explicit).digest).toBe("d1-late");
    expect((await loader.load()).digest).toBe("d3");
  });

  test("explicit refresh always starts a new request and invalidation drops only the named digest", async () => {
    const fetcher = controlledFetcher();
    const loader = createSharedCatalogLoader(fetcher.fetch);
    const initial = loader.load();
    fetcher.requests[0]!.resolve({ digest: "d1" });
    await initial;
    loader.invalidate("other");
    expect((await loader.load()).digest).toBe("d1");
    const refreshed = loader.load({ refresh: true });
    expect(fetcher.requests).toHaveLength(2);
    expect(fetcher.requests[1]!.refresh).toBe(true);
    fetcher.requests[1]!.resolve({ digest: "d2" });
    expect((await refreshed).digest).toBe("d2");
    loader.invalidate("d2");
    const reloaded = loader.load();
    expect(fetcher.requests).toHaveLength(3);
    fetcher.requests[2]!.resolve({ digest: "d3" });
    expect((await reloaded).digest).toBe("d3");
  });
});

const workspaceId = "11111111-1111-4111-8111-111111111111";
const catalog: ToolGatewayCatalog = {
  version: 1,
  accountId: "22222222-2222-4222-8222-222222222222",
  workspaceId,
  generation: 1,
  digest: "a".repeat(64),
  createdAt: "2026-09-02T00:00:00.000Z",
  entries: [
    {
      identity: { serverId: "metrics", toolName: "query" },
      modelName: "metrics__query",
      codemodePath: ["metrics", "query"],
      inputSchema: { type: "object" },
      source: "mcp",
      approval: "none",
    },
  ],
};
const refreshedCatalog = { ...catalog, digest: "b".repeat(64) };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    },
  });
}

const staleBody = {
  error: {
    code: "conflict",
    message: "The workspace tool catalog changed; retry with the current catalog.",
    retryable: true,
    details: { code: "catalog_stale" },
  },
};

describe("workspace tools catalog single flight", () => {
  test("parallel cold dashboard loaders fetch the catalog once; a stale storm refreshes once", async () => {
    let catalogRequests = 0;
    let current = catalog;
    const gate = deferred<void>();
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          catalogRequests += 1;
          await gate.promise;
          return json(current);
        }
        const body = (await request.json()) as { catalogDigest: string; operationId: string };
        if (body.catalogDigest !== current.digest) return json(staleBody, 409);
        return json({
          operationId: body.operationId,
          catalogDigest: current.digest,
          result: { content: [{ type: "text", text: "ok" }] },
        });
      }) as typeof fetch,
    });
    const tools = client.tools.forWorkspace(workspaceId);
    const cold = Array.from({ length: 9 }, () => tools.metrics!.query!({}));
    await Bun.sleep(0);
    gate.resolve();
    await Promise.all(cold);
    expect(catalogRequests).toBe(1);

    current = refreshedCatalog;
    await Promise.all(Array.from({ length: 4 }, () => tools.metrics!.query!({})));
    expect(catalogRequests).toBe(2);
    expect((await tools.$catalog()).digest).toBe(refreshedCatalog.digest);
  });

  test("aborting one cold caller does not cancel the shared catalog request", async () => {
    let catalogRequests = 0;
    const gate = deferred<void>();
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          catalogRequests += 1;
          expect(request.signal.aborted).toBe(false);
          await gate.promise;
          return json(catalog);
        }
        const body = (await request.json()) as { operationId: string };
        return json({
          operationId: body.operationId,
          catalogDigest: catalog.digest,
          result: { content: [] },
        });
      }) as typeof fetch,
    });
    const tools = client.tools.forWorkspace(workspaceId);
    const controller = new AbortController();
    const cancelled = tools.metrics!.query!({}, { signal: controller.signal });
    const sibling = tools.metrics!.query!({});
    await Bun.sleep(0);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve();
    await sibling;
    expect(catalogRequests).toBe(1);
  });
});

describe("host Site bridge catalog single flight", () => {
  test("a Site catalog request abandoned by every frame request cancels the host load", async () => {
    const signals: AbortSignal[] = [];
    const bridge = createSiteToolBridge({
      workspaceId,
      workspaceTools: {
        $catalog: async (options = {}) => {
          signals.push(options.signal!);
          return await new Promise<ToolGatewayCatalog>((_resolve, reject) =>
            options.signal!.addEventListener("abort", () => reject(options.signal!.reason)),
          );
        },
      },
      callTool: async () => {
        throw new Error("unexpected tool call");
      },
    });
    const first = new AbortController();
    const second = new AbortController();
    const waits = Promise.allSettled(
      [first, second].map((controller) => bridge.catalog({ signal: controller.signal })),
    );
    first.abort();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    second.abort();
    expect(signals[0]!.aborted).toBe(true);
    expect(
      (await waits).map((settled) =>
        settled.status === "rejected" ? (settled.reason as Error).name : "fulfilled",
      ),
    ).toEqual(["AbortError", "AbortError"]);
  });

  test("concurrent Site panels project one catalog; one stale storm reloads once with refresh", async () => {
    const catalogCalls: Array<{ refresh?: boolean }> = [];
    let current: ToolGatewayCatalog = catalog;
    const gate = deferred<void>();
    const bridge = createSiteToolBridge({
      workspaceId,
      artifactId: "site",
      siteVersionId: "version",
      requestedTools: [catalog.entries[0]!.identity],
      workspaceTools: {
        $catalog: async (options = {}) => {
          catalogCalls.push(options.refresh ? { refresh: true } : {});
          await gate.promise;
          return current;
        },
      },
      callTool: async ({ request }) => {
        if (request.catalogDigest !== current.digest)
          throw Object.assign(new Error("stale"), { code: "catalog_stale" });
        return {
          operationId: crypto.randomUUID(),
          catalogDigest: current.digest,
          result: { content: [] },
        };
      },
      isCatalogStale: (error) => (error as { code?: string }).code === "catalog_stale",
    });
    const signal = () => new AbortController().signal;
    const aborted = new AbortController();
    const cancelledCatalog = bridge.catalog({ signal: aborted.signal });
    const panels = Array.from({ length: 9 }, () =>
      bridge.call(
        { catalogDigest: "ignored", identity: catalog.entries[0]!.identity, arguments: {} },
        { signal: signal() },
      ),
    );
    aborted.abort();
    await expect(cancelledCatalog).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve();
    await Promise.all(panels);
    expect(catalogCalls).toEqual([{}]);

    current = refreshedCatalog;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        bridge.call(
          { catalogDigest: "ignored", identity: catalog.entries[0]!.identity, arguments: {} },
          { signal: signal() },
        ),
      ),
    );
    expect(catalogCalls).toEqual([{}, { refresh: true }]);
    expect((await bridge.catalog({ signal: signal() })).digest).toBe(refreshedCatalog.digest);
  });
});
