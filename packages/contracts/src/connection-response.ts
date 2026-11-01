import { z } from "zod";
import { defineSchema } from "./define-schema";
import * as primitives from "./primitives";

export const ConnectionKind = defineSchema(() => z.enum(["oauth2", "api_key", "app_install", "delegated"]));
export const ConnectionStatus = defineSchema(() => z.enum(["active", "needs_reauth", "revoked", "error"]));

export const ConnectionMetadata = defineSchema(() =>
  z.object({
    id: primitives.uuid,
    authorityId: primitives.optionalUuid,
    connectionAuthorityGeneration: z.number().int().positive().optional(),
    accountId: primitives.uuid,
    workspaceId: primitives.uuid,
    subjectId: primitives.nullableString,
    providerDomain: primitives.string,
    kind: ConnectionKind,
    status: ConnectionStatus,
    grantedScopes: z.array(primitives.string),
    expiresAt: primitives.nullableString,
    lastRefreshAt: primitives.nullableString,
    lastUsedAt: primitives.nullableString,
    lastError: primitives.nullableString,
    version: primitives.positiveInteger,
    verifiedInstallAt: primitives.string.datetime({ offset: true }).nullable().optional(),
    verifiedInstallVersion: z.number().int().positive().nullable().optional(),
    metadata: z.record(primitives.string, z.unknown()),
    createdBySubjectId: primitives.nullableString,
    updatedBySubjectId: primitives.nullableString,
    createdAt: primitives.string,
    updatedAt: primitives.string,
  }),
);

export const ConnectionResponse = defineSchema(() => z.object({ connection: ConnectionMetadata }));
export type ConnectionResponse = z.infer<typeof ConnectionResponse>;

