import { expect, test } from "bun:test";
import { summarizeUpdateBlockers } from "../src/update-admission";

test("many private sessions produce a bounded, identity-free update receipt", () => {
  const blockers = Array.from({ length: 10_000 }, (_, index) => ({
    kind: index % 2 ? "browser_action" : "computer_virtual_seat",
    resourceId: `private-session-${index}`,
    count: 1,
  }));
  const summary = summarizeUpdateBlockers(blockers);
  expect(summary).toEqual([
    { kind: "browser_action", count: 5000 },
    { kind: "computer_virtual_seat", count: 5000 },
  ]);
  const reply = JSON.stringify({
    ok: true,
    data: { idle: false, operationId: crypto.randomUUID(), blockers: summary },
  });
  expect(reply.length).toBeLessThan(1024);
  expect(reply).not.toContain("private-session");
});

test("unknown future categories retain an overflow count within the byte bound", () => {
  const summary = summarizeUpdateBlockers(
    Array.from({ length: 1000 }, (_, index) => ({
      kind: `category_${index}`.padEnd(64, "x"),
      count: 1,
    })),
  );
  expect(summary).toHaveLength(33);
  expect(summary.reduce((sum, blocker) => sum + blocker.count, 0)).toBe(1000);
  expect(JSON.stringify(summary).length).toBeLessThan(4096);
  expect(summarizeUpdateBlockers([])).toEqual([]);
});
