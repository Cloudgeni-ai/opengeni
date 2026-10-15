/**
 * The hosted secret resolver (§10B.2). One database roundtrip returns the
 * principal's facts and every candidate for every reference; candidates are
 * chosen here (archived dropped, lowest tier, names over aliases, otherwise
 * ambiguous), provider values are fetched, hosted values decrypted, and the
 * batch is recorded. A call resolves all of its references or none (I2).
 *
 * A reference that finds nothing first refreshes the connected vaults that
 * could change the answer: those that could hold it at the priority tier that
 * decided the lookup or above, even when a hosted item matched without the
 * field. When one of those could not be checked (unreachable, rate limited,
 * needing reconnection or still refreshing), the failure names that source
 * instead of reporting the secret missing, so no missing-secret ask card is
 * made for a secret that may exist (external vaults §9). Hosted and
 * explicitly named healthy vaults are never blocked by unrelated outages, and
 * lower-priority vaults never block a miss a higher tier decided.
 */
import {
  buildMissingSecretAskCard,
  formatSecretReference,
  isValidTotpInput,
  parseTotpInput,
  referenceKey,
  secretNameKey,
  SecretReferenceError,
  VAULT_LIMITS,
  type ResolvedSecretValue,
  type SecretMaterial,
  type SecretPrincipal,
  type SecretReference,
  type SecretReferenceFailure,
  type SecretResolver,
  type SecretUseContext,
  type VaultProviderFreshness,
} from "@opengeni/contracts";
import {
  decryptEnvironmentValue,
  listVaultsForSubject,
  recordVaultSecretUse,
  resolveSecretReferenceCandidates,
  type SecretReferenceCandidate,
  type SecretReferenceLookup,
  type SecretResolutionMeta,
  type VaultRow,
} from "@opengeni/db";
import {
  createProviderCallBudget,
  EMPTY_VAULT_PROVIDER_REGISTRY,
  isVaultProviderError,
  type ProviderCallBudget,
  type VaultProviderErrorCode,
  type VaultProviderRegistry,
} from "@opengeni/vaults";
import {
  LINKED_VAULT_MISS_MAX_AGE_MS,
  providerVaultFreshness,
  refreshLinkedVaults,
} from "./provider-sync";
import type { VaultServiceDeps } from "./types";

export type SecretResolverOptions = {
  /** `agent.capabilities.secrets`; when false the resolver refuses every reference. */
  capabilityEnabled: boolean;
  /** Provider calls allowed for this attempt (Q-18); a fresh 50-call budget by default. */
  attemptBudget?: ProviderCallBudget;
  /**
   * Connected vaults for callers that only learn the acting human from the
   * lookup itself (browser and computer routes, `run_on`, the tool gateway):
   * 1Password connection tokens load for that subject. `deps.providers` wins.
   */
  providersForSubject?: (subjectId: string | null) => VaultProviderRegistry;
};

type Chosen = { reference: SecretReference; candidate: SecretReferenceCandidate };

function lookupFor(reference: SecretReference, index: number): SecretReferenceLookup {
  return reference.target.form === "id"
    ? {
        index,
        form: "id",
        itemId: reference.target.itemId,
        field: reference.target.field,
        otp: reference.otp,
        previous: reference.previous,
      }
    : {
        index,
        form: "path",
        segments: [...reference.target.segments],
        otp: reference.otp,
        previous: reference.previous,
      };
}

function readyReference(reference: SecretReference, candidate: SecretReferenceCandidate): string {
  const tail = {
    ...(candidate.fieldName !== null ? { field: candidate.fieldName } : {}),
    otp: reference.otp,
    previous: reference.previous,
  };
  try {
    return formatSecretReference({
      kind: reference.kind,
      vault: candidate.vaultName,
      item: candidate.itemName,
      ...tail,
    });
  } catch {
    return formatSecretReference({ kind: reference.kind, itemId: candidate.itemId, ...tail });
  }
}

/** Why a reference without candidates fails: restricted reach is `denied`, else `not_found`. */
function missingCode(meta: SecretResolutionMeta): "denied" | "not_found" {
  if (meta.kind === "attempt" && !meta.agentAllowed) return "denied";
  if (meta.humanExpected && !meta.humanValid) return "denied";
  if (!meta.hasSecretsUse) return "denied";
  return "not_found";
}

