import { describe, expect, test } from "bun:test";
import type { BackgroundJob, BackgroundJobSpec } from "@opengeni/contracts";
import { BackgroundJobProviderLostError } from "@opengeni/runtime";
import { createBackgroundJobActivities } from "../src/activities/background-jobs";
import type { ActivityServices } from "../src/activities/types";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const jobId = "55555555-5555-4555-8555-555555555555";
const waitId = "66666666-6666-4666-8666-666666666666";
const attemptId = "77777777-7777-4777-8777-777777777777";

const spec: BackgroundJobSpec = {
  command: "/bin/sh",
  args: ["-lc", "echo done"],
  artifactPaths: [],
  metadata: {},
  timeoutSeconds: 60,
};

function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: jobId,
    accountId,
    workspaceId,
    originSessionId: sessionId,
    originTurnId: turnId,
    waitId,
    provider: "modal",
    spec,
    fireKey: `session:${sessionId}:background-job:test`,
    status: "queued",
    providerRef: null,
    providerInstanceId: null,
    startCount: 0,
    cancelRequestedAt: null,
    exitCode: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

function services(overrides: Partial<ActivityServices> = {}): ActivityServices {
  return {
    db: {} as never,
    bus: {} as never,
    settings: {} as never,
    runtime: {} as never,
    objectStorage: null,
    documentServices: {} as never,
    observability: {} as never,
    wakeSessionWorkflow: null,
    backgroundJobProvider: {} as never,
    ...overrides,
  };
}

function settled(status: "completed" | "failed" | "cancelled" | "lost") {
  return {
    job: job({ status }),
    wait: {
      id: waitId,
      sessionId,
      originTurnId: turnId,
      kind: "background_job" as const,
      requestKey: "test",
      state: "resolved" as const,
      outcome: status,
      request: {},
      wakeAt: null,
      nextReminderAt: null,
      reminderSequence: 0,
      backgroundJobId: jobId,
      createdAt: "2026-07-12T00:00:00.000Z",
      resolvedAt: "2026-07-12T00:01:00.000Z",
    },
    delivery: {
      reason: "queued" as const,
      events: [],
      temporalWorkflowId: `session-${sessionId}`,
      workflowWakeRevision: 1,
    },
  };
}

function commonOverrides() {
  return {
    hooks: { heartbeat: () => {}, sleep: async () => {} },
    createBackgroundJobAttempt: async () => ({ id: attemptId, attemptNumber: 1 }),
    getBackgroundJobCancelRequested: async () => false,
    appendBackgroundJobLog: async () => ({}) as never,
    insertBackgroundJobArtifact: async () => ({}) as never,
    publishDurableSessionEvents: async () => {},
  };
}

