import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { codexRequestStorage, codexSubscriptionFetch } from "@opengeni/codex";
import {
  createTurnCredentialLeases,
  type TurnCredentialLeaseDeps,
} from "../src/activities/agent-turn/credential-leases";
import { recordCompletedModelCallBeforeOwnershipFences } from "../src/activities/agent-turn/model-usage";

test.each(["codex", "xai", "claude"] as const)(
  "%s checkpoint lifecycle coalesces events while preserving scoped renewal and usage truth",
  async (provider) => {
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const codex = spyOn(db, "heartbeatCodexCredentialLeaseUntil").mockResolvedValue(new Date());
    const xai = spyOn(db, "heartbeatXaiCredentialLeaseUntil").mockResolvedValue(new Date());
    const claude = spyOn(db, "heartbeatClaudeCredentialLeaseUntil").mockResolvedValue(new Date());
    const heartbeats = { codex, xai, claude };
    const deps = {
      db: {} as TurnCredentialLeaseDeps["db"],
      observability: {
        incrementCounter() {},
        warn() {},
      } as unknown as TurnCredentialLeaseDeps["observability"],
      accountId: "account-fixture",
      workspaceId: "workspace-fixture",
      codexWorkspaceKey: "fixture",
      getTurnId: () => "turn-fixture",
    };
    const leases = createTurnCredentialLeases(deps);
    const lease = leases[provider];
    Object.assign(lease, {
      held: true,
      subjectId: "subject-fixture",
      holderId: "holder-fixture",
      generation: 2,
      confirmedUntilMs: 300_000,
    });
    let usage = 0;
    let signals = 0;
    const completedCall = () =>
      recordCompletedModelCallBeforeOwnershipFences({
        renewLease: () => leases.renewServing("model_usage"),
        recordUsage: async () => {
          usage++;
        },
        leaseLost: leases.servingLost,
        leaseLostMessage: "fixture lease lost",
        recordAttemptSignals: async () => {
          signals++;
        },
      });
    let providerCalls = 0;
    const dispatchCodex = () =>
      codexRequestStorage.run(
        {
          clientVersion: "test",
          getToken: async () => ({
            accessToken: "fixture",
            chatgptAccountId: "fixture",
            isFedramp: false,
          }),
          refresh: async () => ({
            accessToken: "fixture",
            chatgptAccountId: "fixture",
            isFedramp: false,
          }),
          resolveModel: (model) => model,
          beforeProviderDispatch: lease.assertUsable,
        },
        () =>
          codexSubscriptionFetch(async () => {
            providerCalls++;
            return new Response(
              'data: {"type":"response.completed","response":{"id":"fixture-response","status":"completed","output":[]}}\n\n',
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          })("https://chatgpt.com/backend-api/responses", {
            method: "POST",
            body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
          }),
      );
    try {
      // Mirror the runtime checkpoint and completed-response consumer seams.
      for (let event = 0; event < 100; event++) {
        await leases.renewServing("runtime_event");
        expect(leases.servingLost()).toBe(false);
        await completedCall();
        lease.assertUsable();
      }
      expect(codex).not.toHaveBeenCalled();
      expect(xai).not.toHaveBeenCalled();
      expect(claude).not.toHaveBeenCalled();
      expect(lease.confirmedUntilMs).toBe(300_000);
      if (provider === "codex") {
        expect((await dispatchCodex()).status).toBe(200);
        expect(providerCalls).toBe(1);
      }
      now = 60_000;
      await completedCall();
      expect(heartbeats[provider]).toHaveBeenCalledTimes(1);
      if (provider === "codex") {
        expect(codex.mock.calls[0]).toEqual([
          deps.db,
          deps.accountId,
          deps.workspaceId,
          "turn-fixture",
          "holder-fixture",
          2,
          db.CODEX_CREDENTIAL_LEASE_TTL_MS,
        ]);
      } else {
        expect(heartbeats[provider].mock.calls[0]).toEqual([
          deps.db,
          {
            workspaceId: deps.workspaceId,
            subjectId: "subject-fixture",
            turnId: "turn-fixture",
            holderId: "holder-fixture",
            generation: 2,
            leaseTtlMs:
              provider === "xai"
                ? db.XAI_CREDENTIAL_LEASE_TTL_MS
                : db.CLAUDE_CREDENTIAL_LEASE_TTL_MS,
          },
        ]);
      }
      expect(lease.confirmedUntilMs).toBe(360_000);
      await leases.renewServing("runtime_event");
      expect(heartbeats[provider]).toHaveBeenCalledTimes(1);
      now = 120_000;
      heartbeats[provider].mockResolvedValue(null);
      await expect(completedCall()).rejects.toThrow("fixture lease lost");
      expect(usage).toBe(102);
      expect(signals).toBe(101);
      expect(leases.servingLost()).toBe(true);
      expect(lease.lossReason).toBe("not_found");
      expect(() => lease.assertUsable()).toThrow(
        "credential lease is not usable for provider dispatch",
      );
      expect(lease.confirmedUntilMs).toBe(360_000);
      if (provider === "codex") {
        await expect(dispatchCodex()).rejects.toThrow(
          "Codex credential lease is not usable for provider dispatch",
        );
        expect(providerCalls).toBe(1);
      }
    } finally {
      leases.codex.stopHeartbeat();
      leases.xai.stopHeartbeat();
      leases.claude.stopHeartbeat();
      codex.mockRestore();
      xai.mockRestore();
      claude.mockRestore();
      clock.mockRestore();
    }
  },
);
