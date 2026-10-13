import {
  buildMissingSecretAskCard,
  parseTotpInput,
  referenceKey,
  SecretReferenceError,
  type ResolvedSecretValue,
  type SecretPrincipal,
  type SecretReference,
  type SecretReferenceFailure,
  type SecretResolver,
  type SecretUseContext,
} from "@opengeni/contracts";

const STATIC_PRINCIPAL: SecretPrincipal = {
  kind: "attempt",
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  turnId: "00000000-0000-4000-8000-000000000004",
  attemptId: "00000000-0000-4000-8000-000000000005",
  executionGeneration: 1,
};

/** The lookup key a static value map uses for a reference: `Vault/Item/field`, `Item`, or `id:<uuid>[/field]`. */
export function staticSecretKey(ref: SecretReference): string {
  return ref.target.form === "id"
    ? `id:${ref.target.itemId}${ref.target.field === null ? "" : `/${ref.target.field}`}`
    : ref.target.segments.join("/");
}

export interface StaticSecretResolver extends SecretResolver {
  /** Every resolve call, references only (never values). */
  readonly calls: Array<{ refs: string[]; use: SecretUseContext }>;
}

/**
 * A stub resolver over a fixed value map, for delivery and gateway tests
 * before (or without) the hosted resolver. Keys are the reference path as
 * written (`"GitHub"`, `"GitHub/token"`, `"Team/GitHub/token"`) or the ID
 * form (`"id:<uuid>/field"`). `/otp` references expect a TOTP seed value.
 * `#previous` looks up `"<key>#previous"`. All-or-nothing like the real one.
 */
export function createStaticSecretResolver(
  values: Record<string, string>,
  options: { principal?: SecretPrincipal; enabled?: boolean; hasActingHuman?: boolean } = {},
): StaticSecretResolver {
  const calls: StaticSecretResolver["calls"] = [];
  return {
    principal: options.principal ?? STATIC_PRINCIPAL,
    enabled: options.enabled ?? true,
    calls,
    async resolve(refs, use) {
      calls.push({ refs: refs.map((ref) => ref.raw), use });
      const out = new Map<string, ResolvedSecretValue>();
      const failures: SecretReferenceFailure[] = [];
      for (const ref of refs) {
        const key = referenceKey(ref);
        if (out.has(key)) continue;
        const lookup = `${staticSecretKey(ref)}${ref.previous ? "#previous" : ""}`;
        const value = Object.hasOwn(values, lookup) ? values[lookup] : undefined;
        if (value === undefined) {
          failures.push({
            raw: ref.raw,
            code: "not_found",
            message: `no secret named "${lookup}" is available`,
          });
          continue;
        }
        const segments = ref.target.form === "path" ? ref.target.segments : null;
        const itemName = segments
          ? segments.length === 3
            ? segments[1]
            : segments[0]
          : ref.target.form === "id"
            ? ref.target.itemId
            : "";
        let material: ResolvedSecretValue["material"];
        try {
          material = ref.otp
            ? { type: "totp", params: parseTotpInput(value) }
            : { type: "text", value };
        } catch {
          failures.push({
            raw: ref.raw,
            code: "invalid_reference",
            message: "the stored value is not a TOTP seed",
          });
          continue;
        }
        out.set(key, {
          key,
          reference: ref,
          source: "opengeni",
          vaultId: "00000000-0000-4000-8000-0000000000aa",
          vaultName: segments?.length === 3 ? segments[0] : "Static",
          itemId: "00000000-0000-4000-8000-0000000000bb",
          itemName,
          fieldId: null,
          fieldName:
            (segments?.length === 3 ? segments[2] : segments?.[1]) ??
            (ref.target.form === "id" ? (ref.target.field ?? "value") : "value"),
          version: 1,
          material,
        });
      }
      if (failures.length > 0) {
        throw new SecretReferenceError(
          failures,
          buildMissingSecretAskCard(failures, { hasActingHuman: options.hasActingHuman ?? true }),
        );
      }
      return out;
    },
  };
}
