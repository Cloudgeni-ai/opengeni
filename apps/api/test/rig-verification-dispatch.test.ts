import { describe, expect, test } from "bun:test";
import {
  dispatchRigVerification,
  rigVerificationPhysicalWorkflowId,
  type RigVerificationDispatchDependencies,
} from "../src/rig-verification-dispatch";

const input = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  workflowId:
    "rig-verification-version-22222222-2222-4222-8222-222222222222-attempt-33333333-3333-4333-8333-333333333333",
} as const;

class AlreadyStartedError extends Error {}

describe("Rig verification physical dispatch", () => {
  for (const status of ["RUNNING", "COMPLETED", "CONTINUED_AS_NEW"] as const) {
    test(`${status} duplicate is an idempotent acknowledgement`, async () => {
      const starts: string[] = [];
      let advances = 0;
      await dispatchRigVerification(input, {
        getCurrentExecutionGeneration: async () => 1,
        advanceExecutionGeneration: async () => {
          advances += 1;
          return 2;
        },
        start: async ({ physicalWorkflowId }) => {
          starts.push(physicalWorkflowId);
          throw new AlreadyStartedError();
        },
        describeStatus: async () => status,
        isAlreadyStarted: (error) => error instanceof AlreadyStartedError,
      });
      expect(starts).toEqual([rigVerificationPhysicalWorkflowId(input.workflowId, 1)]);
      expect(advances).toBe(0);
    });
  }

  for (const status of [
    "FAILED",
    "CANCELED",
    "CANCELLED",
    "TERMINATED",
    "TIMED_OUT",
    "WORKFLOW_EXECUTION_STATUS_TIMED_OUT",
  ] as const) {
    test(`${status} duplicate advances to a fresh physical generation`, async () => {
      const starts: string[] = [];
      let generation = 1;
      await dispatchRigVerification(input, {
        getCurrentExecutionGeneration: async () => generation,
        advanceExecutionGeneration: async ({ expectedExecutionGeneration }) => {
          expect(expectedExecutionGeneration).toBe(1);
          generation = 2;
          return generation;
        },
        start: async ({ physicalWorkflowId }) => {
          starts.push(physicalWorkflowId);
          if (physicalWorkflowId.endsWith("generation-1")) throw new AlreadyStartedError();
        },
        describeStatus: async () => status,
        isAlreadyStarted: (error) => error instanceof AlreadyStartedError,
      });
      expect(generation).toBe(2);
      expect(starts).toEqual([
        rigVerificationPhysicalWorkflowId(input.workflowId, 1),
        rigVerificationPhysicalWorkflowId(input.workflowId, 2),
      ]);
    });
  }

  test("an unknown duplicate status fails closed", async () => {
    const starts: string[] = [];
    let advances = 0;
    await expect(
      dispatchRigVerification(input, {
        getCurrentExecutionGeneration: async () => 1,
        advanceExecutionGeneration: async () => {
          advances += 1;
          return 2;
        },
        start: async ({ physicalWorkflowId }) => {
          starts.push(physicalWorkflowId);
          throw new AlreadyStartedError();
        },
        describeStatus: async () => "UNSPECIFIED",
        isAlreadyStarted: (error) => error instanceof AlreadyStartedError,
      }),
    ).rejects.toThrow("Unsupported Rig verification workflow status");
    expect(starts).toEqual([rigVerificationPhysicalWorkflowId(input.workflowId, 1)]);
    expect(advances).toBe(0);
  });

  test("concurrent failed-run recovery converges on one advanced generation", async () => {
    let generation = 1;
    const started = new Set<string>();
    const starts: string[] = [];
    const dependencies: RigVerificationDispatchDependencies = {
      getCurrentExecutionGeneration: async () => generation,
      advanceExecutionGeneration: async ({ expectedExecutionGeneration }) => {
        if (generation === expectedExecutionGeneration) generation += 1;
        return generation;
      },
      start: async ({ physicalWorkflowId }) => {
        starts.push(physicalWorkflowId);
        if (physicalWorkflowId.endsWith("generation-1") || started.has(physicalWorkflowId)) {
          throw new AlreadyStartedError();
        }
        started.add(physicalWorkflowId);
      },
      describeStatus: async (physicalWorkflowId) =>
        physicalWorkflowId.endsWith("generation-1") ? "FAILED" : "RUNNING",
      isAlreadyStarted: (error) => error instanceof AlreadyStartedError,
    };

    await Promise.all([
      dispatchRigVerification(input, dependencies),
      dispatchRigVerification(input, dependencies),
    ]);

    expect(generation).toBe(2);
    expect(started).toEqual(new Set([rigVerificationPhysicalWorkflowId(input.workflowId, 2)]));
    expect(starts.filter((id) => id.endsWith("generation-1"))).toHaveLength(2);
  });

  test("a lost start acknowledgement retries the same physical generation", async () => {
    let calls = 0;
    const startedId = rigVerificationPhysicalWorkflowId(input.workflowId, 4);
    const dependencies: RigVerificationDispatchDependencies = {
      getCurrentExecutionGeneration: async () => 4,
      advanceExecutionGeneration: async () => 5,
      start: async ({ physicalWorkflowId }) => {
        expect(physicalWorkflowId).toBe(startedId);
        calls += 1;
        if (calls === 1) throw new Error("transport acknowledgement lost");
        throw new AlreadyStartedError();
      },
      describeStatus: async () => "RUNNING",
      isAlreadyStarted: (error) => error instanceof AlreadyStartedError,
    };

    await expect(dispatchRigVerification(input, dependencies)).rejects.toThrow(
      "transport acknowledgement lost",
    );
    await expect(dispatchRigVerification(input, dependencies)).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
