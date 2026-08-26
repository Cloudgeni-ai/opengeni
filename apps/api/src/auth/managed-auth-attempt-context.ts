import { AsyncLocalStorage } from "node:async_hooks";

type ManagedAuthAttemptContext =
  | { kind: "isolated_transaction"; transactionId: string }
  | { kind: "discard_provider_session" };

const managedAuthAttemptStorage = new AsyncLocalStorage<ManagedAuthAttemptContext>();

export function runManagedAuthAttempt<T>(transactionId: string, action: () => T): T {
  return managedAuthAttemptStorage.run({ kind: "isolated_transaction", transactionId }, action);
}

export function runManagedAuthDiscardedProviderSession<T>(action: () => T): T {
  return managedAuthAttemptStorage.run({ kind: "discard_provider_session" }, action);
}

export function currentManagedAuthAttemptId(): string | null {
  const context = managedAuthAttemptStorage.getStore();
  return context?.kind === "isolated_transaction" ? context.transactionId : null;
}

export function shouldDiscardCurrentManagedAuthProviderSession(): boolean {
  return managedAuthAttemptStorage.getStore()?.kind === "discard_provider_session";
}
