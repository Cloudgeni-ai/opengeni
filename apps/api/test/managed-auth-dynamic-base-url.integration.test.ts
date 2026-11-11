import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ManagedEmailTransport } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import { createManagedAuth } from "../src/auth/managed-auth";

// A deployment serving several public hosts (OPENGENI_BETTER_AUTH_ALLOWED_HOSTS)
// sits behind the bundled web server or an ingress that reaches the API on an
// internal address and names the public host in x-forwarded-host. OAuth
// callbacks must be built on that public host when it is allowed, and on the
// configured public URL otherwise.

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let clientAddress = 10;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("managed-auth-dynamic-base-url");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("dynamic base URL tests require PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 4, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const transport: ManagedEmailTransport = {
  sender: "auth@example.test",
  idempotency: { scope: "test:dynamic-base-url", retentionSeconds: 86_400 },
  send: async () => ({ status: "sent" as const, providerMessageId: null }),
};

function app() {
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: "https://app.example.test",
    betterAuthSecret: "managed-dynamic-base-url-test-secret-at-least-32-bytes",
    betterAuthAllowedHosts: "app.example.test,staging.example.test",
    betterAuthTrustedOrigins: "https://staging.example.test",
    managedAuthGoogleClientId: "google-test",
    managedAuthGoogleClientSecret: "google-secret",
    managedAuthSessionSetMode: "legacy",
  });
  return createApp({
    settings,
    db: client!.db,
    managedAuth: createManagedAuth(settings, client!.db, transport)!,
    managedEmailTransport: transport,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
}

async function googleRedirectUri(forwardedHost: string): Promise<string | null> {
  clientAddress += 1;
  const start = await app().request("http://api.internal:8080/v1/auth/sign-in/social", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `https://${forwardedHost}`,
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": `198.51.100.${clientAddress % 250}`,
      "x-forwarded-host": forwardedHost,
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({
      provider: "google",
      callbackURL: "https://app.example.test/",
      disableRedirect: true,
    }),
  });
  expect(start.status).toBe(200);
  return new URL(((await start.json()) as { url: string }).url).searchParams.get("redirect_uri");
}

describe("managed auth with allowed public hosts", () => {
  test("builds the OAuth callback on the allowed forwarded public host", async () => {
    if (!shared || !client) return;
    expect(await googleRedirectUri("staging.example.test")).toBe(
      "https://staging.example.test/v1/auth/callback/google",
    );
  }, 120_000);

  test("falls back to the configured public URL for a host that isn't allowed", async () => {
    if (!shared || !client) return;
    expect(await googleRedirectUri("elsewhere.example.test")).toBe(
      "https://app.example.test/v1/auth/callback/google",
    );
  }, 120_000);
});
