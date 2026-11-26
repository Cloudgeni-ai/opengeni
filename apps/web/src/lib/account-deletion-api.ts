import {
  AccountDeletionPreview,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  StartAccountDeletionResponse,
} from "@opengeni/contracts";
import { createBrowserAccountsClient } from "@opengeni/sdk/accounts";
import {
  apiBaseUrl,
  apiErrorFromResponseBody,
  currentManagedActorEpoch,
  managedActorFetch,
} from "@/api";

export const ACCOUNT_DELETION_RECEIPT = "opengeni:account-deletion-requested";

export function createAccountDeletionApi(mode: "legacy" | "dual" | "broker") {
  const actorEpoch = currentManagedActorEpoch();
  function assertActor() {
    if (actorEpoch !== currentManagedActorEpoch()) {
      throw new DOMException("The browser account changed", "AbortError");
    }
  }
  async function request(init?: RequestInit) {
    assertActor();
    const response = await managedActorFetch(`${apiBaseUrl}/v1/me/account-deletion`, {
      credentials: "include",
      ...init,
      headers: {
        "content-type": "application/json",
        [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        ...init?.headers,
      },
    });
    const body = await response.text();
    assertActor();
    if (!response.ok) throw apiErrorFromResponseBody(response.status, body);
    return JSON.parse(body) as unknown;
  }
  return {
    preview: async (signal?: AbortSignal) =>
      AccountDeletionPreview.parse(await request({ signal })),
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
      return StartAccountDeletionResponse.parse(
        await request({
          method: "POST",
          headers,
          body: JSON.stringify({ confirm: "DELETE", operationId }),
        }),
      );
    },
  };
}
