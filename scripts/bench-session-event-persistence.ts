#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  appendSessionEventsForTurnAttempt,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type AppendEventInput,
  type SessionEventAppendPhaseObserver,
} from "@opengeni/db";
import { appendAndPublishTurnEventsFenced } from "@opengeni/events";
import { startTestServices } from "@opengeni/testing";

const iterations = integerArgument("--iterations", 40);
const concurrencies = integerListArgument("--concurrency", [1, 4, 16, 32]);
const publishDelaysMs = integerListArgument("--publish-delay-ms", [0, 5, 100]);
const payloadChars = integerArgument("--payload-chars", 512);
const payloadMatrixChars = integerListArgument("--payload-matrix-chars", [0, 512, 16_384]);
const historyDepths = integerListArgument("--history-depths", [0, 1_000, 10_000]);
const lockHoldMs = integerArgument("--lock-hold-ms", 250);
const outputPath = resolve(
  stringArgument("--output") ??
    `${process.env.OPENGENI_EVIDENCE_DIR ?? "/tmp"}/session-event-persistence-benchmark.json`,
);

if (iterations < 5 || iterations > 200) throw new Error("--iterations must be 5..200");
if (concurrencies.some((value) => value < 1 || value > 64)) {
  throw new Error("--concurrency entries must be 1..64");
}
if (publishDelaysMs.some((value) => value < 0 || value > 2_000)) {
  throw new Error("--publish-delay-ms entries must be 0..2000");
}
if (payloadChars < 0 || payloadChars > 16_384) {
  throw new Error("--payload-chars must be 0..16384");
}
if (payloadMatrixChars.some((value) => value < 0 || value > 16_384)) {
  throw new Error("--payload-matrix-chars entries must be 0..16384");
}
if (historyDepths.some((value) => value < 0 || value > 10_000)) {
  throw new Error("--history-depths entries must be 0..10000");
}
if (lockHoldMs < 100 || lockHoldMs > 5_000) {
  throw new Error("--lock-hold-ms must be 100..5000");
}

