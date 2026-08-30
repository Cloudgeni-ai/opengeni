import { describe, expect, test } from "bun:test";

import { createOgAppAuthoringHttpTransport } from "../src";

const WORKSPACE_ID = "workspace / one";
const APP_ID = "app / one";

describe("og-app authoring HTTP transport", () => {
  test("binds managed-session mutations to one workspace CSRF token", async () => {
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const transport = createOgAppAuthoringHttpTransport({
      baseUrl: "https://api.example.test",
      auth: {
        kind: "human_session",
        cookie: "better-auth.session_token=session-value",
      },
      async fetch(input, init) {
        calls.push({ url: new URL(String(input)), init });
        if (String(input).endsWith("/csrf")) {
          return Response.json({
            token: "c".repeat(43),
            expiresInSeconds: 3_600,
          });
        }
        return Response.json({ app: {}, replayed: false });
      },
    });

    await transport.request("apps.create", {
      workspaceId: WORKSPACE_ID,
      request: {} as never,
    });
    await transport.request("apps.create", {
      workspaceId: WORKSPACE_ID,
      request: {} as never,
    });

    expect(
      calls.filter(({ url }) => url.pathname.endsWith("/csrf")),
    ).toHaveLength(1);
    expect(calls.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
      "/v1/workspaces/workspace%20%2F%20one/apps/csrf",
      "/v1/workspaces/workspace%20%2F%20one/apps",
      "/v1/workspaces/workspace%20%2F%20one/apps",
    ]);
    const csrfHeaders = new Headers(calls[0]!.init?.headers);
    expect(csrfHeaders.get("cookie")).toBe(
      "better-auth.session_token=session-value",
    );
    expect(csrfHeaders.has("authorization")).toBe(false);
    for (const call of calls.slice(1)) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("cookie")).toBe(
        `better-auth.session_token=session-value; opengeni.app_csrf=${"c".repeat(43)}`,
      );
      expect(headers.get("x-opengeni-app-csrf")).toBe("c".repeat(43));
      expect(headers.get("origin")).toBe("https://api.example.test");
      expect(headers.get("sec-fetch-site")).toBe("same-origin");
      expect(headers.has("authorization")).toBe(false);
    }
  });

  test("uses bearer authorization for API-key reads without browser credentials", async () => {
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const transport = createOgAppAuthoringHttpTransport({
      baseUrl: "https://api.example.test",
      auth: { kind: "api_key", apiKey: "organization-api-key" },
      async fetch(input, init) {
        calls.push({ url: new URL(String(input)), init });
        return Response.json({ apps: [], nextCursor: null, truncated: false });
      },
    });

    await transport.request("apps.list", {
      workspaceId: WORKSPACE_ID,
      query: { limit: 25, cursor: "next / page" },
    });

    expect(`${calls[0]!.url.pathname}${calls[0]!.url.search}`).toBe(
      "/v1/workspaces/workspace%20%2F%20one/apps?limit=25&cursor=next+%2F+page",
    );
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer organization-api-key");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("x-opengeni-app-csrf")).toBe(false);
  });

  test("rejects caller-supplied Apps CSRF cookies", () => {
    expect(() =>
      createOgAppAuthoringHttpTransport({
        baseUrl: "https://api.example.test",
        auth: {
          kind: "human_session",
          cookie:
            "better-auth.session_token=session; opengeni.app_csrf=caller-controlled",
        },
      }),
    ).toThrow("must not include opengeni.app_csrf");
  });

  test("does not reflect untrusted non-JSON error bodies", async () => {
    const marker = "raw-error-body-must-not-leak";
    const transport = createOgAppAuthoringHttpTransport({
      baseUrl: "https://api.example.test",
      auth: { kind: "api_key", apiKey: "organization-api-key" },
      async fetch() {
        return new Response(`<html>${marker.repeat(1_000)}</html>`, {
          status: 502,
          headers: { "content-type": "text/html" },
        });
      },
    });

    let thrown: unknown;
    try {
      await transport.request("apps.get", {
        workspaceId: WORKSPACE_ID,
        appId: APP_ID,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "OpenGeni Apps request failed with HTTP 502.",
    );
    expect((thrown as Error).message).not.toContain(marker);
  });
});
