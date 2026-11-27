import { AccountDeletionPreview, StartAccountDeletionResponse } from "@opengeni/contracts";
import { createBrowserAccountsClient } from "@opengeni/sdk/accounts";
import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { apiBaseUrl, currentManagedActorEpoch, managedActorFetch } from "@/api";

export const ACCOUNT_DELETION_RECEIPT = "opengeni:account-deletion-requested";

export function createAccountDeletionApi(mode: "legacy" | "dual" | "broker") {
  const actorEpoch = currentManagedActorEpoch();
  function assertActor() {
    if (actorEpoch !== currentManagedActorEpoch()) {
      throw new DOMException("The browser account changed", "AbortError");
    }
  }
  function client(headers?: Record<string, string>) {
    return new OpenGeniBrowserClient({
      baseUrl: apiBaseUrl,
      ...(headers ? { headers } : {}),
      readRetry: false,
      fetch: (input, init) => {
        assertActor();
        return managedActorFetch(input, { ...init, credentials: "include" });
      },
    });
  }
  return {
    async preview(signal?: AbortSignal) {
      assertActor();
      const body = await client().getAccountDeletion({ signal });
      assertActor();
      return AccountDeletionPreview.parse(body);
    },
    async start(operationId: string) {
      assertActor();
      const headers: Record<string, string> = {};
      if (mode !== "legacy") {
        const projection = await createBrowserAccountsClient({
          baseUrl: apiBaseUrl,
          fetch: managedActorFetch,
        }).getSessionSet();
        assertActor();
        if (!projection.selectedSlotId || projection.actorEpoch !== actorEpoch) {
          throw new DOMException("The browser account changed", "AbortError");
        }
        headers["x-opengeni-session-csrf"] = projection.csrfToken;
        headers["x-opengeni-actor-epoch"] = projection.actorEpoch;
      }
      const body = await client(headers).requestAccountDeletion({ confirm: "DELETE", operationId });
      assertActor();
      return StartAccountDeletionResponse.parse(body);
    },
  };
}
