import { describe, expect, test } from "bun:test";
import { act, useEffect } from "react";
import type {
  BrowserAccountsClientLike,
  ManagedAuthSessionSetProjection,
} from "@opengeni/sdk/accounts";
import {
  BrowserAccountsProvider,
  useBrowserAccounts,
  useOptionalBrowserAccountTransitionBlocker,
  type BrowserAccountsContextValue,
  type BrowserAccountTransition,
} from "../src/accounts";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const SLOT_A = "00000000-0000-4000-8000-000000000001";
const SLOT_B = "00000000-0000-4000-8000-000000000002";

function projection(
  input: {
    generation?: string;
    actorEpoch?: string;
    selectedSlotId?: string | null;
    slotIds?: string[];
    state?: ManagedAuthSessionSetProjection["state"];
  } = {},
): ManagedAuthSessionSetProjection {
  const slotIds = input.slotIds ?? [SLOT_A, SLOT_B];
  return {
    mode: "dual",
    generation: input.generation ?? "1",
    actorEpoch: input.actorEpoch ?? "1",
    csrfToken: "c".repeat(43),
    selectedSlotId: input.selectedSlotId === undefined ? SLOT_A : input.selectedSlotId,
    state: input.state ?? "ready",
    slots: slotIds.map((id, index) => ({
      id,
      displayName: `Person ${index + 1}`,
      verifiedClaim: { kind: "email", value: `person-${index + 1}@example.test` },
      state: "active",
    })),
  };
}

function scriptedClient(
  overrides: Partial<BrowserAccountsClientLike> = {},
): BrowserAccountsClientLike {
  const initial = projection();
  return {
    getSessionSet: async () => initial,
    bootstrapSessionSet: async () => initial,
    beginLoginTransaction: async (request) => ({
      id: request.operationId,
      kind: request.kind,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      returnIntentId: null,
    }),
    completeEmailPasswordTransaction: async () => ({ projection: initial, returnIntent: null }),
    cancelLoginTransaction: async () => initial,
    selectLoginSlot: async () => initial,
    logoutLoginSlot: async () => initial,
    logoutSessionSet: async () => ({ generation: "2", actorEpoch: "2", state: "logged_out" }),
    resolveDeepLink: async () => ({ kind: "unavailable" }),
    ...overrides,
  };
}

async function renderAccounts(
  client: BrowserAccountsClientLike,
  onActorTransition: (transition: BrowserAccountTransition) => Promise<void> = async () =>
    undefined,
  broadcastChannelName: string | null = null,
  bootstrapLegacySession = false,
) {
  let current: BrowserAccountsContextValue | null = null;
  function Probe() {
    const accounts = useBrowserAccounts();
    useEffect(() => {
      current = accounts;
    });
    return null;
  }
  const rendered = await renderComponent(
    <BrowserAccountsProvider
      client={client}
      onActorTransition={onActorTransition}
      broadcastChannelName={broadcastChannelName}
      bootstrapLegacySession={bootstrapLegacySession}
    >
      <Probe />
    </BrowserAccountsProvider>,
  );
  await flush();
  return {
    get current() {
      if (!current) throw new Error("accounts probe did not render");
      return current;
    },
    unmount: rendered.unmount,
  };
}

