import { z } from "zod";

const PositiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * Opaque authority frozen at an xAI provider-account acceptance boundary.
 *
 * This snapshot deliberately carries no organization, membership, credential,
 * provider-account, subject, label, quota, token, or plan identity. User scope
 * becomes executable only after exact live database revalidation against the
 * separately stored causal subject and xAI subscription authority row.
 */
export const XaiProviderAccountAuthoritySnapshotV1 = z.discriminatedUnion("scope", [
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

export type XaiProviderAccountAuthoritySnapshotV1 = z.infer<
  typeof XaiProviderAccountAuthoritySnapshotV1
>;

/** Explicit compatibility value for workspace-default accepted work. */
export const WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1 = {
  version: 1,
  scope: "workspace",
} as const satisfies XaiProviderAccountAuthoritySnapshotV1;
