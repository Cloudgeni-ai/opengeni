import { describe, expect, test } from "bun:test";
import {
  clipAgentProvenanceHops,
  frozenScheduledOccurrenceInitiator,
  UNATTRIBUTED_LEGACY_INITIATOR,
} from "../src/turn-initiator";

describe("accepted scheduled service provenance", () => {
  const scheduler = {
    initiator: { kind: "service" as const, subjectId: "scheduler", label: "OpenGeni scheduler" },
    context: { updateIds: ["update-1"], scheduledRunIds: ["run-1"] },
  };

  test("an unattributed legacy task keeps the scheduler, not the missing creator sentinel", () => {
    expect(
      frozenScheduledOccurrenceInitiator(
        { createdBy: UNATTRIBUTED_LEGACY_INITIATOR, createdByContext: { backfill: true } },
        scheduler,
      ),
    ).toBe(scheduler);
  });

  test("a subject-authored task does not turn its creator into the occurrence initiator", () => {
    expect(
      frozenScheduledOccurrenceInitiator(
        { createdBy: { kind: "subject", subjectId: "user:creator" }, createdByContext: {} },
        scheduler,
      ),
    ).toBe(scheduler);
  });

  test("a named service retains accepted provenance, scheduler lineage, and no human", () => {
    const createdBy = { kind: "service" as const, subjectId: "cloudgeni:drift", label: "Drift" };
    expect(
      frozenScheduledOccurrenceInitiator(
        {
          createdBy,
          createdByContext: { label: "Drift", job: "job-42", updateIds: ["not-lineage"] },
        },
        scheduler,
      ),
    ).toEqual({
      initiator: createdBy,
      context: { job: "job-42", ...scheduler.context },
      initiatingHumanSubjectId: null,
    });
  });

  test("the scheduler keeps its historical display label when none was stored", () => {
    expect(
      frozenScheduledOccurrenceInitiator(
        { createdBy: { kind: "service", subjectId: "scheduler" }, createdByContext: {} },
        scheduler,
      ),
    ).toEqual({ ...scheduler, initiatingHumanSubjectId: null });
  });
});

describe("bounded agent provenance", () => {
  test("retains the causal root and newest hops when the middle is truncated", () => {
    const hops = Array.from({ length: 40 }, (_, index) => ({
      kind: "agent",
      sessionId: `session-${index}`,
      turnId: `turn-${index}`,
    }));

    const clipped = clipAgentProvenanceHops(hops);

    expect(clipped).toHaveLength(32);
    expect(clipped[0]).toBe(hops[0]);
    expect(clipped[1]).toBe(hops[9]);
    expect(clipped.at(-1)).toBe(hops[39]);
  });

  test("returns an untruncated chain unchanged", () => {
    const hops = [{ kind: "agent", sessionId: "root", turnId: "turn-root" }];

    expect(clipAgentProvenanceHops(hops)).toBe(hops);
  });
});
