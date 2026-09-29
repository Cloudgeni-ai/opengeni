import { expect, test } from "bun:test";
import { RefreshScheduledTaskAccessRequest, ScheduledTaskAccessAttention } from "../src/index";

const base = {
  taskId: crypto.randomUUID(),
  taskName: "Morning inbox digest",
  executionDigest: "a".repeat(64),
};
const failure = {
  serverId: "mail",
  name: "Mail",
  providerDomain: "mail.example.test",
  reason: "expired" as const,
  count: 1,
  firstOccurredAt: "2026-09-17T08:00:05.000Z",
};

test("an attention item names a failed run, an unavailable account, or both", () => {
  const blocked = {
    ...base,
    runId: null,
    firedAt: null,
    failures: [],
    unavailableAccounts: [{ id: "mail", name: "Mail" }],
  };
  expect(ScheduledTaskAccessAttention.parse(blocked)).toEqual(blocked);
  const both = {
    ...blocked,
    runId: crypto.randomUUID(),
    firedAt: "2026-09-17T08:00:00.000Z",
    failures: [failure],
  };
  expect(ScheduledTaskAccessAttention.parse(both)).toEqual(both);

  // Nothing to say is not an item.
  expect(
    ScheduledTaskAccessAttention.safeParse({ ...blocked, unavailableAccounts: [] }).success,
  ).toBe(false);
  // A run's failures always name the run, and a run always has its time.
  expect(ScheduledTaskAccessAttention.safeParse({ ...blocked, failures: [failure] }).success).toBe(
    false,
  );
  expect(ScheduledTaskAccessAttention.safeParse({ ...both, firedAt: null }).success).toBe(false);
});

test("a refresh may only leave out known defaults", () => {
  const executionDigest = "b".repeat(64);
  expect(
    RefreshScheduledTaskAccessRequest.parse({
      executionDigest,
      leaveOut: { connectors: ["gmail"], openGeniTools: ["browser_read"] },
    }),
  ).toEqual({
    executionDigest,
    leaveOut: { connectors: ["gmail"], openGeniTools: ["browser_read"] },
  });
  expect(
    RefreshScheduledTaskAccessRequest.safeParse({
      executionDigest,
      leaveOut: { openGeniTools: ["not_a_tool"] },
    }).success,
  ).toBe(false);
  expect(
    RefreshScheduledTaskAccessRequest.safeParse({
      executionDigest,
      leaveOut: { connectors: ["gmail"], permissions: ["workspace:admin"] },
    }).success,
  ).toBe(false);
});
