import { describe, expect, mock, test } from "bun:test";
import { Connection, defaultPayloadConverter } from "@temporalio/client";
import {
  identityHash,
  parsePurityArguments,
  PURITY_OUTPUT_PREFIX,
  verifyControlRolloutProof,
  verifyTurnQueuePurity,
  VIDEO_ACTIVITY_TYPE,
  VIDEO_WORKFLOW_TYPE,
  videoRoutingFromInput,
  type ControlRolloutProof,
  type ExecutionRef,
  type PendingActivity,
  type PurityHistoryEvent,
  type PurityLimits,
  type TemporalPurityReader,
  type VideoRouting,
} from "./turn-queue-purity";
import { temporalPurityReader } from "./verify-turn-queue-purity";

const now = Date.parse("2026-10-03T12:20:00.000Z");
const sourceRevision = "a".repeat(40);
const expected = {
  sourceRevision,
  temporalNamespace: "default",
  baseTaskQueue: "opengeni-runs-ts",
};
const limits: PurityLimits = {
  maxPages: 10,
  maxHistoryPages: 10,
  maxWorkflows: 1_000,
  pageSize: 100,
  timeoutMs: 1_000,
  proofMaxAgeSeconds: 300,
};

function proof(): ControlRolloutProof {
  return {
    ...expected,
    observedAt: new Date(now).toISOString(),
    controlDeployment: {
      desiredReplicas: 2,
      updatedReplicas: 2,
      readyReplicas: 2,
      availableReplicas: 2,
      generation: 7,
      observedGeneration: 7,
    },
    controlPods: ["pod-1", "pod-2"].map((id) => ({
      podUidHash: identityHash(id),
      sourceRevision,
      ready: true,
      terminating: false,
      controlQueueRoutingEnabled: true,
    })),
  };
}

function execution(id = "private-workflow-id", workflowType = VIDEO_WORKFLOW_TYPE): ExecutionRef {
  return { workflowId: id, runId: `private-run-${id}`, workflowType };
}

function activity(overrides: Partial<PendingActivity> = {}): PendingActivity {
  return {
    activityId: "private-activity-id",
    activityType: VIDEO_ACTIVITY_TYPE,
    state: "scheduled",
    retrying: false,
    ...overrides,
  };
}

function events(
  ref: ExecutionRef,
  routing: VideoRouting = "control",
  taskQueue?: string,
): PurityHistoryEvent[] {
  return [
    { eventId: "1", started: { workflowType: ref.workflowType, videoRouting: routing } },
    { eventId: "2" },
    ...(taskQueue !== undefined
      ? [
          {
            eventId: "3",
            activityScheduled: {
              activityId: "private-activity-id",
              activityType: VIDEO_ACTIVITY_TYPE,
              taskQueue,
            },
          },
        ]
      : []),
  ];
}

function readerFixture(
  refs: ExecutionRef[] = [],
  history: PurityHistoryEvent[] = refs[0] ? events(refs[0]) : [],
  pendingActivities: PendingActivity[] = [],
) {
  const reader: TemporalPurityReader = {
    listOpenExecutions: mock(async () => ({ items: refs, nextPageToken: "" })),
    describeExecution: mock(async (ref) => ({
      ...ref,
      running: true,
      historyLength: String(history.length),
      pendingActivities,
    })),
    readHistory: mock(async () => ({ items: history, nextPageToken: "" })),
  };
  return reader;
}

function verify(reader: TemporalPurityReader, overrides: Partial<PurityLimits> = {}) {
  return verifyTurnQueuePurity({
    ...expected,
    proof: proof(),
    reader,
    limits: { ...limits, ...overrides },
    now: () => now,
  });
}

