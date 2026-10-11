/**
 * Subscription-funded video on the shared subscription core (design 5.3,
 * EP-T17/EP-N12 funding and selection, EP-N13/EP-N14 admission and
 * reconciliation), for any provider whose adapter funds media.
 *
 * - Selection: the first shared organization- or workspace-scoped candidate
 *   for the session's recorded owner (the session's explicit choice, then
 *   the effective primary, then pool order). Never a personal connection: a
 *   video job outlives its turn, and reconciliation has no turn authority.
 * - Admission records a reference to that canonical connection, never token
 *   material, so no organization-scope envelope can be refused (EP-N13).
 * - Reconciliation reads the credential through the core connection seam
 *   under a `video` operation lease on exactly that connection and refreshes
 *   only under the core lock (EP-N14). Without a usable connection the
 *   operation waits until its recovery deadline (decision 6).
 * - Nothing here reads or writes the chat session binding beyond the
 *   candidate order's explicit choice.
 */
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  readSubscriptionCoreSessionOwner,
  subscriptionCoreOperationConnections,
  type Database,
  type SubscriptionCoreConnectionToken,
  type SubscriptionCoreFetch,
  type SubscriptionCoreProvider,
} from "@opengeni/db";
import type { VideoGenerationCredentialLease } from "./video-generation-admission";
import { encryptVideoGenerationConnectionReference } from "./video-generation-credential";

type SessionContext = { accountId: string; workspaceId: string; sessionId: string };

async function sessionScope(db: Database, context: SessionContext) {
  const owner = await readSubscriptionCoreSessionOwner(db, context);
  if (!owner) return null;
  return {
    kind: "session" as const,
    ...context,
    sessionOwnerSubjectId: owner.ownerSubjectId,
  };
}

/** The video funding lease for this session, or null when no shared connection can fund it. */
export async function subscriptionCoreVideoGenerationCredentialLease(
  db: Database,
  settings: Settings,
  provider: SubscriptionCoreProvider,
  context: SessionContext,
): Promise<VideoGenerationCredentialLease | null> {
  const encryptionKey = environmentsEncryptionKeyBytes(settings);
  if (!encryptionKey) return null;
  const scope = await sessionScope(db, context);
  if (!scope) return null;
  const [selected] = await subscriptionCoreOperationConnections(
    provider,
  ).listSubscriptionCoreOperationCandidates(db, scope);
  if (!selected) return null;
  return Object.freeze({
    fundingSource: "supergrok_subscription",
    connectionId: null,
    version: 1,
    credentialEncrypted: encryptVideoGenerationConnectionReference(encryptionKey, {
      provider: provider.adapter.provider,
      connectionId: selected.connectionId,
    }),
  });
}

/**
 * Run one reconciliation step on the operation's recorded connection under
 * a `video` operation lease. `unavailable` when the session (or its owner
 * context) is gone, the lease is refused, or the connection's first bearer
 * cannot be read (a relogin, a revoked or unassigned connection): nothing
 * reached the provider.
 */
export async function withSubscriptionCoreVideoConnection<T>(
  db: Database,
  settings: Settings,
  provider: SubscriptionCoreProvider,
  operation: { id: string; accountId: string; workspaceId: string; sessionId: string | null },
  connectionId: string,
  run: (connection: {
    resolver: {
      getToken: () => Promise<SubscriptionCoreConnectionToken>;
      refresh: () => Promise<SubscriptionCoreConnectionToken>;
    };
    fetch: SubscriptionCoreFetch;
  }) => Promise<T>,
  deps: { fetchImpl?: SubscriptionCoreFetch } = {},
): Promise<{ kind: "ran"; value: T } | { kind: "unavailable" }> {
  if (!operation.sessionId) return { kind: "unavailable" };
  const scope = await sessionScope(db, {
    accountId: operation.accountId,
    workspaceId: operation.workspaceId,
    sessionId: operation.sessionId,
  });
  if (!scope) return { kind: "unavailable" };
  const unreadable = Symbol("unreadable");
  const ran = await subscriptionCoreOperationConnections(provider).runSubscriptionCoreOperation(
    db,
    settings,
    scope,
    {
      candidates: [connectionId],
      operationKind: "video",
      holderId: `video:${operation.id}`,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    },
    async ({ resolver, fetch, fence }) => {
      try {
        await resolver.getToken();
      } catch {
        return unreadable;
      }
      const fenced: SubscriptionCoreFetch = async (input, init) => {
        // Pre-dispatch fence on the exact operation lease.
        if (!(await fence())) throw new Error("The video operation lease was lost");
        return await fetch(input, init);
      };
      return { value: await run({ resolver, fetch: fenced }) };
    },
  );
  if (ran.kind === "unavailable" || ran.value === unreadable) return { kind: "unavailable" };
  return { kind: "ran", value: ran.value.value };
}
