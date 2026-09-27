import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startTestServices,
  startProcess,
  startE2eWorkerTopology,
  freePort,
  waitFor,
  type StartedProcess,
  type StartedE2eWorkerTopology,
} from "@opengeni/testing";
type SessionProjection = { id: string; parentSessionId: string | null };
type EventProjection = {
  type: string;
  sequence: number;
  turnId: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
};
type TurnProjection = { id: string; source: string; status: string };
const root = new URL("../..", import.meta.url).pathname;

/** One real API plus control and turn workers running one scripted model scenario. */
async function withScenarioStack(
  scenario: string,
  receiptPrefix: string,
  run: (stack: {
    base: string;
    topology: StartedE2eWorkerTopology;
    receiptDir: string;
  }) => Promise<void>,
): Promise<void> {
  const services = await startTestServices({ temporal: true });
  const receiptDir = await mkdtemp(join(tmpdir(), receiptPrefix));
  let api: StartedProcess | undefined;
  let workers: StartedE2eWorkerTopology | undefined;
  try {
    await services.migrate();
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const env = {
      OPENGENI_ENVIRONMENT: "test",
      OPENGENI_DATABASE_URL: services.runtimeDatabaseUrl,
      OPENGENI_NATS_URL: services.natsUrl,
      OPENGENI_TEMPORAL_HOST: services.temporalHost,
      OPENGENI_TEMPORAL_NAMESPACE: "default",
      OPENGENI_TEMPORAL_TASK_QUEUE: `${scenario}-${crypto.randomUUID()}`,
      OPENGENI_API_HOST: "127.0.0.1",
      OPENGENI_API_PORT: String(port),
      OPENGENI_PRODUCT_ACCESS_MODE: "local",
      OPENGENI_OPENAI_API_KEY: "test",
      OPENGENI_OPENAI_MODEL: "scripted-model",
      OPENGENI_SANDBOX_BACKEND: "none",
      OPENGENI_SANDBOX_PREPARATION_PROFILES: "none",
      OPENGENI_TEST_SCENARIO: scenario,
    };
    api = await startProcess(["bun", "apps/api/src/index.ts"], {
      cwd: root,
      env,
      ready: async () => (await fetch(`${origin}/healthz`).catch(() => null))?.ok === true,
      timeoutMs: 60000,
    });
    const access = (await (await fetch(`${origin}/v1/access/me`)).json()) as {
      defaultWorkspaceId: string;
    };
    const base = `${origin}/v1/workspaces/${access.defaultWorkspaceId}`;
    const topology = await startE2eWorkerTopology({ cwd: root, env });
    workers = topology;
    await waitFor(() => topology.ready(), { timeoutMs: 90000, describe: () => topology.logs() });
    await run({ base, topology, receiptDir });
  } finally {
    if (workers) {
      await Bun.write(`${receiptDir}/workers.log`, workers.logs());
      await workers.stop();
    }
    if (api) {
      await Bun.write(`${receiptDir}/api.log`, api.logs());
      await api.stop();
    }
    await services.down();
  }
}

test("public API child wait does not report completed work before deadline", async () => {
  await withScenarioStack("child-wait-boundary", "opengeni-child-wait-", async (stack) => {
    const { base, topology, receiptDir } = stack;
    const create = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "CHILD_WAIT_PARENT_FIXTURE",
        sandboxBackend: "none",
        tools: [{ id: "opengeni", kind: "mcp" }],
      }),
    });
    expect(create.status).toBe(202);
    const parent = (await create.json()) as SessionProjection;
    const events = async (id: string) =>
      (await (
        await fetch(`${base}/sessions/${id}/events?mode=forensic&payloadMode=full&limit=1000`)
      ).json()) as EventProjection[];
    let child: SessionProjection | undefined;
    await waitFor(
      async () => {
        const list = (await (await fetch(`${base}/sessions`)).json()) as SessionProjection[];
        child = list.find((session) => session.parentSessionId === parent.id);
        return !!child;
      },
      { timeoutMs: 60000, describe: () => topology.logs() },
    );
    if (!child) throw new Error("child was not created through the public runtime tool");
    const childId = child.id;
    await waitFor(
      async () => (await events(childId)).some((e) => e.type === "session.wait.started"),
      { timeoutMs: 60000, describe: () => topology.logs() },
    );
    await waitFor(async () => (await events(childId)).some((e) => e.type === "goal.completed"), {
      timeoutMs: 90000,
      describe: () => topology.logs(),
    });
    await waitFor(
      async () =>
        (await events(parent.id)).some(
          (e) => e.type === "system.update.pending" && e.payload.kind === "child_terminal_result",
        ),
      { timeoutMs: 30000, describe: () => topology.logs() },
    );
    const parentEvents = await events(parent.id),
      childEvents = await events(childId);
    const goal = (await (await fetch(`${base}/sessions/${childId}/goal`)).json()) as {
      status: string;
    };
    await Bun.write(
      `${receiptDir}/receipt.json`,
      JSON.stringify({ parentId: parent.id, childId, parentEvents, childEvents, goal }, null, 2),
    );
    const notices = parentEvents.filter(
      (e) => e.type === "system.update.pending" && e.payload.kind === "child_terminal_result",
    );
    const completion = childEvents.find((e) => e.type === "goal.completed");
    expect(notices).toHaveLength(1);
    expect(Date.parse(notices[0]!.occurredAt)).toBeGreaterThanOrEqual(
      Date.parse(completion!.occurredAt),
    );
    expect(notices[0]!.payload.summary).toContain("COMPLETED its goal");
    expect(goal.status).toBe("completed");
  });
}, 300000);

