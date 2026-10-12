import { expect, test } from "bun:test";
import { buildRemoteV2ReplacementHistory } from "../src/context-compaction";
import {
  rebuildCompactionConversation,
  type ConversionHistoryRow,
  type ConversionCompactionEvent,
} from "../src/compaction-conversion";

const time = (n: number) => `2026-10-12T00:00:0${n}.000001Z`;
const message = (content: string) => ({ type: "message", role: "user", content });
const opaque = { type: "compaction", encrypted_content: "opaque-test-only" };
const row = (
  position: number,
  item: Record<string, unknown>,
  turnId: string | null = "turn",
  n = position,
): ConversionHistoryRow => ({ id: `row-${position}`, position, item, turnId, createdAt: time(n) });
const event = (
  summaryPosition: number,
  n: number,
  extra: Record<string, unknown> = {},
): ConversionCompactionEvent => ({
  sequence: n,
  turnId: "compact",
  createdAt: time(n),
  payload: { implementation: "responses_compaction_v2", summaryPosition, ...extra },
});

function fixture() {
  return {
    rows: [
      row(0, message("first")),
      row(1, { type: "message", role: "assistant", content: "answer" }),
      row(2, message("first"), null, 2),
      row(3, opaque, "compact", 2),
      row(4, message("next")),
      row(5, message("next"), null, 5),
      row(6, opaque, "compact", 5),
      row(7, message("last")),
    ],
    events: [event(3, 2), event(6, 5, { supersededFrom: 5, blockLength: 2 })],
  };
}

test("SUB-FAIL-09 rebuilds several remote compactions from retained cleartext, not active flags", () => {
  const input = fixture();
  const result = rebuildCompactionConversation(input);
  expect(result).toMatchObject({
    rebuilt: true,
    items: [input.rows[0]!.item, input.rows[1]!.item, input.rows[4]!.item, input.rows[7]!.item],
    excludedRows: 4,
  });
  expect(
    rebuildCompactionConversation({
      ...input,
      rows: input.rows.map((r) => ({ ...r, active: false })),
    }),
  ).toEqual(result);
});

test("SUB-FAIL-09 latest real clear excludes earlier unsupported history and copied markers are not clears", () => {
  const input = fixture();
  input.rows[0]!.position = -0.5;
  input.rows[4] = row(4, message("[context cleared]"), null, 4);
  input.rows[5] = row(5, message("[context cleared]"), null, 5);
  expect(rebuildCompactionConversation(input)).toMatchObject({
    rebuilt: true,
    items: [message("last")],
    excludedRows: 2,
  });
});

test.each([
  [
    "missing event",
    (f: ReturnType<typeof fixture>) => {
      f.events.splice(0, 1);
    },
  ],
  [
    "fork without turn attribution",
    (f: ReturnType<typeof fixture>) => {
      f.rows.forEach((r) => (r.turnId = null));
    },
  ],
  [
    "fractional legacy layout",
    (f: ReturnType<typeof fixture>) => {
      f.rows[3]!.position = 2.5;
    },
  ],
  [
    "missing retained row",
    (f: ReturnType<typeof fixture>) => {
      f.rows.splice(1, 1);
    },
  ],
  [
    "wrong summary turn",
    (f: ReturnType<typeof fixture>) => {
      f.events[0]!.turnId = "wrong";
    },
  ],
  [
    "wrong transaction timestamp",
    (f: ReturnType<typeof fixture>) => {
      f.events[0]!.createdAt = time(1);
    },
  ],
  [
    "competing event",
    (f: ReturnType<typeof fixture>) => {
      f.events.push(event(3, 2));
    },
  ],
  [
    "different transaction within the same millisecond",
    (f: ReturnType<typeof fixture>) => {
      f.events[0]!.createdAt = time(2).replace("000001", "000002");
    },
  ],
  [
    "unrelated attributed row",
    (f: ReturnType<typeof fixture>) => {
      f.rows[2]!.turnId = "other";
    },
  ],
  [
    "unrelated null-turn row",
    (f: ReturnType<typeof fixture>) => {
      f.rows[2]!.item = message("unrelated");
    },
  ],
  [
    "unknown legacy writer",
    (f: ReturnType<typeof fixture>) => {
      f.events[0]!.payload.implementation = "unknown";
    },
  ],
  [
    "explicit length mismatch",
    (f: ReturnType<typeof fixture>) => {
      f.events[1]!.payload.blockLength = 1;
    },
  ],
  [
    "partial explicit metadata",
    (f: ReturnType<typeof fixture>) => {
      delete f.events[1]!.payload.blockLength;
    },
  ],
  [
    "opaque item without event",
    (f: ReturnType<typeof fixture>) => {
      f.rows[7]!.item = opaque;
    },
  ],
] as const)("SUB-FAIL-09 refuses %s", (_name, mutate) => {
  const input = fixture();
  mutate(input);
  expect(rebuildCompactionConversation(input).rebuilt).toBe(false);
});

