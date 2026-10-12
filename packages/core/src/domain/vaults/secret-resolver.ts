/**
 * The hosted secret resolver (§10B.2). One database roundtrip returns the
 * principal's facts and every candidate for every reference; candidates are
 * chosen here (archived dropped, lowest tier, names over aliases, otherwise
 * ambiguous), provider values are fetched, hosted values decrypted, and the
 * batch is recorded. A call resolves all of its references or none (I2).
 */
import {
  buildMissingSecretAskCard,
  formatSecretReference,
  isValidTotpInput,
  parseTotpInput,
  referenceKey,
  SecretReferenceError,
  VAULT_LIMITS,
  type ResolvedSecretValue,
  type SecretMaterial,
  type SecretPrincipal,
  type SecretReference,
  type SecretReferenceFailure,
  type SecretResolver,
  type SecretUseContext,
} from "@opengeni/contracts";
import {
  decryptEnvironmentValue,
  recordVaultSecretUse,
  resolveSecretReferenceCandidates,
  type SecretReferenceCandidate,
  type SecretReferenceLookup,
  type SecretResolutionMeta,
} from "@opengeni/db";
import {
  createProviderCallBudget,
  EMPTY_VAULT_PROVIDER_REGISTRY,
  isVaultProviderError,
  type ProviderCallBudget,
  type VaultProviderErrorCode,
} from "@opengeni/vaults";
import type { VaultServiceDeps } from "./types";

export type SecretResolverOptions = {
  /** `agent.capabilities.secrets`; when false the resolver refuses every reference. */
  capabilityEnabled: boolean;
  /** Provider calls allowed for this attempt (Q-18); a fresh 50-call budget by default. */
  attemptBudget?: ProviderCallBudget;
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

export function createSecretResolver(
  deps: VaultServiceDeps,
  principal: SecretPrincipal,
  opts: SecretResolverOptions,
): SecretResolver {
  const budget =
    opts.attemptBudget ?? createProviderCallBudget(VAULT_LIMITS.providerReadsPerAttempt);
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

    const { meta, candidates } = await resolveSecretReferenceCandidates(deps.db, context, {
      refs: references.map((reference, index) => lookupFor(reference, index)),
    });
    const failures: SecretReferenceFailure[] = [];
    const chosen: Chosen[] = [];
    references.forEach((reference, index) => {
      const outcome = chooseSecretCandidate(
        reference,
        candidates.filter((candidate) => candidate.refIndex === index),
        meta,
      );
      if ("failure" in outcome) failures.push(outcome.failure);
      else chosen.push({ reference, candidate: outcome.candidate });
    });
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
        const provider = await (deps.providers ?? EMPTY_VAULT_PROVIDER_REGISTRY).forVault({
          source: first.source,
          providerConnectionId: first.providerConnectionId,
        });
        // The provider charges `budget` per call (one readFields per item).
        const values = await provider.readFields(
          { connectionId: first.providerConnectionId, budget },
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
