/**
 * Shared service connections (docs/secrets.md): a workspace-owned API-key
 * connection whose stored headers hold `{{secret:…}}` references to
 * workspace or organization vault items. The values are read here, only for
 * the one request the caller is about to send, under the connection's own
 * vault reach (`service_connection`): never an Only me vault, never a task
 * vault, and never the reach of whoever's call it is. Every read is audited
 * as `vault.secret.used` with the connection id and never the value.
 */
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  SecretReferenceError,
  collectInvalidReferencesDeep,
  collectReferencesDeep,
  referenceKey,
  replaceReferencesDeep,
  secretValueAtDispatch,
  type SecretPrincipal,
} from "@opengeni/contracts";
import type { CredentialReferenceResolution, Database } from "@opengeni/db";
import type { VaultProviderRegistry } from "@opengeni/vaults";
import { createSecretResolver } from "./secret-resolver";

export type ServiceConnectionCredentialDeps = {
  db: Database;
  settings: Settings;
  /**
   * Connected vaults (1Password, host, external) as the workspace itself
   * reaches them, with no acting person (`subjectId: null`).
   */
  providers?: ((workspaceId: string) => VaultProviderRegistry) | undefined;
};

/** Why a shared key could not be read, without the reference or any value. */
export class ServiceConnectionCredentialError extends Error {
  readonly code: "not_found" | "denied" | "unavailable" | "invalid";
  constructor(code: ServiceConnectionCredentialError["code"], message: string) {
    super(message);
    this.name = "ServiceConnectionCredentialError";
    this.code = code;
  }
}

const FAILURE_MESSAGES: Record<ServiceConnectionCredentialError["code"], string> = {
  not_found:
    "The shared key's vault item wasn't found in a workspace or organization vault that works here.",
  denied: "The shared key's vault item isn't one this workspace's shared connections may use.",
  unavailable: "The vault holding the shared key can't be read right now. Try again shortly.",
  invalid: "The shared key isn't a text value a request header can carry.",
};

function failureCode(error: SecretReferenceError): ServiceConnectionCredentialError["code"] {
  const codes = new Set(error.failures.map((failure) => failure.code));
  if (codes.has("denied") || codes.has("approval_required")) return "denied";
  if (
    codes.has("provider_unavailable") ||
    codes.has("provider_rate_limited") ||
    codes.has("provider_auth_expired")
  )
    return "unavailable";
  if (codes.has("not_found") || codes.has("ambiguous") || codes.has("no_primary_field"))
    return "not_found";
  return "invalid";
}

export type ServiceConnectionHeaderInput = Omit<CredentialReferenceResolution, "connection"> & {
  connection: Omit<CredentialReferenceResolution["connection"], "id"> & {
    /** Null while an admin checks a key before the connection exists. */
    id: string | null;
  };
};

/**
 * Resolve a shared key's headers for one request. Throws
 * `ServiceConnectionCredentialError` (fail closed) when a reference is
 * malformed, missing, out of reach, gated by "ask me each time", or not a
 * text value.
 */
export async function resolveServiceConnectionHeaders(
  deps: ServiceConnectionCredentialDeps,
  input: ServiceConnectionHeaderInput,
): Promise<Record<string, string>> {
  if (collectInvalidReferencesDeep(input.headers).length > 0)
    throw new ServiceConnectionCredentialError(
      "invalid",
      "The shared key's reference is malformed.",
    );
  const references = collectReferencesDeep(input.headers);
  if (references.some((reference) => reference.kind !== "secret"))
    throw new ServiceConnectionCredentialError("invalid", FAILURE_MESSAGES.invalid);
  if (references.length === 0) return { ...input.headers };
  const principal: SecretPrincipal = {
    kind: "service_connection",
    accountId: input.connection.accountId,
    workspaceId: input.connection.workspaceId,
    connectionId: input.connection.id,
  };
  const providers = deps.providers?.(input.connection.workspaceId);
  const resolver = createSecretResolver(
    {
      db: deps.db,
      encryptionKey: environmentsEncryptionKeyBytes(deps.settings) ?? null,
      ...(providers ? { providers } : {}),
    },
    principal,
    { capabilityEnabled: true },
  );
  let destination: string | undefined;
  try {
    destination = new URL(input.destinationUrl).host;
  } catch {
    destination = undefined;
  }
  let resolved: Awaited<ReturnType<typeof resolver.resolve>>;
  try {
    resolved = await resolver.resolve(references, {
      surface: "mcp",
      toolName: input.toolName ?? input.serverId ?? "connection",
      ...(destination ? { destination } : {}),
      ...(input.onBehalfOf && Object.keys(input.onBehalfOf).length > 0
        ? { onBehalfOf: input.onBehalfOf }
        : {}),
    });
  } catch (error) {
    if (error instanceof SecretReferenceError) {
      const code = failureCode(error);
      throw new ServiceConnectionCredentialError(code, FAILURE_MESSAGES[code]);
    }
    throw new ServiceConnectionCredentialError("unavailable", FAILURE_MESSAGES.unavailable);
  }
  const values = new Map<string, string>();
  for (const [key, value] of resolved) {
    const material = await secretValueAtDispatch(value);
    if (typeof material !== "string")
      throw new ServiceConnectionCredentialError("invalid", FAILURE_MESSAGES.invalid);
    values.set(key, material);
  }
  return replaceReferencesDeep(input.headers, (reference) => {
    const value = values.get(referenceKey(reference));
    if (value === undefined)
      throw new ServiceConnectionCredentialError("not_found", FAILURE_MESSAGES.not_found);
    return value;
  });
}

/**
 * The connection resolver option (`resolveCredentialReferences`) for the
 * API's tool gateway and the worker's turns: the same resolution for every
 * path that calls a tool.
 */
export function serviceConnectionCredentialReferences(
  deps: ServiceConnectionCredentialDeps,
): (input: CredentialReferenceResolution) => Promise<Record<string, string>> {
  return async (input) => await resolveServiceConnectionHeaders(deps, input);
}
