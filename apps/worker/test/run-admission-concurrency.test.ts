import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { SESSION_USAGE_LIMIT_BASIS } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import {
  AllowanceExhaustedError,
  ensureRunAllowed,
  SessionUsageLimitReachedError,
  TurnAdmissionRefusedError,
} from "../src/activities/agent-turn/admission";

// The checks before each model request read concurrently, but the refusal
// reported is the one the sequential order would have produced: task usage
// limit, then funding, then workspace allowance, then static monthly limits.

const database = {} as db.Database;
const settings = testSettings({
  billingMode: "stripe",
  usageLimitsMode: "static",
  staticUsageLimitsJson: JSON.stringify({ maxMonthlyAgentRunsPerWorkspace: 1 }),
});

type Refusals = { session?: boolean; funding?: boolean; allowance?: boolean; runs?: boolean };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function admit(refusals: Refusals, gate?: Promise<void>) {
  const started: string[] = [];
  const wait = async (name: string) => {
    started.push(name);
    await gate;
  };
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const spies = [
    spyOn(db, "checkSessionUsageLimitAdmission").mockImplementation((async () => {
      await wait("session");
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
  ];
  restoreAfter.push(...spies);
  const result = ensureRunAllowed(
    settings,
    database,
    accountId,
    workspaceId,
    false,
    undefined,
    true,
    false,
    null,
    "scripted-model",
    sessionId,
  ).then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error }),
  );
  return { result, started };
}

const restoreAfter: Array<{ mockRestore(): void }> = [];
function restore() {
  for (const spy of restoreAfter.splice(0)) spy.mockRestore();
}

test("the admission reads start together before any of them completes", async () => {
  const gate = deferred();
  try {
    const { result, started } = await admit({}, gate.promise);
    for (let tick = 0; tick < 20 && started.length < 4; tick++) await Promise.resolve();
    expect([...started].sort()).toEqual(["allowance", "funding", "runs", "session"]);
    gate.release();
    const outcome = await result;
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe(7);
  } finally {
    gate.release();
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
  test(`the ${name} refusal is reported ahead of every later check`, async () => {
    try {
      const { result } = await admit(refusals);
      const outcome = await result;
      expectError(outcome.error);
    } finally {
      restore();
    }
  });
}
