import { describe, expect, spyOn, test } from "bun:test";
import { ErrorEnvelope } from "@opengeni/contracts";
import { requireLimit } from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createApp, type AppDependencies } from "../src/app";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";

describe("typed public allowance refusal", () => {
  test.each(["workspace", "member"] as const)(
    "requireLimit preserves %s refusal through the central HTTP 402 handler",
    async (scope) => {
      const settings = testSettings({ billingMode: "disabled", usageLimitsMode: "none" });
      const deps = {
        settings,
        db: {} as opengeniDb.Database,
        bus: {} as never,
        workflowClient: {} as never,
        managedAuth: null,
      } satisfies AppDependencies;
      const app = createApp(deps);
      const refusal = {
        code: "allowance_exhausted" as const,
        scope,
        resetsAt: "2026-10-01T00:00:00.000Z",
        ...(scope === "member" ? { subjectId: "user:frozen-human" } : {}),
        message: `The ${scope} usage allowance is exhausted.`,
      };
      const allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockResolvedValue(refusal);
      const codex = spyOn(opengeniDb, "isCodexBilledTurn").mockResolvedValue(false);
      app.post("/v1/test-probe/allowance", async (c) => {
        await requireLimit(deps, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          action: "agent_run:create",
          model: "scripted-model",
          quantity: 1,
          initiatingHumanSubjectId: "user:frozen-human",
        });
        return c.json({ accepted: true });
      });
      try {
        const response = await app.request("/v1/test-probe/allowance", { method: "POST" });
        expect(response.status).toBe(402);
        expect(ErrorEnvelope.parse(await response.json()).error).toMatchObject({
          status: 402,
          code: refusal.code,
          message: refusal.message,
          retryable: false,
          details: {
            scope,
            resetsAt: refusal.resetsAt,
            ...(scope === "member" ? { subjectId: "user:frozen-human" } : {}),
          },
        });
      } finally {
        allowance.mockRestore();
        codex.mockRestore();
      }
    },
  );
});
