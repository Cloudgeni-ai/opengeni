import { z } from "zod";

const PositiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * Opaque authority frozen at a Codex provider-account acceptance boundary.
 *
 * The snapshot deliberately carries no organization, membership, credential,
 * provider-account, subject, label, quota, token, or plan identity. A later
 * activation slice may use the user generation only together with separately
 * authorized durable state; this value is never sufficient authority alone.
 */
export const CodexProviderAccountAuthoritySnapshotV1 = z.discriminatedUnion("scope", [
  z
    .object({
      version: z.literal(1),
      scope: z.literal("workspace"),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      scope: z.literal("user"),
      authorityGeneration: PositiveSafeInteger,
    })
    .strict(),
]);

export type CodexProviderAccountAuthoritySnapshotV1 = z.infer<
  typeof CodexProviderAccountAuthoritySnapshotV1
>;

/** Explicit compatibility value for all pre-foundation accepted work. */
export const LEGACY_WORKSPACE_CODEX_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1 = {
  version: 1,
  scope: "workspace",
} as const satisfies CodexProviderAccountAuthoritySnapshotV1;
