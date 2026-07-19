/**
 * Establish the Temporal handoff before the first model-completion mutation,
 * then persist conversation truth, accounting, and the exact audit event in
 * their required order. The callbacks are intentionally persistence-only.
 */
export async function persistCompletedModelCallReceipt<T>(input: {
  establishHandoff: () => void;
  confirmOwnership?: () => Promise<void>;
  persistHistory: () => Promise<void>;
  persistMetering: () => Promise<void>;
  persistEvent: () => Promise<T>;
}): Promise<T> {
  input.establishHandoff();
  await input.confirmOwnership?.();
  await input.persistHistory();
  await input.persistMetering();
  return await input.persistEvent();
}
