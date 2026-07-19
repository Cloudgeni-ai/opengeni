import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const fakeDb = {};
let activeGrants = 0;
const usageByEvent = new Map<string, number>();

// Bun module mocks are process-global. Override only the sentinel DB used by
// this file and delegate every unrelated caller to the real implementation so
// the full test process keeps its actual database behavior.
const realDb = await import("@opengeni/db");
const realDbFns = {
  countActiveTranscriptionGrantsForWorkspace: realDb.countActiveTranscriptionGrantsForWorkspace,
  isCodexBilledTurn: realDb.isCodexBilledTurn,
  sumUsageQuantity: realDb.sumUsageQuantity,
};
mock.module("@opengeni/db", () => ({
  ...realDb,
  countActiveTranscriptionGrantsForWorkspace: mock(async (db: unknown, workspaceId: string) =>
    db === fakeDb
      ? activeGrants
      : await realDbFns.countActiveTranscriptionGrantsForWorkspace(db as never, workspaceId),
  ),
  isCodexBilledTurn: mock(async (input: Parameters<typeof realDb.isCodexBilledTurn>[0]) =>
    input.db === (fakeDb as never) ? false : await realDbFns.isCodexBilledTurn(input),
  ),
  sumUsageQuantity: mock(
    async (db: unknown, input: Parameters<typeof realDb.sumUsageQuantity>[1]) =>
      db === fakeDb
        ? (usageByEvent.get(input.eventType) ?? 0)
        : await realDbFns.sumUsageQuantity(db as never, input),
  ),
}));

const { checkLimit } = await import("../src/billing/limits");

function deps(limits: Record<string, number>) {
  return {
    db: fakeDb,
    settings: {
      billingMode: "disabled",
      usageLimitsMode: "static",
      staticUsageLimitsJson: JSON.stringify(limits),
    },
  } as never;
}

const scopedInput = {
  accountId: "account",
  workspaceId: "workspace",
  subjectId: "user:test",
  action: "transcription:issue" as const,
  quantity: 10,
  costMicros: 10,
};

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  activeGrants = 0;
  usageByEvent.clear();
});

describe("canonical transcription limits", () => {
  test("requires both workspace and subject scope", async () => {
    await expect(
      checkLimit(deps({ maxActiveTranscriptionGrantsPerWorkspace: 1 }), {
        ...scopedInput,
        workspaceId: undefined,
      }),
    ).resolves.toMatchObject({ allowed: false, code: "transcription_scope_required" });
    await expect(
      checkLimit(deps({ maxActiveTranscriptionGrantsPerWorkspace: 1 }), {
        ...scopedInput,
        subjectId: undefined,
      }),
    ).resolves.toMatchObject({ allowed: false, code: "transcription_scope_required" });
  });

  test("includes conservative transcription reservations in the total account cost cap", async () => {
    usageByEvent.set("model.cost", 60);
    usageByEvent.set("transcription.reserved_cost", 30);
    await expect(
      checkLimit(deps({ maxMonthlyCostMicrosPerAccount: 100 }), {
        ...scopedInput,
        costMicros: 11,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      code: "max_monthly_cost_micros_per_account",
    });
  });

  test("routes every static transcription cap through canonical admission", async () => {
    const limits = {
      maxActiveTranscriptionGrantsPerWorkspace: 2,
      maxTranscriptionIssuancesPerMinutePerSubject: 3,
      maxMonthlyTranscriptionSecondsPerWorkspace: 100,
      maxMonthlyTranscriptionCostMicrosPerAccount: 100,
    };

    activeGrants = 2;
    await expect(checkLimit(deps(limits), scopedInput)).resolves.toMatchObject({
      allowed: false,
      code: "max_active_transcription_grants_per_workspace",
    });

    activeGrants = 0;
    usageByEvent.set("transcription.grant_reserved", 3);
    await expect(checkLimit(deps(limits), scopedInput)).resolves.toMatchObject({
      allowed: false,
      code: "max_transcription_issuances_per_minute_per_subject",
    });

    usageByEvent.set("transcription.grant_reserved", 0);
    usageByEvent.set("transcription.reserved_seconds", 91);
    await expect(checkLimit(deps(limits), scopedInput)).resolves.toMatchObject({
      allowed: false,
      code: "max_monthly_transcription_seconds_per_workspace",
    });

    usageByEvent.set("transcription.reserved_seconds", 0);
    usageByEvent.set("transcription.reserved_cost", 91);
    await expect(checkLimit(deps(limits), scopedInput)).resolves.toMatchObject({
      allowed: false,
      code: "max_monthly_transcription_cost_micros_per_account",
    });
  });
});