const services = await startTestServices({ temporal: false });
let client: ReturnType<typeof createDb> | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;
try {
  await services.migrate();
  client = createDb(services.databaseUrl);
  rawSql = postgres(services.databaseUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "benchmark",
    accountExternalId: `event-persistence-account-${suffix}`,
    accountName: "Event persistence benchmark",
    workspaceExternalSource: "benchmark",
    workspaceExternalId: `event-persistence-workspace-${suffix}`,
    workspaceName: "Event persistence benchmark",
    subjectId: `event-persistence-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0];
  if (!grant?.workspaceId) throw new Error("Event persistence bootstrap failed");
  const identity = {
    accountId: grant.accountId,
    subjectId: grant.subjectId,
    workspaceId: grant.workspaceId,
  };

  const sequentialFixture = await createClaimedFixture(client, identity, "sequential");
  const sequentialDurations: number[] = [];
  const sequentialPhaseDurations = new Map<string, number[]>();
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const result = await appendFixtureEvents(client, sequentialFixture, [event(index)], (phase) => {
      const values = sequentialPhaseDurations.get(phase.phase) ?? [];
      values.push(phase.durationSeconds * 1_000);
      sequentialPhaseDurations.set(phase.phase, values);
    });
    sequentialDurations.push(performance.now() - startedAt);
    assertAccepted(result, 1);
  }

  const batchFixture = await createClaimedFixture(client, identity, "batch");
  const batchStartedAt = performance.now();
  const batchResult = await appendFixtureEvents(
    client,
    batchFixture,
    Array.from({ length: iterations }, (_, index) => event(index)),
  );
  const batchElapsedMs = performance.now() - batchStartedAt;
  assertAccepted(batchResult, iterations);

  const sameSessionWaves = [];
  const independentSessionWaves = [];
  for (const concurrency of concurrencies) {
    const sameFixture = await createClaimedFixture(client, identity, `same-session-${concurrency}`);
    sameSessionWaves.push(
      await runWave(
        concurrency,
        (index) => appendFixtureEvents(client!, sameFixture, [event(index)]),
        (result) => assertAccepted(result, 1),
      ),
    );

    const independentFixtures = await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        createClaimedFixture(client!, identity, `independent-${concurrency}-${index}`),
      ),
    );
    independentSessionWaves.push(
      await runWave(
        concurrency,
        (index) => appendFixtureEvents(client!, independentFixtures[index]!, [event(index)]),
        (result) => assertAccepted(result, 1),
      ),
    );
  }

  const publishStates = await Promise.all(
    publishDelaysMs.map(async (publishDelayMs) => ({
      publishDelayMs,
      fixture: await createClaimedFixture(client!, identity, `publish-${publishDelayMs}`),
      appendDurations: [] as number[],
      publishDurations: [] as number[],
      totals: [] as number[],
      publishCalls: 0,
    })),
  );
  for (let index = 0; index < Math.min(iterations, 20); index += 1) {
    for (let offset = 0; offset < publishStates.length; offset += 1) {
      const state = publishStates[(index + offset) % publishStates.length]!;
      const bus = {
        publish: async () => {
          state.publishCalls += 1;
          if (state.publishDelayMs > 0) await Bun.sleep(state.publishDelayMs);
        },
      } as never;
      const startedAt = performance.now();
      let appendDuration = -1;
      let publishDuration = -1;
      const result = await appendAndPublishTurnEventsFenced(
        client.db,
        bus,
        state.fixture.workspaceId,
        state.fixture.sessionId,
        state.fixture.turnId,
        state.fixture.executionGeneration,
        state.fixture.attemptId,
        [fixtureEvent(state.fixture, index)],
        {
          onAppend: ({ durationSeconds }) => {
            appendDuration = durationSeconds * 1_000;
          },
          onPublish: ({ durationSeconds }) => {
            publishDuration = durationSeconds * 1_000;
          },
        },
      );
      assertAccepted(result, 1);
      state.totals.push(performance.now() - startedAt);
      state.appendDurations.push(appendDuration);
      state.publishDurations.push(publishDuration);
    }
  }
  const appendAndPublish = publishStates.map((state) => ({
    publishDelayMs: state.publishDelayMs,
    publishCalls: state.publishCalls,
    appendMs: distribution(state.appendDurations),
    publishMs: distribution(state.publishDurations),
    totalMs: distribution(state.totals),
  }));

  const payloadStates = await Promise.all(
    payloadMatrixChars.map(async (matrixPayloadChars) => ({
      matrixPayloadChars,
      fixture: await createClaimedFixture(client!, identity, `payload-${matrixPayloadChars}`),
      durations: [] as number[],
    })),
  );
  for (let index = 0; index < Math.min(iterations, 20); index += 1) {
    for (let offset = 0; offset < payloadStates.length; offset += 1) {
      const state = payloadStates[(index + offset) % payloadStates.length]!;
      const startedAt = performance.now();
      const result = await appendFixtureEvents(client, state.fixture, [
        eventWithPayloadChars(index, state.matrixPayloadChars),
      ]);
      state.durations.push(performance.now() - startedAt);
      assertAccepted(result, 1);
    }
  }
  const payloadMatrix = payloadStates.map((state) => ({
    payloadChars: state.matrixPayloadChars,
    appendMs: distribution(state.durations),
  }));

  const historyDepthMatrix = [];
  for (const historyDepth of historyDepths) {
    const fixture = await createClaimedFixture(client, identity, `history-${historyDepth}`);
    for (let offset = 0; offset < historyDepth; offset += 250) {
      const count = Math.min(250, historyDepth - offset);
      const result = await appendFixtureEvents(
        client,
        fixture,
        Array.from({ length: count }, (_, index) =>
          eventWithPayloadChars(offset + index, payloadChars),
        ),
      );
      assertAccepted(result, count);
    }
    const durations: number[] = [];
    for (let index = 0; index < Math.min(iterations, 20); index += 1) {
      const startedAt = performance.now();
      const result = await appendFixtureEvents(client, fixture, [event(index)]);
      durations.push(performance.now() - startedAt);
      assertAccepted(result, 1);
    }
    historyDepthMatrix.push({ historyDepth, appendMs: distribution(durations) });
  }

  const lockFixture = await createClaimedFixture(client, identity, "controlled-lock");
  const unrelatedFixture = await createClaimedFixture(client, identity, "controlled-lock-other");
  const controlledLockCases = [];
  for (const kind of [
    "same_session",
    "unrelated_session",
    "same_turn",
    "same_attempt",
    "same_workspace_update",
  ] as const) {
    controlledLockCases.push(
      await runControlledLockCase({
        client,
        rawSql,
        fixture: lockFixture,
        unrelatedFixture,
        kind,
        lockHoldMs,
      }),
    );
  }
  const poolSaturationCases = [];
  for (const holders of [9, 10]) {
    poolSaturationCases.push(
      await runPoolSaturationCase({
        client,
        rawSql,
        fixture: lockFixture,
        holders,
        holdMs: lockHoldMs,
      }),
    );
  }

  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    question:
      "Does durable session-event persistence itself explain seconds-scale pre-model latency, and how does same-session locking differ from independent-session concurrency?",
    configuration: {
      iterations,
      concurrencies,
      payloadChars,
      payloadMatrixChars,
      historyDepths,
      lockHoldMs,
      publishDelaysMs,
    },
    invariants: {
      realPostgres: true,
      realAttemptFence: true,
      acceptedEventCountChecked: true,
      durableBeforePublish: true,
      modelCalled: false,
      productStateMutated: false,
    },
    sequentialSingleEvent: {
      calls: iterations,
      elapsedMs: distribution(sequentialDurations),
      phaseMs: phaseDistributions(sequentialPhaseDurations),
      totalMs: sum(sequentialDurations),
    },
    oneBatch: {
      events: iterations,
      elapsedMs: batchElapsedMs,
      millisecondsPerEvent: batchElapsedMs / iterations,
    },
    sameSessionWaves,
    independentSessionWaves,
    appendAndPublish,
    payloadMatrix,
    historyDepthMatrix,
    controlledLockCases,
    poolSaturationCases,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outputPath, receipt }, null, 2)}\n`);
} finally {
  await Promise.allSettled([
    client?.close() ?? Promise.resolve(),
    rawSql?.end({ timeout: 1 }) ?? Promise.resolve(),
  ]);
  await services.down();
}
process.exit(0);