function deniedMessage(meta: SecretResolutionMeta): string {
  if (meta.kind === "attempt" && !meta.agentAllowed) {
    return "this agent is not allowed to use secrets (secrets:use)";
  }
  if (meta.humanExpected && !meta.humanValid) {
    return "the person this run acts for no longer has access to this workspace; only the task vault is available";
  }
  return "the person this run acts for cannot use secrets here; only the task vault is available";
}

/**
 * Choose one candidate per reference (§10B.2): drop archived items, keep the
 * lowest tier, prefer names over aliases; more than one remaining target is
 * ambiguous and returns ready references to choose from.
 */
export function chooseSecretCandidate(
  reference: SecretReference,
  candidates: readonly SecretReferenceCandidate[],
  meta: SecretResolutionMeta,
): { candidate: SecretReferenceCandidate } | { failure: SecretReferenceFailure } {
  const live = candidates.filter((candidate) => !candidate.archived);
  if (live.length === 0) {
    const code = missingCode(meta);
    return {
      failure: {
        raw: reference.raw,
        code,
        message: code === "denied" ? deniedMessage(meta) : "no reachable vault item matches",
      },
    };
  }
  const lowestTier = Math.min(...live.map((candidate) => candidate.tier));
  let remaining = live.filter((candidate) => candidate.tier === lowestTier);
  if (remaining.some((candidate) => candidate.matchedBy !== "alias")) {
    remaining = remaining.filter((candidate) => candidate.matchedBy !== "alias");
  }
  const targets = new Map<string, SecretReferenceCandidate>();
  for (const candidate of remaining) {
    targets.set(`${candidate.itemId}|${candidate.fieldId ?? ""}`, candidate);
  }
  if (targets.size > 1) {
    const choices = [...targets.values()].map((candidate) => readyReference(reference, candidate));
    return {
      failure: {
        raw: reference.raw,
        code: "ambiguous",
        message: `${targets.size} vault items match; use one of the candidate references`,
        candidates: [...new Set(choices)].sort(),
      },
    };
  }
  const candidate = [...targets.values()][0]!;
  if (candidate.missing === "primary_field") {
    return {
      failure: {
        raw: reference.raw,
        code: "no_primary_field",
        message: `${candidate.itemName} has no primary field; name the field ({{secret:${candidate.itemName}/field}})`,
      },
    };
  }
  if (candidate.missing !== null) {
    const messages = {
      field: "the item has no field with that name",
      totp_field: "the item has no one-time-password (TOTP) field",
      previous_version: "the field has no previous version",
      value: "the field has no value",
    } as const;
    return {
      failure: { raw: reference.raw, code: "not_found", message: messages[candidate.missing] },
    };
  }
  if (reference.previous && candidate.source !== "opengeni") {
    return {
      failure: {
        raw: reference.raw,
        code: "invalid_reference",
        message: "#previous is not available for connected vaults",
      },
    };
  }
  if (reference.otp && candidate.fieldKind !== "totp") {
    return {
      failure: {
        raw: reference.raw,
        code: "invalid_reference",
        message: `/otp needs a one-time-password field; ${candidate.fieldName ?? "the field"} is not one`,
      },
    };
  }
  return { candidate };
}

function providerFailureCode(code: VaultProviderErrorCode): SecretReferenceFailure["code"] {
  if (code === "provider_rate_limited") return "provider_rate_limited";
  if (code === "provider_auth_expired" || code === "provider_auth_invalid") {
    return "provider_auth_expired";
  }
  if (code === "provider_not_found") return "not_found";
  if (code === "provider_permission_denied") return "denied";
  return "provider_unavailable";
}

/**
 * The connected vaults whose mirror decides a reference that found nothing.
 *
 * Where the item could be: the vault a three-segment reference names; for two
 * segments the named vault when the first segment names one (else every
 * connected vault, since it may be `Item/field`); every connected vault for a
 * bare item name; none for an ID.
 *
 * When some item matched but lacks the field (or the one-time password), the
 * lookup keeps the highest-priority tier, so only vaults at that tier or above
 * can change the answer: the connected vaults of matched items there that lack
 * the field, and the connected vaults that could hold the item there but have
 * no match yet. A hosted match never hides a higher-priority connected vault
 * whose provider gained the item or its one-time password, and a vault of a
 * lower-priority tier that is out of date or unavailable never turns a
 * definite miss into an unchecked one.
 */
