import { expect, test } from "bun:test";
import {
  sanitizeRaceProjection,
  sanitizeRaceRequest,
  sanitizeRaceResult,
} from "./browser-account-race-diagnostics";

test("race diagnostics reject arbitrary values and bound projection slots", () => {
  const secret = "synthetic-sensitive-value";
  const results = [
    sanitizeRaceResult({
      status: secret,
      managedAuthCode: secret,
      expectedGeneration: secret,
      expectedActorEpoch: secret,
      responseActorEpoch: secret,
    }),
    sanitizeRaceRequest({
      method: secret,
      pathname: `/v1/${secret}`,
      actorEpoch: secret,
      authorityHash: secret,
    }),
    sanitizeRaceProjection({
      generation: secret,
      actorEpoch: secret,
      selectedSlotId: secret,
      slots: Array.from({ length: 100 }, () => ({ id: secret, state: secret })),
    }),
  ];
  expect(JSON.stringify(results)).not.toContain(secret);
  expect(sanitizeRaceProjection({ slots: Array(100).fill(null) }).slots).toHaveLength(8);
  expect(sanitizeRaceResult({ expectedActorEpoch: "1".repeat(21) }).expectedActorEpoch).toBeNull();
});

test("race diagnostics preserve known conflict causes and decimal epochs", () => {
  expect(
    sanitizeRaceResult({
      status: 409,
      managedAuthCode: "actor_mutation_in_flight",
      expectedGeneration: "2",
      expectedActorEpoch: "1",
      responseActorEpoch: "3",
    }),
  ).toEqual({
    status: 409,
    managedAuthCode: "actor_mutation_in_flight",
    expectedGeneration: "2",
    expectedActorEpoch: "1",
    responseActorEpoch: "3",
  });
  const id = "6b5fd59d-ae9d-42e8-8b9f-d0d3c3bf2092";
  expect(
    sanitizeRaceRequest({
      method: "POST",
      pathname: `/v1/workspaces/${id}/knowledge/entries/search`,
      actorEpoch: "2",
      authorityHash: "a".repeat(64),
    }).pathname,
  ).toBe("/v1/workspaces/:workspaceId/knowledge/entries/search");
  expect(
    sanitizeRaceProjection({
      generation: "2",
      actorEpoch: "1",
      selectedSlotId: id,
      slots: [{ id, state: "active" }],
    }),
  ).toEqual({
    generation: "2",
    actorEpoch: "1",
    selectedSlotId: id,
    slots: [{ id, state: "active" }],
  });
});
