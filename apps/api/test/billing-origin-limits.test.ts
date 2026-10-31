import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import type { Settings } from "@opengeni/config";
import { ADD_CREDITS_ACTION, type BillingOrigin } from "@opengeni/contracts";
import { checkLimit, requireLimit, type ApiRouteDeps } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";
import { insufficientCreditsHttpError } from "../src/http/api-error";

const ACCOUNT = "acct-1";
const WORKSPACE = "ws-1";

function deps(): ApiRouteDeps {
  const settings: Settings = testSettings({ billingMode: "stripe", usageLimitsMode: "managed" });
  return { settings, db: {} as opengeniDb.Database } as ApiRouteDeps;
}

// An account with $50 of plan credit and no credits: app work may run, API
// work may not. The PostgreSQL suite proves the balance projection itself.
let balance: ReturnType<typeof spyOn<typeof opengeniDb, "getSpendableCreditBalance">>;
let allowance: ReturnType<typeof spyOn<typeof opengeniDb, "checkWorkspaceAllowance">>;
beforeEach(() => {
  balance = spyOn(opengeniDb, "getSpendableCreditBalance").mockImplementation(
    async (_db, accountId, _usage, _revision, _at, origin?: BillingOrigin | null) => ({
      accountId,
      balanceMicros: (origin ?? opengeniDb.chargeBillingOrigin()) === "api" ? 0 : 50_000_000,
      currency: "usd",
      updatedAt: new Date().toISOString(),
    }),
  );
  allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockResolvedValue(null);
});
afterEach(() => {
  balance.mockRestore();
  allowance.mockRestore();
});

const run = (billingOrigin?: BillingOrigin) => ({
  accountId: ACCOUNT,
  workspaceId: WORKSPACE,
  action: "agent_run:create" as const,
  quantity: 1,
  ...(billingOrigin ? { billingOrigin } : {}),
});

describe("credit admission by funding origin", () => {
  test("app work spends plan credit", async () => {
    expect((await checkLimit(deps(), run("app"))).allowed).toBe(true);
    expect((await checkLimit(deps(), run())).allowed).toBe(true);
  });

  test("API work is refused without credits, with a 402 that offers Add credits", async () => {
    expect(await checkLimit(deps(), run("api"))).toEqual({
      allowed: false,
      code: "api_credits_required",
      message: "API usage uses credits, not your plan credit.",
    });
    let failure: unknown;
    try {
      await requireLimit(deps(), run("api"));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HTTPException);
    expect((failure as HTTPException).status).toBe(402);
    const mapped = insufficientCreditsHttpError(failure);
    expect(mapped?.status).toBe(402);
    expect(mapped?.message).toBe("API usage uses credits, not your plan credit.");
    expect(mapped?.details).toEqual({ code: "api_credits_required", action: ADD_CREDITS_ACTION });
  });

  test("an API request scope decides when the caller names no origin", async () => {
    const decision = await opengeniDb.withBillingOriginOverride("api", () =>
      checkLimit(deps(), run()),
    );
    expect(decision).toMatchObject({ allowed: false, code: "api_credits_required" });
  });
});
