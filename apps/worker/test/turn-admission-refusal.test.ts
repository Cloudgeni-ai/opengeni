import { describe, expect, spyOn, test } from "bun:test";
import { ActivityFailure, ApplicationFailure } from "@temporalio/workflow";
import {
  API_CREDITS_REQUIRED_MESSAGE,
  SUBSCRIPTION_API_UNAVAILABLE_MESSAGE,
} from "@opengeni/contracts";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { useNoSessionUsageLimitForFakeDatabases } from "@opengeni/testing/session-usage-limits";
import {
  BudgetExhaustedError,
  ensureRunAllowed,
  ensureRunAllowedBetweenModelCalls,
  TurnAdmissionRefusedError,
} from "../src/activities/agent-turn";
import { workflowFailureMessage } from "../src/workflows/activities";

useNoSessionUsageLimitForFakeDatabases();

const ACCOUNT = "acct-1";
const WORKSPACE = "ws-1";
const db = {} as Database;

function billedSettings() {
  return testSettings({ billingMode: "stripe", usageLimitsMode: "managed" });
}

function zeroBalance() {
  return spyOn(opengeniDb, "getSpendableCreditBalance").mockResolvedValue({
    accountId: ACCOUNT,
    balanceMicros: 0,
    currency: "usd",
    updatedAt: new Date().toISOString(),
  });
}

// The same conversion the Temporal SDK applies to a thrown non-Temporal error
// (`ensureApplicationFailure` in @temporalio/common, not exported by the
// worker's direct Temporal dependencies): the class name becomes the type.
function asRunAgentTurnFailure(error: Error): ActivityFailure {
  return new ActivityFailure(
    "Activity task failed",
    "runAgentTurn",
    "activity-1",
    "MAXIMUM_ATTEMPTS_REACHED",
    "worker-1",
    ApplicationFailure.create({
      message: error.message,
      type: error.constructor.name,
      nonRetryable: false,
    }),
  );
}

async function refusal(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("expected the turn to be refused");
}

describe("fixed turn admission refusals", () => {
  test("API work on a connected subscription throws the named refusal", async () => {
    const error = await refusal(
      ensureRunAllowed(
        testSettings({ apiConnectedSubscriptionsEnabled: false }),
        db,
        ACCOUNT,
        WORKSPACE,
        true,
        undefined,
        false,
        false,
        null,
        undefined,
        undefined,
        "api",
        false,
        true,
      ),
    );
    expect(error).toBeInstanceOf(TurnAdmissionRefusedError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("TurnAdmissionRefusedError");
    expect((error as Error).message).toBe(SUBSCRIPTION_API_UNAVAILABLE_MESSAGE);
  });

  test("empty credits throw the named refusal for app and API work", async () => {
    const balance = zeroBalance();
    try {
      const app = await refusal(ensureRunAllowed(billedSettings(), db, ACCOUNT, WORKSPACE, false));
      expect(app).toBeInstanceOf(TurnAdmissionRefusedError);
      expect((app as Error).message).toBe("insufficient workspace credits");
      const api = await refusal(
        ensureRunAllowed(
          billedSettings(),
          db,
          ACCOUNT,
          WORKSPACE,
          false,
          undefined,
          true,
          true,
          null,
          undefined,
          undefined,
          "api",
        ),
      );
      expect(api).toBeInstanceOf(TurnAdmissionRefusedError);
      expect((api as Error).message).toBe(API_CREDITS_REQUIRED_MESSAGE);
    } finally {
      balance.mockRestore();
    }
  });

  test("a reached monthly token limit throws the named refusal", async () => {
    const allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockResolvedValue(null);
    const usage = spyOn(opengeniDb, "sumUsageQuantity").mockResolvedValue(100);
    try {
      const error = await refusal(
        ensureRunAllowed(
          testSettings({
            usageLimitsMode: "static",
            staticUsageLimitsJson: JSON.stringify({ maxMonthlyTokensPerWorkspace: 100 }),
          }),
          db,
          ACCOUNT,
          WORKSPACE,
          false,
          undefined,
          false,
          true,
        ),
      );
      expect(error).toBeInstanceOf(TurnAdmissionRefusedError);
      expect((error as Error).message).toBe("monthly token limit reached (100)");
    } finally {
      usage.mockRestore();
      allowance.mockRestore();
    }
  });

  test("a host entitlements deny keeps its free-text reason behind the generic failure", async () => {
    const error = await refusal(
      ensureRunAllowed(billedSettings(), db, ACCOUNT, WORKSPACE, false, {
        admitRun: async () => ({ allowed: false, reason: "host ledger detail" }),
      } as never),
    );
    expect(error).not.toBeInstanceOf(TurnAdmissionRefusedError);
    expect((error as Error).name).toBe("Error");
    expect(workflowFailureMessage(asRunAgentTurnFailure(error as Error))).toBe(
      "Activity task failed",
    );
  });

  test("between model calls the refusal still becomes a budget stop", async () => {
    const balance = zeroBalance();
    try {
      const error = await refusal(
        ensureRunAllowedBetweenModelCalls({
          settings: billedSettings(),
          db,
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          isExternallyBilledTurn: false,
          chargesOpenGeniCredits: true,
          countsTowardTokenCap: true,
          initiatingHumanSubjectId: null,
          serializedRunState: () => "state",
        }),
      );
      expect(error).toBeInstanceOf(BudgetExhaustedError);
      expect((error as BudgetExhaustedError).message).toBe("insufficient workspace credits");
      expect((error as BudgetExhaustedError).serializedRunState).toBe("state");
      expect((error as BudgetExhaustedError).allowance).toBeNull();
    } finally {
      balance.mockRestore();
    }
  });

  test("turn.failed shows the refusal message instead of the generic activity failure", () => {
    for (const message of [
      SUBSCRIPTION_API_UNAVAILABLE_MESSAGE,
      API_CREDITS_REQUIRED_MESSAGE,
      "insufficient workspace credits",
      "monthly token limit reached (100)",
    ]) {
      expect(
        workflowFailureMessage(asRunAgentTurnFailure(new TurnAdmissionRefusedError(message))),
      ).toBe(message);
    }
    // Any other plain error stays behind the generic Temporal message.
    expect(workflowFailureMessage(asRunAgentTurnFailure(new Error("private detail")))).toBe(
      "Activity task failed",
    );
  });
});
