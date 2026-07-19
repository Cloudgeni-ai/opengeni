import { describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "@opengeni/contracts";
import type { ProducedSessionEvent } from "@opengeni/db";
import {
  appendOrConfirmAndPublishTurnEventsFenced,
  confirmExactTurnEventPersistence,
  type ExactTurnEventInput,
} from "../src";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const producerId = "workflow:turn:activity";
const occurredAt = new Date("2026-07-18T22:22:36.000Z");

const input: ExactTurnEventInput = {
  type: "agent.model.usage",
  payload: { sourceKey: "resp-1", inputTokens: 10, outputTokens: 2 },
  turnId,
  producerId,
  producerSeq: 17,
  occurredAt,
};

function durable(
  association: "current" | "duplicate" | "late_rejected" = "current",
): ProducedSessionEvent {
  const rejected = association === "late_rejected";
  return {
    id: "55555555-5555-4555-8555-555555555555",
    workspaceId,
    sessionId,
    sequence: 91,
    type: rejected ? "turn.event.rejected_late" : input.type,
    payload: rejected
      ? { rejectedType: input.type, rejectedPayload: input.payload }
      : input.payload,
    occurredAt: occurredAt.toISOString(),
    turnId,
    turnGeneration: 7,
    turnAttemptId: attemptId,
    turnAssociation: association,
    producerId,
    producerSeq: 17,
  };
}

const bus = {
  publish: mock(async () => undefined),
} as any;

describe("exact turn event persistence", () => {
  test("confirms only the exact producer payload and attempt fence", () => {
    expect(confirmExactTurnEventPersistence([durable()], [input], 7, attemptId)).toMatchObject({
      accepted: true,
    });
    expect(() =>
      confirmExactTurnEventPersistence(
        [{ ...durable(), payload: { sourceKey: "different" } }],
        [input],
        7,
        attemptId,
      ),
    ).toThrow("producer identity was reused");
  });

  test("appends when the producer row is absent", async () => {
    const appended = durable();
    const append = mock(async () => ({ events: [appended], accepted: true }));
    const find = mock(async () => []);
    await expect(
      appendOrConfirmAndPublishTurnEventsFenced(
        {} as any,
        bus,
        workspaceId,
        sessionId,
        turnId,
        7,
        attemptId,
        [input],
        { append: append as any, find: find as any },
      ),
    ).resolves.toEqual({ events: [appended], accepted: true });
    expect(append).toHaveBeenCalledTimes(1);
  });

  test("confirms commit-response loss without a second durable event", async () => {
    let lookups = 0;
    const append = mock(async () => {
      throw new Error("connection lost after COMMIT");
    });
    const find = mock(async () => (++lookups === 1 ? [] : [durable()]));
    await expect(
      appendOrConfirmAndPublishTurnEventsFenced(
        {} as any,
        bus,
        workspaceId,
        sessionId,
        turnId,
        7,
        attemptId,
        [input],
        { append: append as any, find: find as any },
      ),
    ).resolves.toMatchObject({ accepted: true, events: [durable()] });
    expect(append).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledTimes(2);
  });

  test("preserves a successor-attempt rejection as stale truth", async () => {
    const find = mock(async () => [durable("late_rejected")]);
    const append = mock(async () => ({ events: [] as SessionEvent[], accepted: true }));
    await expect(
      appendOrConfirmAndPublishTurnEventsFenced(
        {} as any,
        bus,
        workspaceId,
        sessionId,
        turnId,
        7,
        attemptId,
        [input],
        { append: append as any, find: find as any },
      ),
    ).resolves.toMatchObject({ accepted: false });
    expect(append).not.toHaveBeenCalled();
  });

  test("keeps PostgreSQL confirmation authoritative when live NATS fanout fails", async () => {
    const append = mock(async () => ({ events: [durable()], accepted: true }));
    const find = mock(async () => []);
    const disconnectedBus = {
      publish: mock(async () => {
        throw new Error("NATS unavailable");
      }),
    } as any;
    await expect(
      appendOrConfirmAndPublishTurnEventsFenced(
        {} as any,
        disconnectedBus,
        workspaceId,
        sessionId,
        turnId,
        7,
        attemptId,
        [input],
        { append: append as any, find: find as any },
      ),
    ).resolves.toEqual({ events: [durable()], accepted: true });
    expect(disconnectedBus.publish).toHaveBeenCalledTimes(1);
  });
});
