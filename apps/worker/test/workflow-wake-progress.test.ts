import { expect, test } from "bun:test";
import type { Context } from "@temporalio/activity";
import { workflowWakeProgress } from "../src/activities/workflow-wake";
import {
  reconcilePendingSessionWorkflowWakes,
  type NotifyServices,
} from "../src/activities/parent-wake";
import { deferred } from "./fixtures/telemetry-clock";

test("wake heartbeat records real progress and stops cancelled attempts", async () => {
  const abort = new AbortController();
  const heartbeats: unknown[] = [];
  const progress = workflowWakeProgress({
    cancellationSignal: abort.signal,
    heartbeat: (details: unknown) => {
      heartbeats.push(details);
    },
  } as Context);
  progress("services");
  const claim = deferred<never[]>();
  const work = reconcilePendingSessionWorkflowWakes(
    { wakeSessionWorkflow: async () => undefined } as unknown as NotifyServices,
    10,
    { claimPendingSessionWorkflowWakes: async () => await claim.promise },
    () => progress("claim"),
  );
  // No timer can claim progress while the DB promise is blocked.
  expect(heartbeats).toEqual([{ stage: "services" }, { stage: "claim" }]);
  abort.abort(new Error("attempt expired"));
  claim.resolve([]);
  await expect(work).rejects.toThrow("attempt expired");
  expect(heartbeats).toHaveLength(2);
  expect(() => progress("late work")).toThrow("attempt expired");
});
