/**
 * Shared service connections: a workspace-owned API-key connection whose
 * stored credential holds `{{secret:…}}` references to workspace or
 * organization vault items instead of the key itself. The reference is what
 * Opengeni stores; the server swaps in the value only for the one request it
 * sends to the tool, under the connection's own vault reach (never anyone's
 * Only me vault or a chat's task vault). See docs/secrets.md.
 */
import {
  containsSecretReference,
  findInvalidSecretReferences,
  findSecretReferences,
} from "./secret-references";

/** `connections.metadata.credentialSource` of a shared service connection. */
export const VAULT_CREDENTIAL_SOURCE = "vault" as const;

/** Whether any header value holds a secret reference. */
export function credentialHeadersHaveSecretReferences(headers: Record<string, string>): boolean {
  return Object.values(headers).some((value) => containsSecretReference(value));
}

/**
 * The references a shared key's headers name, once each, in header order.
 * Throws when a value holds a malformed reference, so nothing half-parsed is
 * stored.
 */
export function credentialHeaderReferences(headers: Record<string, string>): string[] {
  const seen = new Set<string>();
  for (const value of Object.values(headers)) {
    if (findInvalidSecretReferences(value).length > 0)
      throw new Error("A header holds a malformed secret reference.");
    for (const reference of findSecretReferences(value)) seen.add(reference.raw);
  }
  return [...seen];
}

/** Whether a connection's metadata marks a shared service connection. */
export function isVaultCredentialConnection(metadata: Record<string, unknown> | null | undefined) {
  return metadata?.credentialSource === VAULT_CREDENTIAL_SOURCE;
}
