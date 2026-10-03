import { describe, expect, test } from "bun:test";
import { DestinationPolicyError } from "@opengeni/network";
import { testSettings } from "@opengeni/testing";
import {
  credentialProviderTestSummary,
  integrationTestNetworkError,
  sendIntegrationEndpointTest,
} from "../src/integration-endpoint-test";

const settings = testSettings({});

function fetchAnswering(response: Response | (() => never)) {
  return (async () => {
    if (typeof response === "function") return response();
    return response;
  }) as never;
}

async function run(kind: "webhook" | "credential-provider", response: Response | (() => never)) {
  return await sendIntegrationEndpointTest({
    kind,
    url: "https://product.example/endpoint",
    secret: "whsec_test",
    body: '{"type":"webhook.test"}',
    timeoutMs: 1000,
    settings,
    fetch: fetchAnswering(response),
  });
}

describe("integration endpoint tests", () => {
  test("signs the exact body it reports and keeps the first KiB of an error answer", async () => {
    let sent: RequestInit | undefined;
    const result = await sendIntegrationEndpointTest({
      kind: "webhook",
      url: "https://product.example/events",
      secret: "whsec_test",
      body: '{"type":"webhook.test"}',
      headers: { "OpenGeni-Event-Id": "event-1" },
      timeoutMs: 1000,
      settings,
      fetch: (async (_url: string, init: RequestInit) => {
        sent = init;
        return new Response("x".repeat(5000), { status: 500 });
      }) as never,
    });
    const headers = sent!.headers as Record<string, string>;
    expect(headers["OpenGeni-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(headers["OpenGeni-Event-Id"]).toBe("event-1");
    expect(sent!.body).toBe(result.request);
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      error: "The endpoint answered HTTP 500.",
    });
    expect(result.responseBody!.length).toBeLessThanOrEqual(1025);
    expect(result.responseBody!.endsWith("…")).toBe(true);
  });

  test("explains redirects and refused signatures", async () => {
    expect((await run("webhook", new Response(null, { status: 302 }))).error).toContain(
      "Redirects aren't followed",
    );
    expect((await run("credential-provider", new Response("no", { status: 403 }))).error).toContain(
      "provider's signing secret",
    );
  });

  test("a provider answer must be a valid credential response, and its bytes never return", async () => {
    const invalid = await run("credential-provider", new Response("<html>ok</html>"));
    expect(invalid).toMatchObject({ ok: false, status: 200, responseBody: null });
    expect(invalid.error).toContain("isn't JSON");

    const wrongShape = await run(
      "credential-provider",
      Response.json({ status: "ok", environment: { TOKEN: 42 } }),
    );
    expect(wrongShape).toMatchObject({ ok: false, responseBody: null });
    expect(wrongShape.error).toContain("environment.TOKEN");
    expect(wrongShape.error).not.toContain("42");

    const ok = await run(
      "credential-provider",
      Response.json({
        status: "ok",
        environment: { B: "secret-b", A: "secret-a" },
        files: [{ path: "key.json", content: "secret-file" }],
        mcp: [{ url: "https://mcp.example/", headers: { Authorization: "Bearer secret" } }],
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    );
    expect(JSON.stringify(ok)).not.toContain("secret-");
    expect(ok.credentials).toEqual({
      status: "ok",
      environment: ["A", "B"],
      files: ["key.json"],
      git: [],
      mcp: ["https://mcp.example/"],
      expiresAt: "2030-01-01T00:00:00Z",
      authNeeded: [],
    });
  });

  test("summarizes not_applicable and auth_needed answers", () => {
    expect(credentialProviderTestSummary({ status: "not_applicable" }).status).toBe(
      "not_applicable",
    );
    expect(
      credentialProviderTestSummary({
        status: "auth_needed",
        authNeeded: [{ reason: "expired", providerDomain: "github.com", message: "Reconnect" }],
      }).authNeeded,
    ).toEqual([{ reason: "expired", providerDomain: "github.com", message: "Reconnect" }]);
  });

  test("names network failures in words an administrator can act on", async () => {
    const refused = await run("webhook", () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      });
    });
    expect(refused).toMatchObject({ ok: false, status: null });
    expect(refused.error).toContain("refused");
    expect(
      integrationTestNetworkError(
        new DestinationPolicyError("private_or_special_use", "Webhook may not target"),
      ),
    ).toContain("private network");
    expect(integrationTestNetworkError(new DOMException("timed out", "TimeoutError"))).toBe(
      "The endpoint didn't answer in time.",
    );
  });
});
