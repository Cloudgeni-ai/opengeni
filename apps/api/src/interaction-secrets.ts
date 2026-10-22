/**
 * `{{secret:…}}` references in Browser and Computer actions (design §10B.4,
 * BR-1..3). Only agent attempts resolve: the API resolves the references in
 * the secret-bearing fields of an action right before dispatch and sends the
 * plaintext to the controller in the private `secretValues` side map. Human
 * and service callers' text is always typed literally. Agent-owned passkeys
 * ride the same seam: around every agent browser action the API loads the
 * principal's leased passkeys into browserd and pulls registration and
 * assertion events back into the vault.
 */
import {
  type AccessGrant,
  type BrowserPasskeyCredential,
  type BrowserPasskeyCredentialMaterial,
  type BrowserPasskeyEvent,
  type BrowserPasskeySyncRequest,
  type BrowserPasskeySyncResponse,
  buildMissingSecretAskCard,
  containsSecretReference,
  findInvalidSecretReferences,
  findSecretReferences,
  type InteractionSecretValues,
  INTERACTION_PROTOCOL_VERSION,
  isSecretReferenceError,
  referenceKey,
  type SecretClock,
  SecretReferenceError,
  type SecretReferenceFailure,
  type SecretPrincipal,
  type SecretResolver,
  type SecretUseContext,
  secretValueAtDispatch,
} from "@opengeni/contracts";
import { ApiHttpError } from "./http/api-error";

export type AttemptSecretPrincipal = Extract<SecretPrincipal, { kind: "attempt" }>;

/** Vault storage for agent-owned passkeys (F2: `lease_vault_passkeys`,
 * `update_passkey_sign_count`, `release_vault_passkey_leases`). */
export interface InteractionPasskeyStore {
  /** Lease every passkey item the principal may use and no other holder holds. */
  lease(
    principal: AttemptSecretPrincipal,
    holder: string,
    ttlSeconds: number,
  ): Promise<BrowserPasskeyCredential[]>;
  /** Save a passkey the agent just registered; returns the new item. */
  saveRegistered(
    principal: AttemptSecretPrincipal,
    input: { credential: BrowserPasskeyCredentialMaterial; origin: string | null },
  ): Promise<{ itemId: string }>;
  /** Monotonic write-back (`greatest(existing, new)`). */
  updateSignCount(
    principal: AttemptSecretPrincipal,
    itemId: string,
    signCount: number,
  ): Promise<void>;
  release(holder: string): Promise<void>;
}

export interface InteractionSecretsPort {
  /** The principal's resolver, or null when secrets are unavailable here.
   * A resolver with `enabled: false` (capability off) also passes text through
   * literally (Q-35). */
  resolverFor(principal: AttemptSecretPrincipal): Promise<SecretResolver | null>;
  passkeys: InteractionPasskeyStore | null;
  clock?: SecretClock;
}

export type InteractionSecretsLog = (event: string, fields: Record<string, unknown>) => void;

/** The attempt principal of an agent grant. Human, service and incomplete
 * grants have none, so their text is never resolved (BR-1). */
export function attemptSecretPrincipal(grant: AccessGrant): AttemptSecretPrincipal | null {
  if (grant.principalKind !== "agent_attempt") return null;
  const metadata = grant.metadata ?? {};
  const sessionId = metadata["sessionId"];
  const turnId = metadata["turnId"];
  const attemptId = metadata["attemptId"];
  const executionGeneration = metadata["executionGeneration"];
  if (
    typeof sessionId !== "string" ||
    typeof turnId !== "string" ||
    typeof attemptId !== "string" ||
    typeof executionGeneration !== "number" ||
    !Number.isSafeInteger(executionGeneration)
  ) {
    return null;
  }
  return {
    kind: "attempt",
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    turnId,
    attemptId,
    executionGeneration,
  };
}

/** The public failure: nothing was dispatched. `details.secretReference` is
 * the model-facing `{error, failures, askCard, hint}` object; it never
 * contains values. */
export function secretReferenceHttpError(error: SecretReferenceError): ApiHttpError {
  const output = JSON.parse(error.toModelOutput()) as Record<string, unknown>;
  return new ApiHttpError(422, {
    code: "validation_failed",
    message: `${error.message}. ${String(output["hint"] ?? "")}`.trim(),
    retryable: false,
    outcomeUnknown: false,
    details: { reason: "secret_reference_error", secretReference: output },
  });
}

function referenceFailure(
  raw: string,
  code: SecretReferenceFailure["code"],
  message: string,
): SecretReferenceFailure {
  return { raw, code, message };
}

/** Every string in a JSON-like value (native desktop call arguments). */
export function collectStringsDeep(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value))
    for (const entry of value) collectStringsDeep(entry, out, depth + 1);
  else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) collectStringsDeep(entry, out, depth + 1);
  }
  return out;
}

/**
 * Resolve the references in `texts` for an agent grant. Returns undefined
 * when the text must be dispatched literally (non-agent caller, no marker,
 * secrets unavailable or off). Returns a (possibly empty) side map otherwise;
 * an empty map still tells the controller to remove `\{{secret:…}}` escapes.
 * TOTP codes are computed last, at dispatch (Q-33). Throws ApiHttpError(422)
 * before anything is dispatched when any reference fails (I2).
 */
