import { z } from "zod";
import { Permission } from "./permissions";

// External identifiers are opaque, case-sensitive strings. In particular a
// native-looking identifier is still host data, never a native subject claim.
// Bound bytes, not just JS code units: these values share a PostgreSQL B-tree
// index entry. Never normalize/truncate an identifier to make it fit, and reject
// text that the driver would replace or PostgreSQL cannot represent.
const encoder = new TextEncoder();
function opaqueText(maxBytes: number) {
  return z
    .string()
    .min(1)
    .max(maxBytes)
    .refine(
      (value) =>
        !value.includes("\0") &&
        !/[\uD800-\uDFFF]/u.test(value) &&
        encoder.encode(value).byteLength <= maxBytes,
      {
        message: `Identifier must be valid PostgreSQL Unicode text of at most ${maxBytes} UTF-8 bytes`,
      },
    );
}
const externalId = opaqueText(1024);
const source = opaqueText(200);
const externalSubject = z
  .string()
  .regex(/^external_user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/);
const nativeSubject = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^user:[^\r\n]+$(?![\s\S])/);
export const ExternalIdentityReference = z
  .object({
    externalId,
    source: source.default("default"),
  })
  .strict();
export type ExternalIdentityReference = z.infer<typeof ExternalIdentityReference>;

export const AddExternalWorkspaceMemberRequest = z
  .object({
    identity: ExternalIdentityReference,
    permissions: z.array(Permission).min(1).max(Permission.options.length),
  })
  .strict();
export type AddExternalWorkspaceMemberRequest = z.infer<typeof AddExternalWorkspaceMemberRequest>;

/** Uses the organization membership ID returned by lazy identity admission.
 * Reactivation restores admission only, not revoked work or workspace grants. */
export const UpdateExternalIdentityMembershipRequest = z
  .object({
    kind: z.enum(["suspend", "reactivate", "offboard"]),
    expectedAuthorizationRevision: z.number().int().positive().safe(),
    operationId: z.string().uuid(),
    reason: z.string().max(512).optional(),
  })
  .strict();
export type UpdateExternalIdentityMembershipRequest = z.infer<
  typeof UpdateExternalIdentityMembershipRequest
>;

export const ExternalActorSelection = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("external"), identity: ExternalIdentityReference }).strict(),
  z
    .object({
      mode: z.literal("linked_native"),
      identity: ExternalIdentityReference,
      linkId: z.string().uuid(),
      expectedLinkRevision: z.number().int().positive().safe(),
    })
    .strict(),
]);
export type ExternalActorSelection = z.infer<typeof ExternalActorSelection>;

export const ExternalIdentity = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    source,
    externalId,
    subjectId: externalSubject,
    organizationMembershipId: z.string().uuid(),
    personalWorkspaceId: z.string().uuid(),
    status: z.enum(["active", "disabled", "revoked"]),
    authorizationRevision: z.number().int().positive().safe(),
  })
  .strict();
export type ExternalIdentity = z.infer<typeof ExternalIdentity>;

// Audit attribution, not authentication. Only the canonical access resolver
// may establish provenance; accepting this JSON from a browser proves nothing.
export const ExternalActorAttribution = z
  .object({
    accountId: z.string().uuid(),
    authenticatingApiKeyId: z.string().uuid(),
    externalIdentityId: z.string().uuid(),
    externalSubjectId: externalSubject,
    externalAuthorizationRevision: z.number().int().positive().safe(),
    effectiveSubjectId: z.string().min(1).max(1024),
    actingMode: z.enum(["external", "linked_native"]),
    linkId: z.string().uuid().optional(),
    linkRevision: z.number().int().positive().safe().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actingMode === "external") {
      if (
        value.effectiveSubjectId !== value.externalSubjectId ||
        value.linkId !== undefined ||
        value.linkRevision !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "External mode cannot delegate native identity",
        });
      }
    } else if (
      !value.linkId ||
      !value.linkRevision ||
      !nativeSubject.safeParse(value.effectiveSubjectId).success
    ) {
      context.addIssue({
        code: "custom",
        message: "Linked mode requires exact native delegation provenance",
      });
    }
  });
export type ExternalActorAttribution = z.infer<typeof ExternalActorAttribution>;

/** Server-signed/encrypted continuation data, never sufficient live authority. */
export const ExternalActorContinuation = z
  .object({
    identity: ExternalIdentityReference,
    actor: ExternalActorAttribution,
  })
  .strict();
export type ExternalActorContinuation = z.infer<typeof ExternalActorContinuation>;

export const ExternalIdentityLink = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    externalIdentityId: z.string().uuid(),
    externalIdentity: ExternalIdentityReference.optional(),
    nativeSubjectId: nativeSubject.nullable(),
    status: z.enum(["pending", "active", "revoked", "expired"]),
    revision: z.number().int().positive().safe(),
    permissions: z.array(Permission).max(Permission.options.length),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .refine(
    (value) => value.status !== "active" || value.nativeSubjectId !== null,
    "An active link requires a confirmed native identity",
  );
export type ExternalIdentityLink = z.infer<typeof ExternalIdentityLink>;

export const ExternalIdentityLinkPage = z
  .object({
    links: z.array(ExternalIdentityLink).max(50),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
export type ExternalIdentityLinkPage = z.infer<typeof ExternalIdentityLinkPage>;

/** A native confirmation may narrow this request, never broaden it. The
 * challenge is delivered once to the host and is not an authentication token. */
export const BeginExternalIdentityLinkRequest = z
  .object({
    permissions: z.array(Permission).min(1).max(Permission.options.length),
    expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type BeginExternalIdentityLinkRequest = z.input<typeof BeginExternalIdentityLinkRequest>;
export const ConfirmExternalIdentityLinkRequest = z
  .object({
    challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expectedRevision: z.number().int().positive().safe(),
    permissions: z.array(Permission).min(1).max(Permission.options.length),
  })
  .strict();
export type ConfirmExternalIdentityLinkRequest = z.infer<typeof ConfirmExternalIdentityLinkRequest>;
export const BeginExternalIdentityLinkResponse = z
  .object({
    link: ExternalIdentityLink,
    challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    confirmBefore: z.string().datetime({ offset: true }),
  })
  .strict();
export type BeginExternalIdentityLinkResponse = z.infer<typeof BeginExternalIdentityLinkResponse>;
export const ExternalIdentityLinkPreview = z
  .object({
    link: ExternalIdentityLink,
    externalIdentity: ExternalIdentityReference,
    nativeSubjectId: nativeSubject,
    organizationId: z.string().uuid(),
  })
  .strict();
export type ExternalIdentityLinkPreview = z.infer<typeof ExternalIdentityLinkPreview>;

/** Immutable accepted-work restriction, not a browser credential. Original key
 * identity remains audit-only; durable use validates the live link and members. */
export const ExternalLinkWorkSnapshot = z
  .object({
    identity: ExternalIdentityReference,
    actor: ExternalActorAttribution.refine((value) => value.actingMode === "linked_native"),
    permissions: z.array(Permission).max(Permission.options.length),
  })
  .strict();
export type ExternalLinkWorkSnapshot = z.infer<typeof ExternalLinkWorkSnapshot>;
