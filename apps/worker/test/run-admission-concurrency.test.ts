import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { SESSION_USAGE_LIMIT_BASIS } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import {
  AllowanceExhaustedError,
  BudgetExhaustedError,
  ensureRunAllowed,
  ensureRunAllowedBetweenModelCalls,
  HostEntitlementDeniedError,
  SessionUsageLimitReachedError,
  TurnAdmissionRefusedError,
} from "../src/activities/agent-turn/admission";
import * as custody from "../src/activities/agent-turn/session-usage-custody";

// The checks before each model request read concurrently, but the refusal
// reported is the one the sequential order would have produced: task usage
// limit, then funding, then workspace allowance, then static monthly limits.
// Each check has its own gate, released latest-first, so a fail-fast join
// would report the wrong refusal.

const database = {} as db.Database;
const settings = testSettings({
  billingMode: "stripe",
  usageLimitsMode: "static",
  staticUsageLimitsJson: JSON.stringify({ maxMonthlyAgentRunsPerWorkspace: 1 }),
});

type Check = "session" | "funding" | "allowance" | "runs";
type Refusals = Partial<Record<Check, boolean>> & { sessionUnavailable?: boolean };
const CHECKS: Check[] = ["session", "funding", "allowance", "runs"];

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const restoreAfter: Array<{ mockRestore(): void }> = [];
function restore() {
  for (const spy of restoreAfter.splice(0)) spy.mockRestore();
}

async function ticks(count = 20) {
  for (let tick = 0; tick < count; tick++) await Promise.resolve();
}

function harness(refusals: Refusals) {
  const gates = Object.fromEntries(CHECKS.map((check) => [check, deferred()])) as Record<
    Check,
    ReturnType<typeof deferred>
  >;
  const started: string[] = [];
  const wait = async (name: Check) => {
    started.push(name);
    await gates[name].promise;
  };
  const sessionId = crypto.randomUUID();
  restoreAfter.push(
    spyOn(db, "checkSessionUsageLimitAdmission").mockImplementation((async () => {
      await wait("session");
      if (refusals.sessionUnavailable) throw new db.SessionUsageLimitUnavailableError();
      return refusals.session
        ? {
            allowed: false,
            state: null,
            refusal: {
              code: "session_usage_limit_reached",
              basis: SESSION_USAGE_LIMIT_BASIS,
              rootSessionId: sessionId,
              limitMicros: 1,
              usedMicros: 2,
              message: "This task reached its usage limit.",
            },
          }
        : { allowed: true, state: null };
    }) as never),
    spyOn(db, "getSpendableCreditBalance").mockImplementation((async () => {
      await wait("funding");
      return { balanceMicros: refusals.funding ? 0 : 1_000_000, creditPolicyRevision: 7 };
    }) as never),
    spyOn(db, "checkWorkspaceAllowance").mockImplementation((async () => {
      await wait("allowance");
      return refusals.allowance
        ? {
            code: "allowance_exhausted",
            scope: "workspace",
            resetsAt: "2026-12-01T00:00:00.000Z",
            message: "The workspace usage allowance is exhausted.",
          }
        : null;
    }) as never),
    spyOn(db, "sumUsageQuantity").mockImplementation((async () => {
      await wait("runs");
      return refusals.runs ? 2 : 1;
    }) as never),
  );
  /** Release every gate latest-check-first, letting each settle before the next. */
  const releaseReversed = async () => {
    for (let tick = 0; tick < 50 && started.length < 4; tick++) await Promise.resolve();
    for (const check of [...CHECKS].reverse()) {
      gates[check].release();
      await ticks();
    }
  };
  return { gates, started, sessionId, releaseReversed };
}

function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

function admit(
  sessionId: string,
  entitlements?: Parameters<typeof ensureRunAllowed>[5],
): Promise<{ value: number | undefined; error: unknown }> {
  return settle(
    ensureRunAllowed(
      settings,
      database,
      crypto.randomUUID(),
      crypto.randomUUID(),
      false,
      entitlements,
      true,
      false,
      null,
      "scripted-model",
      sessionId,
    ),
  );
}

test("the admission reads start together before any of them completes", async () => {
  const run = harness({});
  try {
    const result = admit(run.sessionId);
    await ticks(50);
    expect([...run.started].sort()).toEqual(["allowance", "funding", "runs", "session"]);
    await run.releaseReversed();
    const outcome = await result;
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe(7);
  } finally {
    restore();
  }
});