test("a person's answer turn keeps a goalless root waiting so its child result wakes it", async () => {
  await withScenarioStack("held-wait-person-turn", "opengeni-held-wait-", async (stack) => {
    const { base, topology, receiptDir } = stack;
    const create = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "HELD_WAIT_ROOT_FIXTURE count the customers in a child session",
        sandboxBackend: "none",
        tools: [{ id: "opengeni", kind: "mcp" }],
      }),
    });
    expect(create.status).toBe(202);
    const parent = (await create.json()) as SessionProjection;
    // The question is queued while the first turn is still running, before the spawn.
    const question = await fetch(`${base}/sessions/${parent.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "user.message",
        payload: { text: "HELD_WAIT_QUESTION how's it going?" },
      }),
    });
    expect(question.status).toBe(202);
    const events = async () =>
      (await (
        await fetch(
          `${base}/sessions/${parent.id}/events?mode=forensic&payloadMode=full&limit=1000`,
        )
      ).json()) as EventProjection[];
    const turns = async () =>
      (await (await fetch(`${base}/sessions/${parent.id}/turns`)).json()) as TurnProjection[];
    const describe = () => `receipt=${receiptDir}\n${topology.logs()}`;
    const isChildResult = (e: EventProjection) =>
      e.type === "system.update.pending" && e.payload.kind === "child_terminal_result";
    try {
      await waitFor(async () => (await events()).some(isChildResult), {
        timeoutMs: 150000,
        describe,
      });
      // Without a goal, only the held wait lets the child result start a turn.
      // Its final message is published before the turn settles, so wait for the
      // settlement and the wait retirement rather than the message alone.
      await waitFor(
        async () => {
          const all = await events();
          const final = all.find(
            (e) =>
              e.type === "agent.message.completed" &&
              JSON.stringify(e.payload).includes("HELD_WAIT_ROOT_FINAL"),
          );
          return (
            final !== undefined &&
            all.some((e) => e.type === "turn.completed" && e.turnId === final.turnId) &&
            all.some((e) => e.type === "session.wait.finished")
          );
        },
        { timeoutMs: 60000, describe },
      );
    } finally {
      await Bun.write(
        `${receiptDir}/receipt.json`,
        JSON.stringify(
          { parentId: parent.id, events: await events(), turns: await turns() },
          null,
          2,
        ),
      );
    }
    const parentEvents = await events();
    const parentTurns = await turns();
    const first = (predicate: (e: EventProjection) => boolean) => {
      const event = parentEvents.find(predicate);
      if (!event) throw new Error(`missing expected event in ${receiptDir}/receipt.json`);
      return event;
    };
    const questionQueued = first(
      (e) => e.type === "user.message" && JSON.stringify(e.payload).includes("HELD_WAIT_QUESTION"),
    );
    // The initial turn is also a person's turn; the answer turn is the one the
    // question queued.
    const answerTurnId = first(
      (e) => e.type === "turn.queued" && e.sequence > questionQueued.sequence,
    ).turnId;
    const answerTurn = parentTurns.find((turn) => turn.id === answerTurnId);
    const resumedTurn = parentTurns.find((turn) => turn.source === "system");
    expect(answerTurn).toMatchObject({ source: "user", status: "completed" });
    expect(resumedTurn?.status).toBe("completed");
    const spawn = first(
      (e) =>
        e.type === "agent.toolCall.created" && JSON.stringify(e.payload).includes("session_create"),
    );
    const waitStarted = first((e) => e.type === "session.wait.started");
    const answerCompleted = first(
      (e) => e.type === "turn.completed" && e.turnId === answerTurn!.id,
    );
    const childResult = first(isChildResult);
    const resumedStarted = first((e) => e.type === "turn.started" && e.turnId === resumedTurn!.id);
    // The losing ordering: question queued before the spawn, the answer turn
    // ends after the wait without waiting again, and the child result follows.
    expect(questionQueued.sequence).toBeLessThan(spawn.sequence);
    expect(waitStarted.sequence).toBeLessThan(answerCompleted.sequence);
    expect(answerCompleted.sequence).toBeLessThan(childResult.sequence);
    expect(
      parentEvents.some(
        (e) =>
          e.type === "agent.message.completed" &&
          e.turnId === answerTurn!.id &&
          JSON.stringify(e.payload).includes("HELD_WAIT_STATUS_REPLY"),
      ),
    ).toBe(true);
    // The answer turn left the wait held; the child result started a new root
    // turn, and only that turn retired the wait.
    expect(resumedStarted.sequence).toBeGreaterThan(childResult.sequence);
    const waitFinished = parentEvents.filter((e) => e.type === "session.wait.finished");
    expect(waitFinished).toHaveLength(1);
    expect(waitFinished[0]!.sequence).toBeGreaterThan(resumedStarted.sequence);
    expect(waitFinished[0]!.payload).toMatchObject({ outcome: "input" });
  });
}, 300000);

test("a person's turn that consumed the awaited child result retires the wait at once", async () => {
  await withScenarioStack(
    "held-wait-consumed-by-person-turn",
    "opengeni-consumed-wait-",
    async (stack) => {
      const { base, topology, receiptDir } = stack;
      const marker = join(receiptDir, "question-queued");
      const create = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initialMessage: `CONSUMED_WAIT_ROOT_FIXTURE CONSUMED_WAIT_MARKER=${marker} count the customers in a child session`,
          sandboxBackend: "none",
          tools: [{ id: "opengeni", kind: "mcp" }],
        }),
      });
      expect(create.status).toBe(202);
      const parent = (await create.json()) as SessionProjection;
      const events = async () =>
        (await (
          await fetch(
            `${base}/sessions/${parent.id}/events?mode=forensic&payloadMode=full&limit=1000`,
          )
        ).json()) as EventProjection[];
      const turns = async () =>
        (await (await fetch(`${base}/sessions/${parent.id}/turns`)).json()) as TurnProjection[];
      const describe = () => `receipt=${receiptDir}\n${topology.logs()}`;
      const isChildResult = (e: EventProjection) =>
        e.type === "system.update.pending" && e.payload.kind === "child_terminal_result";
      try {
        // The child finishes while the root's first turn is still running, so
        // its result is pending when the person's question is queued.
        await waitFor(async () => (await events()).some(isChildResult), {
          timeoutMs: 150000,
          describe,
        });
        const question = await fetch(`${base}/sessions/${parent.id}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "user.message",
            payload: { text: "CONSUMED_WAIT_QUESTION is it done yet?" },
          }),
        });
        expect(question.status).toBe(202);
        await Bun.write(marker, "queued");
        // Well inside the 45 s wait deadline: the answer turn retires the wait.
        await waitFor(
          async () => (await events()).some((e) => e.type === "session.wait.finished"),
          { timeoutMs: 30000, describe },
        );
      } finally {
        await Bun.write(
          `${receiptDir}/receipt.json`,
          JSON.stringify(
            { parentId: parent.id, events: await events(), turns: await turns() },
            null,
            2,
          ),
        );
      }
      const parentEvents = await events();
      const parentTurns = await turns();
      const first = (predicate: (e: EventProjection) => boolean) => {
        const event = parentEvents.find(predicate);
        if (!event) throw new Error(`missing expected event in ${receiptDir}/receipt.json`);
        return event;
      };
      const questionQueued = first(
        (e) =>
          e.type === "user.message" && JSON.stringify(e.payload).includes("CONSUMED_WAIT_QUESTION"),
      );
      const answerTurnId = first(
        (e) => e.type === "turn.queued" && e.sequence > questionQueued.sequence,
      ).turnId;
      const answerTurn = parentTurns.find((turn) => turn.id === answerTurnId);
      expect(answerTurn).toMatchObject({ source: "user", status: "completed" });
      const waitStarted = first((e) => e.type === "session.wait.started");
      const childResult = first(isChildResult);
      const answerCompleted = first(
        (e) => e.type === "turn.completed" && e.turnId === answerTurn!.id,
      );
      // The ordering under test: the child result was pending before the wait
      // was declared, and the person's turn ran next and consumed it.
      expect(childResult.sequence).toBeLessThan(waitStarted.sequence);
      expect(
        parentEvents.some(
          (e) =>
            e.type === "agent.message.completed" &&
            e.turnId === answerTurn!.id &&
            JSON.stringify(e.payload).includes("CONSUMED_WAIT_ROOT_FINAL"),
        ),
      ).toBe(true);
      // That turn consumed the input the wait was for, so it retired the wait
      // with outcome input; no timeout turn follows and no system turn ran.
      const waitFinished = parentEvents.filter((e) => e.type === "session.wait.finished");
      expect(waitFinished).toHaveLength(1);
      expect(waitFinished[0]!.payload).toMatchObject({ outcome: "input" });
      expect(waitFinished[0]!.sequence).toBeGreaterThan(answerCompleted.sequence);
      expect(parentTurns.some((turn) => turn.source === "system")).toBe(false);
      const session = (await (await fetch(`${base}/sessions/${parent.id}`)).json()) as {
        inputWait?: unknown;
      };
      expect(session.inputWait ?? null).toBeNull();
    },
  );
}, 300000);
