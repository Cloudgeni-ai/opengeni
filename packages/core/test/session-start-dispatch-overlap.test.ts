import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { normalizeMessageTimeZone } from "@opengeni/contracts";
import { publishDurableSessionEvents } from "@opengeni/events";
import { measureSessionStartPhase } from "../src/domain/session-start-timing";

function productionDispatch() {
  const source = readFileSync(new URL("../src/domain/sessions.ts", import.meta.url), "utf8");
  const parsed = parseSync("sessions.ts", source);
  expect(parsed.errors).toEqual([]);
  const fn = parsed.program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === "finishStartSession",
  );
  if (fn?.type !== "FunctionDeclaration") throw new Error("Missing finishStartSession");
  const statements = fn.body!.body;
  const declaration = (name: string) =>
    statements.find(
      (node) =>
        node.type === "VariableDeclaration" &&
        node.declarations.some((d) => d.id.type === "Identifier" && d.id.name === name),
    );
  // Start at the first statement the atomic initialization depends on.
  const first = declaration("initialTimeZone") ?? declaration("started")!;
  const last = statements.at(-1)!;
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    `const dispatch = async () => { ${source.slice(first.start, last.end)} };`,
  );
  // Execute the exact production statements, including atomic initialization,
  // both post-commit notifications, error handling and authoritative response read.
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

