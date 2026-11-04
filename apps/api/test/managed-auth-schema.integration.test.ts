import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ManagedEmailTransport } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";

import { createManagedAuth } from "../src/auth/managed-auth";

// Managed auth turns off Better Auth's per-request schema gate because the
// migrations own the auth tables. This test keeps the guarantee that gate
// gave: Better Auth's own schema check passes against the migrated database.

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("managed-auth-schema");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("managed auth schema tests require PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 2, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const transport: ManagedEmailTransport = {
  sender: "auth@example.test",
  idempotency: { scope: "test:managed-auth-schema", retentionSeconds: 86_400 },
  send: async () => ({ status: "sent" as const, providerMessageId: null }),
};

type SchemaCheckContext = {
  checkSchema?: () => Promise<void> | undefined;
  explicitSchemaCheck?: () => Promise<void> | undefined;
};

describe("managed auth schema", () => {
  test("the migrated database matches Better Auth's expected schema", async () => {
    if (!client || !shared) return;
    const settings = testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      publicBaseUrl: "https://app.example.test",
      betterAuthSecret: "managed-auth-schema-test-secret-at-least-32-bytes",
      managedAuthGoogleClientId: "google-test",
      managedAuthGoogleClientSecret: "google-secret",
    });
    const auth = createManagedAuth(settings, client.db, transport)!;
    const context = (await auth.$context) as unknown as SchemaCheckContext;
    // Requests never wait on schema introspection.
    expect(context.checkSchema).toBeUndefined();
    // The explicit check is still available and finds no differences.
    expect(typeof context.explicitSchemaCheck).toBe("function");
    await context.explicitSchemaCheck!();
  });
});
