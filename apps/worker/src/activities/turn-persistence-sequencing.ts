/**
 * Establish the Temporal handoff before the first model-completion mutation,
 * then persist conversation truth, accounting, and the exact audit event in
 * their required order. The callbacks are intentionally persistence-only.
 */
export async function persistCompletedModelCallReceipt<T>(input: {
  establishHandoff: () => Promise<void>;
  confirmOwnership?: () => Promise<void>;
  persistHistory: () => Promise<void>;
  persistMetering: () => Promise<void>;
  persistEvent: () => Promise<T>;
}): Promise<T> {
  await input.establishHandoff();
  await input.confirmOwnership?.();
  await input.persistHistory();
  await input.persistMetering();
  return await input.persistEvent();
}

/**
 * Serialize persistence receipts owned by one live turn attempt.
 *
 * The Agents SDK can start a function-tool invoke while the stream consumer is
 * still settling the model response that authorized it. PostgreSQL deliberately
 * permits only one pending receipt per attempt, so every establish -> durable
 * mutations -> settle region must enter this sequencer before its first await.
 *
 * A failed region poisons the sequencer. Later regions receive the exact same
 * error without running their callback; in particular, a tool cannot establish
 * a new receipt (and therefore cannot execute) after the preceding model result
 * crossed the provider boundary but failed durable persistence.
 */
export class TurnPersistenceSequencer {
  private tail: Promise<void> = Promise.resolve();
  private failure: { error: unknown } | null = null;

  run<T>(persist: () => Promise<T>): Promise<T> {
    const current = this.tail.then(async () => {
      if (this.failure) throw this.failure.error;
      try {
        return await persist();
      } catch (error) {
        this.failure = { error };
        throw error;
      }
    });
    this.tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}
