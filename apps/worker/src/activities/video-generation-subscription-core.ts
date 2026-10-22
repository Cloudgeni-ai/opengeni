/**
 * Subscription-funded video on the shared subscription core (design 5.3,
 * EP-T17/EP-N12 funding and selection, EP-N13/EP-N14 admission and
 * reconciliation), for any provider whose adapter funds media.
 *
 * - Selection: the first shared organization- or workspace-scoped candidate
 *   for the session's recorded owner (the session's explicit choice, then
 *   the effective primary, then pool order) whose stored quota is not
 *   exhausted now; none when every candidate is exhausted. Never a personal
 *   connection: a video job outlives its turn, and reconciliation has no
 *   turn authority.
 * - Admission records a reference to that canonical connection, never token
 *   material, so no organization-scope envelope can be refused (EP-N13).
 * - Reconciliation reads the credential through the core connection seam
 *   under a `video` operation lease on exactly that connection and refreshes
 *   only under the core lock (EP-N14). Without a usable connection the
 *   operation waits until its recovery deadline (decision 6).
 * - Anything that stops a run before its first request reached the provider
 *   (the operation lease's fence, a refused bearer after a 401, a bearer
 *   the provider cannot use) is a `SubscriptionCoreVideoDispatchRejected`:
 *   verified, nothing reached the provider.
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

/** Verified: nothing reached the provider in this run. */
export class SubscriptionCoreVideoDispatchRejected extends Error {
  constructor() {
    super("The video operation could not reach the provider on its subscription connection");
    this.name = "SubscriptionCoreVideoDispatchRejected";
  }
}

async function sessionScope(db: Database, context: SessionContext) {
  const owner = await readSubscriptionCoreSessionOwner(db, context);
  if (!owner) return null;
  return {
    kind: "session" as const,
    ...context,
    sessionOwnerSubjectId: owner.ownerSubjectId,
  };
}

/**
 * The video funding lease for this session, or null when no shared
 * connection can fund it (none assigned, or every one's stored quota is
 * exhausted now: the provider would refuse the start).
 */
export async function subscriptionCoreVideoGenerationCredentialLease(
  db: Database,
  settings: Settings,
  provider: SubscriptionCoreProvider,
  fundingSource: VideoGenerationCredentialLease["fundingSource"],
  context: SessionContext,
): Promise<VideoGenerationCredentialLease | null> {
  const encryptionKey = environmentsEncryptionKeyBytes(settings);
  if (!encryptionKey) return null;
  const scope = await sessionScope(db, context);
  if (!scope) return null;
  const connections = subscriptionCoreOperationConnections(provider);
  const candidates = await connections.listSubscriptionCoreOperationCandidates(db, scope);
  if (candidates.length === 0) return null;
  const exhausted = await connections.readSubscriptionCoreExhaustedConnectionIds(
    db,
    scope,
    candidates.map((candidate) => candidate.connectionId),
  );
  const selected = candidates.find((candidate) => !exhausted.has(candidate.connectionId));
  if (!selected) return null;
  return Object.freeze({
    fundingSource,
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
 * cannot be read or used (a relogin, a revoked or unassigned connection):
 * nothing reached the provider. `bearer` maps the core token to the
 * provider client's bearer inside the pre-dispatch guard.
 */
export async function withSubscriptionCoreVideoConnection<T, Bearer>(
  db: Database,
  settings: Settings,
  provider: SubscriptionCoreProvider,
  operation: { id: string; accountId: string; workspaceId: string; sessionId: string | null },
  connectionId: string,
  bearer: (token: SubscriptionCoreConnectionToken) => Bearer,
  run: (connection: {
    auth: { getToken: () => Promise<Bearer>; refresh: () => Promise<Bearer> };
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
  // Requests that reached the transport, after the core's custody reservation
  // committed (a 401 generated nothing).
  let dispatched = 0;
  const transport = deps.fetchImpl ?? fetch;
  const countedTransport: SubscriptionCoreFetch = async (input, init) => {
    dispatched += 1;
    const response = await transport(input, init);
    if (response.status === 401) dispatched -= 1;
    return response;
  };
  const ran = await subscriptionCoreOperationConnections(provider).runSubscriptionCoreOperation(
    db,
    settings,
    scope,
    {
      candidates: [connectionId],
      operationKind: "video",
      holderId: `video:${operation.id}`,
      fetchImpl: countedTransport,
    },
    async ({ resolver, fetch: custody, fence }) => {
      try {
        bearer(await resolver.getToken());
      } catch {
        return unreadable;
      }
      const beforeDispatch = async <R>(step: () => Promise<R>): Promise<R> => {
        try {
          return await step();
        } catch (error) {
          if (dispatched === 0) throw new SubscriptionCoreVideoDispatchRejected();
          throw error;
        }
      };
      const fenced: SubscriptionCoreFetch = async (input, init) => {
        // Pre-dispatch fence on the exact operation lease.
        const held = await beforeDispatch(fence);
        if (!held) {
          if (dispatched === 0) throw new SubscriptionCoreVideoDispatchRejected();
          throw new Error("The video operation lease was lost");
        }
        // A refused custody reservation never reached the transport.
        return await beforeDispatch(() => custody(input, init));
      };
      return {
        value: await run({
          auth: {
            getToken: () => beforeDispatch(async () => bearer(await resolver.getToken())),
            refresh: () => beforeDispatch(async () => bearer(await resolver.refresh())),
          },
          fetch: fenced,
        }),
      };
    },
  );
  if (ran.kind === "unavailable" || ran.value === unreadable) return { kind: "unavailable" };
  return { kind: "ran", value: ran.value.value };
}