test("SUB-FAIL-09 omits opaque reasoning but retains cleartext without changing audit rows", () => {
  const input = fixture();
  input.rows[7]!.item = {
    type: "reasoning",
    encrypted_content: "opaque-test",
    summary: [{ type: "summary_text", text: "retained" }],
  };
  const result = rebuildCompactionConversation(input);
  expect(result.rebuilt).toBe(true);
  if (!result.rebuilt) return;
  expect(result.items.at(-1)).toEqual({
    type: "reasoning",
    summary: [{ type: "summary_text", text: "retained" }],
  });
  expect(input.rows[7]!.item.encrypted_content).toBe("opaque-test");
});

test("SUB-FAIL-09 explicit block metadata excludes attributed trailing rows", () => {
  const input = fixture();
  input.rows[7] = row(7, message("synthetic trailing"), null, 5);
  input.events[1]!.payload.blockLength = 3;
  const result = rebuildCompactionConversation(input);
  expect(result).toMatchObject({
    rebuilt: true,
    items: [input.rows[0]!.item, input.rows[1]!.item, input.rows[4]!.item],
    excludedRows: 5,
  });
});

test("SUB-FAIL-09 missing first rows and fractional un-compacted prefixes are refused", () => {
  for (const position of [1, -2, 0.5, Number.NaN]) {
    expect(
      rebuildCompactionConversation({
        rows: [row(position, message("missing prefix"), "turn", 0)],
        events: [],
      }).rebuilt,
    ).toBe(false);
  }
});

test("SUB-FAIL-09 identical unrelated or reordered legacy copies are not provenance", () => {
  const input = fixture();
  input.rows[1]!.item = message("first");
  expect(rebuildCompactionConversation(input)).toEqual({
    rebuilt: false,
    reason: "unsupported_layout",
  });
  const reversed = {
    rows: [
      row(0, message("a")),
      row(1, message("b")),
      row(2, message("b"), null, 2),
      row(3, message("a"), null, 2),
      row(4, opaque, "compact", 2),
    ],
    events: [event(4, 2)],
  };
  expect(rebuildCompactionConversation(reversed).rebuilt).toBe(false);
});

test("SUB-FAIL-09 reconstructs the real runtime replacement builder's unchanged legacy copies", () => {
  const original = [message("question"), { type: "message", role: "assistant", content: "answer" }];
  const replacement = buildRemoteV2ReplacementHistory(original, opaque);
  const rows = [
    ...original.map((item, index) => row(index, item)),
    ...replacement.map((item, index) =>
      row(original.length + index, item, item.type === "compaction" ? "compact" : null, 2),
    ),
  ];
  const result = rebuildCompactionConversation({ rows, events: [event(rows.at(-1)!.position, 2)] });
  expect(result).toMatchObject({
    rebuilt: true,
    items: original,
    excludedRows: replacement.length,
  });
});

test("SUB-FAIL-09 long history is complete and exclusions name exact retained positions", () => {
  const items = Array.from({ length: 2500 }, (_, index) =>
    message(`${index}: ${"retained original text ".repeat(200)}`),
  );
  const rows = items.map((item, position) => row(position, item, "turn", 0));
  const result = rebuildCompactionConversation({ rows, events: [] });
  expect(result).toMatchObject({
    rebuilt: true,
    items,
    excludedRows: 0,
    layout: "integer_compaction_v1",
  });
  if (!result.rebuilt) throw new Error("long history refused");
  expect(result.omissions.every((omission) => omission.positions.length === 0)).toBe(true);
  const compacted = rebuildCompactionConversation(fixture());
  if (!compacted.rebuilt) throw new Error("fixture refused");
  expect(compacted.omissions).toContainEqual({
    reason: "replacement_block",
    positions: [2, 3, 5, 6],
  });
  expect(compacted.omissions).toContainEqual({ reason: "opaque_artifact", positions: [3, 6] });
});
