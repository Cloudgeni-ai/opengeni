import { describe, expect, test } from "bun:test";

import { createImmutableRawObjectReader, type ObjectStorage } from "@opengeni/storage";
import {
  APP_HOST_RESOLVER_HEADER,
  appHostMetricRoute,
  appHostMatchesAppId,
  appHostProcessConfiguration,
  createAppHost,
  createAppHostMetricsHandler,
  createHttpAppLaunchResolver,
  createObservedAppHostHandler,
  launchTokenDigest,
  normalizeAppHost,
  type AppHostOptions,
  type AppLaunchResolution,
} from "../src";

const TOKEN = "launch_abcdefghijklmnopqrstuvwxyz012345";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000000";
const APP_ID = "11111111-1111-4111-8111-111111111111";
const BUILD_ID = "77777777-7777-4777-8777-777777777777";
const APP_HOST = `${APP_ID}.apps.example.test`;
const CONTENT_SHA256 = "a".repeat(64);
const FILE_IDS = Object.freeze({
  "index.html": "55555555-5555-4555-8555-555555555555",
  "assets/app.js": "66666666-6666-4666-8666-666666666666",
});
const frozenObjectKey = (path: keyof typeof FILE_IDS, sha256 = CONTENT_SHA256) =>
  `workspaces/${WORKSPACE_ID}/apps/${APP_ID}/builds/${BUILD_ID}/frozen/` +
  `${sha256}/${FILE_IDS[path]}`;
const ENTRY_OBJECT = Object.freeze({
  path: "index.html",
  objectKey: frozenObjectKey("index.html"),
  versionToken: "version:index.html",
});
const RESOLUTION: AppLaunchResolution = Object.freeze({
  appId: APP_ID,
  releaseId: "22222222-2222-4222-8222-222222222222",
  launchId: "44444444-4444-4444-8444-444444444444",
  previewId: null,
  publicationId: "33333333-3333-4333-8333-333333333333",
  expiresAt: new Date("2026-08-29T18:10:00.000Z"),
  spaFallback: true,
  requestedObject: ENTRY_OBJECT,
  entryObject: ENTRY_OBJECT,
});