test("held usage receipts are flushed before any admission read starts", async () => {
  const run = harness({});
  const flushGate = deferred();
  let flushed = false;
  restoreAfter.push(
    spyOn(custody, "flushHeldSessionUsageReceipts").mockImplementation(async () => {
      await flushGate.promise;
      flushed = true;
    }),
  );
  try {
    const result = admit(run.sessionId);
    await ticks(50);
    expect(run.started).toEqual([]);
    flushGate.release();
    await run.releaseReversed();
    expect(flushed).toBe(true);
    expect((await result).error).toBeUndefined();
  } finally {
    flushGate.release();
    restore();
  }
});

const precedence: Array<[string, Refusals, (error: unknown) => void]> = [
  [
    "task usage limit",
    { session: true, funding: true, allowance: true, runs: true },
    (error) => expect(error).toBeInstanceOf(SessionUsageLimitReachedError),
  ],
  [
    "funding",
    { funding: true, allowance: true, runs: true },
    (error) => {
      expect(error).toBeInstanceOf(TurnAdmissionRefusedError);
      expect((error as Error).message).toBe("insufficient workspace credits");
    },
  ],
  [
    "workspace allowance",
    { allowance: true, runs: true },
    (error) => expect(error).toBeInstanceOf(AllowanceExhaustedError),
  ],
  [
    "static monthly limit",
    { runs: true },
    (error) => {
      expect(error).toBeInstanceOf(TurnAdmissionRefusedError);
      expect((error as Error).message).toBe("monthly agent run limit reached (1)");
    },
  ],
];

for (const [name, refusals, expectError] of precedence) {
  test(`the ${name} refusal is reported ahead of every later check, whichever settles first`, async () => {
    const run = harness(refusals);
    try {
      const result = admit(run.sessionId);
      await run.releaseReversed();
      expectError((await result).error);
    } finally {
      restore();
    }
  });
}

test("an unreadable task limit surfaces unwrapped between calls even when the allowance refuses", async () => {
  const run = harness({ sessionUnavailable: true, allowance: true });
  try {
    const result = settle(
      ensureRunAllowedBetweenModelCalls({
        settings,
        db: database,
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        isExternallyBilledTurn: false,
        chargesOpenGeniCredits: true,
        countsTowardTokenCap: false,
        initiatingHumanSubjectId: null,
        modelId: "scripted-model",
        sessionId: run.sessionId,
      }),
    );
    await run.releaseReversed();
    expect((await result).error).toBeInstanceOf(db.SessionUsageLimitUnavailableError);
  } finally {
    restore();
  }
});

test("between calls, the reported refusal is wrapped as the same budget stop", async () => {
  const run = harness({ allowance: true, runs: true });
  try {
    const result = settle(
      ensureRunAllowedBetweenModelCalls({
        settings,
        db: database,
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        isExternallyBilledTurn: false,
        chargesOpenGeniCredits: true,
        countsTowardTokenCap: false,
        initiatingHumanSubjectId: null,
        modelId: "scripted-model",
        sessionId: run.sessionId,
        serializedRunState: () => "state",
      }),
    );
    await run.releaseReversed();
    const error = (await result).error;
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect(error).toMatchObject({
      serializedRunState: "state",
      allowance: expect.objectContaining({ code: "allowance_exhausted" }),
      sessionUsageLimit: null,
    });
  } finally {
    restore();
  }
});

test("a host entitlement deny is reported after the task limit and ahead of the allowance", async () => {
  const admitRun = async () => {
    await Promise.resolve();
    return { allowed: false, reason: "host meter says no" };
  };
  const entitlements = { admitRun } as unknown as Parameters<typeof ensureRunAllowed>[5];

  const limited = harness({ session: true, allowance: true });
  const hostCalls = spyOn(entitlements!, "admitRun");
  restoreAfter.push(hostCalls);
  try {
    const result = admit(limited.sessionId, entitlements);
    await limited.releaseReversed();
    expect((await result).error).toBeInstanceOf(SessionUsageLimitReachedError);
    // The host is consulted alongside the local reads (a read-only decision).
    expect(hostCalls).toHaveBeenCalledTimes(1);
  } finally {
    restore();
  }

  const denied = harness({ allowance: true, runs: true });
  try {
    const result = admit(denied.sessionId, entitlements);
    await denied.releaseReversed();
    const error = (await result).error;
    expect(error).toBeInstanceOf(HostEntitlementDeniedError);
    expect((error as Error).message).toBe("host meter says no");
  } finally {
    restore();
  }
});
