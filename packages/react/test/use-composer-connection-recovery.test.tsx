import { expect, test } from "bun:test";
import {
  OpenGeniApiError,
  type CapabilityCatalogItem,
  type ConnectionMetadata,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useConnectionAccounts } from "../src/app/components/capabilities/use-connection-accounts";
import { useComposer } from "../src/hooks/use-composer";
import { COMPOSER_ACCOUNT_UNAVAILABLE_MESSAGE } from "../src/lib/format";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

const catalog = [
  {
    enabled: true,
    name: "Mail",
    runtime: { mcpServerId: "mail" },
    connectionRef: { providerDomain: "mail.example.test", subjectScope: "subject" },
  },
] as CapabilityCatalogItem[];
const account = (id: string, status: ConnectionMetadata["status"] = "active") =>
  ({
    id,
    subjectId: "sender",
    authorityId: "authority",
    status,
    providerDomain: "mail.example.test",
  }) as ConnectionMetadata;

function refusal(connectionId: string) {
  return new OpenGeniApiError(
    422,
    JSON.stringify({
      error: {
        status: 422,
        code: "validation_failed",
        retryable: false,
        message:
          "A selected connector account is unavailable. Review your connected accounts before sending again.",
        requestId: "request-stale-account",
        details: {
          code: "connection_account_selection_unavailable",
          version: 1,
          reason: "selected_account_unavailable",
          accounts: [{ serverId: "mail", connectionId, reason: "account_inactive" }],
        },
      },
    }),
    { mutation: true },
  );
}

/**
 * A chat whose account list was read while every account worked. `refuse`
 * decides, per send, which account the server refuses (as an older or strict
 * API pod does); `inventory` is what the next account read returns.
 */
async function chat(options: {
  inventory: ConnectionMetadata[];
  refuse: (ids: string[], attempt: number) => string | null;
}) {
  const sessionId = crypto.randomUUID();
  const state = { inventory: options.inventory, reads: 0, deliveryErrors: 0 };
  const sent: string[][] = [];
  const client = Object.assign(
    fakeClient({
      sendMessage: async (_workspace, _session, request) => {
        const input = typeof request === "string" ? { text: request } : request;
        const ids = (input.connectionAccounts ?? []).map((item) => item.connectionId);
        sent.push(ids);
        const refused = options.refuse(ids, sent.length);
        if (refused) throw refusal(refused);
        return {
          id: crypto.randomUUID(),
          sessionId,
          sequence: 1,
          type: "user.message",
          payload: { text: input.text },
          createdAt: new Date().toISOString(),
        } as never;
      },
    }),
    {
      listOwnConnectionAccounts: async () => {
        state.reads++;
        return state.inventory;
      },
    },
  );
  const hook = await renderHook(() => {
    const accounts = useConnectionAccounts(
      client as unknown as OpenGeniBrowserClient,
      { id: sessionId, workspaceId: WORKSPACE_ID, selectedIds: ["mail"] },
      catalog,
      true,
    );
    const composer = useComposer(sessionId, {
      client,
      workspaceId: WORKSPACE_ID,
      sendExtras: () => ({ connectionAccounts: accounts.selections }),
      sendBlocked: () =>
        accounts.loading || accounts.requiresAccountChoice || accounts.error !== null,
      onDeliveryError: (error) => {
        state.deliveryErrors++;
        accounts.onSelectionError(error);
      },
      reviseRefusedAccounts: (error, input) =>
        accounts.reviseRefusedAccounts(error, input.connectionAccounts),
    });
    return { accounts, composer };
  }, undefined);
  await flush();
  return { hook, sent, state };
}

async function send(hook: Awaited<ReturnType<typeof chat>>["hook"]) {
  await actRun(() => hook.result.current.composer.setValue("Read my messages"));
  await actRun(() => hook.result.current.composer.send());
  await flush();
  await flush();
}

for (const explicit of [false, true]) {
  test(`a refused send goes again once on its own without the account that stopped working (${explicit ? "explicit picks" : "default accounts"})`, async () => {
    const working = crypto.randomUUID();
    const expired = crypto.randomUUID();
    let lapsed = true;
    const { hook, sent, state } = await chat({
      inventory: [account(working), account(expired)],
      refuse: (ids) => (lapsed && ids.includes(expired) ? expired : null),
    });
    if (explicit)
      await actRun(() => hook.result.current.accounts.selectAccount("mail", [working, expired]));
    // Its sign-in expires while the chat sits open on the old list.
    state.inventory = [account(working), account(expired, "needs_reauth")];
    await send(hook);

    expect(sent).toEqual([[working, expired], [working]]);
    expect(hook.result.current.composer.optimisticMessages ?? []).toEqual([]);
    expect(hook.result.current.composer.value).toBe("");
    expect(state.deliveryErrors).toBe(0);
    expect(state.reads).toBe(2);
    expect(hook.result.current.accounts.requiresAccountChoice).toBe(false);
    if (explicit) {
      // Only the retry was narrowed: the person's picks stay, so the account
      // is picked again once it is reconnected.
      expect(hook.result.current.accounts.accountChoices).toEqual({ mail: [working, expired] });
      lapsed = false;
      state.inventory = [account(working), account(expired)];
      await actRun(() => hook.result.current.accounts.refresh());
      await flush();
      await send(hook);
      expect(sent.slice(2)).toEqual([[working, expired]]);
      expect(hook.result.current.composer.optimisticMessages ?? []).toEqual([]);
    } else {
      expect(hook.result.current.accounts.selections).toEqual([
        { serverId: "mail", connectionId: working },
      ]);
    }
    await hook.unmount();
  });
}

