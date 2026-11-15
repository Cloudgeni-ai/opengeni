import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { normalizeMessageTimeZone } from "@opengeni/contracts";
import { publishDurableSessionEvents } from "@opengeni/events";
import { measureSessionStartPhase } from "../src/domain/session-start-timing";

/**
 * Runs the exact production statements of `finishStartSession` from the atomic
 * initialization onward, together with the exact post-commit scheduler, against
 * held ports. A create is accepted when initialization commits; the response
 * must never wait for the immediate Temporal wake or live fanout.
 */
function productionDispatch() {
  const source = readFileSync(new URL("../src/domain/sessions.ts", import.meta.url), "utf8");
  const parsed = parseSync("sessions.ts", source);
  expect(parsed.errors).toEqual([]);
  const fn = (name: string) => {
    const node = parsed.program.body.find(
      (item) => item.type === "FunctionDeclaration" && item.id?.name === name,
    );
    if (node?.type !== "FunctionDeclaration") throw new Error(`Missing ${name}`);
    return node;
  };
  const finish = fn("finishStartSession");
  const statements = finish.body!.body;
  const declaration = (name: string) =>
    statements.find(
      (node) =>
        node.type === "VariableDeclaration" &&
        node.declarations.some((d) => d.id.type === "Identifier" && d.id.name === name),
    );
  // Start at the first statement the atomic initialization depends on.
  const first = declaration("initialTimeZone") ?? declaration("started")!;
  const last = statements.at(-1)!;
  const scheduler = fn("scheduleSessionStartPostCommit");
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    `${source.slice(scheduler.start, scheduler.end)}
    const dispatch = async () => { ${source.slice(first.start, last.end)} };`,
  );
  return new Function(
    "ports",
    "input",
    "session",
    `return (async () => {
    const { initializeSessionStartAtomically, publishDurableSessionEvents, requireSession, listSessionTurns, measureSessionStartPhase, normalizeMessageTimeZone } = ports;
    const initialAutomaticTitleForSessionStart = () => null;
    ${code}
    return dispatch();
  })();`,
  ) as (ports: object, input: object, session: object) => Promise<unknown>;
}

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

function fixture(
  options: {
    wakeRevision?: number | null;
    realFanout?: boolean;
    syncFailure?: "fanout" | "wake";
    schedulePostCommit?: (task: () => Promise<void>) => void;
  } = {},
) {
  const holds = {
    initialize: deferred(),
    fanout: deferred(),
    wake: deferred(),
    reload: deferred(),
  };
  const calls: string[] = [];
  const wakes: unknown[] = [];
  const session = { id: "session", workspaceId: "workspace", accountId: "account" };
  const syncError = new Error("synchronous port refusal");
  const bus = {
    publish: () => {
      calls.push("fanout");
      if (options.syncFailure === "fanout") throw syncError;
      return holds.fanout.promise;
    },
  };
  const ports = {
    measureSessionStartPhase,
    normalizeMessageTimeZone,
    initializeSessionStartAtomically: () => {
      calls.push("initialize");
      return holds.initialize.promise;
    },
    publishDurableSessionEvents: options.realFanout ? publishDurableSessionEvents : bus.publish,
    requireSession: () => {
      calls.push("reload");
      return holds.reload.promise;
    },
    listSessionTurns: () => {
      calls.push("initial_turn");
      return Promise.resolve([{ id: "retained-turn" }]);
    },
  };
  const input = {
    db: {},
    bus,
    workflowClient: {
      wakeSessionWorkflow: (wake: unknown) => {
        calls.push("wake");
        wakes.push(wake);
        if (options.syncFailure === "wake") throw syncError;
        return holds.wake.promise;
      },
    },
    ...(options.schedulePostCommit ? { schedulePostCommit: options.schedulePostCommit } : {}),
  };
  const started = {
    workflowWakeRevision: options.wakeRevision === undefined ? 7 : options.wakeRevision,
    temporalWorkflowId: "workflow",
    events: [{}] as object[],
    turn: { id: "turn" } as { id: string } | null,
    changed: true,
  };
  const running = productionDispatch()(ports, input, session);
  void running.catch(() => undefined);
  let settled = false;
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return {
    holds,
    calls,
    wakes,
    running,
    started,
    syncError,
    settled: () => settled,
    async cleanup() {
      holds.initialize.resolve(started);
      holds.fanout.resolve();
      holds.wake.resolve();
      holds.reload.resolve(session);
      await running.catch(() => undefined);
    },
  };
}

test("a stalled Temporal wake and held fanout never delay the accepted create", async () => {
  const f = fixture();
  try {
    expect(f.calls).toEqual(["initialize"]);
    f.holds.initialize.resolve(f.started);
    await flush();
    // Both notifications start right after the commit, before the response
    // read, so the run's start latency is unchanged.
    expect(f.calls).toEqual(["initialize", "fanout", "wake", "reload"]);
    expect(f.wakes).toEqual([
      {
        accountId: "account",
        workspaceId: "workspace",
        sessionId: "session",
        workflowId: "workflow",
        wakeRevision: 7,
      },
    ]);
    f.holds.reload.resolve({ id: "committed", status: "queued", lastSequence: 4 });
    // The wake and fanout are still held: the response does not wait for them.
    expect(await f.running).toEqual({
      session: { id: "committed", status: "queued", lastSequence: 4, initialTurnId: "turn" },
      changed: true,
    });
    expect(f.calls).not.toContain("initial_turn");
  } finally {
    await f.cleanup();
  }
});