describe("background job controller", () => {
  test("starts once, attaches, persists logs, settles, then terminates", async () => {
    const calls: string[] = [];
    const provider = {
      start: async () => {
        calls.push("start");
        return { providerRef: "modal:sandbox:box-1", providerInstanceId: "box-1" };
      },
      observe: async (input: {
        hooks: {
          onLog: (log: { stream: "stdout"; providerOffset: number; text: string }) => Promise<void>;
        };
      }) => {
        calls.push("observe");
        await input.hooks.onLog({ stream: "stdout", providerOffset: 0, text: "done\n" });
        return { status: "completed" as const, exitCode: 0, artifacts: [] };
      },
      terminate: async () => {
        calls.push("terminate");
      },
    };
    const activities = createBackgroundJobActivities(async () => services(), {
      ...commonOverrides(),
      provider,
      claimBackgroundJobStart: async () => ({ action: "start", job: job() }),
      attachBackgroundJobProvider: async () => {
        calls.push("attach");
        return job({ status: "running", providerInstanceId: "box-1", startCount: 1 });
      },
      appendBackgroundJobLog: async (_db, input) => {
        calls.push(`log:${input.providerOffset}:${input.text.trim()}`);
        return {} as never;
      },
      settleBackgroundJob: async (_db, input) => {
        calls.push(`settle:${input.status}`);
        return settled(input.status);
      },
    });

    expect(await activities.runBackgroundJobController({ accountId, workspaceId, jobId })).toEqual({
      status: "completed",
    });
    expect(calls).toEqual([
      "start",
      "attach",
      "observe",
      "log:0:done",
      "settle:completed",
      "terminate",
    ]);
  });

  test("an activity retry reattaches and never invokes provider start", async () => {
    let starts = 0;
    const provider = {
      start: async () => {
        starts += 1;
        throw new Error("must not start");
      },
      observe: async () => ({ status: "completed" as const, artifacts: [] }),
      terminate: async () => {},
    };
    const activities = createBackgroundJobActivities(async () => services(), {
      ...commonOverrides(),
      provider,
      claimBackgroundJobStart: async () => ({
        action: "reattach",
        job: job({
          status: "running",
          providerRef: "modal:sandbox:box-1",
          providerInstanceId: "box-1",
          startCount: 1,
          startedAt: "2026-07-12T00:00:00.000Z",
        }),
      }),
      settleBackgroundJob: async (_db, input) => settled(input.status),
    });

    await activities.runBackgroundJobController({ accountId, workspaceId, jobId });
    expect(starts).toBe(0);
  });

  test("a crash after the start fence but before attach becomes lost without a second start", async () => {
    let starts = 0;
    let claims = 0;
    const provider = {
      start: async () => {
        starts += 1;
        return { providerRef: "modal:sandbox:box-1", providerInstanceId: "box-1" };
      },
      observe: async () => ({ status: "completed" as const, artifacts: [] }),
      terminate: async () => {},
    };
    const activities = createBackgroundJobActivities(async () => services(), {
      ...commonOverrides(),
      provider,
      createBackgroundJobAttempt: async () => ({
        id: claims === 0 ? attemptId : "88888888-8888-4888-8888-888888888888",
        attemptNumber: claims + 1,
      }),
      claimBackgroundJobStart: async () => {
        claims += 1;
        return claims === 1
          ? { action: "start" as const, job: job() }
          : {
              action: "terminal" as const,
              job: job({
                status: "lost",
                startCount: 1,
                error: "provider start was interrupted before attach",
              }),
            };
      },
      attachBackgroundJobProvider: async () => {
        throw new Error("database connection lost before attach acknowledgement");
      },
      settleBackgroundJob: async (_db, input) => settled(input.status),
    });

    await expect(
      activities.runBackgroundJobController({ accountId, workspaceId, jobId }),
    ).rejects.toThrow("before attach acknowledgement");
    expect(await activities.runBackgroundJobController({ accountId, workspaceId, jobId })).toEqual({
      status: "lost",
    });
    expect(starts).toBe(1);
  });

  test("a provider start error consumes the start fence and becomes lost on retry", async () => {
    let starts = 0;
    let claims = 0;
    const activities = createBackgroundJobActivities(async () => services(), {
      ...commonOverrides(),
      provider: {
        start: async () => {
          starts += 1;
          throw new Error("provider rejected the start request");
        },
        observe: async () => {
          throw new Error("must not observe");
        },
        terminate: async () => {},
      },
      claimBackgroundJobStart: async () => {
        claims += 1;
        return claims === 1
          ? { action: "start" as const, job: job() }
          : {
              action: "terminal" as const,
              job: job({
                status: "lost",
                startCount: 1,
                error: "provider start was interrupted before attach",
              }),
            };
      },
      settleBackgroundJob: async (_db, input) => settled(input.status),
    });

    await expect(
      activities.runBackgroundJobController({ accountId, workspaceId, jobId }),
    ).rejects.toThrow("provider rejected the start request");
    expect(await activities.runBackgroundJobController({ accountId, workspaceId, jobId })).toEqual({
      status: "lost",
    });
    expect(starts).toBe(1);
  });

  test("cancellation and timeout become durable terminal outcomes", async () => {
    for (const terminal of [
      { status: "cancelled" as const, artifacts: [] },
      { status: "failed" as const, error: "background job timed out", artifacts: [] },
    ]) {
      let settledStatus = "";
      const activities = createBackgroundJobActivities(async () => services(), {
        ...commonOverrides(),
        provider: {
          start: async () => {
            throw new Error("must not start");
          },
          observe: async () => terminal,
          terminate: async () => {},
        },
        claimBackgroundJobStart: async () => ({
          action: "reattach",
          job: job({ status: "running", providerInstanceId: "box-1", startCount: 1 }),
        }),
        settleBackgroundJob: async (_db, input) => {
          settledStatus = input.status;
          return settled(input.status);
        },
      });
      await activities.runBackgroundJobController({ accountId, workspaceId, jobId });
      expect(settledStatus).toBe(terminal.status);
    }
  });

  test("provider disappearance settles lost", async () => {
    let outcome = "";
    const activities = createBackgroundJobActivities(async () => services(), {
      ...commonOverrides(),
      provider: {
        start: async () => {
          throw new Error("must not start");
        },
        observe: async () => {
          throw new BackgroundJobProviderLostError("box-1");
        },
        terminate: async () => {},
      },
      claimBackgroundJobStart: async () => ({
        action: "reattach",
        job: job({ status: "running", providerInstanceId: "box-1", startCount: 1 }),
      }),
      settleBackgroundJob: async (_db, input) => {
        outcome = input.status;
        return settled(input.status);
      },
    });

    await activities.runBackgroundJobController({ accountId, workspaceId, jobId });
    expect(outcome).toBe("lost");
  });

  test("artifact upload failure keeps the provider for a reattach retry", async () => {
    let claims = 0;
    let puts = 0;
    let settlements = 0;
    let terminations = 0;
    const artifactSpec = { ...spec, artifactPaths: ["/tmp/report.json"] };
    const provider = {
      start: async () => ({ providerRef: "modal:sandbox:box-1", providerInstanceId: "box-1" }),
      observe: async () => ({
        status: "completed" as const,
        exitCode: 0,
        artifacts: [{ path: "/tmp/report.json", bytes: new TextEncoder().encode('{"ok":true}') }],
      }),
      terminate: async () => {
        terminations += 1;
      },
    };
    const storage = {
      maxSinglePutSizeBytes: 1_000_000,
      putObject: async () => {
        puts += 1;
        if (puts === 1) throw new Error("transient object storage failure");
      },
    };
    const activities = createBackgroundJobActivities(
      async () => services({ objectStorage: storage as never }),
      {
        ...commonOverrides(),
        provider,
        claimBackgroundJobStart: async () => {
          claims += 1;
          return claims === 1
            ? { action: "start" as const, job: job({ spec: artifactSpec }) }
            : {
                action: "reattach" as const,
                job: job({
                  spec: artifactSpec,
                  status: "running",
                  providerInstanceId: "box-1",
                  startCount: 1,
                }),
              };
        },
        attachBackgroundJobProvider: async () =>
          job({
            spec: artifactSpec,
            status: "running",
            providerInstanceId: "box-1",
            startCount: 1,
          }),
        settleBackgroundJob: async (_db, input) => {
          settlements += 1;
          return settled(input.status);
        },
      },
    );

    await expect(
      activities.runBackgroundJobController({ accountId, workspaceId, jobId }),
    ).rejects.toThrow("transient object storage failure");
    expect(terminations).toBe(0);
    expect(settlements).toBe(0);

    await activities.runBackgroundJobController({ accountId, workspaceId, jobId });
    expect(puts).toBe(2);
    expect(settlements).toBe(1);
    expect(terminations).toBe(1);
  });
});