export function relevantProviderVaults(
  reference: SecretReference,
  candidates: readonly SecretReferenceCandidate[],
  reachable: readonly VaultRow[],
): VaultRow[] {
  const connected = reachable.filter((vault) => vault.source !== "opengeni");
  if (connected.length === 0) return [];
  const where = possibleProviderVaults(reference, reachable, connected);
  const live = candidates.filter((candidate) => !candidate.archived);
  if (live.length === 0) return where;
  const deciding = Math.min(...live.map((candidate) => candidate.tier));
  const lacking = new Set(
    live
      .filter(
        (candidate) =>
          candidate.tier <= deciding &&
          candidate.source !== "opengeni" &&
          (candidate.missing === "field" || candidate.missing === "totp_field"),
      )
      .map((candidate) => candidate.vaultId),
  );
  const matched = new Set(live.map((candidate) => candidate.vaultId));
  const unmatched = new Set(
    where
      .filter((vault) => vault.tier <= deciding && !matched.has(vault.id))
      .map((vault) => vault.id),
  );
  return connected.filter((vault) => lacking.has(vault.id) || unmatched.has(vault.id));
}

/** The connected vaults a reference's path could point into, matched or not. */
function possibleProviderVaults(
  reference: SecretReference,
  reachable: readonly VaultRow[],
  connected: readonly VaultRow[],
): VaultRow[] {
  if (reference.target.form !== "path") return [];
  const segments = reference.target.segments;
  if (segments.length === 1) return [...connected];
  const nameKey = secretNameKey(segments[0]!);
  const named = reachable.filter((vault) => secretNameKey(vault.name) === nameKey);
  if (segments.length === 2 && named.length === 0) return [...connected];
  return named.filter((vault) => vault.source !== "opengeni");
}

