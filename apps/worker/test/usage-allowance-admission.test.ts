import { describe, expect, spyOn, test } from "bun:test";
import * as database from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  AllowanceExhaustedError,
  BudgetExhaustedError,
  ensureRunAllowed,
} from "../src/activities/agent-turn/admission";

const db = {} as Database;
const accountId = "allowance-account";
const workspaceId = "allowance-workspace";
const subjectId = "allowance-human";
const settings = testSettings({ billingMode: "none", usageLimitsMode: "none" });

describe("worker allowance admission", () => {
  test("checks the initiating human, independently of the organization balance mode", async () => {
    const check = spyOn(database, "checkWorkspaceAllowance").mockResolvedValue(null);
    try {
      await ensureRunAllowed(
        settings,
        db,
        accountId,
        workspaceId,
        false,
        undefined,
        true,
        false,
        subjectId,
      );
      expect(check).toHaveBeenCalledWith(db, { accountId, workspaceId, subjectId });
    } finally {
      check.mockRestore();
    }
  });

  for (const scope of ["workspace", "member"] as const) {
    test(`${scope} exhaustion carries typed scope and reset information`, async () => {
      const refusal = {
        code: "allowance_exhausted" as const,
        scope,
        resetsAt: "2026-10-01T00:00:00.000Z",
        ...(scope === "member" ? { subjectId } : {}),
        message: `${scope} allowance exhausted`,
      };
      const check = spyOn(database, "checkWorkspaceAllowance").mockResolvedValue(refusal);
      try {
        let caught: unknown;
        try {
          await ensureRunAllowed(
            settings,
            db,
            accountId,
            workspaceId,
            false,
            undefined,
            true,
            false,
            subjectId,
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(AllowanceExhaustedError);
        expect((caught as AllowanceExhaustedError).refusal).toEqual(refusal);
        // The post-response valve retains the exact refusal alongside the
        // existing recoverable budget stop and serialized conversation state.
        const stop = new BudgetExhaustedError(refusal.message, "checkpoint", refusal);
        expect(stop.allowance).toEqual(refusal);
        expect(stop.serializedRunState).toBe("checkpoint");
      } finally {
        check.mockRestore();
      }
    });
  }

  test("service work checks the workspace without borrowing a human", async () => {
    const check = spyOn(database, "checkWorkspaceAllowance").mockResolvedValue(null);
    try {
      await ensureRunAllowed(settings, db, accountId, workspaceId, false);
      expect(check).toHaveBeenCalledWith(db, { accountId, workspaceId, subjectId: null });
    } finally {
      check.mockRestore();
    }
  });

  test("externally funded and free calls never read allowance counters", async () => {
    const check = spyOn(database, "checkWorkspaceAllowance").mockImplementation(async () => {
      throw new Error("must not read allowance for externally funded calls");
    });
    try {
      await ensureRunAllowed(settings, db, accountId, workspaceId, true);
      await ensureRunAllowed(
        settings,
        db,
        accountId,
        workspaceId,
        false,
        undefined,
        false,
        false,
        subjectId,
      );
      expect(check).not.toHaveBeenCalled();
    } finally {
      check.mockRestore();
    }
  });
});
