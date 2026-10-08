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

test("core Codex lease heartbeats renew the canonical subscription lease", async () => {
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const codex = spyOn(db, "heartbeatCodexCredentialLeaseUntil").mockResolvedValue(new Date());
  const renew = spyOn(db, "renewSubscriptionTurnLease").mockResolvedValue(new Date());
  const rls = spyOn(db, "withRlsContext").mockImplementation(
    async (_db, _context, callback) => await callback({} as TurnCredentialLeaseDeps["db"]),
  );
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
    getSessionId: () => "session-fixture",
  };
  const leases = createTurnCredentialLeases(deps);
  Object.assign(leases.codex, {
    held: true,
    holderId: "holder-fixture",
    generation: 7,
    confirmedUntilMs: 300_000,
  });
  leases.codex.useSubscriptionCoreLease("connection-fixture");
  try {
    now = 60_000;
    await leases.codex.renew("timer");
    expect(codex).not.toHaveBeenCalled();
    expect(rls).toHaveBeenCalledWith(
      deps.db,
      { accountId: deps.accountId, workspaceId: deps.workspaceId },
      expect.any(Function),
    );
    expect(renew).toHaveBeenCalledWith(expect.anything(), {
      accountId: deps.accountId,
      workspaceId: deps.workspaceId,
      sessionId: "session-fixture",
      turnId: "turn-fixture",
      provider: "codex",
      connectionId: "connection-fixture",
      holderId: "holder-fixture",
      generation: 7,
      ttlMs: db.CODEX_CREDENTIAL_LEASE_TTL_MS,
    });
    expect(leases.codex.confirmedUntilMs).toBe(360_000);
  } finally {
    leases.codex.stopHeartbeat();
    codex.mockRestore();
    renew.mockRestore();
    rls.mockRestore();
    clock.mockRestore();
  }
});

test("core Codex lease is checked at the provider-dispatch boundary", async () => {
  const core = spyOn(db, "assertSubscriptionTurnLeaseCurrent").mockResolvedValue(true);
  const rls = spyOn(db, "withRlsContext").mockImplementation(
    async (_db, _context, callback) => await callback({} as TurnCredentialLeaseDeps["db"]),
  );
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
    getSessionId: () => "session-fixture",
  };
  const leases = createTurnCredentialLeases(deps);
  Object.assign(leases.codex, {
    held: true,
    holderId: "holder-fixture",
    generation: 9,
    confirmedUntilMs: performance.now() + db.CODEX_CREDENTIAL_LEASE_TTL_MS,
  });
  leases.codex.useSubscriptionCoreLease("connection-fixture");
  try {
    await leases.codex.assertCurrentForDispatch();
    expect(core).toHaveBeenCalledWith(expect.anything(), {
      accountId: deps.accountId,
      workspaceId: deps.workspaceId,
      sessionId: "session-fixture",
      turnId: "turn-fixture",
      provider: "codex",
      connectionId: "connection-fixture",
      holderId: "holder-fixture",
      generation: 9,
    });
    core.mockResolvedValueOnce(false);
    await expect(leases.codex.assertCurrentForDispatch()).rejects.toThrow(
      "Codex credential lease is not usable for provider dispatch",
    );
    expect(leases.codex.lossReason).toBe("not_found");
  } finally {
    leases.codex.stopHeartbeat();
    core.mockRestore();
    rls.mockRestore();
  }
});

test("legacy Codex dispatch keeps its existing local lease fence", async () => {
  const core = spyOn(db, "assertSubscriptionTurnLeaseCurrent").mockResolvedValue(true);
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
  Object.assign(leases.codex, {
    held: true,
    holderId: "holder-fixture",
    generation: 3,
    confirmedUntilMs: performance.now() + db.CODEX_CREDENTIAL_LEASE_TTL_MS,
  });
  try {
    await leases.codex.assertCurrentForDispatch();
    expect(core).not.toHaveBeenCalled();
  } finally {
    leases.codex.stopHeartbeat();
    core.mockRestore();
  }
});

test("Codex lease release follows the backend that acquired it", async () => {
  const legacy = spyOn(db, "releaseCodexCredentialLease").mockResolvedValue(true);
  const core = spyOn(db, "releaseSubscriptionTurnLease").mockResolvedValue(true);
  const rls = spyOn(db, "withRlsContext").mockImplementation(
    async (_db, _context, callback) => await callback({} as TurnCredentialLeaseDeps["db"]),
  );
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
    getSessionId: () => "session-fixture",
  };
  const leases = createTurnCredentialLeases(deps);
  Object.assign(leases.codex, { holderId: "holder-fixture", generation: 4 });
  try {
    leases.codex.useSubscriptionCoreLease("connection-fixture");
    expect(await leases.codex.releaseCurrent()).toBe(true);
    expect(core).toHaveBeenCalledWith(expect.anything(), {
      accountId: deps.accountId,
      workspaceId: deps.workspaceId,
      sessionId: "session-fixture",
      turnId: "turn-fixture",
      provider: "codex",
      connectionId: "connection-fixture",
      holderId: "holder-fixture",
      generation: 4,
    });
    expect(legacy).not.toHaveBeenCalled();

    leases.codex.useLegacyCodexLease();
    expect(await leases.codex.releaseCurrent()).toBe(true);
    expect(legacy).toHaveBeenCalledWith(
      deps.db,
      deps.accountId,
      deps.workspaceId,
      "turn-fixture",
      "holder-fixture",
      4,
    );
  } finally {
    leases.codex.stopHeartbeat();
    legacy.mockRestore();
    core.mockRestore();
    rls.mockRestore();
  }
});
