import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, provisionRoles, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

import {
  EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE,
  assertDedicatedOutboxDispatcherDatabaseRole,
} from "../src/editable-artifact-outbox-dispatcher";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let dispatcher: DbClient | null = null;
let available = true;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("editable-artifact-outbox-posture");
  if (!shared) {
    if (requireRealDatabase) throw new Error("Artifact outbox PostgreSQL harness is unavailable");
    available = false;
    return;
  }
  await provisionRoles(shared.adminUrl, {
    rlsStrategy: "scoped",
    artifactOutboxDispatcherRole: EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE,
    artifactOutboxDispatcherPassword: "artifact-outbox-posture-password",
  });
  const dispatcherUrl = new URL(shared.adminUrl);
  dispatcherUrl.username = EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE;
  dispatcherUrl.password = "artifact-outbox-posture-password";
  dispatcher = createDb(dispatcherUrl.toString(), { max: 1 });
}, 180_000);

afterAll(async () => {
  await dispatcher?.close();
  await shared?.release();
}, 180_000);

describe("artifact outbox dispatcher PostgreSQL posture", () => {
  test("accepts the provisioned execute-only role and rejects later column access", async () => {
    if (!available || !shared || !dispatcher) return;
    await expect(
      assertDedicatedOutboxDispatcherDatabaseRole(dispatcher.db),
    ).resolves.toBeUndefined();

    await shared.admin.unsafe(
      `grant select (id) on editable_artifacts to ${EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE}`,
    );
    try {
      await expect(assertDedicatedOutboxDispatcherDatabaseRole(dispatcher.db)).rejects.toThrow(
        "unsafe role posture",
      );
    } finally {
      await shared.admin.unsafe(
        `revoke select (id) on editable_artifacts from ${EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE}`,
      );
    }
  }, 30_000);
});
