import { describe, expect, test } from "bun:test";
import { act, useEffect } from "react";
import type {
  BrowserAccountsClientLike,
  ManagedAuthLoginTransaction,
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
  const getSessionSet = overrides.getSessionSet ?? (async () => initial);
  return {
    getSessionSet,
    reconcileSessionSetAuthority: async () => await getSessionSet(),
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

  test("automatically replays an outcome-unknown switch with the exact original request", async () => {
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

    expect(await actRun(() => accounts.current.selectSlot(SLOT_B))).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]?.expectedGeneration).toBe("1");
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.hasPendingTransition).toBe(false);
    await accounts.unmount();
  });

  test("settles logout-all from the fresh authoritative empty session set", async () => {
    const before = projection({ generation: "4", actorEpoch: "3" });
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
    expect(requests[0]?.expectedGeneration).toBe("4");
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

  test("automatically replays response-lost logout-all with its original generation", async () => {
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

    expect(await actRun(() => accounts.current.logoutAll())).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]?.expectedGeneration).toBe("1");
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection?.slots).toEqual([]);
    expect(accounts.current.hasPendingTransition).toBe(false);
    await accounts.unmount();
  });

  test("bounds automatic outcome-unknown replay and preserves the pending command", async () => {
    const before = projection();
    const selected = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_B });
    let attempts = 0;
    const requests: Array<{ operationId: string; expectedGeneration: string }> = [];
    const client = scriptedClient({
      getSessionSet: async () => (attempts >= 2 ? selected : before),
      selectLoginSlot: async (request) => {
        attempts += 1;
        requests.push(request);
        if (attempts <= 2) {
          throw Object.assign(new Error("unknown"), { code: "operation_outcome_unknown" });
        }
        return selected;
      },
    });
    const accounts = await renderAccounts(client);

    await expect(actRun(() => accounts.current.selectSlot(SLOT_B))).rejects.toThrow("unknown");
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(accounts.current.phase).toBe("recoverable_error");
    expect(accounts.current.hasPendingTransition).toBe(true);

    expect(await actRun(() => accounts.current.continueTransition())).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toEqual(requests[0]);
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.hasPendingTransition).toBe(false);
    await accounts.unmount();
  });

  test("restores reconciled authority when the initiating surface fence rejects", async () => {
    const before = projection();
    let mutationAttempts = 0;
    let reconciliationAttempts = 0;
    let rejectFence = true;
    const transitions: BrowserAccountTransition[] = [];
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => before,
        reconcileSessionSetAuthority: async () => {
          reconciliationAttempts += 1;
          return before;
        },
        selectLoginSlot: async () => {
          mutationAttempts += 1;
          return projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_B });
        },
      }),
      async (transition) => {
        transitions.push(transition);
        if (rejectFence && transition.from?.selectedSlotId === SLOT_A && transition.to === null) {
          rejectFence = false;
          throw new Error("host fence failed");
        }
      },
    );
    transitions.length = 0;
    const initialReconciliationAttempts = reconciliationAttempts;

    await expect(actRun(() => accounts.current.selectSlot(SLOT_B))).rejects.toThrow(
      "host fence failed",
    );
    await flush();

    expect(mutationAttempts).toBe(0);
    // Recovery first discovers the current authority, then confirms it again
    // after the host has restored the actor-owned surface.
    expect(reconciliationAttempts - initialReconciliationAttempts).toBe(2);
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({ from: before, to: null });
    expect(transitions[1]).toMatchObject({ from: null, to: before });
    expect(accounts.current.projection).toEqual(before);
    expect(accounts.current.phase).toBe("recoverable_error");
    expect(accounts.current.hasPendingTransition).toBe(true);
    await accounts.unmount();
  });

  test("restores from neutral authority when refresh supersedes the initiating fence", async () => {
    const before = projection();
    let mutationAttempts = 0;
    let announceFenceStarted!: () => void;
    let releaseFence!: () => void;
    const fenceStarted = new Promise<void>((resolve) => {
      announceFenceStarted = resolve;
    });
    const fenceRelease = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const transitions: BrowserAccountTransition[] = [];
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => before,
        reconcileSessionSetAuthority: async () => before,
        selectLoginSlot: async () => {
          mutationAttempts += 1;
          return projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_B });
        },
      }),
      async (transition) => {
        transitions.push(transition);
        if (transition.from?.selectedSlotId === SLOT_A && transition.to === null) {
          announceFenceStarted();
          await fenceRelease;
        }
      },
    );
    transitions.length = 0;

    let selection!: Promise<boolean>;
    await act(async () => {
      selection = accounts.current.selectSlot(SLOT_B);
      await fenceStarted;
    });
    expect(accounts.current.projection).toBeNull();
    expect(accounts.current.phase).toBe("loading");

    await act(async () => {
      expect(await accounts.current.refresh()).toEqual(before);
    });
    await act(async () => {
      releaseFence();
      expect(await selection).toBe(false);
    });

    expect(mutationAttempts).toBe(0);
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({ from: before, to: null });
    expect(transitions[1]).toMatchObject({ kind: "cross_tab", from: null, to: before });
    expect(accounts.current.projection).toEqual(before);
    expect(accounts.current.phase).toBe("ready");
    await accounts.unmount();
  });

  test("lets logout-all own settlement when its SSE actor-loss signal arrives concurrently", async () => {
    const before = projection({ generation: "4", actorEpoch: "3" });
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
    expect(accounts.current.phase).toBe("loading");

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

  test("double-confirms a fresh empty authority reset after cross-tab logout-all", async () => {
    const before = projection({ generation: "7", actorEpoch: "5", selectedSlotId: SLOT_B });
    const empty = projection({ selectedSlotId: null, slotIds: [] });
    let current = before;
    let reads = 0;
    const transitions: BrowserAccountTransition[] = [];
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => {
          reads += 1;
          return current;
        },
      }),
      async (transition) => {
        transitions.push(transition);
      },
    );
    const initialReads = reads;
    current = empty;

    expect(await actRun(() => accounts.current.invalidateActor())).toEqual(empty);
    expect(reads - initialReads).toBe(2);
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection?.slots).toEqual([]);
    expect(accounts.current.projection?.actorEpoch).toBe("1");
    expect(transitions.at(-1)?.kind).toBe("cross_tab");
    expect(transitions.at(-1)?.from?.actorEpoch).toBe("5");
    await accounts.unmount();
  });

  test("adopts a double-confirmed lower authority that already selected a slot", async () => {
    const before = projection({ generation: "7", actorEpoch: "5", selectedSlotId: SLOT_B });
    const replacement = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_A });
    let current = before;
    const transitions: BrowserAccountTransition[] = [];
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => current,
        reconcileSessionSetAuthority: async () => current,
      }),
      async (transition) => {
        transitions.push(transition);
      },
    );
    current = replacement;

    expect(await actRun(() => accounts.current.invalidateActor())).toEqual(replacement);
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection).toEqual(replacement);
    expect(transitions.at(-1)).toMatchObject({
      kind: "cross_tab",
      from: { actorEpoch: "5", selectedSlotId: SLOT_B },
      to: { actorEpoch: "2", selectedSlotId: SLOT_A },
    });
    await accounts.unmount();
  });

  test("refresh adopts an explicitly reconciled lower authority from a ready actor", async () => {
    const before = projection({ generation: "7", actorEpoch: "5", selectedSlotId: SLOT_B });
    const replacement = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_A });
    let current = before;
    const transitions: BrowserAccountTransition[] = [];
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => current,
        reconcileSessionSetAuthority: async () => current,
      }),
      async (transition) => {
        transitions.push(transition);
      },
    );
    current = replacement;

    expect(await actRun(() => accounts.current.refresh())).toEqual(replacement);
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection).toEqual(replacement);
    expect(transitions.at(-1)).toMatchObject({
      kind: "cross_tab",
      from: { generation: "7", actorEpoch: "5", selectedSlotId: SLOT_B },
      to: { generation: "2", actorEpoch: "2", selectedSlotId: SLOT_A },
    });
    await accounts.unmount();
  });

  test("settles a second authority rotation that arrives while tenant state is loading", async () => {
    const before = projection({ generation: "7", actorEpoch: "5", selectedSlotId: SLOT_B });
    const first = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_A });
    const second = projection({ selectedSlotId: null, slotIds: [] });
    let current = before;
    const transitions: BrowserAccountTransition[] = [];
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => current,
        reconcileSessionSetAuthority: async () => current,
      }),
      async (transition) => {
        transitions.push(transition);
        if (transition.from === before && transition.to === first) current = second;
      },
    );
    current = first;

    expect(await actRun(() => accounts.current.refresh())).toEqual(second);
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection).toEqual(second);
    expect(transitions.slice(-2)).toEqual([
      expect.objectContaining({ from: before, to: first }),
      expect.objectContaining({ from: first, to: second }),
    ]);
    await accounts.unmount();
  });

  test("retries explicit authority reconciliation after a failed invalidation probe", async () => {
    const before = projection({ generation: "7", actorEpoch: "5", selectedSlotId: SLOT_B });
    const replacement = projection({ selectedSlotId: null, slotIds: [] });
    let current = before;
    let failNextReconciliation = false;
    const client = scriptedClient({
      getSessionSet: async () => current,
      reconcileSessionSetAuthority: async () => {
        if (failNextReconciliation) {
          failNextReconciliation = false;
          throw new TypeError("authority probe failed");
        }
        return current;
      },
    });
    const accounts = await renderAccounts(client);
    current = replacement;
    failNextReconciliation = true;

    await expect(actRun(() => accounts.current.invalidateActor())).rejects.toThrow(
      "authority probe failed",
    );
    await flush();
    expect(accounts.current.phase).toBe("recoverable_error");
    expect(accounts.current.projection).toBeNull();

    expect(await actRun(() => accounts.current.refresh())).toEqual(replacement);
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection).toEqual(replacement);
    await accounts.unmount();
  });

  test("reconciles a lower authority after a pending mutation settles", async () => {
    const before = projection({ generation: "7", actorEpoch: "5" });
    const staleAccepted = projection({ generation: "8", actorEpoch: "6", selectedSlotId: SLOT_B });
    const replacement = projection({ selectedSlotId: null, slotIds: [] });
    let current = before;
    let announceMutation!: () => void;
    let releaseMutation!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      announceMutation = resolve;
    });
    const mutationRelease = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let reconciliationCount = 0;
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => current,
        reconcileSessionSetAuthority: async () => {
          reconciliationCount += 1;
          return current;
        },
        selectLoginSlot: async () => {
          announceMutation();
          await mutationRelease;
          return staleAccepted;
        },
      }),
    );
    const initialReconciliationCount = reconciliationCount;

    let selection!: Promise<boolean>;
    await act(async () => {
      selection = accounts.current.selectSlot(SLOT_B);
      await mutationStarted;
    });
    await act(async () => {
      expect(await accounts.current.invalidateActor()).toBeNull();
    });
    current = replacement;
    await act(async () => {
      releaseMutation();
      expect(await selection).toBe(true);
    });

    expect(reconciliationCount - initialReconciliationCount).toBe(2);
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection).toEqual(replacement);
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
    expect(transitions.at(-1)?.kind).toBe("cross_tab");
    expect(transitions.at(-1)?.from?.selectedSlotId).toBe(SLOT_A);
    expect(transitions.at(-1)?.to).toBeNull();

    release(invalidated);
    await act(async () => await settlement);
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.projection?.state).toBe("actor_change_required");
    expect(transitions.at(-1)?.from?.selectedSlotId).toBe(SLOT_A);
    expect(transitions.at(-1)?.to?.selectedSlotId).toBeNull();
    await accounts.unmount();
  });

  test("publishes an accepted actor hint before the local transition settles", async () => {
    const originalBroadcastChannel = globalThis.BroadcastChannel;
    const messages: unknown[] = [];
    class RecordingBroadcastChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

      constructor(readonly _name: string) {}

      postMessage(value: unknown): void {
        messages.push(value);
      }

      close(): void {}
    }
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: RecordingBroadcastChannel,
    });

    let current = projection();
    let releaseTransition!: () => void;
    const transitionSettled = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    let accounts: Awaited<ReturnType<typeof renderAccounts>> | null = null;
    try {
      accounts = await renderAccounts(
        scriptedClient({
          getSessionSet: async () => current,
          selectLoginSlot: async () => {
            current = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_B });
            return current;
          },
        }),
        async (transition) => {
          if (transition.to?.selectedSlotId === SLOT_B) {
            await transitionSettled;
          }
        },
        "accounts-publish-test",
      );

      let selection!: Promise<boolean>;
      await act(async () => {
        selection = accounts!.current.selectSlot(SLOT_B);
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({
        type: "actor-transition-pending",
        transitionId: expect.any(String),
        generation: "1",
        actorEpoch: "1",
      });
      expect(messages[1]).toEqual({
        type: "actor-epoch-changed",
        generation: "2",
        actorEpoch: "2",
      });
      expect(accounts.current.phase).toBe("loading");

      await act(async () => {
        releaseTransition();
        expect(await selection).toBe(true);
      });
      expect(messages).toEqual([
        expect.objectContaining({ type: "actor-transition-pending" }),
        { type: "actor-epoch-changed", generation: "2", actorEpoch: "2" },
        {
          type: "actor-transition-released",
          transitionId: (messages[0] as { transitionId: string }).transitionId,
        },
      ]);
    } finally {
      releaseTransition();
      await accounts?.unmount();
      Object.defineProperty(globalThis, "BroadcastChannel", {
        configurable: true,
        value: originalBroadcastChannel,
      });
    }
  });

  test("holds peer actor work before an actor-changing mutation can start", async () => {
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
    const peerTransitions: BrowserAccountTransition[] = [];
    const initiatorTransitions: BrowserAccountTransition[] = [];
    let peer: Awaited<ReturnType<typeof renderAccounts>> | null = null;
    let initiator: Awaited<ReturnType<typeof renderAccounts>> | null = null;
    try {
      peer = await renderAccounts(
        scriptedClient({ getSessionSet: async () => current }),
        async (transition) => {
          peerTransitions.push(transition);
        },
        "accounts-precommit-hold-test",
      );
      peerTransitions.length = 0;
      initiator = await renderAccounts(
        scriptedClient({
          getSessionSet: async () => current,
          selectLoginSlot: async () => {
            expect(peerTransitions.at(-1)?.to).toBeNull();
            expect(initiatorTransitions.at(-1)?.to).toBeNull();
            current = projection({
              generation: "2",
              actorEpoch: "2",
              selectedSlotId: SLOT_B,
            });
            return current;
          },
        }),
        async (transition) => {
          initiatorTransitions.push(transition);
        },
        "accounts-precommit-hold-test",
      );
      initiatorTransitions.length = 0;

      expect(await actRun(() => initiator!.current.selectSlot(SLOT_B))).toBe(true);
      await flush();
      expect(peerTransitions[0]?.to).toBeNull();
      expect(initiatorTransitions[0]?.to).toBeNull();
      expect(peer.current.projection?.selectedSlotId).toBe(SLOT_B);
      expect(peer.current.projection?.actorEpoch).toBe("2");
    } finally {
      await initiator?.unmount();
      await peer?.unmount();
      Object.defineProperty(globalThis, "BroadcastChannel", {
        configurable: true,
        value: originalBroadcastChannel,
      });
    }
  });

  test("revokes neutral peer slot metadata when logout-all rotates the authority", async () => {
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

    let current = projection({ selectedSlotId: null });
    const empty = projection({ selectedSlotId: null, slotIds: [] });
    let peer: Awaited<ReturnType<typeof renderAccounts>> | null = null;
    let initiator: Awaited<ReturnType<typeof renderAccounts>> | null = null;
    try {
      peer = await renderAccounts(
        scriptedClient({
          getSessionSet: async () => current,
          reconcileSessionSetAuthority: async () => current,
        }),
        async () => undefined,
        "accounts-neutral-logout-all-test",
      );
      initiator = await renderAccounts(
        scriptedClient({
          getSessionSet: async () => current,
          reconcileSessionSetAuthority: async () => current,
          logoutSessionSet: async () => {
            current = empty;
            return { generation: "2", actorEpoch: "2", state: "logged_out" };
          },
        }),
        async () => undefined,
        "accounts-neutral-logout-all-test",
      );

      expect(peer.current.projection?.slots.map((slot) => slot.verifiedClaim.value)).toEqual([
        "person-1@example.test",
        "person-2@example.test",
      ]);
      expect(await actRun(() => initiator!.current.logoutAll())).toBe(true);
      await flush();
      expect(peer.current.projection?.slots).toEqual([]);
      expect(JSON.stringify(peer.current.projection)).not.toContain("person-1@example.test");
      expect(JSON.stringify(peer.current.projection)).not.toContain("person-2@example.test");
    } finally {
      await initiator?.unmount();
      await peer?.unmount();
      Object.defineProperty(globalThis, "BroadcastChannel", {
        configurable: true,
        value: originalBroadcastChannel,
      });
    }
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

  test("discards a delayed begin result after actor invalidation", async () => {
    const before = projection({ generation: "7", actorEpoch: "5", selectedSlotId: SLOT_B });
    const replacement = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_A });
    let current = before;
    let announceBegin!: () => void;
    let releaseBegin!: (transaction: ManagedAuthLoginTransaction) => void;
    const beginStarted = new Promise<void>((resolve) => {
      announceBegin = resolve;
    });
    const delayedBegin = new Promise<ManagedAuthLoginTransaction>((resolve) => {
      releaseBegin = resolve;
    });
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => current,
        reconcileSessionSetAuthority: async () => current,
        beginLoginTransaction: async () => {
          announceBegin();
          return await delayedBegin;
        },
      }),
    );

    let beginning!: Promise<ManagedAuthLoginTransaction>;
    await act(async () => {
      beginning = accounts.current.beginAdd();
      await beginStarted;
    });
    current = replacement;
    expect(await actRun(() => accounts.current.invalidateActor())).toEqual(replacement);

    let staleError: unknown;
    await act(async () => {
      releaseBegin({
        id: crypto.randomUUID(),
        kind: "add",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        returnIntentId: null,
      });
      try {
        await beginning;
      } catch (caught) {
        staleError = caught;
      }
    });
    expect(staleError).toMatchObject({ name: "AbortError" });
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.transaction).toBeNull();
    expect(accounts.current.projection).toEqual(replacement);
    await accounts.unmount();
  });

  test("discards a delayed cancel result after actor invalidation", async () => {
    const before = projection({ generation: "7", actorEpoch: "5", selectedSlotId: SLOT_B });
    const replacement = projection({ generation: "2", actorEpoch: "2", selectedSlotId: SLOT_A });
    const staleCancel = projection({ generation: "8", actorEpoch: "6", selectedSlotId: SLOT_B });
    let current = before;
    let announceCancel!: () => void;
    let releaseCancel!: (projection: ManagedAuthSessionSetProjection) => void;
    const cancelStarted = new Promise<void>((resolve) => {
      announceCancel = resolve;
    });
    const delayedCancel = new Promise<ManagedAuthSessionSetProjection>((resolve) => {
      releaseCancel = resolve;
    });
    const accounts = await renderAccounts(
      scriptedClient({
        getSessionSet: async () => current,
        reconcileSessionSetAuthority: async () => current,
        cancelLoginTransaction: async () => {
          announceCancel();
          return await delayedCancel;
        },
      }),
    );
    await actRun(() => accounts.current.beginAdd());

    let cancelling!: Promise<void>;
    await act(async () => {
      cancelling = accounts.current.cancelLoginTransaction();
      await cancelStarted;
    });
    current = replacement;
    expect(await actRun(() => accounts.current.invalidateActor())).toEqual(replacement);

    let staleError: unknown;
    await act(async () => {
      releaseCancel(staleCancel);
      try {
        await cancelling;
      } catch (caught) {
        staleError = caught;
      }
    });
    expect(staleError).toMatchObject({ name: "AbortError" });
    expect(accounts.current.phase).toBe("ready");
    expect(accounts.current.transaction).toBeNull();
    expect(accounts.current.projection).toEqual(replacement);
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
    expect(transitionCount).toBe(initialTransitions + 2);
    expect(readCount).toBe(4);
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
    const transitions: BrowserAccountTransition[] = [];
    let accounts: Awaited<ReturnType<typeof renderAccounts>> | null = null;
    const peer = new FakeBroadcastChannel("accounts-test");
    try {
      accounts = await renderAccounts(
        scriptedClient({ getSessionSet: async () => current }),
        async (transition) => {
          transitions.push(transition);
        },
        "accounts-test",
      );
      const initialTransitions = transitions.length;
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
      expect(transitions).toHaveLength(initialTransitions + 2);
      expect(transitions.at(-2)?.to).toBeNull();
      expect(transitions.at(-1)?.to?.selectedSlotId).toBe(SLOT_B);
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