type DbClient = NonNullable<typeof client>;
type Fixture = {
  attemptId: string;
  executionGeneration: number;
  producerId: string;
  sessionId: string;
  turnId: string;
  workspaceId: string;
};

async function createClaimedFixture(
  dbClient: DbClient,
  identity: { accountId: string; subjectId: string; workspaceId: string },
  label: string,
): Promise<Fixture> {
  const session = await createSession(dbClient.db, {
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    initialMessage: `Event persistence ${label}`,
    resources: [],
    tools: [],
    metadata: { benchmark: "session-event-persistence", label },
    model: "scripted-model",
    sandboxBackend: "none",
  });
  await withWorkspaceSubjectSessionActivityRls(
    dbClient.db,
    identity.workspaceId,
    identity.subjectId,
    async (scopedDb) =>
      await scopedDb.transaction(
        async (tx) =>
          await submitHumanPromptInTransaction(tx as unknown as typeof scopedDb, {
            accountId: identity.accountId,
            workspaceId: identity.workspaceId,
            sessionId: session.id,
            subjectId: identity.subjectId,
            actor: { type: "human", subjectId: identity.subjectId },
            operationKey: `event-benchmark-${crypto.randomUUID()}`,
            delivery: "send",
            text: `Event persistence ${label}`,
            resources: [],
            reasoningEffortFallback: "low",
            source: "user",
          }),
      ),
  );
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(dbClient.db, identity.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") {
    throw new Error(`Fixture ${label} was not claimed: ${claim.action}`);
  }
  return {
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
    producerId: `benchmark-${crypto.randomUUID()}`,
    sessionId: session.id,
    turnId: claim.turn.id,
    workspaceId: identity.workspaceId,
  };
}

function event(index: number): Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId"> {
  return eventWithPayloadChars(index, payloadChars);
}

