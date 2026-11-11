import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { InteractionRequestTargetReader } from "@opengeni/runtime";
import {
  INTERACTION_TARGET_UNREADABLE_HERE,
  interactionInterventionRequestsForPause,
  interactionPauseCallFromItem,
} from "../src/activities/agent-turn/interaction-pause";
import {
  stableInteractionInterventionId,
  stableInteractionInterventionOperationId,
} from "../src/activities/agent-turn/admission";

const sessionId = randomUUID();
const turnId = randomUUID();
const request = {
  operation: "request" as const,
  resourceKind: "browser_session" as const,
  resourceId: randomUUID(),
  targetId: "tab-1",
  kind: "mfa" as const,
  reason: "Approve the sign-in on your phone.",
  expiresInSeconds: 900,
};
const reading = {
  controllerGeneration: "controller-1",
  targetGeneration: "target-1",
  documentGeneration: null,
};

describe("interaction requests a pause records", () => {
  test("reads the target of every request without an auth run, and nothing else", async () => {
    const read: string[] = [];
    const readTarget: InteractionRequestTargetReader = async (input) => {
      read.push(input.targetId);
      return reading;
    };
    const supplied = {
      ...request,
      targetId: "tab-supplied",
      expectedControllerGeneration: "controller-1",
      expectedTargetGeneration: "target-1",
      expectedDocumentGeneration: null,
    };
    const authRun = { ...request, targetId: "tab-auth", authRunId: randomUUID() };
    const wait = { operation: "wait" as const, interventionId: randomUUID() };
    const requests = await interactionInterventionRequestsForPause({
      sessionId,
      turnId,
      calls: [
        { toolCallId: "call-omitted", input: request },
        { toolCallId: "call-supplied", input: supplied },
        { toolCallId: "call-auth", input: authRun },
        { toolCallId: "call-wait", input: wait },
      ],
      readTarget,
    });
    expect(read.sort()).toEqual(["tab-1", "tab-supplied"]);
    expect(requests).toEqual([
      {
        id: stableInteractionInterventionId(sessionId, turnId, "call-omitted"),
        operationId: stableInteractionInterventionOperationId(sessionId, turnId, "call-omitted"),
        toolCallId: "call-omitted",
        input: request,
        currentTarget: reading,
      },
      {
        id: stableInteractionInterventionId(sessionId, turnId, "call-supplied"),
        operationId: stableInteractionInterventionOperationId(sessionId, turnId, "call-supplied"),
        toolCallId: "call-supplied",
        input: supplied,
        currentTarget: reading,
      },
      {
        id: stableInteractionInterventionId(sessionId, turnId, "call-auth"),
        operationId: stableInteractionInterventionOperationId(sessionId, turnId, "call-auth"),
        toolCallId: "call-auth",
        input: authRun,
      },
      {
        id: stableInteractionInterventionId(sessionId, turnId, "call-wait"),
        operationId: stableInteractionInterventionOperationId(sessionId, turnId, "call-wait"),
        toolCallId: "call-wait",
        input: wait,
      },
    ]);
  });

  test("passes on why a target could not be read, or that it cannot be read here", async () => {
    const [unread] = await interactionInterventionRequestsForPause({
      sessionId,
      turnId,
      calls: [{ toolCallId: "call-1", input: request }],
      readTarget: async () => "browser tab tab-1 was not found",
    });
    expect(unread?.currentTarget).toBe("browser tab tab-1 was not found");
    const [noReader] = await interactionInterventionRequestsForPause({
      sessionId,
      turnId,
      calls: [{ toolCallId: "call-1", input: request }],
      readTarget: null,
    });
    expect(noReader?.currentTarget).toBe(INTERACTION_TARGET_UNREADABLE_HERE);
  });

  test("reads a stored call's arguments back, as text or as an object", () => {
    expect(
      interactionPauseCallFromItem("call-1", {
        type: "function_call",
        arguments: JSON.stringify(request),
      }),
    ).toEqual({ toolCallId: "call-1", input: request });
    expect(
      interactionPauseCallFromItem("call-2", { type: "function_call", arguments: request }),
    ).toEqual({ toolCallId: "call-2", input: request });
  });

  test("the first pause and every re-freeze read targets with the attempt's reader", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/stream-attempt.ts", import.meta.url),
    ).text();
    const readerUses = source.match(/readTarget: eventing\.interactionRequestTargetReader/g) ?? [];
    // One at the first pause, one in the re-freeze passed to the open-suffix resume.
    expect(readerUses).toHaveLength(2);
    const resumeAt = source.indexOf(
      "const openSuffixResume = await settleOpenSuffixResumeIfNeeded",
    );
    expect(resumeAt).toBeGreaterThan(-1);
    expect(
      source.indexOf("readTarget: eventing.interactionRequestTargetReader", resumeAt),
    ).toBeGreaterThan(resumeAt);
    expect(source).toContain("recorded: observeOpenedInteractionRequests");
    // Refused requests opened nothing: the metric counts recorded calls only.
    expect(source).toContain(
      "await observeOpenedInteractionRequests(interactionInterventionInterruptions)",
    );
    expect(source).not.toMatch(
      /for \(const interruption of interactionInterventionInterruptions\)[\s\S]{0,200}outcome: "opened"/,
    );
  });
});
