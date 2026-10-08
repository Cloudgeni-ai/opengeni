import { describe, expect, test } from "bun:test";
import type { SessionTurn } from "@opengeni/contracts";
import { inputWaitReply } from "../src/activities/agent-turn/input-wait-reply";

const status = "Two of the ten reviews are done; the rest are still running.";

type Turn = Pick<SessionTurn, "source" | "initiator" | "initiatorContext">;
const human: Turn = {
  source: "user",
  initiator: { kind: "subject", subjectId: "user:alice" },
  initiatorContext: {},
};
const agentHop = {
  kind: "agent",
  sessionId: "11111111-1111-4111-8111-111111111111",
  turnId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  executionGeneration: 1,
};

async function reply(
  turn: Turn,
  latestAssistantMessageText: string | null = status,
  options: { inputWaitYielded?: boolean; durable?: string | null } = {},
): Promise<string | null> {
  return await inputWaitReply({
    inputWaitYielded: options.inputWaitYielded ?? true,
    turn,
    latestAssistantMessageText,
    readLatestDurableTurnMessage: async () => options.durable ?? null,
  });
}

describe("reply recorded when a turn ends waiting for input", () => {
  test("a human or API message that ends in wait_for_input records its latest message", async () => {
    for (const source of ["user", "api"] as const) {
      expect(await reply({ ...human, source })).toBe(status);
    }
    // A realtime delegation or an embedding host's service assertion still
    // relays a person's message.
    for (const initiator of [
      { kind: "service" as const, subjectId: "realtime-delegation" },
      { kind: "service" as const, subjectId: "acme-support-host" },
    ]) {
      expect(
        await reply({ source: "api", initiator, initiatorContext: { hostRequestId: "r-1" } }),
      ).toBe(status);
    }
  });

  test("machine-started turns, ordinary completions and silent waits record nothing", async () => {
    for (const source of ["goal", "system", "scheduled_task", "compaction"] as const) {
      expect(await reply({ ...human, source })).toBeNull();
    }
    // The answer of an ordinary completion is the turn output itself.
    expect(await reply(human, status, { inputWaitYielded: false })).toBeNull();
    for (const latest of ["", "  \n"]) {
      expect(await reply(human, latest)).toBeNull();
    }
  });

  test("an agent-created child's first turn records nothing although its source is user", async () => {
    // A spawned child's first turn inherits the parent's human initiator and
    // carries the agent hop; the task prompt came from the parent agent.
    expect(await reply({ ...human, initiatorContext: { via: [agentHop] } })).toBeNull();
    expect(
      await reply({ ...human, initiatorContext: { via: [agentHop], viaTruncated: true } }),
    ).toBeNull();
    // Same for an agent's API call into another session.
    expect(
      await reply({ ...human, source: "api", initiatorContext: { via: [agentHop] } }),
    ).toBeNull();
  });

  test("a worker-created session's first turn records nothing although its source is user", async () => {
    for (const initiator of [
      { kind: "service" as const, subjectId: "scheduler", label: "OpenGeni scheduler" },
      { kind: "service" as const, subjectId: "automation:44444444-4444-4444-8444-444444444444" },
      { kind: "service" as const, subjectId: "site-auth-maintenance" },
    ]) {
      expect(await reply({ source: "user", initiator, initiatorContext: {} })).toBeNull();
    }
  });

  test("a turn resumed in a later activity falls back to its latest durable message", async () => {
    // The activity that resumed after an approval or recovery streamed no
    // message of its own; the turn's answer is already durable.
    expect(await reply(human, null, { durable: status })).toBe(status);
    expect(await reply(human, null, { durable: null })).toBeNull();
    // A message this activity completed is newer than any durable one.
    expect(await reply(human, "Newer answer", { durable: status })).toBe("Newer answer");
    // An ineligible turn never reads.
    let read = false;
    await inputWaitReply({
      inputWaitYielded: true,
      turn: { ...human, source: "goal" },
      latestAssistantMessageText: null,
      readLatestDurableTurnMessage: async () => {
        read = true;
        return status;
      },
    });
    expect(read).toBe(false);
  });
});
