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
import { conversationTimeline } from "../src/conversation-timeline";
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
const removed = crypto.randomUUID();
const replacement = crypto.randomUUID();
const account = (id: string) =>
  ({
    id,
    subjectId: "sender",
    authorityId: "authority",
    status: "active",
    providerDomain: "mail.example.test",
  }) as ConnectionMetadata;

for (const explicit of [false, true]) {
  test(`removed account recovery preserves ${explicit ? "explicit pins" : "default account selection"} and requires a fresh send`, async () => {
    const sessionId = crypto.randomUUID();
    let inventory = [account(removed)];
    let reads = 0;
    const sent: string[][] = [];
    const client = Object.assign(
      fakeClient({
        sendMessage: async (_workspace, _session, request) => {
          const input = typeof request === "string" ? { text: request } : request;
          const ids = (input.connectionAccounts ?? []).map((item) => item.connectionId);
          sent.push(ids);
          if (ids.includes(removed))
            throw new OpenGeniApiError(
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
                    accounts: [
                      { serverId: "mail", connectionId: removed, reason: "account_not_visible" },
                    ],
                  },
                },
              }),
              { mutation: true },
            );
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
          reads++;
          return inventory;
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
        onDeliveryError: (error) => accounts.onSelectionError(error),
      });
      return { accounts, composer };
    }, undefined);
    await flush();
    if (explicit) await actRun(() => hook.result.current.accounts.selectAccount("mail", [removed]));
    inventory = [account(replacement)]; // removed/reconnected in a different tab
    await actRun(() => hook.result.current.composer.setValue("Read my messages"));
    await actRun(() => hook.result.current.composer.send());
    await flush();
    const failed = hook.result.current.composer.optimisticMessages![0]!;
    expect(failed).toMatchObject({
      text: "Read my messages",
      state: "failed",
      retryable: false,
      outcomeUnknown: false,
      error: COMPOSER_ACCOUNT_UNAVAILABLE_MESSAGE,
    });
    expect(reads).toBe(2);
    expect(sent).toEqual([[removed]]);
    const row = conversationTimeline(
      [],
      { queue: [], snapshot: null, acceptedSteers: [] },
      hook.result.current.composer,
    )[0];
    expect(row?.kind === "user-message" ? row.delivery?.onRetry : null).toBeUndefined();
    await actRun(() => hook.result.current.composer.retryOptimisticMessage?.(failed.clientEventId));
    expect(sent).toEqual([[removed]]);
    expect(hook.result.current.accounts.requiresAccountChoice).toBe(explicit);
    if (explicit) {
      expect(hook.result.current.accounts.accountChoices).toEqual({ mail: [removed] });
      expect(hook.result.current.accounts.selections).toEqual([]);
      await actRun(() => hook.result.current.accounts.selectAccount("mail", [replacement]));
    }
    await actRun(() =>
      hook.result.current.composer.restoreOptimisticMessage?.(failed.clientEventId),
    );
    expect(hook.result.current.composer.value).toBe("Read my messages");
    await actRun(() => hook.result.current.composer.send());
    await flush();
    expect(sent).toEqual([[removed], [replacement]]);
    await hook.unmount();
  });
}
