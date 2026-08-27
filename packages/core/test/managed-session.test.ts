import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import * as coreRoot from "../src";
import {
  getManagedAuthRequestActorAbortSignal,
  getManagedAuthRequestActorAdmissionStamp,
  getManagedAuthRequestActorLeaseStamp,
  getManagedSession,
  installManagedAuthActorLeaseRuntimeForTest,
  ManagedAuthActorLeaseOutcomeUnknownError,
  markManagedAuthRequestActorTransitionApplied,
  releaseManagedAuthRequestActorLease,
  validateManagedAuthRequestActorLease,
} from "../src/managed-session";
import { ManagedAuthActorChangeError, managedAuthSha256 } from "../src/managed-auth-session-sets";

function validationDatabase(valid: boolean, onExecute?: () => void) {
  return {
    execute: async () => {
      onExecute?.();
      return [{ valid }];
    },
  };
}

const authority = "lease-authority";
const slotId = "7438e162-ded0-45fe-94f1-f4548ca532f8";
const selectedSession = {
  slotId,
  authSessionId: "auth-session-1",
  authUserId: "auth-user-1",
  token: "server-only-token",
  email: "actor@example.test",
  name: "Actor",
  emailVerified: true,
};
const sessionSetSnapshot = {
  projection: {
    mode: "broker",
    generation: "3",
    actorEpoch: "7",
    selectedSlotId: slotId,
    state: "ready",
    slots: [
      {
        id: slotId,
        displayName: "Actor",
        verifiedClaim: { kind: "email", value: "actor@example.test" },
        state: "active",
      },
    ],
  },
  selected: selectedSession,
  internalSlots: [selectedSession],
};

type ExecuteStep = unknown[] | (() => Promise<unknown[]>);

function sequenceDatabase(steps: ExecuteStep[]) {
  const calls: number[] = [];
  const db = {
    execute: async () => {
      calls.push(calls.length + 1);
      const step = steps.shift();
      if (!step) throw new Error(`unexpected lease database call ${calls.length}`);
      return typeof step === "function" ? await step() : step;
    },
  };
  return { db, calls, remaining: steps };
}

type ScheduledTask = {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
  handle: ReturnType<typeof setTimeout>;
};

function deterministicLeaseRuntime(monotonicNow: () => number) {
  const tasks: ScheduledTask[] = [];
  let terminateCalls = 0;
  const restore = installManagedAuthActorLeaseRuntimeForTest({
    monotonicNow,
    schedule: (callback, delayMs) => {
      const task = {
        callback,
        delayMs,
        cancelled: false,
      } as Omit<ScheduledTask, "handle"> & {
        handle?: ReturnType<typeof setTimeout>;
      };
      task.handle = task as unknown as ReturnType<typeof setTimeout>;
      tasks.push(task as ScheduledTask);
      return task.handle;
    },
    cancel: (handle) => {
      const task = tasks.find((candidate) => candidate.handle === handle);
      if (task) task.cancelled = true;
    },
    terminate: () => {
      terminateCalls += 1;
    },
  });
  return { tasks, restore, terminateCalls: () => terminateCalls };
}

function managedSessionAdapter() {
  const resolved = {
    session: {
      id: selectedSession.authSessionId,
      userId: selectedSession.authUserId,
    },
    user: {
      id: selectedSession.authUserId,
      email: selectedSession.email,
      name: selectedSession.name,
      emailVerified: true,
    },
  };
  return {
    resolveSelectedSession: async () => resolved,
    refreshSelectedSession: async () => resolved,
  };
}

