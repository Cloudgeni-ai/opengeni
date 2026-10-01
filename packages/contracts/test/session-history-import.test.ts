import { describe, expect, test } from "bun:test";
import {
  AppendArchivedSessionEventsRequest,
  ArchivedSessionImportEvent,
  ImportArchivedSessionRequest,
  SESSION_HISTORY_IMPORT_MAX_EVENT_BYTES,
  SessionImportedArchive,
} from "../src";

const event = {
  type: "user.message" as const,
  createdAt: "2024-03-01T08:00:00.000Z",
  payload: { text: "Original transcript — 日本語", resources: [] },
};
const request = {
  importId: "old-host/chat-42",
  title: "Planning the migration",
  createdAt: event.createdAt,
};

describe("archived session import contracts", () => {
  test("accepts metadata-only create and preserves historical payload text", () => {
    expect(ImportArchivedSessionRequest.parse(request).events).toEqual([]);
    expect(ArchivedSessionImportEvent.parse(event)).toEqual(event);
    expect(
      ImportArchivedSessionRequest.parse({
        ...request,
        events: [event],
        visibility: "user_private",
      }),
    ).toMatchObject({ events: [event], visibility: "user_private" });
    expect(
      SessionImportedArchive.parse({
        importId: request.importId,
        importedAt: "2026-10-01T06:30:00.000Z",
        readOnly: true,
      }).readOnly,
    ).toBe(true);
  });

  test("owner identity is supplied by verified asUser authority, not body labels", () => {
    expect(
      ImportArchivedSessionRequest.safeParse({ ...request, owner: "someone-else" }).success,
    ).toBe(false);
    expect(
      ImportArchivedSessionRequest.safeParse({ ...request, createdBy: "user:other" }).success,
    ).toBe(false);
  });

  test("rejects operational authority, invalid dates and foreign envelope fields", () => {
    for (const type of [
      "session.created",
      "session.control.resumed",
      "user.approvalDecision",
      "credential.auth_needed",
      "system.update.delivered",
    ]) {
      expect(ArchivedSessionImportEvent.safeParse({ ...event, type }).success).toBe(false);
    }
    expect(ArchivedSessionImportEvent.safeParse({ ...event, createdAt: "yesterday" }).success).toBe(
      false,
    );
    expect(ArchivedSessionImportEvent.safeParse({ ...event, sequence: 100 }).success).toBe(false);
    expect(
      ArchivedSessionImportEvent.safeParse({ ...event, workspaceId: crypto.randomUUID() }).success,
    ).toBe(false);
  });

  test("requires lossless finite JSON and refuses cyclic or deeply nested payloads", () => {
    for (const invalid of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      BigInt(1),
      new Date(),
      () => "text",
    ]) {
      expect(
        ArchivedSessionImportEvent.safeParse({ ...event, payload: { text: invalid } }).success,
      ).toBe(false);
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(ArchivedSessionImportEvent.safeParse({ ...event, payload: cycle }).success).toBe(false);
    let deep: unknown = "text";
    for (let index = 0; index < 70; index++) deep = { nested: deep };
    expect(ArchivedSessionImportEvent.safeParse({ ...event, payload: { deep } }).success).toBe(
      false,
    );
  });

  test("bounds events and batch bytes in UTF-8 without truncating accepted data", () => {
    expect(
      ArchivedSessionImportEvent.safeParse({
        ...event,
        payload: { text: "é".repeat(SESSION_HISTORY_IMPORT_MAX_EVENT_BYTES / 2) },
      }).success,
    ).toBe(false);
    expect(
      ImportArchivedSessionRequest.safeParse({
        ...request,
        events: Array.from({ length: 101 }, () => event),
      }).success,
    ).toBe(false);
    const large = { ...event, payload: { text: "x".repeat(250_000) } };
    expect(ArchivedSessionImportEvent.safeParse(large).success).toBe(true);
    expect(
      AppendArchivedSessionEventsRequest.safeParse({
        batchId: "large",
        offset: 0,
        events: Array.from({ length: 5 }, () => large),
      }).success,
    ).toBe(false);
  });

  test("requires a nonempty keyed batch and a safe contiguous offset", () => {
    const batch = { batchId: "part-1", offset: 0, events: [event] };
    expect(AppendArchivedSessionEventsRequest.parse(batch)).toEqual(batch);
    for (const invalid of [
      { ...batch, batchId: "" },
      { ...batch, offset: -1 },
      { ...batch, offset: -0 },
      { ...batch, offset: 0.5 },
      { ...batch, offset: Number.MAX_SAFE_INTEGER + 1 },
      { ...batch, events: [] },
    ]) {
      expect(AppendArchivedSessionEventsRequest.safeParse(invalid).success).toBe(false);
    }
  });

  test("rejects sub-millisecond source dates instead of silently losing precision", () => {
    for (const createdAt of ["2024-03-01T08:00:00.123456Z", "2024-03-01T08:00:00.0001+02:00"]) {
      expect(ArchivedSessionImportEvent.safeParse({ ...event, createdAt }).success).toBe(false);
      expect(ImportArchivedSessionRequest.safeParse({ ...request, createdAt }).success).toBe(false);
    }
    for (const createdAt of [
      "2024-03-01T08:00:00Z",
      "2024-03-01T08:00:00.1Z",
      "2024-03-01T08:00:00.123+02:00",
    ]) {
      expect(ArchivedSessionImportEvent.parse({ ...event, createdAt }).createdAt).toBe(createdAt);
    }
  });

  test("supports leaf-module initialization independently of the root contract order", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'import { ImportArchivedSessionRequest } from "./packages/contracts/src/session-history-import.ts"; console.log(ImportArchivedSessionRequest.safeParse({importId:"leaf",title:"Archive",createdAt:"2024-03-01T08:00:00Z"}).success);',
      ],
      { cwd: `${import.meta.dir}/../../..`, stderr: "pipe", stdout: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("true");
  });
});
