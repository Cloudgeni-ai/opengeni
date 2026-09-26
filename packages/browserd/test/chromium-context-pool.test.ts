import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  EphemeralChromiumContextPool,
  CdpTransportError,
  type BrowserCdpConnection,
  type CdpEvent,
} from "../src";

function fixture(terminate?: () => Promise<void>) {
  const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
  const connections: Array<{ emit: (method: string, params: Record<string, unknown>) => void }> =
    [];
  let launches = 0;
  let stops = 0;
  let contexts = 0;
  let fail = "";
  const pool = new EphemeralChromiumContextPool({
    authorityKey: "trusted-owner-and-egress",
    maxContexts: 2,
    launch: async () => {
      launches++;
      return {
        run: async <T>() => ({ cdpUrl: "ws://127.0.0.1/fixture" }) as T,
        terminate: async () => {
          await terminate?.();
          stops++;
        },
      };
    },
    connect: async () => {
      const listeners = new Map<string, (event: CdpEvent) => void>();
      let closed = false;
      connections.push({
        emit: (method, params) => listeners.get(method)?.({ method, params, sessionId: null }),
      });
      const connection: BrowserCdpConnection = {
        send: async <T>(method: string, params: Readonly<Record<string, unknown>> = {}) => {
          if (closed || method === fail) throw new CdpTransportError("fixture transport loss");
          calls.push({ method, params });
          let result: unknown = {};
          if (method === "Target.createBrowserContext")
            result = { browserContextId: `context-${++contexts}` };
          if (method === "Target.getTargets")
            result = {
              targetInfos: [
                {
                  targetId: "own",
                  browserContextId: "context-1",
                  type: "page",
                  url: "https://example.com",
                  title: "own",
                },
                {
                  targetId: "foreign",
                  browserContextId: "context-2",
                  type: "page",
                  url: "https://example.org",
                  title: "foreign",
                },
                { targetId: "default", type: "page", url: "about:blank", title: "default" },
              ],
            };
          return result as T;
        },
        on: (method, listener) => {
          listeners.set(method, listener);
          return () => {
            listeners.delete(method);
          };
        },
        waitForEvent: async () => {
          throw new Error("unexpected wait");
        },
        close: () => {
          closed = true;
        },
      };
      return connection;
    },
  });
  const options = () => ({ browserSessionId: randomUUID(), controllerGeneration: randomUUID() });
  return {
    pool,
    calls,
    connections,
    options,
    fail: (method: string) => {
      fail = method;
    },
    counts: () => ({ launches, stops }),
  };
}

test("context pool isolates discovery and rejects foreign/default target reads and closes before dispatch", async () => {
  const f = fixture();
  const a = await f.pool.createDriver("trusted-owner-and-egress", f.options());
  const b = await f.pool.createDriver("trusted-owner-and-egress", f.options());
  expect((await a.listTargets()).map((target) => target.id)).toEqual(["own"]);
  expect((await b.listTargets()).map((target) => target.id)).toEqual(["foreign"]);
  for (const targetId of ["foreign", "default"]) {
    await expect(a.closeTarget(targetId)).rejects.toThrow("browser target does not exist");
    await expect(a.captureScreenshot(targetId)).rejects.toThrow("browser target does not exist");
    await expect(a.selectTarget(targetId)).rejects.toThrow("browser target does not exist");
  }
  expect(
    f.calls.some((call) =>
      [
        "Target.closeTarget",
        "Target.attachToTarget",
        "Page.captureScreenshot",
        "Target.activateTarget",
      ].includes(call.method),
    ),
  ).toBe(false);
  await a.close();
  expect(f.counts()).toEqual({ launches: 1, stops: 0 });
  expect((await b.listTargets()).map((target) => target.id)).toEqual(["foreign"]);
  await b.close();
  expect(f.counts()).toEqual({ launches: 1, stops: 1 });
  expect(
    f.calls
      .filter((call) => call.method === "Target.disposeBrowserContext")
      .map((call) => call.params.browserContextId),
  ).toEqual(["context-1", "context-2"]);
  await expect(f.pool.createDriver("trusted-owner-and-egress", f.options())).rejects.toThrow(
    "generation ended",
  );
});

