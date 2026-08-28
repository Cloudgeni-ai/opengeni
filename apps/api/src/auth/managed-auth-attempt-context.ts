import { AsyncLocalStorage } from "node:async_hooks";

type ManagedAuthAttemptContext =
  | {
      kind: "isolated_transaction";
      transactionId: string;
      providerId: "credential" | "google" | "github";
      createdAuthSessionId: string | null;
    }
  | { kind: "provider"; providerId: "credential" | "google" | "github" }
  | { kind: "discard_provider_session" };

const managedAuthAttemptStorage = new AsyncLocalStorage<ManagedAuthAttemptContext>();

export function runManagedAuthAttempt<T>(
  transactionId: string,
  providerId: "credential" | "google" | "github",
  action: () => T,
): T {
  return managedAuthAttemptStorage.run(
    { kind: "isolated_transaction", transactionId, providerId, createdAuthSessionId: null },
    action,
  );
}

export function runManagedAuthProvider<T>(
  providerId: "credential" | "google" | "github",
  action: () => T,
): T {
  return managedAuthAttemptStorage.run({ kind: "provider", providerId }, action);
}

export function runManagedAuthDiscardedProviderSession<T>(action: () => T): T {
  return managedAuthAttemptStorage.run({ kind: "discard_provider_session" }, action);
}

export function currentManagedAuthAttemptId(): string | null {
  const context = managedAuthAttemptStorage.getStore();
  return context?.kind === "isolated_transaction" ? context.transactionId : null;
}

export function currentManagedAuthProviderId(): "credential" | "google" | "github" {
  const context = managedAuthAttemptStorage.getStore();
  return context?.kind === "isolated_transaction" || context?.kind === "provider"
    ? context.providerId
    : "credential";
}

export function recordCurrentManagedAuthSession(authSessionId: string): void {
  const context = managedAuthAttemptStorage.getStore();
  if (context?.kind === "isolated_transaction") context.createdAuthSessionId = authSessionId;
}

export function currentManagedAuthCreatedSessionId(): string | null {
  const context = managedAuthAttemptStorage.getStore();
  return context?.kind === "isolated_transaction" ? context.createdAuthSessionId : null;
}

export function shouldDiscardCurrentManagedAuthProviderSession(): boolean {
  return managedAuthAttemptStorage.getStore()?.kind === "discard_provider_session";
}