export async function resolveInteractionSecretValues(input: {
  port: InteractionSecretsPort | null | undefined;
  grant: AccessGrant;
  texts: readonly string[];
  use: SecretUseContext;
  /** Runs once the text is known to carry references for an agent with
   * secrets enabled, before anything resolves: a controller that cannot
   * accept secret values refuses here, with nothing used or dispatched. */
  beforeResolve?: () => Promise<void>;
}): Promise<InteractionSecretValues | undefined> {
  const { port, grant, texts, use, beforeResolve } = input;
  if (!port) return undefined;
  if (!texts.some((text) => containsSecretReference(text))) return undefined;
  const principal = attemptSecretPrincipal(grant);
  if (!principal) return undefined;
  const resolver = await port.resolverFor(principal);
  if (!resolver || !resolver.enabled) return undefined;
  await beforeResolve?.();
  const failures: SecretReferenceFailure[] = [];
  for (const text of texts) {
    for (const invalid of findInvalidSecretReferences(text)) {
      failures.push(
        referenceFailure(invalid.raw, "invalid_reference", `invalid reference: ${invalid.reason}`),
      );
    }
  }
  const references = texts.flatMap((text) => findSecretReferences(text));
  for (const reference of references) {
    if (reference.kind === "secretfile") {
      failures.push(
        referenceFailure(
          reference.raw,
          "secretfile_not_allowed",
          "{{secretfile:…}} is for commands that read a file path; type the value with {{secret:…}}",
        ),
      );
    }
  }
  if (failures.length > 0) throw secretReferenceHttpError(new SecretReferenceError(failures));
  if (references.length === 0) return {};
  let resolved;
  try {
    resolved = await resolver.resolve(references, use);
  } catch (error) {
    if (isSecretReferenceError(error)) {
      if (error instanceof SecretReferenceError) throw secretReferenceHttpError(error);
      // A structurally equal error from another copy of the contracts module.
      const foreign = error as unknown as {
        failures: SecretReferenceFailure[];
        askCard?: SecretReferenceError["askCard"];
      };
      throw secretReferenceHttpError(
        new SecretReferenceError(
          foreign.failures,
          foreign.askCard ?? buildMissingSecretAskCard(foreign.failures, { hasActingHuman: false }),
        ),
      );
    }
    throw error;
  }
  const values: InteractionSecretValues = {};
  const ordered = [...resolved.values()].sort(
    (left, right) => Number(left.material.type === "totp") - Number(right.material.type === "totp"),
  );
  for (const value of ordered) {
    const material = await secretValueAtDispatch(value, port.clock);
    if (typeof material !== "string") {
      failures.push(
        referenceFailure(
          value.reference.raw,
          "binary_value",
          "this field holds a file; browsers and desktops can only type text",
        ),
      );
      continue;
    }
    values[value.key] = material;
  }
  if (failures.length > 0) throw secretReferenceHttpError(new SecretReferenceError(failures));
  for (const reference of references) {
    if (values[referenceKey(reference)] === undefined) {
      throw secretReferenceHttpError(
        new SecretReferenceError([
          referenceFailure(reference.raw, "not_found", "the reference did not resolve"),
        ]),
      );
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------

export const PASSKEY_LEASE_TTL_SECONDS = 600;
const PASSKEY_LEASE_RENEW_MS = 60_000;
const PASSKEY_SESSION_CACHE_LIMIT = 2_048;

type PasskeySessionState = {
  leasedAtMs: number;
  credentials: BrowserPasskeyCredential[];
  unsupported: boolean;
};

/** Per-process lease cache: renew at most once a minute per browser session
 * (leases last ten minutes and renew on use, Q-32). */
const passkeySessions = new Map<string, PasskeySessionState>();

/** The latest pending sync per BrowserSession; later syncs chain after it. */
const passkeySyncTails = new Map<string, Promise<void>>();

export function resetPasskeySessionCacheForTests(): void {
  passkeySessions.clear();
  passkeySyncTails.clear();
}

/** One lease holder per BrowserSession: every target in it shares the set. */
export function passkeyLeaseHolder(browserSessionId: string): string {
  return browserSessionId;
}

export type PasskeySyncClient = {
  passkeySync(request: BrowserPasskeySyncRequest): Promise<BrowserPasskeySyncResponse>;
};

function isUnsupportedSync(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  const name = (error as { name?: unknown } | null)?.name;
  return status === 404 || status === 405 || name === "BrowserControlUnsupportedError";
}

/**
 * Load the principal's passkeys into the BrowserSession and write back what
 * happened since the last sync. Best effort: a failure is logged and never
 * fails the surrounding action. Unacknowledged events stay in browserd and
 * are retried on the next sync.
 *
 * Syncs for one BrowserSession run one at a time, in call order, so a caller
 * may start the write-back after an action without awaiting it: the next
 * action's sync waits for it instead of racing it on the same events.
 */
export function syncBrowserPasskeys(input: PasskeySyncInput): Promise<PasskeySyncResult> {
  const previous = passkeySyncTails.get(input.browserSessionId);
  const run = (previous ?? Promise.resolve()).then(() => syncBrowserPasskeysNow(input));
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  passkeySyncTails.set(input.browserSessionId, tail);
  void tail.then(() => {
    if (passkeySyncTails.get(input.browserSessionId) === tail) {
      passkeySyncTails.delete(input.browserSessionId);
    }
  });
  return run;
}

type PasskeySyncResult = { saved: number; asserted: number } | null;

type PasskeySyncInput = {
  port: InteractionSecretsPort | null | undefined;
  grant: AccessGrant;
  browserSessionId: string;
  controllerGeneration: string;
  client: PasskeySyncClient;
  /** Lease again now (right before an action), taking over from any other browser. */
  refresh?: boolean;
  now?: () => number;
  log?: InteractionSecretsLog;
};

async function syncBrowserPasskeysNow(input: PasskeySyncInput): Promise<PasskeySyncResult> {
  const store = input.port?.passkeys;
  if (!store) return null;
  const principal = attemptSecretPrincipal(input.grant);
  if (!principal) return null;
  const now = input.now ?? Date.now;
  const holder = passkeyLeaseHolder(input.browserSessionId);
  // Per attempt: a later turn may act for another person, so it leases (and
  // replaces browserd's credential set with) its own passkeys first.
  const cacheKey = `${input.browserSessionId}:${input.controllerGeneration}:${principal.attemptId}`;
  let state = passkeySessions.get(cacheKey);
  if (state?.unsupported) return null;
  const lease = async (): Promise<BrowserPasskeyCredential[]> => {
    const credentials = await store.lease(principal, holder, PASSKEY_LEASE_TTL_SECONDS);
    state = { leasedAtMs: now(), credentials, unsupported: false };
    passkeySessions.delete(cacheKey);
    passkeySessions.set(cacheKey, state);
    while (passkeySessions.size > PASSKEY_SESSION_CACHE_LIMIT) {
      passkeySessions.delete(passkeySessions.keys().next().value!);
    }
    return credentials;
  };
  const request = (
    credentials: BrowserPasskeyCredential[] | null,
    acknowledgeEventIds: string[],
  ): BrowserPasskeySyncRequest => ({
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    browserSessionId: input.browserSessionId,
    controllerGeneration: input.controllerGeneration,
    credentials,
    acknowledgeEventIds,
  });
  try {
    const due =
      input.refresh === true || !state || now() - state.leasedAtMs >= PASSKEY_LEASE_RENEW_MS;
    const credentials = due ? await lease() : null;
    let response: BrowserPasskeySyncResponse;
    try {
      response = await input.client.passkeySync(request(credentials, []));
    } catch (error) {
      if (isUnsupportedSync(error)) {
        passkeySessions.set(cacheKey, {
          leasedAtMs: now(),
          credentials: [],
          unsupported: true,
        });
        await store.release(holder).catch(() => undefined);
        return null;
      }
      throw error;
    }
    if (response.events.length === 0) return { saved: 0, asserted: 0 };
    const processed: string[] = [];
    const itemByCredential = new Map(
      (state?.credentials ?? []).map((credential) => [credential.credentialId, credential.itemId]),
    );
    let saved = 0;
    let asserted = 0;
    for (const event of response.events as BrowserPasskeyEvent[]) {
      try {
        if (event.type === "registered") {
          const existing = itemByCredential.get(event.credential.credentialId);
          if (existing === undefined) {
            const result = await store.saveRegistered(principal, {
              credential: event.credential,
              origin: event.origin,
            });
            itemByCredential.set(event.credential.credentialId, result.itemId);
            saved += 1;
          }
        } else {
          const itemId = event.itemId ?? itemByCredential.get(event.credentialId) ?? null;
          if (itemId !== null) {
            await store.updateSignCount(principal, itemId, event.signCount);
            asserted += 1;
          } else {
            input.log?.("browser.passkey.assertion_unmatched", { rpId: event.rpId });
          }
        }
        processed.push(event.eventId);
      } catch (error) {
        input.log?.("browser.passkey.event_failed", {
          type: event.type,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // New items are loaded with their item IDs so later assertions write back.
    const refreshed = saved > 0 ? await lease() : null;
    await input.client.passkeySync(request(refreshed, processed));
    if (saved > 0 || asserted > 0) {
      input.log?.("browser.passkey.synced", { saved, asserted });
    }
    return { saved, asserted };
  } catch (error) {
    input.log?.("browser.passkey.sync_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Release the BrowserSession's passkey leases (session end). Best effort. */
export async function releaseBrowserPasskeys(
  port: InteractionSecretsPort | null | undefined,
  browserSessionId: string,
): Promise<void> {
  for (const key of [...passkeySessions.keys()]) {
    if (key.startsWith(`${browserSessionId}:`)) passkeySessions.delete(key);
  }
  await port?.passkeys?.release(passkeyLeaseHolder(browserSessionId)).catch(() => undefined);
}
