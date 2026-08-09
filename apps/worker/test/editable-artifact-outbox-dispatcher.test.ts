import { describe, expect, test } from "bun:test";
import {
  EDITABLE_ARTIFACT_OUTBOX_DATABASE_URL_ENV,
  EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE,
  assertDedicatedOutboxDispatcherDatabaseRole,
  dedicatedDispatcherDatabaseUrl,
} from "../src/editable-artifact-outbox-dispatcher";

describe("editable artifact outbox production composition", () => {
  test("requires the dedicated dispatcher database role", () => {
    const dedicated = `postgres://${EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE}:secret@db.internal/opengeni`;
    expect(dedicatedDispatcherDatabaseUrl(dedicated)).toBe(dedicated);

    expect(() =>
      dedicatedDispatcherDatabaseUrl("postgres://opengeni_app:secret@db.internal/opengeni"),
    ).toThrow(EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE);
    expect(() => dedicatedDispatcherDatabaseUrl("https://db.internal/opengeni")).toThrow(
      EDITABLE_ARTIFACT_OUTBOX_DATABASE_URL_ENV,
    );
  });

  test("accepts a percent-encoded exact role and rejects role lookalikes", () => {
    expect(
      dedicatedDispatcherDatabaseUrl(
        "postgresql://opengeni_artifact_outbox_dispatcher:p@localhost/opengeni",
      ),
    ).toContain("opengeni_artifact_outbox_dispatcher");
    expect(() =>
      dedicatedDispatcherDatabaseUrl(
        "postgres://opengeni_artifact_outbox_dispatcher_admin:p@localhost/opengeni",
      ),
    ).toThrow();
  });

  test("runtime posture rejects inherited relation or sequence access", async () => {
    const row = {
      current_role: EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE,
      session_role: EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE,
      can_access_any_relation: false,
      can_access_any_sequence: false,
    };
    await expect(
      assertDedicatedOutboxDispatcherDatabaseRole({
        execute: async () => [row],
      } as never),
    ).resolves.toBeUndefined();
    await expect(
      assertDedicatedOutboxDispatcherDatabaseRole({
        execute: async () => [{ ...row, can_access_any_relation: true }],
      } as never),
    ).rejects.toThrow("unsafe role posture");
    await expect(
      assertDedicatedOutboxDispatcherDatabaseRole({
        execute: async () => [{ ...row, can_access_any_sequence: true }],
      } as never),
    ).rejects.toThrow("unsafe role posture");
  });
});
