import { expect, test } from "bun:test";
import {
  acceptedPolicy,
  servingRevision,
} from "../../../packages/contracts/test/fixtures/turn-serving-policy";
import {
  projectRejectedProviderArtifacts,
  projectServingProviderArtifacts,
} from "../src/activities/run-input";

const opaque = {
  type: "reasoning",
  id: "reasoning-1",
  encrypted_content: "opaque",
  summary: [{ type: "summary_text", text: "Keep this summary" }],
};
const compact = { type: "compaction", encrypted_content: "opaque-compact" };
const turnMetadata = new Map<string, unknown>([
  [
    "turn",
    {
      turnExecutionPolicyV1: acceptedPolicy,
      turnServingPolicyV1: [
        servingRevision(),
        servingRevision({ executionGeneration: 2, historyPosition: 20, policy: acceptedPolicy }),
      ],
    },
  ],
]);
const options = { enabled: true, servingProviderId: "target", turnMetadata };

test("SUB-FAIL-08 D-37: provenance uses the latest revision strictly below each history position", () => {
  const rows = [
    { item: opaque, turnId: "turn", position: 10 },
    { item: opaque, turnId: "turn", position: 11 },
    { item: compact, turnId: "turn", position: 20 },
    { item: opaque, turnId: "turn", position: 21 },
    { item: compact, turnId: "turn", position: 22 },
    { item: { type: "function_call", call_id: "done" }, turnId: "turn", position: 23 },
  ];
  const before = structuredClone(rows);
  const result = projectServingProviderArtifacts(rows, options);
  expect(result).toHaveLength(5);
  expect(result[0]).not.toHaveProperty("encrypted_content");
  expect(result[0]!.summary).toEqual(opaque.summary);
  expect(result[1]).toBe(opaque);
  expect(result[2]).toBe(compact);
  expect(result[3]).not.toHaveProperty("encrypted_content");
  expect(result[4]).toEqual(rows[5]!.item);
  expect(rows).toEqual(before);
});

test("SUB-FAIL-08: unattributable rows retain today's projection and reactive rejection still wins", () => {
  const rows = [
    { item: opaque, turnId: null, position: 30 },
    { item: compact, turnId: "missing", position: 31 },
    { item: opaque, turnId: "malformed", position: 32 },
    { item: opaque, turnId: "turn", position: 12, providerArtifactInvalidatedAt: new Date() },
    { item: compact, turnId: "turn", position: 13, providerArtifactInvalidatedAt: new Date() },
  ];
  const metadata = new Map(turnMetadata).set("malformed", { turnServingPolicyV1: null });
  expect(projectServingProviderArtifacts(rows, { ...options, turnMetadata: metadata })).toEqual(
    projectRejectedProviderArtifacts(rows),
  );
});

test("D-43: disabled or omitted projection gate does not read provenance", () => {
  const rows = [
    { item: opaque, turnId: "turn", position: 1 },
    { item: compact, turnId: "turn", position: 2 },
  ];
  let provenanceReads = 0;
  const unavailable = {
    get() {
      provenanceReads++;
      throw new Error("must not read");
    },
  } as unknown as ReadonlyMap<string, unknown>;
  for (const enabled of [false, undefined])
    expect(
      projectServingProviderArtifacts(rows, { ...options, enabled, turnMetadata: unavailable }),
    ).toEqual([opaque, compact]);
  expect(provenanceReads).toBe(0);
});
