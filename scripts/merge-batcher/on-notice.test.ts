import { test, expect } from "bun:test";
import { stageOnNotice } from "./active";
import { emptyLedger } from "./model";
test("one ON ID stages every open PR once, independent of readiness or owner", () => {
  const ledger = emptyLedger();
  expect(stageOnNotice(ledger, "rollout-20261023", [1, 42, 3, 42], "2026-10-23T00:00:00Z")).toBe(
    true,
  );
  expect(ledger.onNotices?.["rollout-20261023"]?.recipients).toEqual([1, 3, 42]);
  expect(Object.values(ledger.effects)).toHaveLength(3);
  for (const effect of Object.values(ledger.effects)) {
    expect(effect.kind).toBe("comment");
    if (effect.kind === "comment")
      expect(effect.body).toContain("Merges now go through the batcher: add `queue-ready` to land");
  }
  const restored = JSON.parse(JSON.stringify(ledger));
  expect(stageOnNotice(restored, "rollout-20261023", [99], "2026-10-23T01:00:00Z")).toBe(false);
  expect(Object.values(restored.effects)).toHaveLength(3);
});
test("invalid notice inventory cannot partially stage effects", () => {
  const ledger = emptyLedger();
  expect(() =>
    stageOnNotice(ledger, "rollout-20261023", [1, -1], "2026-10-23T00:00:00Z"),
  ).toThrow();
  expect(Object.keys(ledger.effects)).toHaveLength(0);
});
