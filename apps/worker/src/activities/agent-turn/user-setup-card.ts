import { sessionChatUrl } from "@opengeni/contracts";
import { CONNECTED_MACHINE_CAPABILITY_ID, userSetupCardPayload } from "@opengeni/core";
import { appendTurnCapabilityCardOnce } from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import type { UserSetupCardPoster } from "@opengeni/runtime";

type AppendCardOnce = typeof appendTurnCapabilityCardOnce;
type PublishEvents = typeof publishDurableSessionEvents;

export type UserSetupCardInput = {
  db: Parameters<AppendCardOnce>[0];
  bus: Parameters<PublishEvents>[0];
  /** Connected Machines are enabled on this deployment; their cards can't help otherwise. */
  connectedMachinesEnabled: boolean;
  /** The web app's base URL, for the chat link the agent can hand out. */
  webBaseUrl: string | null | undefined;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  executionGeneration: number;
  attemptId: string;
  append?: AppendCardOnce;
  publish?: PublishEvents;
};

/**
 * Posts the setup card for a tool refusal the person can fix (see
 * USER_SETUP_BLOCKERS) in the calling turn, at most once per turn and card: a
 * later refusal in the same turn reuses the card already shown. The append
 * runs under the attempt fence, so a replaced turn posts nothing. Resolves
 * "unavailable" when the card can't help on this deployment, and null when it
 * was not posted.
 */
export function userSetupCardPoster(input: UserSetupCardInput): UserSetupCardPoster {
  const append = input.append ?? appendTurnCapabilityCardOnce;
  const publish = input.publish ?? publishDurableSessionEvents;
  return async (blocker, toolName, options) => {
    if (
      blocker.capabilityId === CONNECTED_MACHINE_CAPABILITY_ID &&
      !input.connectedMachinesEnabled
    ) {
      return "unavailable";
    }
    // A machine card names the machine the agent asked for, so it leads with
    // allowing that machine, and a refusal for another machine gets its own.
    const requestedSandboxId = options?.requestedSandboxId?.toLowerCase() ?? null;
    const payload = userSetupCardPayload(blocker, { toolName, requestedSandboxId });
    if (!payload) return null;
    const appended = await append(
      input.db,
      input.workspaceId,
      input.sessionId,
      input.turnId,
      input.executionGeneration,
      input.attemptId,
      blocker.capabilityId,
      { type: "tool.auth_needed", payload },
      requestedSandboxId,
    );
    await publish(input.bus, input.workspaceId, input.sessionId, appended.events);
    if (!appended.accepted) return null;
    return { chatUrl: sessionChatUrl(input.webBaseUrl, input.workspaceId, input.sessionId) };
  };
}