test("a connector whose only pick stopped working is never resent with no pick (that would widen)", async () => {
  const expired = crypto.randomUUID();
  const other = crypto.randomUUID();
  for (const explicit of [false, true]) {
    const { hook, sent, state } = await chat({
      inventory: explicit ? [account(expired), account(other)] : [account(expired)],
      refuse: (ids) => (ids.includes(expired) ? expired : null),
    });
    if (explicit) await actRun(() => hook.result.current.accounts.selectAccount("mail", [expired]));
    state.inventory = explicit
      ? [account(expired, "needs_reauth"), account(other)]
      : [account(expired, "needs_reauth")];
    await send(hook);

    // No pick for a connector means "use its accounts", so no resend: the
    // older API's refusal stands as today's failed message.
    expect(sent).toEqual([[expired]]);
    expect(hook.result.current.composer.optimisticMessages![0]).toMatchObject({
      state: "failed",
      error: COMPOSER_ACCOUNT_UNAVAILABLE_MESSAGE,
    });
    expect(state.deliveryErrors).toBe(1);
    await hook.unmount();
  }
});

test("a lapsed pick keeps Send enabled and is sent as picked, never swapped", async () => {
  const picked = crypto.randomUUID();
  const other = crypto.randomUUID();
  const { hook, sent, state } = await chat({
    inventory: [account(picked), account(other)],
    // A current API leaves the lapsed pick out itself.
    refuse: () => null,
  });
  await actRun(() => hook.result.current.accounts.selectAccount("mail", [picked]));
  state.inventory = [account(picked, "needs_reauth"), account(other)];
  await actRun(() => hook.result.current.accounts.refresh());
  await flush();

  expect(hook.result.current.accounts.requiresAccountChoice).toBe(false);
  expect(hook.result.current.accounts.selections).toEqual([
    { serverId: "mail", connectionId: picked },
  ]);
  await send(hook);
  expect(sent).toEqual([[picked]]);
  expect(hook.result.current.composer.optimisticMessages ?? []).toEqual([]);
  expect(state.deliveryErrors).toBe(0);
  await hook.unmount();
});

test("a refused pick is never replaced by the connector's other account", async () => {
  const picked = crypto.randomUUID();
  const other = crypto.randomUUID();
  const { hook, sent, state } = await chat({
    inventory: [account(picked), account(other)],
    refuse: (ids) => (ids.includes(picked) ? picked : null),
  });
  await actRun(() => hook.result.current.accounts.selectAccount("mail", [picked]));
  state.inventory = [account(picked, "needs_reauth"), account(other)];
  await send(hook);

  // Leaving the only pick out would let the server use `other`: no resend.
  expect(sent).toEqual([[picked]]);
  const failed = hook.result.current.composer.optimisticMessages![0]!;
  expect(failed).toMatchObject({
    text: "Read my messages",
    state: "failed",
    retryable: false,
    error: COMPOSER_ACCOUNT_UNAVAILABLE_MESSAGE,
  });
  expect(state.deliveryErrors).toBe(1);
  // The pick stays as the person made it; it shows as needing reconnecting.
  expect(hook.result.current.accounts.accountChoices).toEqual({ mail: [picked] });
  expect(hook.result.current.accounts.requiresAccountChoice).toBe(false);
  await hook.unmount();
});

test("a second refusal shows the failed message and never tries another account", async () => {
  const working = crypto.randomUUID();
  const expired = crypto.randomUUID();
  const unpicked = crypto.randomUUID();
  const { hook, sent, state } = await chat({
    inventory: [account(working), account(expired), account(unpicked)],
    // The server still refuses the resend (its view differs from this list).
    refuse: (ids) => (ids.includes(expired) ? expired : (ids[0] ?? null)),
  });
  await actRun(() => hook.result.current.accounts.selectAccount("mail", [working, expired]));
  state.inventory = [account(working), account(expired, "needs_reauth"), account(unpicked)];
  await send(hook);

  expect(sent).toEqual([[working, expired], [working]]);
  expect(sent.flat()).not.toContain(unpicked);
  const failed = hook.result.current.composer.optimisticMessages![0]!;
  expect(failed).toMatchObject({
    text: "Read my messages",
    state: "failed",
    retryable: false,
    outcomeUnknown: false,
    error: COMPOSER_ACCOUNT_UNAVAILABLE_MESSAGE,
  });
  expect(state.deliveryErrors).toBe(1);
  await hook.unmount();
});
