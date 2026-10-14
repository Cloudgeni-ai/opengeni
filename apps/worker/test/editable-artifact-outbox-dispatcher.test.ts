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

  test("runtime posture names the inherited relation or sequence access it rejects", async () => {
    const row = {
      current_role: EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE,
      session_role: EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE,
      accessible_relations: [] as string[],
    };
    await expect(
      assertDedicatedOutboxDispatcherDatabaseRole({
        execute: async () => [row],
      } as never),
    ).resolves.toBeUndefined();
    await expect(
      assertDedicatedOutboxDispatcherDatabaseRole({
        execute: async () => [
          { ...row, accessible_relations: ["public.editable_artifacts", "public.some_seq"] },
        ],
      } as never),
    ).rejects.toThrow(
      "unsafe role posture: it can directly access public.editable_artifacts, public.some_seq;",
    );
    await expect(
      assertDedicatedOutboxDispatcherDatabaseRole({
        execute: async () => [
          { ...row, accessible_relations: ["a.r1", "a.r2", "a.r3", "a.r4", "a.r5", "a.r6"] },
        ],
      } as never),
    ).rejects.toThrow("a.r1, a.r2, a.r3, a.r4, a.r5 and more");
    await expect(
      assertDedicatedOutboxDispatcherDatabaseRole({
        execute: async () => [
          { ...row, current_role: "opengeni_app", session_role: "opengeni_app" },
        ],
      } as never),
    ).rejects.toThrow("connected as role opengeni_app (session role opengeni_app)");
    await expect(
      assertDedicatedOutboxDispatcherDatabaseRole({
        execute: async () => [{ ...row, accessible_relations: "{}" }],
      } as never),
    ).rejects.toThrow("relation access could not be verified");
  });
});