describe("turn queue purity arguments and rollout proof", () => {
  test("pins required source/proof and bounded defaults", () => {
    expect(
      parsePurityArguments(["--proof", "/private/proof.json", "--source-revision", sourceRevision]),
    ).toEqual({
      ...limits,
      maxPages: 100,
      maxHistoryPages: 100,
      maxWorkflows: 10_000,
      timeoutMs: 120_000,
      proofPath: "/private/proof.json",
      sourceRevision,
    });
  });

  test.each(
    [
      [],
      ["--proof", "private-path"],
      ["--proof", "private-path", "--source-revision", "unverified"],
      ["--proof", "private-path", "--source-revision", sourceRevision, "--proof", "second"],
      [
        "--proof",
        "private-path",
        "--source-revision",
        sourceRevision,
        "--unknown",
        "private-payload",
      ],
      ["--proof", "private-path", "--source-revision", sourceRevision, "--page-size", "0"],
      ["--proof", "private-path", "--source-revision", sourceRevision, "--page-size", "1001"],
      ["--proof", "private-path", "--source-revision", sourceRevision, "--max-pages", "NaN"],
      ["--proof", "private-path", "--source-revision", sourceRevision, "--max-pages", "1.5"],
      [
        "--proof",
        "private-path",
        "--source-revision",
        sourceRevision,
        "--proof-max-age-seconds",
        "301",
      ],
    ].map((argv) => ({ argv })),
  )("rejects malformed arguments without echoing them: %j", ({ argv }) => {
    expect(() => parsePurityArguments(argv)).toThrow("arguments_invalid");
  });

  test("requires fresh complete rollout evidence including every control pod", () => {
    expect(verifyControlRolloutProof(proof(), expected, now + 300_000, 300)).toEqual(proof());
    expect(() => verifyControlRolloutProof(proof(), expected, now + 300_001, 300)).toThrow(
      "proof_stale",
    );
    expect(() => verifyControlRolloutProof(proof(), expected, now - 1, 300)).toThrow("proof_stale");
  });

  test.each([
    (p: ControlRolloutProof) => {
      p.controlDeployment.readyReplicas = 1;
    },
    (p: ControlRolloutProof) => {
      p.controlDeployment.updatedReplicas = 1;
    },
    (p: ControlRolloutProof) => {
      p.controlDeployment.availableReplicas = 1;
    },
    (p: ControlRolloutProof) => {
      p.controlDeployment.observedGeneration = 6;
    },
    (p: ControlRolloutProof) => {
      p.controlPods.pop();
    },
    (p: ControlRolloutProof) => {
      p.controlPods[1]!.podUidHash = p.controlPods[0]!.podUidHash;
    },
    (p: ControlRolloutProof) => {
      p.controlPods[1]!.sourceRevision = "b".repeat(40);
    },
    (p: ControlRolloutProof) => {
      p.controlPods[1]!.ready = false;
    },
    (p: ControlRolloutProof) => {
      p.controlPods[1]!.terminating = true;
    },
  ])("rejects a partial, mixed, or unconverged control rollout", (mutate) => {
    const value = proof();
    mutate(value);
    expect(() => verifyControlRolloutProof(value, expected, now, 300)).toThrow(
      "control_rollout_incomplete",
    );
  });

  test("rejects routing-disabled pods independently of source SHA", () => {
    const value = proof();
    value.controlPods[0]!.controlQueueRoutingEnabled = false;
    expect(() => verifyControlRolloutProof(value, expected, now, 300)).toThrow(
      "control_routing_disabled",
    );
  });

  test.each(["sourceRevision", "temporalNamespace", "baseTaskQueue"] as const)(
    "binds proof to %s",
    (key) => {
      const value = proof();
      value[key] = key === "sourceRevision" ? "b".repeat(40) : "different-private-scope";
      expect(() => verifyControlRolloutProof(value, expected, now, 300)).toThrow(
        "proof_scope_mismatch",
      );
    },
  );

  test("rejects unknown/missing proof facts rather than guessing", () => {
    expect(() => verifyControlRolloutProof({}, expected, now, 300)).toThrow("proof_invalid");
    expect(() =>
      verifyControlRolloutProof({ ...proof(), customerPayload: "secret" }, expected, now, 300),
    ).toThrow("proof_invalid");
  });

  test.each([false, undefined])("legacy frozen flag %j is never upgraded by a new pod", (flag) => {
    expect(
      videoRoutingFromInput({
        baseTaskQueue: expected.baseTaskQueue,
        controlQueueRoutingEnabled: flag,
      }),
    ).toBe("legacy");
  });

  test.each([null, "true", 1, {}, []].map((flag) => ({ flag })))(
    "malformed routing flag/input fails closed: %j",
    ({ flag }) => {
      expect(
        videoRoutingFromInput({
          baseTaskQueue: expected.baseTaskQueue,
          controlQueueRoutingEnabled: flag,
        }),
      ).toBe("unknown");
    },
  );
});