for (const failed of ["fanout", "wake"] as const) {
  test(`a rejected ${failed} is logged, never returned to the accepted caller`, async () => {
    const f = fixture();
    try {
      f.holds.initialize.resolve(f.started);
      await flush();
      f.holds[failed].reject(new Error(`${failed} transport down`));
      f.holds.reload.resolve({ id: "session" });
      expect(await f.running).toEqual({
        session: { id: "session", initialTurnId: "turn" },
        changed: true,
      });
      await flush();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls[0])).toContain(
        failed === "wake" ? "session_workflow_wake_failed" : "session_start_event_fanout_failed",
      );
    } finally {
      await f.cleanup();
    }
  });

  test(`a synchronously refusing ${failed} port still lets the create succeed`, async () => {
    const f = fixture({ syncFailure: failed });
    try {
      f.holds.initialize.resolve(f.started);
      await flush();
      expect(f.calls).toEqual(["initialize", "fanout", "wake", "reload"]);
      f.holds.reload.resolve({ id: "session" });
      expect(await f.running).toEqual({
        session: { id: "session", initialTurnId: "turn" },
        changed: true,
      });
    } finally {
      await f.cleanup();
    }
  });
}

test("real best-effort fanout failure leaves the create successful", async () => {
  const f = fixture({ realFanout: true });
  try {
    f.holds.initialize.resolve(f.started);
    await flush();
    expect(f.calls).toEqual(["initialize", "fanout", "wake", "reload"]);
    f.holds.fanout.reject(new Error("transient transport"));
    f.holds.reload.resolve({ id: "response", status: "queued" });
    expect(await f.running).toEqual({
      session: { id: "response", status: "queued", initialTurnId: "turn" },
      changed: true,
    });
  } finally {
    await f.cleanup();
  }
});

test("initialization refusal produces neither fanout nor wake", async () => {
  const f = fixture();
  const failure = new Error("atomic refusal");
  try {
    f.holds.initialize.reject(failure);
    await expect(f.running).rejects.toBe(failure);
    expect(f.calls).toEqual(["initialize"]);
  } finally {
    await f.cleanup();
  }
});

test("null wake revision does not signal a workflow", async () => {
  const f = fixture({ wakeRevision: null });
  try {
    f.holds.initialize.resolve(f.started);
    await flush();
    expect(f.calls).toEqual(["initialize", "fanout", "reload"]);
  } finally {
    await f.cleanup();
  }
});

test("response read failure is the request error even while notifications are held", async () => {
  const f = fixture();
  const failure = new Error("response read failed");
  try {
    f.holds.initialize.resolve(f.started);
    await flush();
    f.holds.reload.reject(failure);
    await expect(f.running).rejects.toBe(failure);
  } finally {
    await f.cleanup();
  }
});

test("deferred and cancelled initialization retain the initial-turn fallback read", async () => {
  const f = fixture({ wakeRevision: null });
  try {
    f.started.turn = null;
    f.started.changed = false;
    f.started.events = [];
    f.holds.initialize.resolve(f.started);
    f.holds.reload.resolve({ id: "session", status: "cancelled" });
    expect(await f.running).toEqual({
      session: { id: "session", status: "cancelled", initialTurnId: "retained-turn" },
      changed: false,
    });
    // Nothing committed to deliver: no fanout and no wake.
    expect(f.calls).toEqual(["initialize", "reload", "initial_turn"]);
  } finally {
    await f.cleanup();
  }
});

test("the host scheduler owns post-commit delivery and receives it before the response", async () => {
  const scheduled: Array<() => Promise<void>> = [];
  const f = fixture({ schedulePostCommit: (task) => scheduled.push(task) });
  try {
    f.holds.initialize.resolve(f.started);
    await flush();
    expect(scheduled).toHaveLength(1);
    expect(f.calls).toEqual(["initialize", "reload"]);
    f.holds.reload.resolve({ id: "session" });
    await f.running;
    f.holds.fanout.resolve();
    f.holds.wake.reject(new Error("temporal unavailable"));
    await expect(scheduled[0]!()).resolves.toBeUndefined();
    expect(f.calls).toEqual(["initialize", "reload", "fanout", "wake"]);
    expect(f.wakes).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("a throwing host scheduler cannot fail an accepted create", async () => {
  const f = fixture({
    schedulePostCommit: () => {
      throw new Error("scheduler closed");
    },
  });
  try {
    f.holds.initialize.resolve(f.started);
    await flush();
    f.holds.reload.resolve({ id: "session" });
    expect(await f.running).toEqual({
      session: { id: "session", initialTurnId: "turn" },
      changed: true,
    });
    expect(JSON.stringify(warn.mock.calls)).toContain("session_start_post_commit_schedule_failed");
  } finally {
    await f.cleanup();
  }
});