describe("dedicated Apps byte host", () => {
  test("normalizes Host, hashes the launch token, and streams immutable bytes", async () => {
    const fixture = appHostFixture({
      "index.html": new TextEncoder().encode('<script src="assets/app.js"></script>'),
    });
    const response = await fixture.host.fetch(
      request(`https://${APP_HOST.toUpperCase()}:443/.opengeni/launch/${TOKEN}/index.html`),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<script src="assets/app.js"></script>');
    expect(fixture.resolverInputs).toEqual([
      {
        host: APP_HOST,
        launchTokenDigest: launchTokenDigest(TOKEN),
        requestedPath: "index.html",
      },
    ]);
    expect(fixture.keys).toEqual([frozenObjectKey("index.html")]);
    expect(fixture.ranges).toEqual([[0, 36]]);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://console.example.test",
    );
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);
  });

  test("refuses bytes when a frozen object key now resolves to another provider version", async () => {
    const fixture = appHostFixture({
      "index.html": new TextEncoder().encode("original"),
    });
    fixture.setObject(
      frozenObjectKey("index.html"),
      new TextEncoder().encode("replacement"),
      "version:index.html:replacement",
    );

    const response = await fixture.host.fetch(
      request(`https://${APP_HOST}/.opengeni/launch/${TOKEN}/index.html`),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("replacement");
    expect(fixture.ranges).toEqual([]);
  });

  test("supports HEAD, exact single ranges, and unsatisfiable-range responses", async () => {
    const fixture = appHostFixture({
      "assets/app.js": new TextEncoder().encode("0123456789"),
    });
    const url = `https://${APP_HOST}/.opengeni/launch/${TOKEN}/assets/app.js`;

    const head = await fixture.host.fetch(request(url, { method: "HEAD", range: "bytes=2-5" }));
    expect(head.status).toBe(206);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-length")).toBe("4");
    expect(head.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(fixture.ranges).toEqual([]);

    const selected = await fixture.host.fetch(request(url, { range: "bytes=-3" }));
    expect(selected.status).toBe(206);
    expect(selected.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await selected.text()).toBe("789");

    const multiple = await fixture.host.fetch(request(url, { range: "bytes=0-1,4-5" }));
    expect(multiple.status).toBe(416);
    expect(multiple.headers.get("content-range")).toBe("bytes */10");
  });

  test("falls back to the immutable entry only for browser HTML navigation", async () => {
    const fixture = appHostFixture({
      "index.html": new TextEncoder().encode("SPA"),
    });
    const route = `https://${APP_HOST}/.opengeni/launch/${TOKEN}/projects/active`;
    const navigation = await fixture.host.fetch(
      request(route, {
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
    );
    expect(navigation.status).toBe(200);
    expect(await navigation.text()).toBe("SPA");
    expect(fixture.keys).toEqual([frozenObjectKey("index.html")]);

    fixture.keys.length = 0;
    const asset = await fixture.host.fetch(
      request(`https://${APP_HOST}/.opengeni/launch/${TOKEN}/assets/missing.js`, {
        headers: { accept: "*/*" },
      }),
    );
    expect(asset.status).toBe(404);
    expect(fixture.keys).toEqual([]);
  });

  test("rejects ambient credentials, malformed paths, invalid hosts, and expired grants", async () => {
    const fixture = appHostFixture({
      "index.html": new TextEncoder().encode("ok"),
    });
    const url = `https://${APP_HOST}/.opengeni/launch/${TOKEN}/index.html`;
    for (const headers of [{ cookie: "session=secret" }, { authorization: "Bearer secret" }]) {
      const denied = await fixture.host.fetch(request(url, { headers }));
      expect(denied.status).toBe(400);
    }
    expect(fixture.resolverInputs).toEqual([]);

    for (const path of ["../secret", "assets%2Fsecret", "assets//app.js", "assets/%5Csecret"]) {
      const denied = await fixture.host.fetch(
        request(`https://${APP_HOST}/.opengeni/launch/${TOKEN}/${path}`),
      );
      expect(denied.status).toBe(404);
    }
    expect(fixture.resolverInputs).toEqual([]);

    const badHost = await fixture.host.fetch(
      request(`https://${APP_HOST}/.opengeni/launch/${TOKEN}/index.html`, {
        headers: { host: "victim.example.test, attacker.example.test" },
      }),
    );
    expect(badHost.status).toBe(404);
    expect(fixture.resolverInputs).toEqual([]);

    const productOrigin = await fixture.host.fetch(
      request(url, { headers: { host: "console.example.test" } }),
    );
    expect(productOrigin.status).toBe(404);
    expect(fixture.resolverInputs).toEqual([]);

    const nonAppOrigin = await fixture.host.fetch(
      request(url, { headers: { host: "web.example.test" } }),
    );
    expect(nonAppOrigin.status).toBe(404);
    expect(fixture.resolverInputs).toEqual([]);

    const expired = appHostFixture(
      { "index.html": new TextEncoder().encode("old") },
      {
        resolution: {
          ...RESOLUTION,
          expiresAt: new Date("2026-08-29T17:59:59.999Z"),
        },
      },
    );
    const expiredResponse = await expired.host.fetch(request(url));
    expect(expiredResponse.status).toBe(404);
    expect(expired.keys).toEqual([]);

    const wrongApp = appHostFixture(
      { "index.html": new TextEncoder().encode("wrong") },
      {
        resolution: {
          ...RESOLUTION,
          appId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      },
    );
    expect(await wrongApp.host.fetch(request(url))).toMatchObject({
      status: 404,
    });
    expect(wrongApp.keys).toEqual([]);

    const stagingKey =
      `workspaces/${WORKSPACE_ID}/apps/${APP_ID}/builds/${BUILD_ID}/staging/` +
      FILE_IDS["index.html"];
    const stagingResolution = appHostFixture(
      { "index.html": new TextEncoder().encode("unfrozen") },
      { objectKeysByPath: { "index.html": stagingKey } },
    );
    expect(await stagingResolution.host.fetch(request(url))).toMatchObject({
      status: 404,
    });
    expect(stagingResolution.keys).toEqual([]);
  });

  test("serves only frozen bytes after the signed staging PUT is replayed", async () => {
    const original = new TextEncoder().encode("export const value = 'verified';");
    const replacement = new TextEncoder().encode("export const value = 'changed!';");
    const frozenKey = frozenObjectKey("assets/app.js", "b".repeat(64));
    const stagingKey =
      `workspaces/${WORKSPACE_ID}/apps/${APP_ID}/builds/${BUILD_ID}/staging/` +
      FILE_IDS["assets/app.js"];
    const fixture = appHostFixture(
      { "assets/app.js": original },
      {
        objectKeysByPath: { "assets/app.js": frozenKey },
        additionalObjects: { [stagingKey]: original },
      },
    );

    // Replaying the original signed PUT mutates only the untrusted staging key.
    fixture.setObject(stagingKey, replacement, "staging-v2");
    const response = await fixture.host.fetch(
      request(`https://${APP_HOST}/.opengeni/launch/${TOKEN}/assets/app.js`),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export const value = 'verified';");
    expect(fixture.keys).toEqual([frozenKey]);
    expect(fixture.keys).not.toContain(stagingKey);
  });

  test("does not reveal resolver, storage, token, or object-key diagnostics", async () => {
    const resolverFailure = appHostFixture({}, { resolverFailure: true });
    const url = `https://${APP_HOST}/.opengeni/launch/${TOKEN}/index.html`;
    const unavailable = await resolverFailure.host.fetch(request(url));
    expect(unavailable.status).toBe(503);
    const resolverBody = await unavailable.text();
    expect(resolverBody).not.toContain(TOKEN);
    expect(resolverBody).not.toContain(WORKSPACE_ID);
    expect(resolverBody).not.toContain("database password");

    const storageFailure = appHostFixture({}, { storageFailure: true });
    const storageUnavailable = await storageFailure.host.fetch(request(url));
    expect(storageUnavailable.status).toBe(503);
    const storageBody = await storageUnavailable.text();
    expect(storageBody).not.toContain(TOKEN);
    expect(storageBody).not.toContain(WORKSPACE_ID);
    expect(storageBody).not.toContain("provider credential");
  });

  test("records only bounded request dimensions and isolates observer failures", async () => {
    const fixture = appHostFixture({
      "index.html": new TextEncoder().encode("ok"),
    });
    const observations: unknown[] = [];
    let now = 1_000;
    const observed = createObservedAppHostHandler(
      fixture.host,
      {
        recordHttpRequest(input) {
          observations.push(input);
        },
      },
      () => {
        now += 25;
        return now;
      },
    );
    const url = `https://${APP_HOST}/.opengeni/launch/${TOKEN}/index.html`;
    expect(await (await observed(request(url))).text()).toBe("ok");
    expect(observations).toEqual([
      {
        method: "GET",
        route: "/.opengeni/launch/:token/:path",
        status: 200,
        durationSeconds: 0.025,
      },
    ]);
    const serialized = JSON.stringify(observations);
    for (const privateValue of [TOKEN, APP_ID, WORKSPACE_ID, BUILD_ID, "index.html", APP_HOST]) {
      expect(serialized).not.toContain(privateValue);
    }

    const failSafe = createObservedAppHostHandler(fixture.host, {
      recordHttpRequest() {
        throw new Error("registry failure");
      },
    });
    expect(await failSafe(request(url))).toMatchObject({ status: 200 });
    expect(appHostMetricRoute(`/other/${TOKEN}`)).toBe("/other");
  });

  test("serves Prometheus exposition only from the dedicated metrics handler", async () => {
    const handler = createAppHostMetricsHandler(
      {
        async prometheusMetrics() {
          return 'opengeni_build_info{component="app-host"} 1\n';
        },
      },
      "/internal/metrics",
    );
    const metrics = await handler(new Request("http://metrics.internal/internal/metrics"));
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("cache-control")).toBe("no-store");
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    expect(await metrics.text()).toContain('component="app-host"');

    const head = await handler(
      new Request("http://metrics.internal/internal/metrics", { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(
      await handler(new Request("http://metrics.internal/internal/metrics", { method: "POST" })),
    ).toMatchObject({ status: 405 });
    expect(await handler(new Request("http://metrics.internal/metrics"))).toMatchObject({
      status: 404,
    });
  });
});

describe("Apps launch resolver callout", () => {
  test("sends only canonical Host plus the token digest with omitted ambient credentials", async () => {
    const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
    const resolver = createHttpAppLaunchResolver({
      url: "http://opengeni-api:8000/internal/apps/resolve-launch",
      sharedKey: "r".repeat(64),
      async fetchImpl(url, init) {
        calls.push({
          url: String(url),
          init: init!,
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          ...RESOLUTION,
          expiresAt: RESOLUTION.expiresAt.toISOString(),
        });
      },
    });
    const result = await resolver.resolve({
      host: APP_HOST,
      launchTokenDigest: launchTokenDigest(TOKEN),
      requestedPath: "index.html",
    });
    expect(result).toEqual(RESOLUTION);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      host: APP_HOST,
      launchTokenDigest: launchTokenDigest(TOKEN),
      requestedPath: "index.html",
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain(TOKEN);
    expect(calls[0]!.init.credentials).toBe("omit");
    expect(new Headers(calls[0]!.init.headers).get(APP_HOST_RESOLVER_HEADER)).toBe("r".repeat(64));
    expect(new Headers(calls[0]!.init.headers).has("cookie")).toBe(false);
    expect(new Headers(calls[0]!.init.headers).has("authorization")).toBe(false);
  });

  test("fails closed on denial, malformed output, and oversized output", async () => {
    const denied = createHttpAppLaunchResolver({
      url: "http://opengeni-api:8000/internal/apps/resolve-launch",
      sharedKey: "r".repeat(64),
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    await expect(
      denied.resolve({
        host: APP_HOST,
        launchTokenDigest: launchTokenDigest(TOKEN),
        requestedPath: "index.html",
      }),
    ).resolves.toBeNull();

    const malformed = createHttpAppLaunchResolver({
      url: "http://opengeni-api:8000/internal/apps/resolve-launch",
      sharedKey: "r".repeat(64),
      fetchImpl: async () => Response.json({ expiresAt: "not enough fields" }),
    });
    await expect(
      malformed.resolve({
        host: APP_HOST,
        launchTokenDigest: launchTokenDigest(TOKEN),
        requestedPath: "index.html",
      }),
    ).resolves.toBeNull();

    const oversized = createHttpAppLaunchResolver({
      url: "http://opengeni-api:8000/internal/apps/resolve-launch",
      sharedKey: "r".repeat(64),
      fetchImpl: async () => new Response("x".repeat(20_000)),
    });
    await expect(
      oversized.resolve({
        host: APP_HOST,
        launchTokenDigest: launchTokenDigest(TOKEN),
        requestedPath: "index.html",
      }),
    ).rejects.toThrow("unavailable");
  });
});

describe("Apps Host normalization", () => {
  test("accepts only canonical DNS hosts and bounded ports", () => {
    expect(normalizeAppHost("STATUS.Apps.Example.test.:443")).toBe("status.apps.example.test");
    for (const invalid of [
      " status.apps.example.test",
      "status.apps.example.test,evil.test",
      "user@status.apps.example.test",
      "status..apps.example.test",
      "-status.apps.example.test",
      "status.apps.example.test:0",
      "[::1]:8080",
    ]) {
      expect(normalizeAppHost(invalid)).toBeNull();
    }
  });

  test("binds a resolver result to the stable App id in the hostname", () => {
    expect(appHostMatchesAppId(APP_HOST, APP_ID)).toBe(true);
    expect(appHostMatchesAppId("console.example.test", APP_ID)).toBe(false);
    expect(appHostMatchesAppId(`preview-${APP_ID}.apps.example.test`, APP_ID)).toBe(false);
    expect(appHostMatchesAppId(APP_HOST, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(false);
  });

  test("loads only dedicated process configuration and rejects malformed values", () => {
    expect(
      appHostProcessConfiguration({
        OPENGENI_APP_HOST_RESOLVER_URL: "http://opengeni-api:8000/internal/apps/resolve-launch",
        OPENGENI_APP_HOST_RESOLVER_KEY: "r".repeat(64),
        OPENGENI_APP_HOST_FRAME_ANCESTORS:
          "https://console.example.test,https://admin.example.test",
      }),
    ).toEqual({
      hostname: "0.0.0.0",
      port: 8080,
      metricsPort: 9090,
      metricsPath: "/metrics",
      resolverUrl: "http://opengeni-api:8000/internal/apps/resolve-launch",
      resolverKey: "r".repeat(64),
      resolverTimeoutMs: 2000,
      frameAncestors: ["https://console.example.test", "https://admin.example.test"],
    });
    expect(() =>
      appHostProcessConfiguration({
        OPENGENI_APP_HOST_RESOLVER_URL: "http://opengeni-api:8000/internal/apps/resolve-launch",
        OPENGENI_APP_HOST_RESOLVER_KEY: "r".repeat(64),
        OPENGENI_APP_HOST_PORT: "0",
      }),
    ).toThrow("OPENGENI_APP_HOST_PORT");
    expect(() =>
      appHostProcessConfiguration({
        OPENGENI_APP_HOST_RESOLVER_URL: "http://opengeni-api:8000/internal/apps/resolve-launch",
        OPENGENI_APP_HOST_RESOLVER_KEY: "r".repeat(64),
        OPENGENI_APP_HOST_METRICS_PORT: "8080",
      }),
    ).toThrow("must differ");
    expect(() =>
      appHostProcessConfiguration({
        OPENGENI_APP_HOST_RESOLVER_URL: "http://opengeni-api:8000/internal/apps/resolve-launch",
        OPENGENI_APP_HOST_RESOLVER_KEY: "r".repeat(64),
        OPENGENI_APP_HOST_METRICS_PATH: "//metrics",
      }),
    ).toThrow("OPENGENI_APP_HOST_METRICS_PATH");
  });
});

function appHostFixture(
  files: Record<string, Uint8Array>,
  options: {
    resolution?: AppLaunchResolution;
    resolverFailure?: boolean;
    storageFailure?: boolean;
    objectKeysByPath?: Readonly<Record<string, string>>;
    additionalObjects?: Readonly<Record<string, Uint8Array>>;
  } = {},
): {
  host: ReturnType<typeof createAppHost>;
  resolverInputs: Array<{
    host: string;
    launchTokenDigest: string;
    requestedPath: string | null;
  }>;
  keys: string[];
  ranges: Array<[number, number]>;
  setObject(key: string, bytes: Uint8Array, version?: string): void;
} {
  const objectKeyForPath = (path: string) => {
    const configured = options.objectKeysByPath?.[path];
    if (configured) return configured;
    const fileId = FILE_IDS[path as keyof typeof FILE_IDS];
    if (!fileId) throw new Error(`Test fixture lacks a frozen object identity for ${path}`);
    return frozenObjectKey(path as keyof typeof FILE_IDS);
  };
  const entries = new Map(
    Object.entries(files).map(([path, bytes]) => [
      objectKeyForPath(path),
      {
        bytes: bytes.slice(),
        version: `version:${path}`,
        contentType: path.endsWith(".html")
          ? "text/html; charset=utf-8"
          : "text/javascript; charset=utf-8",
      },
    ]),
  );
  for (const [key, bytes] of Object.entries(options.additionalObjects ?? {})) {
    entries.set(key, {
      bytes: bytes.slice(),
      version: `version:${key}`,
      contentType: "text/javascript; charset=utf-8",
    });
  }
  const resolverInputs: Array<{
    host: string;
    launchTokenDigest: string;
    requestedPath: string | null;
  }> = [];
  const keys: string[] = [];
  const ranges: Array<[number, number]> = [];
  const partialStorage: Pick<ObjectStorage, "headObject" | "getObjectRange"> = {
    async headObject(key) {
      keys.push(key);
      if (options.storageFailure) throw new Error(`provider credential at ${key}`);
      const entry = entries.get(key);
      return entry
        ? {
            ContentLength: entry.bytes.byteLength,
            ContentType: entry.contentType,
            VersionToken: entry.version,
          }
        : null;
    },
    async getObjectRange(input) {
      ranges.push([input.start, input.endInclusive]);
      const entry = entries.get(input.key);
      if (!entry || entry.version !== input.expectedVersionToken) return null;
      return {
        bytes: entry.bytes.slice(input.start, input.endInclusive + 1),
        versionToken: entry.version,
      };
    },
  };
  const appOptions: AppHostOptions = {
    resolver: {
      async resolve(input) {
        resolverInputs.push(input);
        if (options.resolverFailure) throw new Error("database password leaked");
        if (input.host !== APP_HOST) return null;
        const base = options.resolution ?? RESOLUTION;
        const entryObject = {
          path: base.entryObject.path,
          objectKey: objectKeyForPath(base.entryObject.path),
          versionToken: base.entryObject.versionToken,
        };
        const requestedObject =
          input.requestedPath !== null &&
          (Object.hasOwn(files, input.requestedPath) ||
            input.requestedPath === base.entryObject.path ||
            options.storageFailure)
            ? {
                path: input.requestedPath,
                objectKey: objectKeyForPath(input.requestedPath),
                versionToken:
                  input.requestedPath === base.entryObject.path
                    ? base.entryObject.versionToken
                    : `version:${input.requestedPath}`,
              }
            : null;
        return Object.freeze({ ...base, requestedObject, entryObject });
      },
    },
    storage: createImmutableRawObjectReader(partialStorage),
    frameAncestors: ["https://console.example.test"],
    now: () => new Date("2026-08-29T18:00:00.000Z"),
  };
  return {
    host: createAppHost(appOptions),
    resolverInputs,
    keys,
    ranges,
    setObject(key, bytes, version = `version:${key}:replacement`) {
      const current = entries.get(key);
      entries.set(key, {
        bytes: bytes.slice(),
        version,
        contentType: current?.contentType ?? "application/octet-stream",
      });
    },
  };
}

function request(
  url: string,
  options: {
    method?: string;
    range?: string;
    headers?: HeadersInit;
  } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.range) headers.set("range", options.range);
  return new Request(url, { method: options.method ?? "GET", headers });
}