describe("bounded read-only Temporal purity scan", () => {
  test("empty complete inventory passes only with valid rollout evidence", async () => {
    const reader = readerFixture();
    const result = await verify(reader);
    expect(result).toMatchObject({ complete: true, pure: true, failureCode: null });
    expect(reader.listOpenExecutions).toHaveBeenCalledTimes(2);
    expect(reader.describeExecution).not.toHaveBeenCalled();
  });

  test("invalid proof performs no Temporal reads", async () => {
    const reader = readerFixture();
    const result = await verifyTurnQueuePurity({
      ...expected,
      proof: {},
      reader,
      limits,
      now: () => now,
    });
    expect(result).toMatchObject({ complete: false, pure: false, failureCode: "proof_invalid" });
    expect(reader.listOpenExecutions).not.toHaveBeenCalled();
  });

  test("open legacy timer-only/continued run blocks even with zero pending activities", async () => {
    const ref = execution();
    const result = await verify(readerFixture([ref], events(ref, "legacy")));
    expect(result).toMatchObject({
      complete: true,
      pure: false,
      counts: { legacyVideoWorkflows: 1, turnQueueVideoActivities: 0 },
    });
    expect(result.findings).toEqual([
      { executionHash: identityHash(ref.workflowId, ref.runId), reason: "legacy_video_workflow" },
    ]);
    expect(JSON.stringify(result)).not.toContain(ref.workflowId);
    expect(JSON.stringify(result)).not.toContain(ref.runId);
  });

  test("control-routed timer-only video run is pure", async () => {
    const ref = execution();
    expect(await verify(readerFixture([ref], events(ref)))).toMatchObject({
      complete: true,
      pure: true,
      counts: { videoWorkflows: 1 },
    });
  });

  test.each(["scheduled", "started", "cancel_requested"] as const)(
    "%s turn-queue video activity blocks any workflow type",
    async (state) => {
      const ref = execution("private-other-workflow", "otherWorkflow");
      const result = await verify(
        readerFixture([ref], events(ref, "control", `${expected.baseTaskQueue}-turns`), [
          activity({ state }),
        ]),
      );
      expect(result).toMatchObject({
        complete: true,
        pure: false,
        counts: { turnQueueVideoActivities: 1, legacyVideoWorkflows: 0 },
      });
    },
  );

  test("server-held retry blocks independently of workflow routing and retry count", async () => {
    const ref = execution();
    const result = await verify(
      readerFixture([ref], events(ref, "control", `${expected.baseTaskQueue}-turns`), [
        activity({ retrying: true }),
      ]),
    );
    expect(result).toMatchObject({
      pure: false,
      counts: { turnQueueVideoActivities: 1, retryingTurnQueueVideoActivities: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("private-activity-id");
  });

  test("completed historical turn-queue video work is not current contamination", async () => {
    const ref = execution();
    expect(
      await verify(readerFixture([ref], events(ref, "control", `${expected.baseTaskQueue}-turns`))),
    ).toMatchObject({
      complete: true,
      pure: true,
      counts: { turnQueueVideoActivities: 0 },
    });
  });

  test("reused activity IDs use the latest scheduled queue, not completed work", async () => {
    const ref = execution();
    const history = events(ref, "control", `${expected.baseTaskQueue}-turns`);
    history.push({
      eventId: "4",
      activityScheduled: {
        activityId: "private-activity-id",
        activityType: VIDEO_ACTIVITY_TYPE,
        taskQueue: expected.baseTaskQueue,
      },
    });
    expect(await verify(readerFixture([ref], history, [activity()]))).toMatchObject({
      complete: true,
      pure: true,
      counts: { turnQueueVideoActivities: 0, controlQueueVideoActivities: 1 },
    });
  });

  test.each([expected.baseTaskQueue, "unrelated-queue"])(
    "pending video on %s does not contaminate target turns queue",
    async (queue) => {
      const ref = execution();
      const result = await verify(
        readerFixture([ref], events(ref, "control", queue), [activity()]),
      );
      expect(result).toMatchObject({
        complete: true,
        pure: true,
        counts: { turnQueueVideoActivities: 0 },
      });
      expect(
        result.counts.controlQueueVideoActivities + result.counts.otherQueueVideoActivities,
      ).toBe(1);
    },
  );

  test("unknown frozen input is incomplete, never interpreted as true", async () => {
    const ref = execution();
    expect(await verify(readerFixture([ref], events(ref, "unknown")))).toMatchObject({
      complete: false,
      pure: false,
      failureCode: "video_input_unknown",
    });
  });

  test("a pending activity with no matching scheduled queue is incomplete", async () => {
    const ref = execution();
    expect(await verify(readerFixture([ref], events(ref), [activity()]))).toMatchObject({
      complete: false,
      pure: false,
      failureCode: "pending_activity_queue_unknown",
    });
  });

  test("all pages are exhausted, duplicate visibility rows do not multiply counts", async () => {
    const ref = execution();
    const reader = readerFixture([ref], events(ref, "legacy"));
    reader.listOpenExecutions = mock(async (token) => ({
      items: [ref],
      nextPageToken: token === "" ? "next" : "",
    }));
    reader.readHistory = mock(async (_ref, token) => ({
      items: token === "" ? events(ref, "legacy").slice(0, 1) : events(ref, "legacy").slice(1),
      nextPageToken: token === "" ? "next" : "",
    }));
    expect(await verify(reader)).toMatchObject({
      complete: true,
      pure: false,
      counts: { openExecutions: 1, legacyVideoWorkflows: 1 },
    });
    expect(reader.listOpenExecutions).toHaveBeenCalledTimes(4);
    expect(reader.readHistory).toHaveBeenCalledTimes(2);
  });

  test.each(["listing", "history"])(
    "%s pagination cannot silently stop at its cap",
    async (kind) => {
      const ref = execution();
      const reader = readerFixture([ref], events(ref));
      if (kind === "listing")
        reader.listOpenExecutions = mock(async () => ({ items: [ref], nextPageToken: "next" }));
      else
        reader.readHistory = mock(async () => ({
          items: events(ref).slice(0, 1),
          nextPageToken: "next",
        }));
      expect(await verify(reader, { maxPages: 1, maxHistoryPages: 1 })).toMatchObject({
        complete: false,
        pure: false,
        failureCode: kind === "listing" ? "listing_incomplete" : "history_incomplete",
      });
    },
  );

  test("repeated page token is a failure, not successful EOF", async () => {
    const reader = readerFixture();
    reader.listOpenExecutions = mock(async () => ({ items: [], nextPageToken: "repeat" }));
    expect(await verify(reader)).toMatchObject({
      complete: false,
      pure: false,
      failureCode: "pagination_repeated",
    });
  });

  test("repeated history token also fails closed", async () => {
    const ref = execution();
    const reader = readerFixture([ref], events(ref));
    let reads = 0;
    reader.readHistory = mock(async () => ({
      items: [{ eventId: String(++reads), ...(reads === 1 ? events(ref)[0] : {}) }],
      nextPageToken: "repeat",
    }));
    expect(await verify(reader)).toMatchObject({
      complete: false,
      pure: false,
      failureCode: "pagination_repeated",
    });
  });

  test("workflow inventory cap is fail-closed", async () => {
    expect(
      await verify(readerFixture([execution("one"), execution("two")]), { maxWorkflows: 1 }),
    ).toMatchObject({ failureCode: "listing_incomplete", pure: false });
  });

  test.each(
    [
      [{ eventId: "2" }],
      [{ eventId: "1" }],
      [
        {
          eventId: "1",
          started: { workflowType: VIDEO_WORKFLOW_TYPE, videoRouting: "control" as const },
        },
        { eventId: "3" },
      ],
    ].map((history) => ({ history })),
  )("missing start/gapped history is incomplete", async ({ history }) => {
    expect(await verify(readerFixture([execution()], history))).toMatchObject({
      complete: false,
      pure: false,
      failureCode: "history_incomplete",
    });
  });

  test("empty final token cannot conceal history shorter than Describe", async () => {
    const ref = execution();
    const reader = readerFixture([ref], events(ref));
    reader.describeExecution = mock(async () => ({
      ...ref,
      running: true,
      historyLength: "3",
      pendingActivities: [],
    }));
    expect(await verify(reader)).toMatchObject({ failureCode: "history_incomplete", pure: false });
  });

  test("continued-as-new/closed run race invalidates a purity observation", async () => {
    const ref = execution();
    const reader = readerFixture([ref], events(ref));
    let reads = 0;
    reader.describeExecution = mock(async () => ({
      ...ref,
      running: ++reads === 1,
      historyLength: "2",
      pendingActivities: [],
    }));
    expect(await verify(reader)).toMatchObject({
      complete: false,
      pure: false,
      failureCode: "scan_changed",
    });
  });

  test("a new run appearing in the final visibility pass invalidates purity", async () => {
    const reader = readerFixture();
    let reads = 0;
    reader.listOpenExecutions = mock(async () => ({
      items: ++reads === 1 ? [] : [execution()],
      nextPageToken: "",
    }));
    expect(await verify(reader)).toMatchObject({
      complete: false,
      pure: false,
      failureCode: "scan_changed",
    });
  });

  test("changed pending activity/history invalidates a mixed observation", async () => {
    const ref = execution();
    const reader = readerFixture([ref], events(ref));
    let reads = 0;
    reader.describeExecution = mock(async () => ({
      ...ref,
      running: true,
      historyLength: ++reads === 1 ? "2" : "3",
      pendingActivities: [],
    }));
    expect(await verify(reader)).toMatchObject({
      complete: false,
      pure: false,
      failureCode: "scan_changed",
    });
  });

  test("proof freshness is rechecked at completion", async () => {
    let clock = now;
    const reader = readerFixture();
    reader.listOpenExecutions = mock(async () => {
      clock = now + 301_000;
      return { items: [], nextPageToken: "" };
    });
    expect(
      await verifyTurnQueuePurity({
        ...expected,
        proof: proof(),
        reader,
        limits: { ...limits, timeoutMs: 600_000 },
        now: () => clock,
      }),
    ).toMatchObject({ failureCode: "proof_stale", complete: false, pure: false });
  });

  test("remote errors are fixed-code failures with no raw diagnostics", async () => {
    const reader = readerFixture();
    reader.listOpenExecutions = mock(async () => {
      throw new Error("private-token private-customer-payload private-host");
    });
    const result = await verify(reader);
    expect(result).toMatchObject({
      failureCode: "temporal_read_failed",
      complete: false,
      pure: false,
    });
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  test("hung reads have a finite fail-closed deadline", async () => {
    const reader = readerFixture();
    reader.listOpenExecutions = mock(() => new Promise<never>(() => undefined));
    expect(await verify(reader, { timeoutMs: 2 })).toMatchObject({
      failureCode: "scan_deadline_exceeded",
      complete: false,
      pure: false,
    });
  });
});

describe("pinned SDK read adapter", () => {
  function sdkConnection(overrides: Record<string, unknown>) {
    return { workflowService: overrides } as unknown as Pick<Connection, "workflowService">;
  }

  test("projects frozen input only, without customer fields", async () => {
    const ref = execution();
    const payload = defaultPayloadConverter.toPayload({
      baseTaskQueue: expected.baseTaskQueue,
      controlQueueRoutingEnabled: true,
      accountId: "private-account",
      customerPayload: "private-content",
    });
    const sdk = sdkConnection({
      getWorkflowExecutionHistory: async () => ({
        history: {
          events: [
            {
              eventId: { toString: () => "1" },
              workflowExecutionStartedEventAttributes: {
                workflowType: { name: VIDEO_WORKFLOW_TYPE },
                input: { payloads: [payload] },
              },
            },
          ],
        },
        nextPageToken: new Uint8Array(),
      }),
    });
    const result = await temporalPurityReader(sdk, "default").readHistory(ref, "", 100);
    expect(result.items[0]!.started).toEqual({
      workflowType: VIDEO_WORKFLOW_TYPE,
      videoRouting: "control",
    });
    expect(JSON.stringify(result)).not.toContain("private-account");
    expect(JSON.stringify(result)).not.toContain("private-content");
  });

  test.each([false, undefined])("SDK decoding preserves legacy flag %j", async (flag) => {
    const payload = defaultPayloadConverter.toPayload({
      baseTaskQueue: expected.baseTaskQueue,
      controlQueueRoutingEnabled: flag,
    });
    const sdk = sdkConnection({
      getWorkflowExecutionHistory: async () => ({
        history: {
          events: [
            {
              eventId: { toString: () => "1" },
              workflowExecutionStartedEventAttributes: {
                workflowType: { name: VIDEO_WORKFLOW_TYPE },
                input: { payloads: [payload] },
              },
            },
          ],
        },
      }),
    });
    expect(
      (await temporalPurityReader(sdk, "default").readHistory(execution(), "", 100)).items[0]!
        .started!.videoRouting,
    ).toBe("legacy");
  });

  test("SDK rejects unsupported raw/archived history without exposing bytes", async () => {
    const sdk = sdkConnection({
      getWorkflowExecutionHistory: async () => ({ rawHistory: [{ data: "private-history" }] }),
    });
    await expect(
      temporalPurityReader(sdk, "default").readHistory(execution(), "", 100),
    ).rejects.toThrow("history_incomplete");
  });

  test("all-open query is fixed, page tokens round-trip, and no write API is needed", async () => {
    const list = mock(async (_request: unknown) => ({
      executions: [
        {
          execution: { workflowId: "private-id", runId: "private-run" },
          type: { name: VIDEO_WORKFLOW_TYPE },
        },
      ],
      nextPageToken: new Uint8Array([1, 2, 3]),
    }));
    const result = await temporalPurityReader(
      sdkConnection({ listWorkflowExecutions: list }),
      "default",
    ).listOpenExecutions("AQID", 17);
    expect(list.mock.calls[0]![0]).toMatchObject({
      query: "ExecutionStatus = 'Running'",
      namespace: "default",
      pageSize: 17,
      nextPageToken: Buffer.from([1, 2, 3]),
    });
    expect(result.nextPageToken).toBe("AQID");
  });

  test("pending retry projection does not retain heartbeat/failure/customer bytes", async () => {
    const ref = execution();
    const sdk = sdkConnection({
      describeWorkflowExecution: async () => ({
        workflowExecutionInfo: {
          execution: ref,
          type: { name: ref.workflowType },
          status: 1,
          historyLength: { toString: () => "3" },
        },
        pendingActivities: [
          {
            activityId: "private-activity-id",
            activityType: { name: VIDEO_ACTIVITY_TYPE },
            state: 1,
            attempt: 2,
            nextAttemptScheduleTime: {},
            heartbeatDetails: "private-heartbeat",
            lastFailure: "private-failure",
          },
        ],
      }),
    });
    const result = await temporalPurityReader(sdk, "default").describeExecution(ref);
    expect(result.pendingActivities).toEqual([activity({ retrying: true })]);
    expect(JSON.stringify(result)).not.toContain("private-heartbeat");
    expect(JSON.stringify(result)).not.toContain("private-failure");
  });
});

describe("CLI proof input stays bounded and private", () => {
  const cliPath = new URL("./verify-turn-queue-purity.ts", import.meta.url).pathname;
  function spawnCli(input: string | "pipe", extra: string[] = []) {
    return Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        cliPath,
        "--proof",
        "/dev/stdin",
        "--source-revision",
        sourceRevision,
        ...extra,
      ],
      {
        stdin: input === "pipe" ? "pipe" : Buffer.from(input),
        stdout: "pipe",
        stderr: "pipe",
        env: {},
      },
    );
  }

  test("reads metadata proof from /dev/stdin before rejecting stale evidence, without RPC", async () => {
    const value = { ...proof(), observedAt: "2000-01-01T00:00:00.000Z" };
    const child = spawnCli(JSON.stringify(value));
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(output.startsWith(PURITY_OUTPUT_PREFIX)).toBe(true);
    expect(JSON.parse(output.slice(PURITY_OUTPUT_PREFIX.length))).toMatchObject({
      complete: false,
      pure: false,
      failureCode: "proof_stale",
    });
    expect(output).not.toContain("controlDeployment");
  });

  test("oversized piped proof never bypasses the byte cap", async () => {
    const child = spawnCli(JSON.stringify({ privatePayload: "x".repeat(1_048_576) }));
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(1);
    expect(JSON.parse(output.slice(PURITY_OUTPUT_PREFIX.length))).toMatchObject({
      complete: false,
      pure: false,
      failureCode: "proof_invalid",
    });
    expect(output).not.toContain("privatePayload");
    expect(output.length).toBeLessThan(2_000);
  });

  test("an unfinished proof pipe fails closed within its deadline", async () => {
    const child = spawnCli("pipe", ["--timeout-ms", "100"]);
    try {
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(1);
      const result = JSON.parse(output.slice(PURITY_OUTPUT_PREFIX.length));
      expect(result).toMatchObject({
        complete: false,
        pure: false,
      });
      // Bun can reject a not-yet-readable nonblocking stdin immediately. Both
      // that error and the abort deadline must be fixed-code fail-closed paths.
      expect(["proof_invalid", "scan_deadline_exceeded"]).toContain(result.failureCode);
    } finally {
      child.kill();
    }
  });
});
