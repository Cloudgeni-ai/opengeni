import { expect, test } from "bun:test";
import {
  countTurnServingPolicyChangesV1,
  readTurnServingPolicyV1,
  TurnServingPolicyV1,
  TurnPendingServingPolicyV1,
  readTurnPendingServingPolicyV1,
} from "../src";
import { acceptedPolicy, servingRevision } from "./fixtures/turn-serving-policy";

test("D-37 pending validation: proposals are strict, separate from serving provenance", () => {
  const revision = servingRevision();
  const pending = {
    schemaVersion: 1,
    sourceExecutionGeneration: 1,
    sourceAttemptId: crypto.randomUUID(),
    policy: revision.policy,
    connectionId: revision.connectionId,
    reason: revision.reason,
  };
  expect(TurnPendingServingPolicyV1.parse(pending)).toEqual(pending);
  expect(readTurnPendingServingPolicyV1({})).toBeNull();
  expect(readTurnPendingServingPolicyV1({ turnPendingServingPolicyV1: pending })).toEqual(pending);
  expect(readTurnServingPolicyV1({ turnPendingServingPolicyV1: pending })).toEqual({
    kind: "absent",
  });
  for (const invalid of [
    null,
    { ...pending, sourceExecutionGeneration: 0 },
    { ...pending, historyPosition: 10 },
    { ...pending, policy: { ...pending.policy, credentialRestriction: "developer_setup" } },
  ]) {
    expect(TurnPendingServingPolicyV1.safeParse(invalid).success).toBe(false);
    expect(() => readTurnPendingServingPolicyV1({ turnPendingServingPolicyV1: invalid })).toThrow(
      "Malformed",
    );
  }
});

test("D-37 schema: strict secret-safe serving identity and external funding", () => {
  const revision = servingRevision();
  expect(TurnServingPolicyV1.parse(revision)).toEqual(revision);
  for (const invalid of [
    { ...revision, secret: "untrusted-secret" },
    { ...revision, executionGeneration: 0 },
    { ...revision, executionGeneration: 1.5 },
    { ...revision, connectionId: "not-an-id" },
    { ...revision, historyPosition: -1 },
    { ...revision, policy: { ...revision.policy, credentialRestriction: "developer_setup" } },
    {
      ...revision,
      policy: {
        ...revision.policy,
        billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
      },
    },
    {
      ...revision,
      policy: {
        ...revision.policy,
        credentialSource: { kind: "deployment", mechanism: "api_key" },
      },
    },
  ])
    expect(TurnServingPolicyV1.safeParse(invalid).success).toBe(false);
});

test("D-37 reader: only absent is legacy; malformed or out-of-order revisions fail closed", () => {
  const first = servingRevision();
  const next = servingRevision({ executionGeneration: 2, historyPosition: 10.5 });
  expect(readTurnServingPolicyV1(null)).toEqual({ kind: "absent" });
  expect(readTurnServingPolicyV1({ unrelated: 1 })).toEqual({ kind: "absent" });
  expect(readTurnServingPolicyV1({ turnServingPolicyV1: [first, next] })).toEqual({
    kind: "valid",
    revisions: [first, next],
  });
  for (const value of [
    null,
    undefined,
    [],
    [first, first],
    [next, first],
    [first, { ...next, historyPosition: 9 }],
    [{ secret: "untrusted-secret" }],
  ]) {
    expect(() => readTurnServingPolicyV1({ turnServingPolicyV1: value })).toThrow("Malformed");
    try {
      readTurnServingPolicyV1({ turnServingPolicyV1: value });
    } catch (error) {
      expect(String(error)).not.toContain("untrusted-secret");
    }
  }
  expect(() => readTurnServingPolicyV1([])).toThrow("Malformed");
});

test("SUB-FAIL-11 D-39: count only provider/model changes after the baseline", () => {
  const first = servingRevision();
  const accountOnly = servingRevision({
    executionGeneration: 2,
    connectionId: "00000000-0000-4000-8000-000000000002",
  });
  const reasoningOnly = servingRevision({
    executionGeneration: 3,
    policy: { ...first.policy, reasoningEffort: "low" },
  });
  const sameProviderModel = servingRevision({
    executionGeneration: 4,
    policy: { ...first.policy, productModelId: "target/second" },
  });
  const providerOnly = servingRevision({
    executionGeneration: 5,
    policy: { ...sameProviderModel.policy, providerId: "third" },
  });
  const returned = servingRevision({ executionGeneration: 6, policy: acceptedPolicy });
  expect(countTurnServingPolicyChangesV1([])).toBe(0);
  expect(countTurnServingPolicyChangesV1([first, accountOnly, reasoningOnly])).toBe(0);
  expect(
    countTurnServingPolicyChangesV1([
      first,
      accountOnly,
      reasoningOnly,
      sameProviderModel,
      providerOnly,
      returned,
    ]),
  ).toBe(3);
});
