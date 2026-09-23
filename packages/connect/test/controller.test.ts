import { describe, expect, test } from "bun:test";
import { ConnectController, type ConnectAttempt, type ConnectTransport } from "../src";

function attempt(overrides: Partial<ConnectAttempt> = {}): ConnectAttempt {
  return {
    id: "attempt",
    workspaceId: "workspace",
    providerId: "provider",
    ownership: "personal",
    revision: 1,
    state: "requires_user_action",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "integration",
    expiresAt: "2027-01-01T00:00:00Z",
    nextAction: { type: "authorize", url: "https://provider.example.com/oauth" },
    ...overrides,
  };
}
function transport(overrides: Partial<ConnectTransport> = {}): ConnectTransport {
  return {
    catalog: async () => [],
    accounts: async () => [],
    pending: async () => [],
    begin: async () => attempt(),
    get: async () => attempt(),
    advance: async () => attempt({ revision: 2 }),
    cancel: async () => attempt({ revision: 2, state: "cancelled", nextAction: { type: "none" } }),
    disconnect: async () => {},
    ...overrides,
  };
}

describe("Connect controller", () => {
  test("failed credential submissions do not retain raw transport errors in snapshots", async () => {
    const secret = "synthetic-transport-secret";
    const failure = Object.assign(
      new Error(`Provider rejected ${secret}`, { cause: { token: secret } }),
      {
        request: { headers: { authorization: secret } },
      },
    );
    const controller = new ConnectController(
      transport({
        advance: async () => {
          throw failure;
        },
      }),
      "workspace",
    );
    await controller.recover("attempt");
    const result = await controller
      .advance({ type: "credentials", values: { token: secret } }, "operation")
      .catch((error: unknown) => error);
    expect(result).toBe(failure);
    const snapshot = controller.getSnapshot();
    expect(snapshot.busy).toBe(false);
    expect(snapshot.error).not.toBe(failure);
    expect(snapshot.error?.message).not.toContain(secret);
    expect(snapshot.error?.cause).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(Object.isFrozen(snapshot.error)).toBe(true);
    controller.dispose();
  });
  test("polling publishes the next action and rejects regression from the selected revision", async () => {
    let response = attempt({ revision: 3 });
    const controller = new ConnectController(transport({ get: async () => response }), "workspace");
    await controller.recover("attempt");
    response = attempt({ revision: 2, nextAction: { type: "none" } });
    await expect(controller.waitForAction()).rejects.toThrow("revision mismatch");
    expect(controller.getSnapshot().attempt?.revision).toBe(3);
    response = attempt({
      revision: 4,
      state: "connected_but_incomplete",
      nextAction: { type: "none" },
    });
    await controller.waitForAction();
    expect(controller.getSnapshot().attempt?.revision).toBe(4);
    expect(controller.getSnapshot().busy).toBe(false);
  });

  test("disposal settles polling even if the transport ignores cancellation", async () => {
    let pending = false;
    const controller = new ConnectController(
      transport({ get: () => (pending ? new Promise(() => {}) : Promise.resolve(attempt())) }),
      "workspace",
    );
    await controller.recover("attempt");
    pending = true;
    const result = controller.waitForAction();
    controller.dispose();
    await expect(result).rejects.toThrow();
  });

  test("passes the exact return URL without changing query or fragment", async () => {
    const returnUrl = "https://host.example.com/a?opaque=%2f%2B&x=1&x=2#tab/%3f";
    let received = "";
    const controller = new ConnectController(
      transport({
        begin: async (_workspace, input) => {
          received = input.returnUrl;
          return attempt();
        },
      }),
      "workspace",
    );
    await controller.begin({
      providerId: "provider",
      ownership: "personal",
      returnUrl,
      idempotencyKey: "begin",
    });
    expect(received).toBe(returnUrl);
    expect(controller.getSnapshot().attempt?.state).toBe("requires_user_action");
  });

  test("distinguishes connected credentials from installed integration", async () => {
    const controller = new ConnectController(
      transport({
        get: async () =>
          attempt({
            state: "connected_but_incomplete",
            credentialsCommitted: true,
            integrationInstalled: false,
            nextAction: {
              type: "preview",
              previewId: "preview",
              contentHash: "digest",
              operations: [],
            },
          }),
      }),
      "workspace",
    );
    await controller.recover("attempt");
    expect(controller.getSnapshot().attempt?.credentialsCommitted).toBe(true);
    expect(controller.getSnapshot().attempt?.integrationInstalled).toBe(false);
  });

  test("rejects wrong workspace, wrong attempt and stale revision without replacing valid state", async () => {
    let response = attempt();
    const controller = new ConnectController(transport({ get: async () => response }), "workspace");
    await controller.recover("attempt");
    response = attempt({ workspaceId: "other" });
    await expect(controller.refresh()).rejects.toThrow("scope mismatch");
    response = attempt({ id: "other" });
    await expect(controller.refresh()).rejects.toThrow("scope mismatch");
    response = attempt({ revision: 0 });
    await expect(controller.refresh()).rejects.toThrow("revision is stale");
    expect(controller.getSnapshot().attempt?.id).toBe("attempt");
    expect(controller.getSnapshot().attempt?.revision).toBe(1);
    expect(controller.getSnapshot().busy).toBe(false);
  });

  test("does not allow a late response to replace a newly selected attempt", async () => {
    let resolveFirst!: (value: ConnectAttempt) => void;
    const firstResponse = new Promise<ConnectAttempt>((resolve) => {
      resolveFirst = resolve;
    });
    const controller = new ConnectController(
      transport({
        get: async (_workspace, id) => (id === "first" ? await firstResponse : attempt({ id })),
      }),
      "workspace",
    );
    const first = controller.recover("first").catch((error: unknown) => error);
    await controller.recover("second");
    resolveFirst(attempt({ id: "first" }));
    expect(await first).toBeInstanceOf(Error);
    expect(String(await first)).toContain("superseded");
    expect(controller.getSnapshot().attempt?.id).toBe("second");
  });

  test("sends revision and idempotency fences without retaining credential form values", async () => {
    let submitted: unknown;
    const controller = new ConnectController(
      transport({
        advance: async (_workspace, _id, input) => {
          submitted = input;
          return attempt({ revision: 2 });
        },
      }),
      "workspace",
    );
    await controller.recover("attempt");
    await controller.advance(
      { type: "credentials", values: { token: "synthetic-secret" } },
      "same-key",
    );
    expect(submitted).toEqual({
      expectedRevision: 1,
      idempotencyKey: "same-key",
      action: { type: "credentials", values: { token: "synthetic-secret" } },
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("synthetic-secret");
    expect(Object.isFrozen(controller.getSnapshot().attempt?.nextAction)).toBe(true);
  });

  test("dispose aborts in-flight transport and stops notifications", async () => {
    let signal: AbortSignal | undefined;
    let resolve!: (value: ConnectAttempt) => void;
    const response = new Promise<ConnectAttempt>((done) => {
      resolve = done;
    });
    const controller = new ConnectController(
      transport({
        get: async (_workspace, _id, options) => {
          signal = options?.signal;
          return await response;
        },
      }),
      "workspace",
    );
    let updates = 0;
    controller.subscribe(() => {
      updates++;
    });
    const operation = controller.recover("attempt").catch((error: unknown) => error);
    controller.dispose();
    expect(signal?.aborted).toBe(true);
    resolve(attempt());
    expect(await operation).toBeInstanceOf(Error);
    expect(String(await operation)).toContain("superseded");
    expect(updates).toBe(1);
    expect(() => controller.refresh()).toThrow("disposed");
  });
});