test("authority and bounded capacity checks do not evict existing contexts", async () => {
  const f = fixture();
  await expect(f.pool.createDriver("another-owner", f.options())).rejects.toThrow(
    "authority mismatch",
  );
  expect(f.counts().launches).toBe(0);
  const [a, b] = await Promise.all([
    f.pool.createDriver("trusted-owner-and-egress", f.options()),
    f.pool.createDriver("trusted-owner-and-egress", f.options()),
  ]);
  await expect(f.pool.createDriver("trusted-owner-and-egress", f.options())).rejects.toThrow(
    "capacity",
  );
  expect(await a.listTargets()).toHaveLength(1);
  expect(await b.listTargets()).toHaveLength(1);
  await f.pool.close();
  await a.close();
  await b.close();
  expect(f.counts().stops).toBe(1);
});

test("download and geolocation setup is context scoped; foreign process-wide download events are ignored", async () => {
  const f = fixture();
  let downloads = 0;
  const a = await f.pool.createDriver("trusted-owner-and-egress", {
    ...f.options(),
    downloadDirectory: "/tmp/own-downloads",
    emulation: {
      locale: null,
      timezone: null,
      geolocation: { latitude: 1, longitude: 2, accuracyMeters: 1 },
    },
    downloadEvents: {
      begin: async () => {
        downloads++;
      },
      progress: async () => {
        downloads++;
        return { cancelReason: null };
      },
      reject: async () => {},
    },
  });
  await a.listTargets();
  expect(
    f.calls.find((call) => call.method === "Browser.setDownloadBehavior")?.params.browserContextId,
  ).toBe("context-1");
  expect(
    f.calls.find((call) => call.method === "Browser.grantPermissions")?.params.browserContextId,
  ).toBe("context-1");
  for (const connection of f.connections) {
    connection.emit("Browser.downloadWillBegin", {
      guid: "foreign-guid",
      frameId: "foreign-frame",
      suggestedFilename: "secret",
    });
    connection.emit("Browser.downloadProgress", {
      guid: "foreign-guid",
      state: "completed",
      receivedBytes: 100,
    });
  }
  expect(downloads).toBe(0);
  await expect(a.runtimeSnapshot()).rejects.toThrow("cannot capture or restore durable profiles");
  await a.close();
});

test("transport loss invalidates every lease without relaunch or command replay", async () => {
  const f = fixture();
  const a = await f.pool.createDriver("trusted-owner-and-egress", f.options());
  const b = await f.pool.createDriver("trusted-owner-and-egress", f.options());
  await a.listTargets();
  await b.listTargets();
  f.fail("Target.getTargets");
  await expect(a.listTargets()).rejects.toThrow("transport loss");
  f.fail("");
  await expect(b.listTargets()).rejects.toThrow("generation ended");
  await expect(f.pool.createDriver("trusted-owner-and-egress", f.options())).rejects.toThrow(
    "generation ended",
  );
  expect(f.counts()).toEqual({ launches: 1, stops: 1 });
  await f.pool.close();
});

test("uncertain context creation ends the entire owned process instead of retrying", async () => {
  const f = fixture();
  f.fail("Target.createBrowserContext");
  await expect(f.pool.createDriver("trusted-owner-and-egress", f.options())).rejects.toThrow(
    "transport loss",
  );
  expect(f.counts()).toEqual({ launches: 1, stops: 1 });
});

test.each([false, true])(
  "every close awaits shared termination and observes its failure=%s",
  async (reject) => {
    const started = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<void>();
    const f = fixture(async () => {
      started.resolve();
      await completion.promise;
    });
    const driver = await f.pool.createDriver("trusted-owner-and-egress", f.options());
    await driver.listTargets();
    f.fail("Target.getTargets");
    const observation = driver.listTargets().catch((error: unknown) => error);
    await started.promise;
    let poolSettled = false;
    let driverSettled = false;
    const poolClose = f.pool.close().then(
      () => {
        poolSettled = true;
      },
      (error: unknown) => {
        poolSettled = true;
        return error;
      },
    );
    const driverClose = driver.close().then(
      () => {
        driverSettled = true;
      },
      (error: unknown) => {
        driverSettled = true;
        return error;
      },
    );
    await Bun.sleep(0);
    expect(poolSettled).toBe(false);
    expect(driverSettled).toBe(false);
    expect(f.counts().stops).toBe(0);
    const failure = new Error("termination failed");
    if (reject) completion.reject(failure);
    else completion.resolve();
    const results = await Promise.all([observation, poolClose, driverClose]);
    if (reject) {
      expect(results).toEqual([failure, failure, failure]);
      await expect(f.pool.close()).rejects.toThrow("termination failed");
    } else {
      expect(results[0]).toBeInstanceOf(CdpTransportError);
      expect(results.slice(1)).toEqual([undefined, undefined]);
      expect(f.counts().stops).toBe(1);
    }
  },
);