describe("background job dispatch repair", () => {
  test("starts each claimed stable workflow once and marks its dispatch", async () => {
    let claims = 0;
    const starts: string[] = [];
    const marked: string[] = [];
    const service = services({
      startBackgroundJobWorkflow: async (input) => {
        starts.push(input.workflowId);
      },
    });
    const activities = createBackgroundJobActivities(async () => service, {
      ...commonOverrides(),
      claimPendingBackgroundJobDispatches: async () => {
        claims += 1;
        return claims === 1
          ? [
              {
                id: "99999999-9999-4999-8999-999999999999",
                accountId,
                workspaceId,
                jobId,
                dispatchKey: `background-job:${jobId}:controller:v1`,
                workflowId: `background-job-${jobId}`,
                attempts: 1,
              },
            ]
          : [];
      },
      markBackgroundJobDispatchStarted: async (_db, input) => {
        marked.push(input.dispatchKey);
      },
      markBackgroundJobDispatchFailed: async () => {},
    });

    expect(await activities.dispatchBackgroundJobControllers()).toBe(1);
    expect(await activities.dispatchBackgroundJobControllers()).toBe(0);
    expect(starts).toEqual([`background-job-${jobId}`]);
    expect(marked).toEqual([`background-job:${jobId}:controller:v1`]);
  });
});