async function acquireTestLease(db: unknown): Promise<Request> {
  let capturedRequest: Request | null = null;
  const app = new Hono().post("/", async (c) => {
    capturedRequest = c.req.raw;
    const session = await getManagedSession(c, {} as never, {
      db: db as never,
      sessionSetMode: "broker",
      sessionAdapter: managedSessionAdapter() as never,
    });
    return c.json({ authenticated: session !== null });
  });
  const response = await app.request("/", {
    method: "POST",
    headers: {
      cookie: `opengeni.session_set=${authority}`,
      "x-opengeni-actor-epoch": "7",
    },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ authenticated: true });
  if (!capturedRequest) throw new Error("managed request was not captured");
  return capturedRequest;
}

async function flushPromiseCallbacks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("getManagedSession", () => {
  test("keeps the mutable lease test clock out of the production root export", () => {
    expect("installManagedAuthActorLeaseRuntimeForTest" in coreRoot).toBe(false);
  });

  test("requests and forwards every Better Auth session renewal cookie", async () => {
    const renewedSession = "better-auth.session_token=renewed; Path=/; HttpOnly";
    const refreshedCache =
      "better-auth.session_data=refreshed; Expires=Wed, 12 Aug 2026 12:00:00 GMT; Path=/; HttpOnly";
    let receivedHeaders: Headers | undefined;
    let returnHeaders: boolean | undefined;
    const auth = {
      api: {
        getSession: async (input: { headers: Headers; returnHeaders?: boolean }) => {
          receivedHeaders = input.headers;
          returnHeaders = input.returnHeaders;
          const headers = new Headers();
          headers.append("set-cookie", renewedSession);
          headers.append("set-cookie", refreshedCache);
          return {
            headers,
            response: {
              session: { id: "session-1" },
              user: { id: "user-1" },
            },
          };
        },
      },
    };
    const app = new Hono().get("/", async (c) => {
      const session = await getManagedSession(c, auth as never);
      return c.json({ userId: session?.user.id });
    });

    const response = await app.request("/", {
      headers: { cookie: "better-auth.session_token=original" },
    });

    expect(response.status).toBe(200);
    expect(returnHeaders).toBe(true);
    expect(receivedHeaders?.get("cookie")).toBe("better-auth.session_token=original");
    expect(response.headers.getSetCookie()).toEqual([renewedSession, refreshedCache]);
    expect(await response.json()).toEqual({ userId: "user-1" });
  });

  test("does not invent a cookie when Better Auth does not refresh the session", async () => {
    const auth = {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: null,
        }),
      },
    };
    const app = new Hono().get("/", async (c) => {
      const session = await getManagedSession(c, auth as never);
      return c.json({ authenticated: session !== null });
    });

    const response = await app.request("/");

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ authenticated: false });
  });

  test("accepts a managed session only when its canonical authority stamp is current", async () => {
    const auth = {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: {
            session: { id: "session-current" },
            user: { id: "user-1" },
          },
        }),
      },
    };
    const app = new Hono().get("/", async (c) => {
      const session = await getManagedSession(c, auth as never, {
        db: validationDatabase(true) as never,
      });
      return c.json({ authenticated: session !== null });
    });

    const response = await app.request("/");

    expect(await response.json()).toEqual({ authenticated: true });
  });

  test("denies a managed-session projection that omits the Better Auth session id", async () => {
    let validationQueries = 0;
    const auth = {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: { user: { id: "user-1" } },
        }),
      },
    };
    const app = new Hono().get("/", async (c) => {
      const session = await getManagedSession(c, auth as never, {
        db: validationDatabase(true, () => {
          validationQueries += 1;
        }) as never,
      });
      return c.json({ authenticated: session !== null });
    });

    const response = await app.request("/");

    expect(validationQueries).toBe(0);
    expect(await response.json()).toEqual({ authenticated: false });
  });

  test("denies a managed session whose canonical authority stamp is stale", async () => {
    const auth = {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: {
            session: { id: "session-stale" },
            user: { id: "user-1" },
          },
        }),
      },
    };
    const app = new Hono().get("/", async (c) => {
      const session = await getManagedSession(c, auth as never, {
        db: validationDatabase(false) as never,
      });
      return c.json({ authenticated: session !== null });
    });

    const response = await app.request("/");

    expect(await response.json()).toEqual({ authenticated: false });
  });

  test("reauthorizes a locked streaming response without mutating headers or following actors", async () => {
    let reauthorize!: () => Promise<unknown>;
    const changedSnapshot = {
      ...sessionSetSnapshot,
      projection: {
        ...sessionSetSnapshot.projection,
        generation: "4",
        actorEpoch: "8",
      },
    };
    const sequence = sequenceDatabase([
      [{ result: sessionSetSnapshot }],
      [{ result: sessionSetSnapshot }],
      [{ result: changedSnapshot }],
    ]);
    const app = new Hono().get("/", async (c) => {
      await getManagedSession(c, {} as never, {
        db: sequence.db as never,
        sessionSetMode: "broker",
        sessionAdapter: managedSessionAdapter() as never,
      });
      reauthorize = () =>
        getManagedSession(c, {} as never, {
          db: sequence.db as never,
          sessionSetMode: "broker",
          sessionAdapter: managedSessionAdapter() as never,
        });
      return c.body(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
          },
        }),
      );
    });

    const response = await app.request("/", {
      headers: {
        cookie: `opengeni.session_set=${authority}`,
        "x-opengeni-actor-epoch": "7",
      },
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");

    await expect(reauthorize()).resolves.toMatchObject({
      user: { id: "auth-user-1" },
    });
    await expect(reauthorize()).rejects.toMatchObject({
      status: 409,
      message: "actor_change_required",
    });
    await reader.cancel();
    expect(sequence.remaining).toHaveLength(0);
  });

  test("exposes verified actor evidence on a read without inventing a mutation lease", async () => {
    const sequence = sequenceDatabase([[{ result: sessionSetSnapshot }]]);
    let admission: ReturnType<typeof getManagedAuthRequestActorAdmissionStamp> = null;
    let lease: ReturnType<typeof getManagedAuthRequestActorLeaseStamp> = null;
    const app = new Hono().get("/", async (c) => {
      const session = await getManagedSession(c, {} as never, {
        db: sequence.db as never,
        sessionSetMode: "broker",
        sessionAdapter: managedSessionAdapter() as never,
      });
      admission = getManagedAuthRequestActorAdmissionStamp(c.req.raw);
      lease = getManagedAuthRequestActorLeaseStamp(c.req.raw);
      return c.json({ authenticated: session !== null });
    });

    const response = await app.request("/", {
      headers: {
        cookie: `opengeni.session_set=${authority}`,
        "x-opengeni-actor-epoch": "7",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
    expect(admission).toEqual({
      authorityHash: managedAuthSha256(authority),
      actorEpoch: "7",
    });
    expect(lease).toBeNull();
    expect(sequence.remaining).toHaveLength(0);
  });

  test("acquires, validates, marks a known transition, and releases one exact actor lease", async () => {
    const sequence = sequenceDatabase([
      [{ result: sessionSetSnapshot }],
      [{ expiresAt: "2026-08-26T01:15:00.000Z" }],
      [{ result: sessionSetSnapshot }],
      [{ valid: true }],
      [{ released: true }],
    ]);
    const runtime = deterministicLeaseRuntime(() => 1_000);
    let request: Request | null = null;
    try {
      request = await acquireTestLease(sequence.db);
      expect(getManagedAuthRequestActorLeaseStamp(request)).toMatchObject({
        actorEpoch: "7",
      });
      expect(getManagedAuthRequestActorAbortSignal(request)?.aborted).toBe(false);
      await validateManagedAuthRequestActorLease(request);
      markManagedAuthRequestActorTransitionApplied(request);
      await validateManagedAuthRequestActorLease(request);
      expect(sequence.calls).toHaveLength(4);
    } finally {
      if (request) await releaseManagedAuthRequestActorLease(request);
      runtime.restore();
    }
    expect(sequence.calls).toHaveLength(5);
    expect(sequence.remaining).toHaveLength(0);
  });

  test("releases a renewal that resolves after the outer request already released", async () => {
    let resolveRenewal!: (rows: unknown[]) => void;
    const renewal = new Promise<unknown[]>((resolve) => {
      resolveRenewal = resolve;
    });
    const sequence = sequenceDatabase([
      [{ result: sessionSetSnapshot }],
      [{ expiresAt: "2026-08-26T01:15:00.000Z" }],
      [{ result: sessionSetSnapshot }],
      () => renewal,
      [{ released: true }],
      [{ released: true }],
    ]);
    let monotonicMs = 1_000;
    const runtime = deterministicLeaseRuntime(() => monotonicMs);
    try {
      const request = await acquireTestLease(sequence.db);
      const refresh = runtime.tasks.find((task) => task.delayMs === 5 * 60 * 1_000)!;
      monotonicMs += refresh.delayMs;
      refresh.callback();
      await flushPromiseCallbacks();
      expect(sequence.calls).toHaveLength(4);
      await releaseManagedAuthRequestActorLease(request);
      resolveRenewal([{ expiresAt: "2026-08-26T01:20:00.000Z" }]);
      await flushPromiseCallbacks();
      expect(sequence.calls).toHaveLength(6);
      expect(sequence.remaining).toHaveLength(0);
    } finally {
      runtime.restore();
    }
  });

  test("poisons on renewal failure and uses a monotonic fatal deadline despite a backward wall clock", async () => {
    const refreshFailure = new Error("lease renewal failed");
    const sequence = sequenceDatabase([
      [{ result: sessionSetSnapshot }],
      [{ expiresAt: "2026-08-26T01:15:00.000Z" }],
      [{ result: sessionSetSnapshot }],
      async () => {
        throw refreshFailure;
      },
      [{ released: true }],
    ]);
    let monotonicMs = 1_000;
    const runtime = deterministicLeaseRuntime(() => monotonicMs);
    const originalDateNow = Date.now;
    let request: Request | null = null;
    try {
      request = await acquireTestLease(sequence.db);
      const refresh = runtime.tasks.find((task) => task.delayMs === 5 * 60 * 1_000)!;
      monotonicMs += refresh.delayMs;
      Date.now = () => -8_000_000_000_000_000;
      refresh.callback();
      await flushPromiseCallbacks();
      expect(getManagedAuthRequestActorAbortSignal(request)?.aborted).toBe(true);
      await expect(validateManagedAuthRequestActorLease(request)).rejects.toBeInstanceOf(
        ManagedAuthActorLeaseOutcomeUnknownError,
      );
      const fatal = runtime.tasks.find((task) => task.delayMs === 595_000);
      expect(fatal).toBeDefined();
      fatal!.callback();
      expect(runtime.terminateCalls()).toBe(1);
    } finally {
      Date.now = originalDateNow;
      if (request) await releaseManagedAuthRequestActorLease(request);
      runtime.restore();
    }
    expect(sequence.remaining).toHaveLength(0);
  });

  test("fails the final exact lease validation after an actor transition", async () => {
    const sequence = sequenceDatabase([
      [{ result: sessionSetSnapshot }],
      [{ expiresAt: "2026-08-26T01:15:00.000Z" }],
      [{ result: sessionSetSnapshot }],
      [{ valid: false }],
      [{ released: false }],
    ]);
    const runtime = deterministicLeaseRuntime(() => 1_000);
    let request: Request | null = null;
    try {
      request = await acquireTestLease(sequence.db);
      await expect(validateManagedAuthRequestActorLease(request)).rejects.toBeInstanceOf(
        ManagedAuthActorChangeError,
      );
    } finally {
      if (request) await releaseManagedAuthRequestActorLease(request);
      runtime.restore();
    }
    expect(sequence.remaining).toHaveLength(0);
  });
});
