import { AsyncLocalStorage } from "node:async_hooks";

const managedAuthAttemptStorage = new AsyncLocalStorage<string>();

export function runManagedAuthAttempt<T>(transactionId: string, action: () => T): T {
  return managedAuthAttemptStorage.run(transactionId, action);
}

export function currentManagedAuthAttemptId(): string | null {
  return managedAuthAttemptStorage.getStore() ?? null;
}