function fixture(
  wakeRevision: number | null = 7,
  realFanout = false,
  syncFailure?: "fanout" | "wake",
) {
  const holds = {
    initialize: deferred(),
    fanout: deferred(),
    wake: deferred(),
    reload: deferred(),
  };
  const calls: string[] = [];
  const session = { id: "session", workspaceId: "workspace", accountId: "account" };
  const syncError = new Error("synchronous port refusal");
  const bus = {
    publish: () => {
      calls.push("fanout");
      if (syncFailure === "fanout") throw syncError;
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
    publishDurableSessionEvents: realFanout ? publishDurableSessionEvents : bus.publish,
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
      wakeSessionWorkflow: () => {
        calls.push("wake");
        if (syncFailure === "wake") throw syncError;
        return holds.wake.promise;
      },
    },
  };
  const started = {
    workflowWakeRevision: wakeRevision,
    temporalWorkflowId: "workflow",
    events: [{}],
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

for (const first of ["fanout", "wake"] as const) {
  test(`atomic commit precedes both notifications; ${first} completion cannot release response alone`, async () => {
    const f = fixture();
    try {
      expect(f.calls).toEqual(["initialize"]);
      f.holds.initialize.resolve(f.started);
      await flush();
      expect(f.calls).toEqual(["initialize", "fanout", "wake", "reload"]);
      f.holds[first].resolve();
      await flush();
      expect(f.settled()).toBe(false);
      expect(f.calls.filter((call) => call === "reload")).toHaveLength(1);
      f.holds[first === "fanout" ? "wake" : "fanout"].resolve();
      await flush();
      expect(f.calls).toEqual(["initialize", "fanout", "wake", "reload"]);
    } finally {
      await f.cleanup();
    }
  });
}

for (const failed of ["fanout", "wake"] as const) {
  test(`${failed} failure still joins the held sibling and response read`, async () => {
    const f = fixture();
    const failure = new Error(failed);
    try {
      f.holds.initialize.resolve(f.started);
      await flush();
      f.holds[failed].reject(failure);
      await flush();
      expect(f.settled()).toBe(false);
      expect(f.calls.filter((call) => call === "reload")).toHaveLength(1);
      f.holds[failed === "fanout" ? "wake" : "fanout"].resolve();
      await flush();
      expect(f.settled()).toBe(false);
      f.holds.reload.resolve({ id: "session" });
      await expect(f.running).rejects.toBe(failure);
    } finally {
      await f.cleanup();
    }
  });
}

for (const firstFailed of ["fanout", "wake"] as const) {
  test(`dual rejection keeps fanout-before-wake error priority, observed ${firstFailed} first`, async () => {
    const f = fixture();
    const failures = { fanout: new Error("fanout"), wake: new Error("wake") };
    try {
      f.holds.initialize.resolve(f.started);
      await flush();
      f.holds[firstFailed].reject(failures[firstFailed]);
      await flush();
      f.holds[firstFailed === "fanout" ? "wake" : "fanout"].reject(
        failures[firstFailed === "fanout" ? "wake" : "fanout"],
      );
      f.holds.reload.reject(new Error("reload"));
      await expect(f.running).rejects.toBe(failures.fanout);
      expect(f.calls.filter((call) => call === "reload")).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });
}

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
  const f = fixture(null);
  try {
    f.holds.initialize.resolve(f.started);
    f.holds.fanout.resolve();
    await flush();
    expect(f.calls).toEqual(["initialize", "fanout", "reload"]);
  } finally {
    await f.cleanup();
  }
});

test("real best-effort fanout failure remains successful after both notifications settle", async () => {
  const f = fixture(7, true);
  try {
    f.holds.initialize.resolve(f.started);
    await flush();
    expect(f.calls).toEqual(["initialize", "fanout", "wake", "reload"]);
    f.holds.fanout.reject(new Error("transient transport"));
    await flush();
    expect(f.settled()).toBe(false);
    f.holds.wake.resolve();
    f.holds.reload.resolve({ id: "response", status: "queued" });
    expect(await f.running).toEqual({
      session: { id: "response", status: "queued", initialTurnId: "turn" },
      changed: true,
    });
  } finally {
    await f.cleanup();
  }
});

for (const failed of ["fanout", "wake"] as const) {
  test(`synchronous ${failed} port failure still observes and joins the held sibling`, async () => {
    const f = fixture(7, false, failed);
    try {
      f.holds.initialize.resolve(f.started);
      await flush();
      expect(f.calls).toEqual(["initialize", "fanout", "wake", "reload"]);
      expect(f.settled()).toBe(false);
      expect(f.calls.filter((call) => call === "reload")).toHaveLength(1);
      f.holds[failed === "fanout" ? "wake" : "fanout"].resolve();
      f.holds.reload.resolve({ id: "session" });
      await expect(f.running).rejects.toBe(f.syncError);
    } finally {
      await f.cleanup();
    }
  });
}

test("response reads finish while both notification transports are held", async () => {
  const f = fixture();
  try {
    f.holds.initialize.resolve(f.started);
    await flush();
    expect(f.calls).toEqual(["initialize", "fanout", "wake", "reload"]);
    f.holds.reload.resolve({ id: "committed", status: "queued", lastSequence: 4 });
    await flush();
    expect(f.settled()).toBe(false);
    f.holds.fanout.resolve();
    f.holds.wake.resolve();
    expect(await f.running).toEqual({
      session: { id: "committed", status: "queued", lastSequence: 4, initialTurnId: "turn" },
      changed: true,
    });
    expect(f.calls).not.toContain("initial_turn");
  } finally {
    await f.cleanup();
  }
});

test("response read failure waits for both transports without an unhandled rejection", async () => {
  const f = fixture();
  const failure = new Error("response read failed");
  try {
    f.holds.initialize.resolve(f.started);
    await flush();
    f.holds.reload.reject(failure);
    await flush();
    expect(f.settled()).toBe(false);
    f.holds.fanout.resolve();
    await flush();
    expect(f.settled()).toBe(false);
    f.holds.wake.resolve();
    await expect(f.running).rejects.toBe(failure);
  } finally {
    await f.cleanup();
  }
});

test("deferred and cancelled initialization retain the initial-turn fallback read", async () => {
  const f = fixture(null);
  try {
    f.started.turn = null;
    f.started.changed = false;
    f.holds.initialize.resolve(f.started);
    f.holds.reload.resolve({ id: "session", status: "cancelled" });
    await flush();
    expect(f.calls).toEqual(["initialize", "fanout", "reload", "initial_turn"]);
    expect(f.settled()).toBe(false);
    f.holds.fanout.resolve();
    expect(await f.running).toEqual({
      session: { id: "session", status: "cancelled", initialTurnId: "retained-turn" },
      changed: false,
    });
  } finally {
    await f.cleanup();
  }
});