describe("BrowserAccountsProvider", () => {
  test("lets legacy hosts render optional blockers without an accounts provider", async () => {
    function LegacyProbe() {
      useOptionalBrowserAccountTransitionBlocker("legacy-draft", () => ({
        id: "legacy-draft",
        label: "Legacy draft",
      }));
      return null;
    }
    const rendered = await renderComponent(<LegacyProbe />);
    await rendered.unmount();
  });

  test("adopts the ambient legacy session once during dual-mode initialization", async () => {
    const empty = projection({ selectedSlotId: null, slotIds: [] });
    const adopted = projection();
    const bootstrapRequests: Array<{ operationId: string; expectedGeneration: string }> = [];
    let current = empty;
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => current,
        bootstrapSessionSet: async (request) => {
          bootstrapRequests.push(request);
          current = adopted;
          return adopted;
        },
      }),
      async () => undefined,
      null,
      true,
    );

    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection?.selectedSlotId).toBe(SLOT_A);
    expect(bootstrapRequests).toHaveLength(1);
    expect(bootstrapRequests[0]?.expectedGeneration).toBe("1");
    await accounts.unmount();
  });

  test("confirms the actor twice before exposing the initial ready state", async () => {
    const calls: string[] = [];
    const client = scriptedClient({
      getSessionSet: async () => {
        calls.push("session-set");
        return projection();
      },
    });
    const accounts = await renderAccounts(client, async () => {
      calls.push("transition");
    });

    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection?.selectedSlotId).toBe(SLOT_A);
    expect(calls).toEqual(["session-set", "transition", "session-set"]);
    await accounts.unmount();
  });

  test("holds a stable switch operation behind real blockers and clears only after settlement", async () => {
    let blocked = true;
    const operationIds: string[] = [];
    let selected = projection();
    const transitions: BrowserAccountTransition[] = [];
    const client = scriptedClient({
      getSessionSet: async () => selected,
      selectLoginSlot: async (request) => {
        operationIds.push(request.operationId);
        selected = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_B });
        return selected;
      },
    });
    const accounts = await renderAccounts(client, async (transition) => {
      transitions.push(transition);
    });
    const unregister = accounts.current.registerTransitionBlocker("composer", () =>
      blocked ? { id: "ignored", label: "Unsent composer draft" } : null,
    );

    expect(await actRun(() => accounts.current.selectSlot(SLOT_B))).toBe(false);
    expect(accounts.current.phase).toBe("blocked");
    expect(accounts.current.blockers.map((item) => item.id)).toEqual(["composer"]);
    expect(operationIds).toEqual([]);

    blocked = false;
    expect(await actRun(() => accounts.current.continueTransition())).toBe(true);
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection?.actorEpoch).toBe("2");
    expect(operationIds).toHaveLength(1);
    expect(transitions.at(-1)?.kind).toBe("select");
    unregister();
    await accounts.unmount();
  });

  test("does not clear tenant state when an unselected slot is removed", async () => {
    let selected = projection();
    let transitionCount = 0;
    const client = scriptedClient({
      getSessionSet: async () => selected,
      logoutLoginSlot: async () => {
        selected = projection({ generation: "2", slotIds: [SLOT_A] });
        return selected;
      },
    });
    const accounts = await renderAccounts(client, async () => {
      transitionCount += 1;
    });
    const initialTransitions = transitionCount;

    expect(await actRun(() => accounts.current.logoutSlot(SLOT_B, null))).toBe(true);
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection?.slots.map((slot) => slot.id)).toEqual([SLOT_A]);
    expect(transitionCount).toBe(initialTransitions);
    await accounts.unmount();
  });

  test("reconciles popup add completion without switching the selected account", async () => {
    let current = projection({ slotIds: [SLOT_A] });
    let transitionCount = 0;
    const client = scriptedClient({
      getSessionSet: async () => current,
      beginLoginTransaction: async (request) => ({
        id: request.operationId,
        kind: request.kind,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        returnIntentId: null,
      }),
    });
    const accounts = await renderAccounts(client, async () => {
      transitionCount += 1;
    });
    const initialTransitions = transitionCount;
    const transaction = await actRun(() => accounts.current.beginAdd());
    current = projection({ generation: "2" });

    expect(
      await actRun(() => accounts.current.settleExternalLoginTransaction(transaction.id)),
    ).toBe(true);
    expect(accounts.current.transaction).toBeNull();
    expect(accounts.current.projection?.slots).toHaveLength(2);
    expect(accounts.current.projection?.selectedSlotId).toBe(SLOT_A);
    expect(transitionCount).toBe(initialTransitions);
    await accounts.unmount();
  });

  test("ignores a delayed lower actor epoch instead of transitioning backwards", async () => {
    const current = projection({ generation: "3", actorEpoch: "3", selectedSlotId: SLOT_B });
    const stale = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_A });
    const reads = [current, current, stale];
    let transitions = 0;
    const accounts = await renderAccounts(
      scriptedClient({ getSessionSet: async () => reads.shift() ?? stale }),
      async () => {
        transitions += 1;
      },
    );
    const initialTransitions = transitions;

    await actRun(() => accounts.current.refresh());
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection?.actorEpoch).toBe("3");
    expect(accounts.current.projection?.selectedSlotId).toBe(SLOT_B);
    expect(transitions).toBe(initialTransitions);
    await accounts.unmount();
  });

  test("replays an outcome-unknown switch with the exact original request", async () => {
    let selected = projection();
    let attempts = 0;
    const requests: Array<{ operationId: string; expectedGeneration: string }> = [];
    const client = scriptedClient({
      getSessionSet: async () => selected,
      selectLoginSlot: async (request) => {
        attempts += 1;
        requests.push({
          operationId: request.operationId,
          expectedGeneration: request.expectedGeneration,
        });
        if (attempts === 1) {
          selected = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_B });
          throw Object.assign(new Error("unknown"), { code: "operation_outcome_unknown" });
        }
        return selected;
      },
    });
    const accounts = await renderAccounts(client);

    await expect(actRun(() => accounts.current.selectSlot(SLOT_B))).rejects.toThrow("unknown");
    await flush();
    expect(accounts.current.phase).toBe("recoverable_error");
    expect(accounts.current.hasPendingTransition).toBe(true);
    expect(await actRun(() => accounts.current.continueTransition())).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]?.expectedGeneration).toBe("1");
    expect(accounts.current.hasPendingTransition).toBe(false);
    await accounts.unmount();
  });

  test("settles logout-all from the fresh authoritative empty session set", async () => {
    const before = projection();
    const empty = projection({ selectedSlotId: null, slotIds: [] });
    let current = before;
    const requests: Array<{ operationId: string; expectedGeneration: string }> = [];
    const transitions: BrowserAccountTransition[] = [];
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => current,
        logoutSessionSet: async (request) => {
          requests.push(request);
          current = empty;
          return { generation: "2", actorEpoch: "2", state: "logged_out" };
        },
      }),
      async (transition) => {
        transitions.push(transition);
      },
    );

    expect(await actRun(() => accounts.current.logoutAll())).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.expectedGeneration).toBe("1");
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection).toMatchObject({
      selectedSlotId: null,
      slots: [],
      state: "ready",
    });
    expect(accounts.current.projection?.csrfToken).toHaveLength(43);
    expect(transitions.at(-1)?.kind).toBe("logout_all");
    expect(transitions.at(-1)?.to?.slots).toEqual([]);
    await accounts.unmount();
  });

  test("replays response-lost logout-all with its original generation", async () => {
    const before = projection();
    const empty = projection({ selectedSlotId: null, slotIds: [] });
    let current = before;
    let attempts = 0;
    const requests: Array<{ operationId: string; expectedGeneration: string }> = [];
    const client = scriptedClient({
      getSessionSet: async () => current,
      logoutSessionSet: async (request) => {
        attempts += 1;
        requests.push(request);
        current = empty;
        if (attempts === 1) {
          throw Object.assign(new Error("unknown"), { code: "operation_outcome_unknown" });
        }
        return { generation: "2", actorEpoch: "2", state: "logged_out" };
      },
    });
    const accounts = await renderAccounts(client);

    await expect(actRun(() => accounts.current.logoutAll())).rejects.toThrow("unknown");
    await flush();
    expect(accounts.current.phase).toBe("recoverable_error");
    expect(accounts.current.projection?.slots).toEqual([]);
    expect(accounts.current.hasPendingTransition).toBe(true);

    expect(await actRun(() => accounts.current.continueTransition())).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]?.expectedGeneration).toBe("1");
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection?.slots).toEqual([]);
    expect(accounts.current.hasPendingTransition).toBe(false);
    await accounts.unmount();
  });

  test("lets logout-all own settlement when its SSE actor-loss signal arrives concurrently", async () => {
    const before = projection();
    const empty = projection({ selectedSlotId: null, slotIds: [] });
    let current = before;
    let announcePostStarted!: () => void;
    let releasePost!: () => void;
    const postStarted = new Promise<void>((resolve) => {
      announcePostStarted = resolve;
    });
    const postRelease = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const transitions: BrowserAccountTransition[] = [];
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => current,
        logoutSessionSet: async () => {
          current = empty;
          announcePostStarted();
          await postRelease;
          return { generation: "2", actorEpoch: "2", state: "logged_out" };
        },
      }),
      async (transition) => {
        transitions.push(transition);
      },
    );

    let logout!: Promise<boolean>;
    await act(async () => {
      logout = accounts.current.logoutAll();
      await postStarted;
    });
    expect(accounts.current.phase).toBe("committing");

    await act(async () => {
      expect(await accounts.current.invalidateActor()).toBeNull();
    });
    expect(accounts.current.phase).toBe("loading");
    expect(accounts.current.projection).toBeNull();

    await act(async () => {
      releasePost();
      expect(await logout).toBe(true);
    });
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection?.slots).toEqual([]);
    expect(accounts.current.projection?.selectedSlotId).toBeNull();
    expect(accounts.current.hasPendingTransition).toBe(false);
    expect(transitions.at(-1)?.kind).toBe("logout_all");
    expect(transitions.at(-1)?.to?.slots).toEqual([]);
    await accounts.unmount();
  });

  test("hides a server-invalidated actor immediately and settles only after confirmation", async () => {
    const before = projection();
    const invalidated = projection({
      generation: "2",
      actorEpoch: "2",
      selectedSlotId: null,
      state: "actor_change_required",
    });
    let reads = 0;
    let release!: (value: ManagedAuthSessionSetProjection) => void;
    const pending = new Promise<ManagedAuthSessionSetProjection>((resolve) => {
      release = resolve;
    });
    const transitions: BrowserAccountTransition[] = [];
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => {
          reads += 1;
          if (reads <= 2) return before;
          if (reads === 3) return await pending;
          return invalidated;
        },
      }),
      async (transition) => {
        transitions.push(transition);
      },
    );

    let settlement!: Promise<ManagedAuthSessionSetProjection | null>;
    await act(async () => {
      settlement = accounts.current.invalidateActor();
      await Promise.resolve();
    });
    expect(accounts.current.phase).toBe("loading");
    expect(accounts.current.projection).toBeNull();

    release(invalidated);
    await act(async () => await settlement);
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection?.state).toBe("actor_change_required");
    expect(transitions.at(-1)?.from?.selectedSlotId).toBe(SLOT_A);
    expect(transitions.at(-1)?.to?.selectedSlotId).toBeNull();
    await accounts.unmount();
  });

  test("reports add reconciliation with the add transition kind", async () => {
    let current = projection();
    const transitions: BrowserAccountTransition[] = [];
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => current,
        beginLoginTransaction: async () => {
          current = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_B });
          throw Object.assign(new Error("generation changed"), { code: "generation_conflict" });
        },
      }),
      async (transition) => {
        transitions.push(transition);
      },
    );
    transitions.length = 0;

    await expect(actRun(() => accounts.current.beginAdd())).rejects.toThrow("generation changed");
    await flush();
    expect(transitions.at(-1)?.kind).toBe("add");
    await accounts.unmount();
  });

  test("keeps a selected-account reauthentication blocked without retaining credentials", async () => {
    let blocked = true;
    let selected = projection();
    const completionRequests: Array<{ operationId: string; expectedGeneration: string }> = [];
    const client = scriptedClient({
      getSessionSet: async () => selected,
      beginLoginTransaction: async (request) => ({
        id: request.operationId,
        kind: request.kind,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        returnIntentId: null,
      }),
      completeEmailPasswordTransaction: async (request) => {
        completionRequests.push({
          operationId: request.operationId,
          expectedGeneration: request.expectedGeneration,
        });
        if (completionRequests.length === 1) {
          selected = projection({ generation: "2", actorEpoch: "2" });
          throw Object.assign(new Error("unknown"), { code: "operation_outcome_unknown" });
        }
        return { projection: selected, returnIntent: null };
      },
    });
    const accounts = await renderAccounts(client);
    const unregister = accounts.current.registerTransitionBlocker("draft", () =>
      blocked ? { id: "ignored", label: "Unsaved draft" } : null,
    );

    await expect(actRun(() => accounts.current.beginReauth(SLOT_A))).rejects.toThrow(
      "Settle account transition blockers",
    );
    await flush();
    expect(accounts.current.phase).toBe("blocked");
    expect(accounts.current.transaction).toBeNull();

    blocked = false;
    await actRun(() => accounts.current.beginReauth(SLOT_A));
    const secret = "correct horse battery staple";
    await expect(
      actRun(() =>
        accounts.current.completeEmailPassword({
          email: "person-1@example.test",
          password: secret,
        }),
      ),
    ).rejects.toThrow("unknown");
    await flush();
    expect(JSON.stringify(accounts.current)).not.toContain(secret);
    expect(accounts.current.transaction?.kind).toBe("reauth");
    expect(accounts.current.phase).toBe("recoverable_error");

    expect(
      await actRun(() =>
        accounts.current.completeEmailPassword({
          email: "person-1@example.test",
          password: "typed again",
        }),
      ),
    ).toBe(true);
    expect(completionRequests).toHaveLength(2);
    expect(completionRequests[1]).toEqual(completionRequests[0]);
    expect(completionRequests[0]?.expectedGeneration).toBe("1");
    expect(accounts.current.transaction).toBeNull();
    unregister();
    await accounts.unmount();
  });

  test("reconciles a stale mutation receipt without exposing the older actor", async () => {
    const current = projection({ generation: "3", actorEpoch: "3", selectedSlotId: SLOT_B });
    const stale = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_A });
    let readCount = 0;
    let transitionCount = 0;
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => {
          readCount += 1;
          return current;
        },
        selectLoginSlot: async () => stale,
      }),
      async () => {
        transitionCount += 1;
      },
    );
    const initialTransitions = transitionCount;

    expect(await actRun(() => accounts.current.selectSlot(SLOT_A))).toBe(true);
    expect(accounts.current.projection?.actorEpoch).toBe("3");
    expect(accounts.current.projection?.selectedSlotId).toBe(SLOT_B);
    expect(transitionCount).toBe(initialTransitions);
    expect(readCount).toBe(3);
    await accounts.unmount();
  });

  test("treats BroadcastChannel data as a secret-free hint and rereads authority", async () => {
    const originalBroadcastChannel = globalThis.BroadcastChannel;
    class FakeBroadcastChannel {
      static readonly instances = new Set<FakeBroadcastChannel>();
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

      constructor(readonly name: string) {
        FakeBroadcastChannel.instances.add(this);
      }

      postMessage(value: unknown): void {
        for (const peer of FakeBroadcastChannel.instances) {
          if (peer !== this && peer.name === this.name) {
            peer.onmessage?.(new MessageEvent("message", { data: value }));
          }
        }
      }

      close(): void {
        FakeBroadcastChannel.instances.delete(this);
      }
    }
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: FakeBroadcastChannel,
    });

    let current = projection();
    let transitionCount = 0;
    let accounts: Awaited<ReturnType<typeof renderAccounts>> | null = null;
    const peer = new FakeBroadcastChannel("accounts-test");
    try {
      accounts = await renderAccounts(
        scriptedClient({ getSessionSet: async () => current }),
        async () => {
          transitionCount += 1;
        },
        "accounts-test",
      );
      const initialTransitions = transitionCount;
      current = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_B });

      await actRun(() =>
        peer.postMessage({
          type: "actor-epoch-changed",
          generation: "2",
          actorEpoch: "2",
          injectedProjection: projection(),
          token: "must-not-be-trusted",
        }),
      );
      await flush();

      expect(accounts.current.projection?.selectedSlotId).toBe(SLOT_B);
      expect(accounts.current.projection?.actorEpoch).toBe("2");
      expect(transitionCount).toBe(initialTransitions + 1);
    } finally {
      peer.close();
      await accounts?.unmount();
      Object.defineProperty(globalThis, "BroadcastChannel", {
        configurable: true,
        value: originalBroadcastChannel,
      });
    }
  });
});
