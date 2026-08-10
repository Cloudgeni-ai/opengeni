import {
  decodeEditableArtifactBrokerHint,
  editableArtifactLiveHintSubject,
  type EditableArtifactLiveHintPort,
} from "@opengeni/core";
import type { EventBus, OpStreamConnection } from "@opengeni/events";

/**
 * Uses the API's existing resilient NATS connection. Hints carry no operation
 * bytes; every callback causes a durable DB head read and contiguous gap-fill.
 */
export class EventBusEditableArtifactLiveHints implements EditableArtifactLiveHintPort {
  constructor(private readonly bus: Pick<EventBus, "getOpStreamConnection">) {}

  async subscribe(
    input: Parameters<EditableArtifactLiveHintPort["subscribe"]>[0],
  ): Promise<() => void> {
    const connection = this.bus.getOpStreamConnection?.();
    if (!connection) throw new Error("Event bus has no artifact hint subscription transport");
    const subject = editableArtifactLiveHintSubject(input.scope, input.artifactId);
    const subscription = connection.subscribe(subject);
    let active = true;
    try {
      await requireFlushBarrier(connection);
    } catch (error) {
      subscription.unsubscribe();
      throw error;
    }
    void (async () => {
      try {
        for await (const message of subscription) {
          if (!active) return;
          try {
            const hint = decodeEditableArtifactBrokerHint(message.data, {
              scope: input.scope,
              artifactId: input.artifactId,
            });
            input.onHint({
              artifactId: input.artifactId,
              headSequence: hint.headSequence,
            });
          } catch {
            // Broker input is advisory and untrusted. Drop poison; periodic
            // durable reconciliation remains authoritative.
          }
        }
      } catch {
        if (active) input.onReconnect();
      }
    })();
    return () => {
      if (!active) return;
      active = false;
      subscription.unsubscribe();
    };
  }
}

async function requireFlushBarrier(connection: OpStreamConnection): Promise<void> {
  if (!connection.flush) {
    throw new Error("Artifact hint subscription transport lacks a flush barrier");
  }
  await connection.flush();
}
