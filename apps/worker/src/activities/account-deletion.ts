import { firstPartyMcpInternalBaseUrl } from "@opengeni/config";
import { z } from "zod";
import type { ControlActivityServices } from "./types";

const outcome = z.discriminatedUnion("done", [
  z.object({ done: z.literal(true) }),
  z.object({ done: z.literal(false), waitMs: z.number().int().nonnegative() }),
]);

export type AccountDeletionWorkHandle = { requestId: string; ticket: string };

export function createAccountDeletionActivities(services: () => Promise<ControlActivityServices>) {
  return {
    async advanceAccountDeletion(input: AccountDeletionWorkHandle) {
      const { settings } = await services();
      const origin = firstPartyMcpInternalBaseUrl(settings);
      const endpoint = new URL(
        `/_og/internal/account-deletion/${encodeURIComponent(input.requestId)}`,
        origin,
      );
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${input.ticket}` },
        redirect: "error",
        signal: AbortSignal.timeout(75_000),
      });
      if (!response.ok)
        throw new Error(`Account deletion coordinator unavailable (HTTP ${response.status})`);
      return outcome.parse(await response.json());
    },
  };
}
