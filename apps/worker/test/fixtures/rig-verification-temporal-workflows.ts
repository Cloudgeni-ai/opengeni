import { ActivityCancellationType, proxyActivities } from "@temporalio/workflow";

export { rigVerificationWorkflow } from "../../src/workflows/rig-verification";

type DeadlineProbeActivities = {
  runRigVerificationDeadlineProbe(): Promise<void>;
};

const deadlineProbeActivities = proxyActivities<DeadlineProbeActivities>({
  startToCloseTimeout: "5 seconds",
  heartbeatTimeout: "500 milliseconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 1 },
});

/** A short real-server deadline around the production verifier lifecycle. */
export async function rigVerificationDeadlineProbeWorkflow(): Promise<void> {
  await deadlineProbeActivities.runRigVerificationDeadlineProbe();
}