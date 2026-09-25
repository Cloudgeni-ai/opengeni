import { describe, expect, test } from "bun:test";
import { getSettings, type Settings } from "@opengeni/config";
import { createObservability } from "@opengeni/observability";
import { MemoryEventBus, testSettings } from "@opengeni/testing";

import { createApp } from "../src/app";
import {
  createLocalBrowserBoundary,
  localBrowserBoundaryResponse,
  type LocalBrowserBoundarySettings,
} from "../src/http/local-browser-boundary";

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
};

function request(host: string, origin?: string, method = "GET"): Request {
  const headers = new Headers({ host });
  if (origin !== undefined) headers.set("origin", origin);
  return new Request("http://127.0.0.1:8000/v1/workspaces", { method, headers });
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
      // Docker Desktop sandboxes and the Linux Docker bridge route.
      "host.docker.internal:8000",
      "172.18.0.1:8000",
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
    // Without a configured web origin the apps/web dev default applies.
    expect(
      boundary({ webBaseUrl: undefined }).rejection(
        request("127.0.0.1:8000", "http://localhost:3000"),
      ),
    ).toBeNull();
    // A specific API bind address is this computer too.
    expect(boundary({ apiHost: "::1" }).allowedHostnames.has("[::1]")).toBe(true);
    expect(boundary({ apiHost: "0.0.0.0" }).allowedHostnames.has("0.0.0.0")).toBe(false);
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
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({
      error: {
        status: 403,
        code: "forbidden",
        message: "refused",
        retryable: false,
        details: { code: "LOCAL_ORIGIN_NOT_ALLOWED" },
      },
    });
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

  test("leaves CORS unchanged outside local development", async () => {
    const api = app({ environment: "test", productAccessMode: "local" });
    const response = await api.request("http://127.0.0.1:8000/healthz", {
      headers: { host: "anything.example", origin: "https://embed.example.test" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