/** A miss that cannot be trusted because a relevant connected vault was not checked. */
function uncheckedSourceFailure(
  reference: SecretReference,
  unchecked: ReadonlyArray<{ vault: VaultRow; freshness: VaultProviderFreshness }>,
): SecretReferenceFailure {
  const authExpired = unchecked.filter(({ vault }) => vault.syncStatus === "auth_expired");
  const rateLimited = unchecked.filter(
    ({ freshness }) => freshness.state === "unavailable" && freshness.retryAt !== null,
  );
  const [code, named, why] =
    authExpired.length > 0
      ? (["provider_auth_expired", authExpired, "needs to be reconnected"] as const)
      : rateLimited.length > 0
        ? (["provider_rate_limited", rateLimited, "is rate limited by its provider"] as const)
        : ([
            "provider_unavailable",
            unchecked,
            unchecked.every(({ freshness }) => freshness.state === "refreshing")
              ? "is still refreshing"
              : "could not be checked",
          ] as const);
  const names = named
    .slice(0, 3)
    .map(({ vault }) => vault.name)
    .join(", ");
  const retryAt = rateLimited
    .map(({ freshness }) => freshness.retryAt!)
    .sort()
    .at(0);
  return {
    raw: reference.raw,
    code,
    message:
      `not found in the vaults that could be checked, but ${names} ${why}, so it may be there` +
      (code === "provider_rate_limited" && retryAt
        ? `; try again after ${retryAt}`
        : "; try again later"),
  };
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function materialFromPlaintext(
  reference: SecretReference,
  kind: SecretReferenceCandidate["fieldKind"],
  plaintext: string,
): SecretMaterial | SecretReferenceFailure {
  if (reference.otp) {
    if (!isValidTotpInput(plaintext)) {
      return {
        raw: reference.raw,
        code: "invalid_reference",
        message: "the one-time-password field does not hold a valid setup key",
      };
    }
    return { type: "totp", params: parseTotpInput(plaintext) };
  }
  if (kind === "file") return { type: "bytes", value: decodeBase64(plaintext) };
  return { type: "text", value: plaintext };
}

function isFailure(
  value: SecretMaterial | SecretReferenceFailure,
): value is SecretReferenceFailure {
  return "code" in value;
}

/**
 * One provider-read budget per agent attempt in this process. The API builds a
 * resolver per browser action, gateway call and `run_on`; sharing the budget
 * keeps a loop of calls inside one attempt at the per-attempt read cap instead
 * of a fresh cap per call.
 */
const attemptBudgets = new Map<string, ProviderCallBudget>();
const ATTEMPT_BUDGET_CACHE_LIMIT = 4096;

function sharedAttemptBudget(principal: SecretPrincipal): ProviderCallBudget {
  if (principal.kind !== "attempt") {
    return createProviderCallBudget(VAULT_LIMITS.providerReadsPerAttempt);
  }
  const key = `${principal.attemptId}:${principal.executionGeneration}`;
  let budget = attemptBudgets.get(key);
  if (!budget) {
    budget = createProviderCallBudget(VAULT_LIMITS.providerReadsPerAttempt);
    attemptBudgets.set(key, budget);
    while (attemptBudgets.size > ATTEMPT_BUDGET_CACHE_LIMIT) {
      attemptBudgets.delete(attemptBudgets.keys().next().value!);
    }
  }
  return budget;
}

export function createSecretResolver(
  deps: VaultServiceDeps,
  principal: SecretPrincipal,
  opts: SecretResolverOptions,
): SecretResolver {
  const budget = opts.attemptBudget ?? sharedAttemptBudget(principal);
  const context = { kind: "principal" as const, principal };

  async function resolve(
    refs: readonly SecretReference[],
    use: SecretUseContext,
  ): Promise<Map<string, ResolvedSecretValue>> {
    const unique = new Map<string, SecretReference>();
    for (const reference of refs) {
      if (!unique.has(referenceKey(reference))) unique.set(referenceKey(reference), reference);
    }
    const resolved = new Map<string, ResolvedSecretValue>();
    if (unique.size === 0) return resolved;
    const references = [...unique.values()];
    if (!opts.capabilityEnabled) {
      throw new SecretReferenceError(
        references.map((reference) => ({
          raw: reference.raw,
          code: "denied",
          message: "secrets are turned off for this agent",
        })),
        null,
      );
    }

    const choose = async () => {
      const { meta, candidates } = await resolveSecretReferenceCandidates(deps.db, context, {
        refs: references.map((reference, index) => lookupFor(reference, index)),
      });
      const outcomes = references.map((reference, index) => {
        const own = candidates.filter((candidate) => candidate.refIndex === index);
        return { reference, candidates: own, outcome: chooseSecretCandidate(reference, own, meta) };
      });
      return { meta, outcomes };
    };
    let { meta, outcomes } = await choose();
    // One provider registry per resolve, made only when a connected vault is needed.
    let registry: VaultProviderRegistry | null | undefined;
    const providers = (): VaultProviderRegistry | null => {
      if (registry === undefined) {
        registry = deps.providers ?? opts.providersForSubject?.(meta.subjectId) ?? null;
      }
      return registry;
    };
    const misses = () =>
      outcomes.filter(
        (entry) => "failure" in entry.outcome && entry.outcome.failure.code === "not_found",
      );
    // A reference to an item added straight in a connected provider (1Password)
    // finds nothing until the vault's mirror catches up: refresh the relevant
    // stale linked vaults once and look again before reporting it missing.
    let reachable: VaultRow[] | null = null;
    let refreshing = new Set<string>();
    if (misses().length > 0) {
      reachable = await listVaultsForSubject(deps.db, context, {
        workspaceId: principal.workspaceId,
      });
      const relevant = new Map<string, VaultRow>();
      for (const entry of misses()) {
        for (const vault of relevantProviderVaults(entry.reference, entry.candidates, reachable)) {
          relevant.set(vault.id, vault);
        }
      }
      const refreshProviders = relevant.size > 0 ? providers() : null;
      if (refreshProviders) {
        const report = await refreshLinkedVaults({
          db: deps.db,
          context,
          vaults: [...relevant.values()],
          providers: refreshProviders,
          maxAgeMs: LINKED_VAULT_MISS_MAX_AGE_MS,
        });
        refreshing = new Set(report.pending);
        if (report.changed.length > 0) ({ meta, outcomes } = await choose());
        if (
          report.outcomes.some((outcome) => outcome.state === "done" || outcome.state === "failed")
        ) {
          reachable = await listVaultsForSubject(deps.db, context, {
            workspaceId: principal.workspaceId,
          });
        }
      }
    }
    const failures: SecretReferenceFailure[] = [];
    const chosen: Chosen[] = [];
    const checkedAt = new Date();
    for (const entry of outcomes) {
      if ("candidate" in entry.outcome) {
        chosen.push({ reference: entry.reference, candidate: entry.outcome.candidate });
        continue;
      }
      let failure = entry.outcome.failure;
      if (failure.code === "not_found" && reachable) {
        const unchecked = relevantProviderVaults(entry.reference, entry.candidates, reachable)
          .map((vault) => ({
            vault,
            freshness: providerVaultFreshness(vault, checkedAt, {
              maxAgeMs: LINKED_VAULT_MISS_MAX_AGE_MS,
              refreshing: refreshing.has(vault.id),
            })!,
          }))
          .filter(({ freshness }) => freshness.state !== "current");
        if (unchecked.length > 0) failure = uncheckedSourceFailure(entry.reference, unchecked);
      }
      failures.push(failure);
    }
    const hasActingHuman = meta.humanExpected && meta.humanValid;
    if (failures.length > 0) {
      throw new SecretReferenceError(
        failures,
        buildMissingSecretAskCard(failures, { hasActingHuman }),
      );
    }

    // Provider values: one readFields call per provider item.
    const providerValues = new Map<string, SecretMaterial>();
    const providerGroups = new Map<string, Chosen[]>();
    for (const entry of chosen) {
      if (entry.candidate.source === "opengeni") continue;
      const groupKey = `${entry.candidate.vaultId}|${entry.candidate.itemId}`;
      providerGroups.set(groupKey, [...(providerGroups.get(groupKey) ?? []), entry]);
    }
    for (const group of providerGroups.values()) {
      const first = group[0]!.candidate;
      try {
        const provider = await (providers() ?? EMPTY_VAULT_PROVIDER_REGISTRY).forVault({
          source: first.source,
          providerConnectionId: first.providerConnectionId,
        });
        // The provider charges `budget` per call (one readFields per item). The
        // durable epoch invalidates its value cache after a refresh anywhere.
        const values = await provider.readFields(
          {
            connectionId: first.providerConnectionId,
            budget,
            cacheEpoch: first.providerCacheEpoch ?? null,
          },
          first.providerVaultRef ?? "",
          first.providerItemRef ?? "",
          [...new Set(group.map((entry) => entry.candidate.providerFieldRef ?? ""))],
        );
        for (const value of values) {
          providerValues.set(`${first.itemId}|${value.externalFieldId}`, value.material);
        }
      } catch (error) {
        const code = isVaultProviderError(error)
          ? providerFailureCode(error.code)
          : "provider_unavailable";
        for (const entry of group) {
          failures.push({
            raw: entry.reference.raw,
            code,
            message:
              code === "provider_rate_limited"
                ? "the connected vault is rate limited; try again later"
                : code === "provider_auth_expired"
                  ? "the connected vault needs to be reconnected"
                  : code === "not_found"
                    ? "the connected vault no longer has this item"
                    : "the connected vault is unavailable",
          });
        }
      }
    }

    for (const { reference, candidate } of chosen) {
      let material: SecretMaterial | SecretReferenceFailure;
      if (candidate.source === "opengeni") {
        if (deps.encryptionKey === null || candidate.valueEncrypted === null) {
          material = {
            raw: reference.raw,
            code: "provider_unavailable",
            message: "vault encryption is not configured on this server",
          };
        } else {
          let plaintext: string | null = null;
          try {
            plaintext = decryptEnvironmentValue(deps.encryptionKey, candidate.valueEncrypted);
          } catch {
            plaintext = null;
          }
          material =
            plaintext === null
              ? {
                  raw: reference.raw,
                  code: "provider_unavailable",
                  message: "the value cannot be decrypted",
                }
              : materialFromPlaintext(reference, candidate.fieldKind, plaintext);
        }
      } else {
        const value = providerValues.get(`${candidate.itemId}|${candidate.providerFieldRef ?? ""}`);
        if (value === undefined) {
          if (failures.some((failure) => failure.raw === reference.raw)) continue;
          material = {
            raw: reference.raw,
            code: "not_found",
            message: "the connected vault no longer has this field",
          };
        } else if (reference.otp && value.type === "text") {
          material = materialFromPlaintext(reference, "totp", value.value);
        } else {
          material = value;
        }
      }
      if (isFailure(material)) {
        failures.push(material);
        continue;
      }
      resolved.set(referenceKey(reference), {
        key: referenceKey(reference),
        reference,
        source: candidate.source,
        vaultId: candidate.vaultId,
        vaultName: candidate.vaultName,
        itemId: candidate.itemId,
        itemName: candidate.itemName,
        fieldId: candidate.fieldId,
        fieldName: candidate.fieldName ?? "",
        version: candidate.version,
        material,
      });
    }
    if (failures.length > 0) {
      resolved.clear();
      throw new SecretReferenceError(
        failures,
        buildMissingSecretAskCard(failures, { hasActingHuman }),
      );
    }

    await recordVaultSecretUse(deps.db, context, {
      use,
      items: [...resolved.values()].map((value) => ({
        itemId: value.itemId,
        vaultId: value.vaultId,
        fieldId: value.fieldId,
        fieldName: value.fieldName,
        reference: value.reference.raw,
      })),
    });
    return resolved;
  }

  return { principal, enabled: opts.capabilityEnabled, resolve };
}
