import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import type { ModelRequestEvidence, SessionEvent } from "@opengeni/contracts";
import { withModelRequestEvidence } from "@opengeni/runtime";
import {
  emitModelCallUsage,
  type TurnEventPublisher,
} from "../src/activities/agent-turn/model-usage";

test("evidence joins only the exact committed current usage event, including auxiliary purpose", async () => {
  const records: ModelRequestEvidence[] = [];
  let accepted = true;
  const publish: TurnEventPublisher = async (events) => ({
    accepted,
    canonicalStartupMilestones: [],
    events: events.map(
      (event) =>
        ({
          ...event,
          id: "committed-event",
          sequence: 42,
          turnAssociation: accepted ? "current" : "late",
        }) as SessionEvent,
    ),
  });
  const input = {
    observability: createObservability(testSettings(), { component: "worker" }),
    publish,
    accountId: "account",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    provider: "codex",
    providerApi: "responses" as const,
    model: "gpt-6.1-sol",
    purpose: "session-title" as const,
    sourceKey: "actual-title-response",
    usage: { usage: { inputTokens: 7, outputTokens: 2 } },
  };
  await withModelRequestEvidence(
    async (r) => {
      records.push(r);
    },
    async () => {
      expect(await emitModelCallUsage(input)).toBe(true);
      accepted = false;
      expect(await emitModelCallUsage({ ...input, sourceKey: "late-response" })).toBe(false);
      expect(await emitModelCallUsage({ ...input, usage: null })).toBe(false);
    },
  );
  const evidence = records.filter((r) => r.kind === "usage");
  expect(evidence).toHaveLength(1);
  expect(evidence[0]?.responseId).toBe("actual-title-response");
  expect(evidence[0]?.purpose).toBe("session-title");
  expect(evidence[0]?.details).toEqual({
    sourceKey: "actual-title-response",
    usageEventId: "committed-event",
    usageEventSequence: 42,
  });
  expect((evidence[0]!.content as any).cachedTokens).toBeNull();
});

test("worker claim/settlement and auxiliary call sites own the evidence lifecycle", () => {
  const run = readFileSync(new URL("../src/activities/agent-turn/run.ts", import.meta.url), "utf8");
  const compaction = readFileSync(
    new URL("../src/activities/agent-turn/compaction-prep.ts", import.meta.url),
    "utf8",
  );
  expect(run.indexOf("await startModelRequestEvidence()")).toBeGreaterThan(
    run.indexOf("await claimTurnAttempt("),
  );
  expect(run).toMatch(/await finishModelRequestEvidence\(\);\s*return settle\(\.\.\.args\);/);
  expect(run).toContain('withModelEvidencePurpose("session-title"');
  expect(run).toContain('withModelEvidencePurpose("compaction"');
  expect(compaction).toMatch(
    /withModelEvidencePurpose\("compaction",\s*\(\) => summarizeModel\(s, m\)\)/,
  );
  expect(run).toContain("!resolvedServices.settings.modelRequestEvidenceEnabled");
});
