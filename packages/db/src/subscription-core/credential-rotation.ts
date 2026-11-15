/**
 * The one credential rotation every subscription-core refresh runs, inside a
 * chat turn or outside one (operations, usage reads, administered
 * connections). The caller supplies the authority-specific writes; the
 * rotation decides what is persisted, so every path stores the same facts,
 * including the plan the new token reports.
 */
import { subscriptionCoreCredentialRefresher } from "@opengeni/subscriptions";

import type { Database } from "../database";

import { decryptEnvironmentValue, encryptEnvironmentValue } from "../environment-crypto";

import type { SubscriptionCoreProvider } from "./provider";

/**
 * The writes of one credential refresh, under the caller's authority (each
 * runs in the caller's transaction): `begin` takes the per-connection
 * refresh lock, rechecks the caller's access and returns the stored
 * credential to rotate (null: refused); `persist` stores the rotated
 * credential and the plan it reports, and `fail` marks the connection
 * needs-relogin, each fenced on the refresh generation `begin` returned.
 */
export type SubscriptionCoreCredentialRefreshWriter = {
  begin(tx: Database): Promise<{ refreshGeneration: number; credentialEncrypted: string } | null>;
  persist(
    tx: Database,
    input: {
      refreshGeneration: number;
      credentialEncrypted: string;
      expiresAt: Date | null;
      refreshedAt: Date;
      /** The plan the rotated credential reports; null keeps the recorded plan. */
      planType: string | null;
    },
  ): Promise<boolean>;
  fail(tx: Database, input: { refreshGeneration: number; message: string }): Promise<boolean>;
};

export type SubscriptionCoreCredentialRotationOutcome =
  | {
      kind: "refreshed";
      /** The rotated credential, already persisted. */
      credential: unknown;
      refreshGeneration: number;
      /** The plan the rotated credential reported (persisted with it). */
      planType: string | null;
    }
  /** Another refresh or credential writer already advanced the generation. */
  | { kind: "superseded" }
  | { kind: "relogin"; message: string; marked: boolean }
  | { kind: "refused" }
  | { kind: "error"; error: unknown };

/** Decrypt and decode a stored credential with the provider's codec. */
export function decodeSubscriptionCoreCredential(
  provider: SubscriptionCoreProvider,
  key: Uint8Array,
  encrypted: string,
): unknown {
  let plaintext: string;
  try {
    plaintext = decryptEnvironmentValue(key, encrypted);
  } catch {
    // Fixed text and no cause: never echo ciphertext or key material.
    throw new Error(`A core ${provider.adapter.displayName} credential could not be decrypted`);
  }
  // The adapter throws fixed text for malformed plaintext (never echoing it).
  return provider.adapter.credential.decode(plaintext);
}

/**
 * One credential refresh in the caller's transaction, through the caller's
 * writer: `begin` (lock and recheck), the adapter's rotation, then
 * `persist` before any other fallible work (a rolled-back transaction
 * would discard the only valid refresh token), or `fail` when only a new
 * sign-in recovers. Failures are returned, never thrown, so a status write
 * commits.
 */
export async function rotateSubscriptionCoreCredential(
  tx: Database,
  provider: SubscriptionCoreProvider,
  key: Uint8Array,
  writer: SubscriptionCoreCredentialRefreshWriter,
  observedRefreshGeneration: number,
  now: () => Date,
): Promise<SubscriptionCoreCredentialRotationOutcome> {
  const credential = await writer.begin(tx);
  if (!credential) return { kind: "refused" };
  const generation = credential.refreshGeneration;
  if (generation !== observedRefreshGeneration) return { kind: "superseded" };
  let current: unknown;
  try {
    current = decodeSubscriptionCoreCredential(provider, key, credential.credentialEncrypted);
  } catch (error) {
    return { kind: "error", error };
  }
  // Renewal depends on the credential's format, never on the provider.
  const refresher = subscriptionCoreCredentialRefresher(provider.adapter, current);
  if (!refresher) {
    // A credential that never renews (an API key, a setup token) is
    // refreshed only when it expired or the provider refused it: only a new
    // sign-in recovers.
    const message = provider.adapter.reloginText("");
    const marked = await writer.fail(tx, { refreshGeneration: generation, message });
    return { kind: "relogin", message, marked };
  }
  try {
    const rotated = await refresher.rotate(current);
    // Persist before any other fallible work: a rolled-back transaction
    // would discard the only valid refresh token.
    const persisted = await writer.persist(tx, {
      refreshGeneration: generation,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        provider.adapter.credential.encode(rotated.credential),
      ),
      expiresAt: rotated.expiresAt ?? null,
      refreshedAt: now(),
      planType: rotated.planType ?? null,
    });
    if (!persisted) return { kind: "superseded" };
    return {
      kind: "refreshed",
      credential: rotated.credential,
      refreshGeneration: generation + 1,
      planType: rotated.planType ?? null,
    };
  } catch (error) {
    const relogin = refresher.reloginMessage(error);
    if (relogin !== null) {
      const marked = await writer.fail(tx, {
        refreshGeneration: generation,
        message: provider.adapter.reloginText(relogin),
      });
      return { kind: "relogin", message: relogin, marked };
    }
    return { kind: "error", error };
  }
}