function eventWithPayloadChars(
  index: number,
  characters: number,
): Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId"> {
  return {
    type: index % 2 === 0 ? "sandbox.operation.started" : "sandbox.operation.completed",
    payload: {
      name: "event-persistence-benchmark",
      index,
      text: "x".repeat(characters),
    },
  };
}

type ControlledLockKind =
  | "same_session"
  | "unrelated_session"
  | "same_turn"
  | "same_attempt"
  | "same_workspace_update";

async function runControlledLockCase(input: {
  client: DbClient;
  rawSql: ReturnType<typeof postgres>;
  fixture: Fixture;
  unrelatedFixture: Fixture;
  kind: ControlledLockKind;
  lockHoldMs: number;
}) {
  let lockAcquired: () => void = () => undefined;
  const acquired = new Promise<void>((resolveAcquired) => {
    lockAcquired = resolveAcquired;
  });
  const holder = input.rawSql.begin(async (tx) => {
    if (input.kind === "same_session") {
      await tx`
        select id from sessions
        where workspace_id = ${input.fixture.workspaceId}
          and id = ${input.fixture.sessionId}
        for no key update
      `;
    } else if (input.kind === "unrelated_session") {
      await tx`
        select id from sessions
        where workspace_id = ${input.unrelatedFixture.workspaceId}
          and id = ${input.unrelatedFixture.sessionId}
        for no key update
      `;
    } else if (input.kind === "same_turn") {
      await tx`
        select id from session_turns
        where workspace_id = ${input.fixture.workspaceId}
          and id = ${input.fixture.turnId}
        for update
      `;
    } else if (input.kind === "same_attempt") {
      await tx`
        select id from session_turn_attempts
        where workspace_id = ${input.fixture.workspaceId}
          and id = ${input.fixture.attemptId}
        for update
      `;
    } else {
      await tx`
        select id from workspaces
        where id = ${input.fixture.workspaceId}
        for update
      `;
    }
    lockAcquired();
    await Bun.sleep(input.lockHoldMs);
  });
  await acquired;

  let appendSettled = false;
  const appendPhases = new Map<string, number[]>();
  const startedAt = performance.now();
  const append = (async () => {
    const result = await appendFixtureEvents(input.client, input.fixture, [event(0)], (phase) => {
      const values = appendPhases.get(phase.phase) ?? [];
      values.push(phase.durationSeconds * 1_000);
      appendPhases.set(phase.phase, values);
    });
    return { result, appendMs: performance.now() - startedAt };
  })().finally(() => {
    appendSettled = true;
  });
  await Bun.sleep(Math.min(50, Math.floor(input.lockHoldMs / 4)));
  const blockedAtProbe = !appendSettled;
  const observedLockWaits = await input.rawSql<Array<{ waitEvent: string | null; query: string }>>`
    select wait_event as "waitEvent", left(query, 240) as query
    from pg_stat_activity
    where datname = current_database()
      and pid <> pg_backend_pid()
      and wait_event_type = 'Lock'
    order by pid
  `;
  const { result, appendMs } = await append;
  await holder;
  assertAccepted(result, 1);

  const expectedBlocked = input.kind !== "unrelated_session";
  if (blockedAtProbe !== expectedBlocked) {
    throw new Error(
      `Controlled ${input.kind} lock expected blocked=${expectedBlocked}, observed ${blockedAtProbe}`,
    );
  }
  return {
    kind: input.kind,
    lockHoldMs: input.lockHoldMs,
    expectedBlocked,
    blockedAtProbe,
    appendMs,
    phaseMs: phaseDistributions(appendPhases),
    observedLockWaits,
  };
}

