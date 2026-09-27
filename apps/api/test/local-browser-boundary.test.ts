import { describe, expect, test } from "bun:test";
import { getSettings, type Settings } from "@opengeni/config";
import { createObservability } from "@opengeni/observability";
import { MemoryEventBus, testSettings } from "@opengeni/testing";

import { createApp } from "../src/app";
import {
  createLocalBrowserBoundary,
  localBrowserBoundaryResponse,
  markLocalInternalDispatch,
  type LocalBrowserBoundarySettings,
} from "../src/http/local-browser-boundary";
import { dispatchApiWebSocketUpgrade } from "../src/http/websocket-upgrade-dispatch";

/** What `bun run dev` hands the API: its web origin and, on Linux Docker, the sandbox route. */
const devStack: LocalBrowserBoundarySettings = {
  productAccessMode: "local",
  environment: "local",
  apiHost: "127.0.0.1",
  webBaseUrl: "http://127.0.0.1:3000",
  publicBaseUrl: undefined,
  opengeniMcpUrl: "http://172.18.0.1:8000/v1/workspaces/{workspaceId}/mcp",
  opengeniMcpInternalUrl: "http://127.0.0.1:8000/v1/workspaces/{workspaceId}/mcp",
  githubAppManifestBaseUrl: undefined,
  localAllowedOrigins: undefined,
  sandboxBackend: "docker",
};

const codemodeCall = "/v1/workspaces/ws-1/codemode/calls";

function request(
  host: string,
  origin?: string,
  method = "GET",
  path = "/v1/workspaces",
  extraHeaders: Record<string, string> = {},
): Request {
  const headers = new Headers({ host, ...extraHeaders });
  if (origin !== undefined) headers.set("origin", origin);
  return new Request(`http://127.0.0.1:8000${path}`, { method, headers });
}

function boundary(overrides: Partial<LocalBrowserBoundarySettings> = {}) {
  const created = createLocalBrowserBoundary({ ...devStack, ...overrides });
  if (!created) throw new Error("expected a local browser boundary");
  return created;
}

