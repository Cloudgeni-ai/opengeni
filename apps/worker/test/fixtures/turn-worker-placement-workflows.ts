import { proxyActivities } from "@temporalio/workflow";

type PlacementInput = {
  sequence: number;
  enqueuedAtMs: number;
  delayMs: number;
  activityScheduledAtMs?: number;
};

type PlacementResult = {
  workerId: string;
  sequence: number;
  startedAtMs: number;
  apiToActivityStartMs: number;
  eligibleQueueWaitMs: number;
};

const { placementActivity } = proxyActivities<{
  placementActivity(input: PlacementInput): Promise<PlacementResult>;
}>({ startToCloseTimeout: "30s" });

export async function placementWorkflow(input: PlacementInput): Promise<PlacementResult> {
  return await placementActivity({ ...input, activityScheduledAtMs: Date.now() });
}

export async function placementBurstWorkflow(
  inputs: PlacementInput[],
): Promise<PlacementResult[]> {
  const activityScheduledAtMs = Date.now();
  return await Promise.all(
    inputs.map((input) => placementActivity({ ...input, activityScheduledAtMs })),
  );
}
