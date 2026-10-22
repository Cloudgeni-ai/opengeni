import { chromeSetupCardPayload, CONNECTED_MACHINE_CAPABILITY_ID } from "@opengeni/core";
import { appendTurnCapabilityCardOnce } from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";

type AppendCardOnce = typeof appendTurnCapabilityCardOnce;
type PublishEvents = typeof publishDurableSessionEvents;

export type ChromeSetupCardInput = {
  db: Parameters<AppendCardOnce>[0];
  bus: Parameters<PublishEvents>[0];
  /** Connected Machines are enabled on this deployment; without them Chrome can't connect. */
  enabled: boolean;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  executionGeneration: number;
  attemptId: string;
  append?: AppendCardOnce;
  publish?: PublishEvents;
};

/**
 * Posts the Chrome setup card (the Connected Machine card for the person's own
 * Chrome) in the calling turn, at most once per turn: a later browser_open in
 * the same turn reuses the card already shown. The append runs under the
 * attempt fence, so a replaced turn posts nothing. Undefined when Connected
 * Machines are off, since the card could not help.
 */
export function chromeSetupCardPoster(
  input: ChromeSetupCardInput,
): (() => Promise<boolean>) | undefined {
  if (!input.enabled) return undefined;
  const append = input.append ?? appendTurnCapabilityCardOnce;
  const publish = input.publish ?? publishDurableSessionEvents;
  return async () => {
    const appended = await append(
      input.db,
      input.workspaceId,
      input.sessionId,
      input.turnId,
      input.executionGeneration,
      input.attemptId,
      CONNECTED_MACHINE_CAPABILITY_ID,
      { type: "tool.auth_needed", payload: chromeSetupCardPayload("browser_open") },
    );
    await publish(input.bus, input.workspaceId, input.sessionId, appended.events);
    return appended.accepted;
  };
}