describe("local browser boundary", () => {
  test("applies only to local access mode in the local environment", () => {
    expect(createLocalBrowserBoundary(devStack)).not.toBeNull();
    for (const productAccessMode of ["managed", "configured"] as const) {
      expect(createLocalBrowserBoundary({ ...devStack, productAccessMode })).toBeNull();
    }
    // Helm single-node and conformance fixtures run local access mode under
    // their own environment names; the unit-test harness uses "test".
    for (const environment of ["production", "single-node", "local-kubernetes", "test"]) {
      expect(createLocalBrowserBoundary({ ...devStack, environment })).toBeNull();
    }
  });

  test("answers only requests addressed to this computer", () => {
    const local = boundary();
    for (const host of [
      "127.0.0.1:8000",
      "localhost:8000",
      "[::1]:8000",
      "LOCALHOST:8000",
      // Web dev-server proxy and same-origin reference-app proxies keep their own port.
      "127.0.0.1:3000",
    ]) {
      expect(local.rejection(request(host))).toBeNull();
    }
    for (const host of [
      // DNS rebinding: an attacker's name resolving to 127.0.0.1.
      "attacker.example:8000",
      "127.0.0.1.attacker.example:8000",
      "localhost.:8000",
      "127.1:8000",
      "0.0.0.0:8000",
      "192.168.1.20:8000",
      "user@127.0.0.1:8000",
      "127.0.0.1:8000/path",
      "",
    ]) {
      expect(local.rejection(request(host))?.code).toBe("LOCAL_HOST_NOT_ALLOWED");
    }
  });

  test("serves only sandbox routes, never browsers, on the names sandboxes use", () => {
    const local = boundary();
    expect(local.sandboxHostnames).toEqual(new Set(["host.docker.internal", "172.18.0.1"]));
    // Docker Desktop sandboxes and the Linux Docker bridge route.
    for (const host of ["host.docker.internal:8000", "172.18.0.1:8000"]) {
      for (const path of [
        codemodeCall,
        "/v1/workspaces/ws-1/codemode/sdk/v1/workspaces/site-host/sessions",
        "/v1/workspaces/ws-1/mcp",
        "/v1/workspaces/ws-1/mcp/docs",
        `/v1/git/personal/${"a".repeat(43)}/git-receive-pack`,
      ]) {
        expect(local.rejection(request(host, undefined, "POST", path))).toBeNull();
      }
      // Node's fetch sends Sec-Fetch-Mode, so it does not mark a browser.
      expect(
        local.rejection(
          request(host, undefined, "POST", codemodeCall, { "sec-fetch-mode": "cors" }),
        ),
      ).toBeNull();
      for (const path of ["/v1/workspaces", "/healthz", "/v1/workspaces/ws-1/sessions", "/"]) {
        expect(local.rejection(request(host, undefined, "GET", path))?.code).toBe(
          "LOCAL_SANDBOX_ROUTE_ONLY",
        );
      }
    }
    // A page served under a sandbox name (DNS rebinding of host.docker.internal
    // by a hostile resolver) can send neither its own Origin nor any browser
    // request, even to a sandbox route.
    for (const [origin, headers] of [
      ["http://host.docker.internal:8000", {}],
      ["http://127.0.0.1:3000", {}],
      [undefined, { "sec-fetch-site": "same-origin" }],
    ] as const) {
      expect(
        local.rejection(request("host.docker.internal:8000", origin, "POST", codemodeCall, headers))
          ?.code,
      ).toBe("LOCAL_SANDBOX_ROUTE_ONLY");
    }
    expect(
      local.originAllowed("http://host.docker.internal:8000", "host.docker.internal:8000"),
    ).toBe(false);
    expect(local.originAllowed("http://172.18.0.1:8000", "172.18.0.1:8000")).toBe(false);
  });

  test("admits host.docker.internal only with the Docker sandbox", () => {
    for (const sandboxBackend of ["local", "modal", "none"] as const) {
      const other = boundary({ sandboxBackend, opengeniMcpUrl: undefined });
      expect(other.sandboxHostnames.has("host.docker.internal")).toBe(false);
      expect(
        other.rejection(request("host.docker.internal:8000", undefined, "POST", codemodeCall))
          ?.code,
      ).toBe("LOCAL_HOST_NOT_ALLOWED");
    }
    // A remote sandbox tunnel is a sandbox name too.
    const modal = boundary({
      sandboxBackend: "modal",
      opengeniMcpUrl: "https://dev-edge.example.test/v1/workspaces/{workspaceId}/mcp",
    });
    expect(modal.sandboxHostnames).toEqual(new Set(["dev-edge.example.test"]));
    expect(
      modal.rejection(request("dev-edge.example.test", undefined, "POST", codemodeCall)),
    ).toBeNull();
    expect(modal.rejection(request("dev-edge.example.test"))?.code).toBe(
      "LOCAL_SANDBOX_ROUTE_ONLY",
    );
  });

  test("keeps a name the browser also uses a browser host", () => {
    const shared = boundary({
      webBaseUrl: "http://homeserver:3000",
      opengeniMcpUrl: "http://homeserver:8000/v1/workspaces/{workspaceId}/mcp",
    });
    expect(shared.browserHostnames.has("homeserver")).toBe(true);
    expect(shared.sandboxHostnames.has("homeserver")).toBe(false);
    expect(shared.rejection(request("homeserver:8000", "http://homeserver:3000"))).toBeNull();
  });

  test("accepts browser requests only from this stack's web app or the API itself", () => {
    const local = boundary();
    for (const origin of [
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "http://[::1]:3000",
      // Pages the API serves itself, such as the MCP OAuth consent form.
      "http://127.0.0.1:8000",
    ]) {
      expect(local.rejection(request("127.0.0.1:8000", origin, "POST"))).toBeNull();
    }
    for (const origin of [
      "https://attacker.example",
      "http://attacker.example:8000",
      // Other programs' pages on this computer, including sandbox-served previews.
      "http://127.0.0.1:5173",
      "http://localhost:8080",
      // Sandboxed iframes, file: pages, and cross-origin redirects.
      "null",
      "http://127.0.0.1:3000/path",
      "not an origin",
    ]) {
      expect(local.rejection(request("127.0.0.1:8000", origin, "POST"))?.code).toBe(
        "LOCAL_ORIGIN_NOT_ALLOWED",
      );
    }
    // A same-origin dev proxy (for example the React reference app's /demo-api)
    // forwards its own Host and Origin.
    expect(local.rejection(request("127.0.0.1:3100", "http://127.0.0.1:3100", "POST"))).toBeNull();
    // A rebinding page's own origin is still refused because its Host is.
    expect(
      local.rejection(request("attacker.example:8000", "http://attacker.example:8000", "POST"))
        ?.code,
    ).toBe("LOCAL_HOST_NOT_ALLOWED");
  });

  test("admits explicitly configured origins and addresses", () => {
    const configured = boundary({
      webBaseUrl: "http://homeserver:3000",
      publicBaseUrl: "https://homeserver.example-tailnet.ts.net",
      localAllowedOrigins: "http://127.0.0.1:5173, https://embed.example.test",
    });
    expect(configured.allowedOrigins).toEqual(
      new Set([
        "http://homeserver:3000",
        "https://homeserver.example-tailnet.ts.net",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://[::1]:5173",
        "https://embed.example.test",
      ]),
    );
    expect(configured.rejection(request("homeserver:8000", "http://homeserver:3000"))).toBeNull();
    expect(
      configured.rejection(
        request("homeserver.example-tailnet.ts.net", "https://homeserver.example-tailnet.ts.net"),
      ),
    ).toBeNull();
    expect(configured.rejection(request("127.0.0.1:8000", "http://localhost:5173"))).toBeNull();
    // A tunnel configured for GitHub App callbacks reaches the API under its own name.
    expect(
      boundary({ githubAppManifestBaseUrl: "https://dev-tunnel.example.test" }).rejection(
        request("dev-tunnel.example.test"),
      ),
    ).toBeNull();
    // Without a configured web origin the apps/web dev default applies, also
    // when only a public (tunnel) address is configured.
    for (const publicBaseUrl of [undefined, "https://oauth-tunnel.example.test"]) {
      const defaults = boundary({ webBaseUrl: undefined, publicBaseUrl });
      expect(defaults.rejection(request("127.0.0.1:8000", "http://localhost:3000"))).toBeNull();
      if (publicBaseUrl) {
        expect(
          defaults.rejection(request("oauth-tunnel.example.test", publicBaseUrl, "POST")),
        ).toBeNull();
      }
    }
    // A specific API bind address is this computer too.
    expect(boundary({ apiHost: "::1" }).browserHostnames.has("[::1]")).toBe(true);
    expect(boundary({ apiHost: "192.168.1.20" }).browserHostnames.has("192.168.1.20")).toBe(true);
    expect(boundary({ apiHost: "0.0.0.0" }).browserHostnames.has("0.0.0.0")).toBe(false);
  });

  test("rejects malformed configured origins at startup", () => {
    for (const value of [
      "127.0.0.1:5173",
      "http://127.0.0.1:5173/app",
      "http://*.example.test",
      "ftp://127.0.0.1",
      "http://user@127.0.0.1:5173",
      "http://127.0.0.1:5173?x=1",
    ]) {
      expect(() => getSettings({ OPENGENI_LOCAL_ALLOWED_ORIGINS: value })).toThrow(
        "OPENGENI_LOCAL_ALLOWED_ORIGINS",
      );
    }
    expect(
      getSettings({ OPENGENI_LOCAL_ALLOWED_ORIGINS: "http://127.0.0.1:5173/, https://a.test" })
        .localAllowedOrigins,
    ).toBe("http://127.0.0.1:5173/, https://a.test");
  });

  test("renders the standard error envelope outside Hono", async () => {
    const response = localBrowserBoundaryResponse({
      status: 403,
      code: "LOCAL_ORIGIN_NOT_ALLOWED",
      message: "refused",
      refused: "https://attacker.example",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = await response.text();
    expect(body).not.toContain("attacker.example");
    expect(JSON.parse(body)).toEqual({
      error: {
        status: 403,
        code: "forbidden",
        message: "refused",
        retryable: false,
        details: { code: "LOCAL_ORIGIN_NOT_ALLOWED" },
      },
    });
  });

  test("logs each distinct refused Host or Origin once, with the setting to change", () => {
    const warnings: Array<{ message: string; attributes: Record<string, string> }> = [];
    const local = createLocalBrowserBoundary(devStack, {
      warn: (message, attributes) => warnings.push({ message, attributes }),
    })!;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      local.rejection(request("127.0.0.1:8000", "http://192.168.1.20:3000", "POST"));
      local.rejection(request("attacker.example:8000"));
      local.rejection(request("host.docker.internal:8000"));
      expect(local.rejection(request("127.0.0.1:8000"))).toBeNull();
    }
    expect(warnings.map((warning) => warning.attributes)).toEqual([
      {
        code: "LOCAL_ORIGIN_NOT_ALLOWED",
        refused: "http://192.168.1.20:3000",
        host: "127.0.0.1:8000",
        setting: "OPENGENI_WEB_BASE_URL or OPENGENI_LOCAL_ALLOWED_ORIGINS",
      },
      {
        code: "LOCAL_HOST_NOT_ALLOWED",
        refused: "attacker.example:8000",
        host: "attacker.example:8000",
        setting:
          "OPENGENI_WEB_BASE_URL, OPENGENI_PUBLIC_BASE_URL, or OPENGENI_LOCAL_ALLOWED_ORIGINS",
      },
      {
        code: "LOCAL_SANDBOX_ROUTE_ONLY",
        refused: "host.docker.internal:8000",
        host: "host.docker.internal:8000",
        setting: "OPENGENI_WEB_BASE_URL or OPENGENI_LOCAL_ALLOWED_ORIGINS",
      },
    ]);
    // A rebinding page cycling through names cannot flood the log.
    for (let index = 0; index < 100; index += 1) {
      local.rejection(request(`rebind-${index}.attacker.example:8000`));
    }
    expect(warnings.length).toBeLessThanOrEqual(32);
  });

  test("admits only the API's own re-dispatch without a Host", () => {
    const local = boundary();
    // The Codemode SDK proxy strips Host and re-dispatches a non-sandbox path
    // under the sandbox address the original request used.
    const forwarded = () =>
      new Request("http://172.18.0.1:8000/v1/workspaces/ws-1/sessions", { method: "GET" });
    expect(forwarded().headers.get("host")).toBeNull();
    expect(local.rejection(forwarded())?.code).toBe("LOCAL_SANDBOX_ROUTE_ONLY");
    expect(local.rejection(markLocalInternalDispatch(forwarded()))).toBeNull();
    // Without a Host header the request URL's authority is checked.
    expect(local.rejection(new Request("http://attacker.example:8000/healthz"))?.code).toBe(
      "LOCAL_HOST_NOT_ALLOWED",
    );
    expect(local.rejection(new Request("http://127.0.0.1:8000/healthz"))).toBeNull();
  });
});

describe("API WebSocket upgrade dispatch", () => {
  function transports() {
    const upgraded: string[] = [];
    const route = (prefix: string) => ({
      handles: (incoming: Request) => new URL(incoming.url).pathname.startsWith(prefix),
      upgrade: (incoming: Request, server: { id: string }) => {
        upgraded.push(`${server.id}:${new URL(incoming.url).pathname}`);
        return undefined;
      },
    });
    return { upgraded, routes: [route("/v1/frames"), route("/v1/artifacts")] };
  }
  const server = { id: "bun" };
  const socket = (host: string, path: string, origin?: string) =>
    new Request(`http://127.0.0.1:8000${path}`, {
      headers: { host, upgrade: "websocket", ...(origin ? { origin } : {}) },
    });

  test("refuses a WebSocket from another site or a rebinding host before upgrading", async () => {
    const { upgraded, routes } = transports();
    const local = boundary();
    for (const [incoming, code] of [
      [
        socket("127.0.0.1:8000", "/v1/frames/1", "https://attacker.example"),
        "LOCAL_ORIGIN_NOT_ALLOWED",
      ],
      [socket("attacker.example:8000", "/v1/artifacts/1"), "LOCAL_HOST_NOT_ALLOWED"],
      [
        socket("host.docker.internal:8000", "/v1/artifacts/1", "http://host.docker.internal:8000"),
        "LOCAL_SANDBOX_ROUTE_ONLY",
      ],
    ] as const) {
      const dispatch = dispatchApiWebSocketUpgrade(incoming, server, routes, local);
      expect(dispatch.handled).toBe(true);
      const response = dispatch.handled ? dispatch.response : undefined;
      expect(response?.status).toBe(403);
      expect(
        ((await response!.json()) as { error: { details: { code: string } } }).error.details.code,
      ).toBe(code);
    }
    expect(upgraded).toEqual([]);
  });

  test("upgrades the web app's WebSockets and leaves other requests to the app", () => {
    const { upgraded, routes } = transports();
    const local = boundary();
    expect(
      dispatchApiWebSocketUpgrade(
        socket("127.0.0.1:8000", "/v1/frames/1", "http://localhost:3000"),
        server,
        routes,
        local,
      ),
    ).toEqual({ handled: true, response: undefined });
    // Outside local development there is no boundary.
    expect(
      dispatchApiWebSocketUpgrade(
        socket("anything.example", "/v1/artifacts/2", "https://embed.example.test"),
        server,
        routes,
        null,
      ),
    ).toEqual({ handled: true, response: undefined });
    expect(upgraded).toEqual(["bun:/v1/frames/1", "bun:/v1/artifacts/2"]);
    expect(
      dispatchApiWebSocketUpgrade(socket("attacker.example", "/healthz"), server, routes, local),
    ).toEqual({ handled: false });
  });
});

describe("local API browser boundary", () => {
  const observability = createObservability(
    {
      serviceName: "opengeni",
      environment: "local",
      deploymentRevision: "revision-test",
      observabilityStructuredLogs: false,
      observabilityMetricsEnabled: false,
      observabilityOtlpEndpoint: "",
      observabilityOtlpHeaders: "",
    },
    { component: "api" },
  );

  function app(settings: Partial<Settings>) {
    return createApp({
      settings: { ...testSettings(), ...settings },
      db: {} as never,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
      managedAuth: null,
      observability,
    });
  }

  const local = () =>
    app({
      environment: "local",
      productAccessMode: "local",
      publicBaseUrl: undefined,
      webBaseUrl: "http://127.0.0.1:3000",
    });

  test("refuses other sites and rebinding hosts before any route runs", async () => {
    const api = local();
    const crossSite = await api.request("http://127.0.0.1:8000/v1/workspaces", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8000",
        origin: "https://attacker.example",
        "content-type": "text/plain",
      },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("access-control-allow-origin")).toBeNull();
    expect(((await crossSite.json()) as { error: { details: unknown } }).error.details).toEqual({
      code: "LOCAL_ORIGIN_NOT_ALLOWED",
    });

    const preflight = await api.request("http://127.0.0.1:8000/v1/workspaces", {
      method: "OPTIONS",
      headers: {
        host: "127.0.0.1:8000",
        origin: "https://attacker.example",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const rebinding = await api.request("http://attacker.example:8000/healthz", {
      headers: { host: "attacker.example:8000" },
    });
    expect(rebinding.status).toBe(403);
    expect(((await rebinding.json()) as { error: { details: unknown } }).error.details).toEqual({
      code: "LOCAL_HOST_NOT_ALLOWED",
    });
  });

  test("serves the stack's web app with credentialed CORS and never wildcard CORS", async () => {
    const api = local();
    const preflight = await api.request("http://127.0.0.1:8000/v1/workspaces", {
      method: "OPTIONS",
      headers: {
        host: "127.0.0.1:8000",
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");

    const health = await api.request("http://127.0.0.1:8000/healthz", {
      headers: { host: "127.0.0.1:8000", origin: "http://127.0.0.1:3000" },
    });
    expect(health.status).toBe(200);
    expect(health.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3000");

    // SDK, curl, and sandbox callbacks send no Origin and get no CORS grant.
    const server = await api.request("http://127.0.0.1:8000/healthz", {
      headers: { host: "127.0.0.1:8000" },
    });
    expect(server.status).toBe(200);
    expect(server.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("serves only sandbox calls on sandbox addresses and logs each refusal once", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const logged = createObservability(
      {
        serviceName: "opengeni",
        environment: "local",
        deploymentRevision: "revision-test",
        observabilityStructuredLogs: false,
        observabilityMetricsEnabled: false,
        observabilityOtlpEndpoint: "",
        observabilityOtlpHeaders: "",
      },
      { component: "api" },
    );
    logged.warn = (_message, attributes = {}) => {
      warnings.push({ ...attributes });
    };
    const api = createApp({
      settings: {
        ...testSettings(),
        environment: "local",
        productAccessMode: "local",
        publicBaseUrl: undefined,
        webBaseUrl: "http://127.0.0.1:3000",
        sandboxBackend: "docker",
        opengeniMcpUrl: "http://172.18.0.1:8000/v1/workspaces/{workspaceId}/mcp",
      },
      db: {} as never,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
      managedAuth: null,
      observability: logged,
    });
    const refusedCode = async (response: Response) => {
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      return ((await response.json()) as { error: { details: { code: string } } }).error.details
        .code;
    };
    // The DNS-rebinding probe: a page served as host.docker.internal sends its
    // own Origin to the API under that name.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rebinding = await api.request("http://host.docker.internal:8000/v1/workspaces", {
        method: "POST",
        headers: {
          host: "host.docker.internal:8000",
          origin: "http://host.docker.internal:8000",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(await refusedCode(rebinding)).toBe("LOCAL_SANDBOX_ROUTE_ONLY");
    }
    // A same-origin GET carries no Origin, but the rest of the API is not a sandbox route.
    const read = await api.request("http://host.docker.internal:8000/healthz", {
      headers: { host: "host.docker.internal:8000" },
    });
    expect(await refusedCode(read)).toBe("LOCAL_SANDBOX_ROUTE_ONLY");
    // Without a Host header the request URL's authority is checked the same way.
    const hostless = await api.fetch(new Request("http://172.18.0.1:8000/healthz"));
    expect(await refusedCode(hostless)).toBe("LOCAL_SANDBOX_ROUTE_ONLY");
    // The same API still answers on loopback.
    const health = await api.request("http://127.0.0.1:8000/healthz", {
      headers: { host: "127.0.0.1:8000" },
    });
    expect(health.status).toBe(200);
    expect(warnings).toEqual([
      expect.objectContaining({
        code: "LOCAL_SANDBOX_ROUTE_ONLY",
        refused: "host.docker.internal:8000",
      }),
      expect.objectContaining({ code: "LOCAL_SANDBOX_ROUTE_ONLY", refused: "172.18.0.1:8000" }),
    ]);
  });

  test("leaves CORS unchanged outside local development", async () => {
    const api = app({ environment: "test", productAccessMode: "local" });
    const response = await api.request("http://127.0.0.1:8000/healthz", {
      headers: { host: "anything.example", origin: "https://embed.example.test" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
