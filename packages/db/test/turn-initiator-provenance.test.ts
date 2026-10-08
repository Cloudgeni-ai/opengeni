import { describe, expect, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  metadataWithTurnExecutionPolicyV1,
  ServiceTurnInitiatorContext,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import {
  clipAgentProvenanceHops,
  contextForCausalTurn,
  contextWithFrozenCredentialRestrictions,
  frozenCredentialRestriction,
  frozenInitiatorForCommandActor,
  frozenScheduledOccurrenceInitiator,
  UNATTRIBUTED_LEGACY_INITIATOR,
} from "../src/turn-initiator";

describe("frozen setup credential provenance", () => {
  test("public service context cannot forge or overwrite the protected restriction", () => {
    expect(
      ServiceTurnInitiatorContext.safeParse({ credentialRestriction: "developer_setup" }).success,
    ).toBe(false);
    expect(ServiceTurnInitiatorContext.safeParse({ credentialRestriction: "full" }).success).toBe(
      false,
    );
    expect(ServiceTurnInitiatorContext.safeParse({ job: "normal-host-provenance" }).success).toBe(
      true,
    );
  });

  test("private coalesced lineage preserves any restricted source, including the last sender", () => {
    const context = { updateIds: ["normal", "setup"] };
    expect(
      contextWithFrozenCredentialRestrictions(context, [
        {},
        { credentialRestriction: "developer_setup" },
      ]),
    ).toEqual({
      ...context,
      credentialRestriction: "developer_setup",
    });
    expect(contextWithFrozenCredentialRestrictions(context, [null, undefined, {}])).toBe(context);
    expect(
      contextWithFrozenCredentialRestrictions(
        { ...context, credentialRestriction: "developer_setup" },
        [{}],
      ).credentialRestriction,
    ).toBe("developer_setup");
  });

  test("malformed protected ceilings fail closed rather than downgrading", () => {
    for (const credentialRestriction of [null, undefined, false, "full"]) {
      expect(() => frozenCredentialRestriction({ credentialRestriction })).toThrow(
        "Malformed frozen credential restriction",
      );
    }
  });

  test("a causal continuation preserves setup scope outside clipped diagnostic hops", () => {
    const context = contextForCausalTurn(
      {},
      {
        initiator: { kind: "service", subjectId: "host" },
        context: {
          credentialRestriction: "developer_setup",
          via: Array.from({ length: 40 }, () => ({ kind: "agent" })),
        },
      },
      { sessionId: "source", turnId: "source-turn" },
    );
    expect(context.credentialRestriction).toBe("developer_setup");
    expect(context.viaTruncated).toBe(true);
  });

  test.each(["turn", "session", "none"] as const)(
    "exact source %s policy capture retains its ceiling",
    async (source) => {
      const settings = testSettings();
      const policy = resolveTurnExecutionPolicyV1(settings, {
        modelId: "scripted-model",
        requestedModelId: null,
        modelSource: "session",
        reasoningEffort: "high",
        reasoningSource: "session",
      });
      let selectedMetadata = false;
      const fakeDb = {
        select: (selection: Record<string, unknown>) => {
          selectedMetadata = Object.hasOwn(selection, "metadata");
          const query = {
            from: () => query,
            innerJoin: () => query,
            where: () => query,
            limit: async () => [
              {
                initiatorKind: "service",
                initiatorSubjectId: "host:setup",
                initiatorContext: { job: "source" },
                initiatingHumanSubjectId: null,
                metadata: metadataWithTurnExecutionPolicyV1(
                  {},
                  {
                    ...policy,
                    ...(source === "turn"
                      ? { credentialRestriction: "developer_setup" as const }
                      : {}),
                  },
                ),
                sessionMetadata: metadataWithTurnExecutionPolicyV1(
                  {},
                  {
                    ...policy,
                    ...(source === "session"
                      ? { credentialRestriction: "developer_setup" as const }
                      : {}),
                  },
                ),
              },
            ],
          };
          return query;
        },
      };
      const frozen = await frozenInitiatorForCommandActor(fakeDb as never, "workspace", {
        type: "agent_attempt",
        sessionId: "source",
        turnId: "source-turn",
        attemptId: "attempt",
        executionGeneration: 1,
      });
      expect(selectedMetadata).toBe(true);
      expect(frozen.context.credentialRestriction).toBe(
        source === "none" ? undefined : "developer_setup",
      );
      expect(frozen.context.job).toBe("source");
      expect(frozen.initiatingHumanSubjectId).toBeNull();
    },
  );
});

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
  test("causal continuations retain exact service identity and context without recursive chains", () => {
    const initiator = { kind: "service" as const, subjectId: "host:drift", label: "Drift" };
    const original = { occurrenceId: "run-42", nested: { region: "eu" }, label: "Drift" };
    let context = original as Record<string, unknown>;
    for (let index = 0; index < 40; index++) {
      context = contextForCausalTurn(
        { updateIds: [`update-${index}`] },
        { initiator, context },
        { sessionId: "session", turnId: `turn-${index}` },
      );
    }
    const via = context.via as Array<Record<string, unknown>>;
    expect(via).toHaveLength(32);
    expect(context.viaTruncated).toBe(true);
    expect(context.updateIds).toEqual(["update-39"]);
    expect(via[0]).toEqual({
      kind: "service",
      sessionId: "session",
      turnId: "turn-0",
      initiator,
      context: original,
    });
    expect(via.at(-1)?.turnId).toBe("turn-39");
    expect(via.every((hop) => !("via" in (hop.context as Record<string, unknown>)))).toBe(true);
    expect(original).toEqual({ occurrenceId: "run-42", nested: { region: "eu" }, label: "Drift" });
  });

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
