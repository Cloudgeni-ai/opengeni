import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { authorizationServerForgotClient } from "../src/integrations/oauth-client";

// Answers recorded from real providers (2026-11-16): Supabase answers an
// unknown client_id with HTTP 422 {"message":"Unrecognized client_id"} and a
// known one with 303 to its consent page; Dropbox redirects an unknown one to
// /oauth2/authorize_error?...&error_name=unknown_client_id.
const known = "known-client";
let server: ReturnType<typeof Bun.serve>;
let origin = "";
const redirectUri = "https://app.opengeni.test/v1/integrations/oauth/callback";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const clientId = url.searchParams.get("client_id");
      const recognized = clientId === known;
      switch (url.pathname) {
        case "/supabase/authorize":
          return recognized
            ? new Response(null, { status: 303, headers: { location: "/dashboard/authorize" } })
            : Response.json({ message: "Unrecognized client_id" }, { status: 422 });
        case "/dropbox/authorize":
          return new Response(null, {
            status: 302,
            headers: {
              location: recognized
                ? "/login?cont=%2Foauth2%2Fauthorize"
                : `/oauth2/authorize_error?client_id=${encodeURIComponent(clientId ?? "")}&error_detail=Invalid+client_id&error_name=unknown_client_id`,
            },
          });
        case "/callback-error/authorize":
          return new Response(null, {
            status: 302,
            headers: { location: `${redirectUri}?error=invalid_client&state=x` },
          });
        case "/callback-scope-error/authorize":
          return new Response(null, {
            status: 302,
            headers: { location: `${redirectUri}?error=invalid_scope&state=x` },
          });
        case "/login-page/authorize":
          return new Response("<html>Sign in. Invalid client? Contact support.</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        case "/bad-request/authorize":
          return Response.json(
            { error: "invalid_request", error_description: "missing nonce" },
            {
              status: 400,
            },
          );
        case "/rate-limited/authorize":
          return Response.json({ error: "invalid_client" }, { status: 429 });
        case "/down/authorize":
          return new Response("unknown client", { status: 503 });
        case "/hang/authorize":
          return new Promise<Response>(() => {});
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

function forgot(path: string, clientId = "forgotten-client") {
  return authorizationServerForgotClient(testSettings({ environment: "test" }), {
    authorizationEndpoint: `${origin}${path}`,
    clientId,
    redirectUri,
    scopes: ["projects:read"],
    signal: new AbortController().signal,
  });
}

describe("authorizationServerForgotClient", () => {
  test("recognizes a provider that answers an unknown client with a 4xx error", async () => {
    expect(await forgot("/supabase/authorize")).toBe(true);
    expect(await forgot("/supabase/authorize", known)).toBe(false);
  });

  test("recognizes a provider that redirects an unknown client to its error page", async () => {
    expect(await forgot("/dropbox/authorize")).toBe(true);
    expect(await forgot("/dropbox/authorize", known)).toBe(false);
  });

  test("an error sent to our callback counts only when it is invalid_client", async () => {
    expect(await forgot("/callback-error/authorize")).toBe(true);
    expect(await forgot("/callback-scope-error/authorize")).toBe(false);
  });

  test("keeps the client on any answer that is not an explicit unknown client", async () => {
    expect(await forgot("/login-page/authorize")).toBe(false);
    expect(await forgot("/bad-request/authorize")).toBe(false);
    expect(await forgot("/rate-limited/authorize")).toBe(false);
    expect(await forgot("/down/authorize")).toBe(false);
    expect(await forgot("/missing/authorize")).toBe(false);
  });

  test("keeps the client when the provider cannot be reached", async () => {
    expect(
      await authorizationServerForgotClient(testSettings({ environment: "test" }), {
        authorizationEndpoint: "http://127.0.0.1:1/authorize",
        clientId: "forgotten-client",
        redirectUri,
        scopes: [],
        signal: new AbortController().signal,
      }),
    ).toBe(false);
  });

  test("keeps the client when the provider does not answer in time", async () => {
    const started = Date.now();
    expect(await forgot("/hang/authorize")).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  test("still stops when the Connect itself is aborted", async () => {
    const connect = new AbortController();
    const probe = authorizationServerForgotClient(testSettings({ environment: "test" }), {
      authorizationEndpoint: `${origin}/hang/authorize`,
      clientId: "forgotten-client",
      redirectUri,
      scopes: [],
      signal: connect.signal,
    });
    connect.abort();
    await expect(probe).rejects.toBeDefined();
  });
});
