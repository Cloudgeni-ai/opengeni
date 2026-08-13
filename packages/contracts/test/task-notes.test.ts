import { describe, expect, test } from "bun:test";
import {
  TASK_NOTE_LIST_MAX_LIMIT,
  TASK_NOTE_LIST_RESPONSE_MAX_BYTES,
  TASK_NOTE_REASON_MAX_BYTES,
  TASK_NOTE_TEXT_MAX_BYTES,
  TaskNoteListResponse,
  TaskNoteReason,
  TaskNoteText,
} from "../src";

function note(text: string, index = 0) {
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    rootSessionId: "00000000-0000-4000-8000-000000000100",
    kind: "finding",
    text,
    status: "active",
    version: 1,
    expiresAt: "2026-08-14T00:00:00.000Z",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    archivedAt: null,
    provenance: {
      actorKind: "human",
      sourceSessionId: "00000000-0000-4000-8000-000000000200",
      sourceTurnId: "00000000-0000-4000-8000-000000000300",
    },
  };
}

describe("task note contracts", () => {
  test("bounds note and archive text by UTF-8 bytes and rejects padded content", () => {
    expect(TaskNoteText.safeParse("😀".repeat(TASK_NOTE_TEXT_MAX_BYTES / 4)).success).toBe(true);
    expect(TaskNoteText.safeParse(`😀${"a".repeat(TASK_NOTE_TEXT_MAX_BYTES - 3)}`).success).toBe(
      false,
    );
    expect(TaskNoteReason.safeParse("😀".repeat(TASK_NOTE_REASON_MAX_BYTES / 4)).success).toBe(
      true,
    );
    expect(TaskNoteReason.safeParse(" padded ").success).toBe(false);
  });

  test("bounds both list cardinality and aggregate serialized bytes", () => {
    expect(
      TaskNoteListResponse.safeParse({
        notes: Array.from({ length: TASK_NOTE_LIST_MAX_LIMIT }, (_, index) => note("x", index)),
      }).success,
    ).toBe(true);
    expect(
      TaskNoteListResponse.safeParse({
        notes: Array.from({ length: TASK_NOTE_LIST_MAX_LIMIT + 1 }, (_, index) => note("x", index)),
      }).success,
    ).toBe(false);
    const oversized = {
      notes: Array.from({ length: TASK_NOTE_LIST_MAX_LIMIT }, (_, index) =>
        note("x".repeat(TASK_NOTE_TEXT_MAX_BYTES), index),
      ),
    };
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeLessThan(
      TASK_NOTE_LIST_RESPONSE_MAX_BYTES,
    );
    expect(TaskNoteListResponse.safeParse(oversized).success).toBe(true);
  });
});
