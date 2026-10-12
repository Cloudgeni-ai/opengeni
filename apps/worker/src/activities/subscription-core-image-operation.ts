/**
 * A turn's image operation on the shared subscription core, for any
 * provider whose image client takes a custody fetch (design 5.3, EP-N09 and
 * EP-N10; the Codex image path, M3 PR 2c, keeps its own dispatch hooks).
 *
 * It runs on the turn's own placed connection under the accepted turn's
 * authority, with its own `image` operation lease keyed by the ledger's
 * operation id, the bearer from the core connection seam (refresh only
 * under the core lock) and every physical request through the core's
 * request custody. The chat-turn lease is checked, never taken, and the
 * session binding is never read or written.
 *
 * Anything that stops the operation before its first request reached the
 * provider (the chat lease or the operation lease is gone, the bearer
 * cannot be read or mapped to the provider client's bearer) is a
 * `SubscriptionCoreImageDispatchRejected`: the ledger returns the operation
 * to `prepared` instead of `outcome_unknown`.
 */
import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  subscriptionCoreOperationConnections,
  type Database,
  type SubscriptionCoreConnectionToken,
  type SubscriptionCoreFetch,
  type SubscriptionCoreProvider,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";

/** Verified: nothing reached the provider. */
export class SubscriptionCoreImageDispatchRejected extends Error {
  constructor() {
    super("The image operation could not start on its subscription connection");
    this.name = "SubscriptionCoreImageDispatchRejected";
  }
}

export async function runSubscriptionCoreImageOperation<T, Bearer>(
  input: {
    db: Database;
    settings: Settings;
    provider: SubscriptionCoreProvider;
    identity: SubscriptionCoreTurnIdentity;
    connectionId: string;
    attemptId: string;
    executionGeneration: number;
    /** The image ledger's operation id (keys the operation lease). */
    operationId: string;
    toolCallId: string;
    /** The turn's chat-lease dispatch fence: the live attempt still holds the chat lease. */
    assertChatLease: () => Promise<void>;
    /** Maps the core token to the provider client's bearer (inside the pre-dispatch guard). */
    bearer: (token: SubscriptionCoreConnectionToken) => Bearer;
    fetchImpl?: SubscriptionCoreFetch;
  },
  generate: (operation: {
    auth: { getToken: () => Promise<Bearer>; refresh: () => Promise<Bearer> };
    fetch: SubscriptionCoreFetch;
  }) => Promise<T>,
): Promise<T> {
  // Requests that reached the transport, after the core's custody reservation
  // committed (a 401 generated nothing). Until one did, every failure is a
  // verified pre-dispatch rejection.
  let dispatched = 0;
  const transport = input.fetchImpl ?? fetch;
  const countedTransport: SubscriptionCoreFetch = async (url, init) => {
    dispatched += 1;
    const response = await transport(url, init);
    if (response.status === 401) dispatched -= 1;
    return response;
  };
  const beforeDispatch = async <R>(step: () => Promise<R>): Promise<R> => {
    let result: R;
    try {
      result = await step();
    } catch {
      if (dispatched === 0) throw new SubscriptionCoreImageDispatchRejected();
      throw new Error("The image operation lost its subscription lease");
    }
    if (result === false) {
      if (dispatched === 0) throw new SubscriptionCoreImageDispatchRejected();
      throw new Error("The image operation lost its subscription lease");
    }
    return result;
  };
  await beforeDispatch(input.assertChatLease);
  let ran: { kind: "ran"; value: T } | { kind: "unavailable" };
  try {
    ran = await subscriptionCoreOperationConnections(input.provider).runSubscriptionCoreOperation(
      input.db,
      input.settings,
      { kind: "turn", identity: input.identity },
      {
        candidates: [input.connectionId],
        operationKind: "image",
        operationId: input.operationId,
        attemptId: input.attemptId,
        generation: input.executionGeneration,
        // Bounded (the column allows 256 characters): tool-call ids are provider-supplied.
        holderId: `image:${createHash("sha256").update(`${input.attemptId}\0${input.toolCallId}`).digest("hex")}`,
        fetchImpl: countedTransport,
      },
      async ({ resolver, fetch: custody, fence }) =>
        await generate({
          auth: {
            getToken: () => beforeDispatch(async () => input.bearer(await resolver.getToken())),
            refresh: () => beforeDispatch(async () => input.bearer(await resolver.refresh())),
          },
          fetch: async (url, init) => {
            await beforeDispatch(input.assertChatLease);
            await beforeDispatch(fence);
            return await custody(url, init);
          },
        }),
    );
  } catch (error) {
    // Lease acquisition, a refused custody reservation, or anything else
    // before the first request reached the transport: nothing was sent.
    if (dispatched === 0 && !(error instanceof SubscriptionCoreImageDispatchRejected)) {
      throw new SubscriptionCoreImageDispatchRejected();
    }
    throw error;
  }
  if (ran.kind === "unavailable") throw new SubscriptionCoreImageDispatchRejected();
  return ran.value;
}