async function runPoolSaturationCase(input: {
  client: DbClient;
  rawSql: ReturnType<typeof postgres>;
  fixture: Fixture;
  holders: number;
  holdMs: number;
}) {
  const sleepers = Array.from(
    { length: input.holders },
    async () => await input.client.db.execute(sql`select pg_sleep(${input.holdMs / 1_000})`),
  );
  let activeSleepers = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await input.rawSql<Array<{ count: number }>>`
      select count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and state = 'active'
        and pid <> pg_backend_pid()
        and query like '%pg_sleep%'
    `;
    activeSleepers = row?.count ?? 0;
    if (activeSleepers >= input.holders) break;
    await Bun.sleep(5);
  }
  if (activeSleepers < input.holders) {
    await Promise.allSettled(sleepers);
    throw new Error(`Expected ${input.holders} active pool sleepers, observed ${activeSleepers}`);
  }

  let appendSettled = false;
  const appendPhases = new Map<string, number[]>();
  const startedAt = performance.now();
  const append = (async () => {
    const result = await appendFixtureEvents(input.client, input.fixture, [event(0)], (phase) => {
      const values = appendPhases.get(phase.phase) ?? [];
      values.push(phase.durationSeconds * 1_000);
      appendPhases.set(phase.phase, values);
    });
    return { result, appendMs: performance.now() - startedAt };
  })().finally(() => {
    appendSettled = true;
  });
  await Bun.sleep(Math.min(50, Math.floor(input.holdMs / 4)));
  const blockedAtProbe = !appendSettled;
  const [{ result, appendMs }] = await Promise.all([append, Promise.all(sleepers)]);
  assertAccepted(result, 1);

  const expectedBlocked = input.holders === 10;
  if (expectedBlocked && !blockedAtProbe) {
    throw new Error(
      `Pool saturation with ${input.holders} holders expected a blocked append at the probe`,
    );
  }
  return {
    poolMax: 10,
    holders: input.holders,
    holdMs: input.holdMs,
    activeSleepers,
    expectedBlocked,
    blockedAtProbe,
    appendMs,
    phaseMs: phaseDistributions(appendPhases),
  };
}

function fixtureEvent(fixture: Fixture, index: number): AppendEventInput {
  return {
    ...event(index),
    turnId: fixture.turnId,
    producerId: `${fixture.producerId}-${index}`,
    producerSeq: 1,
  };
}

async function appendFixtureEvents(
  dbClient: DbClient,
  fixture: Fixture,
  events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>,
  observePhase?: SessionEventAppendPhaseObserver,
) {
  const producerId = `${fixture.producerId}-${crypto.randomUUID()}`;
  return await appendSessionEventsForTurnAttempt(
    dbClient.db,
    fixture.workspaceId,
    fixture.sessionId,
    fixture.turnId,
    fixture.executionGeneration,
    fixture.attemptId,
    events.map((input, index) => ({
      ...input,
      turnId: fixture.turnId,
      producerId,
      producerSeq: index + 1,
    })),
    observePhase,
  );
}

function assertAccepted(
  result: { accepted: boolean; events: unknown[] },
  expectedEvents: number,
): void {
  if (!result.accepted || result.events.length !== expectedEvents) {
    throw new Error(
      `Persistence invariant failed: accepted=${result.accepted}, events=${result.events.length}, expected=${expectedEvents}`,
    );
  }
}

async function runWave<T>(
  concurrency: number,
  operation: (index: number) => Promise<T>,
  assertResult: (result: T) => void,
) {
  const startedAt = performance.now();
  const starts = new Array<number>(concurrency);
  const durations = new Array<number>(concurrency);
  const results = await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      starts[index] = performance.now();
      const result = await operation(index);
      durations[index] = performance.now() - starts[index]!;
      return result;
    }),
  );
  for (const result of results) assertResult(result);
  const wallMs = performance.now() - startedAt;
  return {
    concurrency,
    wallMs,
    operationsPerSecond: (concurrency / wallMs) * 1_000,
    operationMs: distribution(durations),
  };
}

function distribution(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (value: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(value * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1)!,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function phaseDistributions(values: Map<string, number[]>) {
  return Object.fromEntries(
    [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([phase, samples]) => [phase, distribution(samples)]),
  );
}

function stringArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerArgument(name: string, fallback: number): number {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function integerListArgument(name: string, fallback: number[]): number[] {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = value.split(",").map((item) => Number.parseInt(item, 10));
  if (parsed.length === 0 || parsed.some((item) => !Number.isSafeInteger(item))) {
    throw new Error(`${name} must be a comma-separated list of integers`);
  }
  return [...new Set(parsed)];
}
