import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const ManagedSignInProvider = /* @__PURE__ */ defineSchema(() =>
  z.enum(["google", "github"]),
);

export {
  accountContactEmail,
  isPasskeyOnlyAccountEmail,
  PASSKEY_ONLY_ACCOUNT_EMAIL_DOMAIN,
  passkeyOnlyAccountEmail,
} from "./passkey-only-account";

/** A WebAuthn credential a person registered, without its key material. */
export const ManagedPasskey = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    name: z.string().min(1).max(80),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    // Synced passkeys (a password manager or platform keychain) survive the
    // loss of one device; a single-device key, such as a security key, does not.
    backedUp: primitives.boolean,
  }),
);
export type ManagedPasskey = z.infer<typeof ManagedPasskey>;

/**
 * A browser's WebAuthn response, exactly as `navigator.credentials` produced
 * it in JSON form. The server verifies it; nothing in it is trusted before.
 */
export const ManagedPasskeyCredentialResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: z.string().min(1).max(1400),
      rawId: z.string().min(1).max(1400),
      type: z.literal("public-key"),
      response: z.record(z.string(), z.unknown()),
      clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
      authenticatorAttachment: z.string().max(32).optional(),
    })
    .passthrough(),
);

/** Options for one WebAuthn ceremony, and the single-use id that answers it. */
export const ManagedPasskeyCeremony = /* @__PURE__ */ defineSchema(() =>
  z.object({
    challengeId: z.string().min(16).max(128),
    options: z.record(z.string(), z.unknown()),
  }),
);
export type ManagedPasskeyCeremony = z.infer<typeof ManagedPasskeyCeremony>;

export const ManagedPasskeySignInRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      challengeId: z.string().min(16).max(128),
      response: ManagedPasskeyCredentialResponse,
    })
    .strict(),
);
export const ManagedPasskeySignUpOptionsRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: z.string().trim().min(1).max(80),
      signupChallengeToken: z.string().max(2048).optional(),
    })
    .strict(),
);
export const ManagedPasskeySignUpRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      challengeId: z.string().min(16).max(128),
      response: ManagedPasskeyCredentialResponse,
    })
    .strict(),
);
export const ManagedPasskeySignInResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    // True when the response signed this browser in. Passkeys are offered
    // only in the legacy session-set mode, where that is always the case.
    signedIn: primitives.boolean,
  }),
);
export const ManagedSignInMethods = /* @__PURE__ */ defineSchema(() =>
  z.object({
    identityId: primitives.uuid,
    email: z.string().email(),
    emailVerified: primitives.boolean,
    identityRevision: primitives.positiveInteger,
    freshAuthenticationRequired: primitives.boolean,
    methods: z.array(
      z.object({
        provider: z.enum(["credential", "google", "github"]),
        connected: primitives.boolean,
        available: primitives.boolean,
        canDisconnect: primitives.boolean,
        implicitRelinkingSuppressed: primitives.boolean,
      }),
    ),
    // The person's passkeys, oldest first. Absent from servers without
    // passkey sign-in.
    passkeys: z.array(ManagedPasskey).default([]),
    // Whether this deployment lets people add and sign in with passkeys.
    passkeysAvailable: primitives.boolean.default(false),
    // False while removing any one passkey would leave no usable sign-in method.
    canRemovePasskey: primitives.boolean.default(false),
  }),
);
export type ManagedSignInMethods = z.infer<typeof ManagedSignInMethods>;
export const ManagedSignInMutation = /* @__PURE__ */ defineSchema(() =>
  z.object({
    expectedIdentityId: primitives.uuid,
    operationId: primitives.uuid,
    expectedIdentityRevision: primitives.positiveInteger,
  }),
);
export const ManagedSignInProviderMutation = /* @__PURE__ */ defineSchema(() =>
  ManagedSignInMutation.extend({
    provider: ManagedSignInProvider,
  }).strict(),
);
export const ManagedSignInPasswordMutation = /* @__PURE__ */ defineSchema(() =>
  ManagedSignInMutation.extend({
    newPassword: z.string().min(8).max(128),
    currentPassword: z.string().min(1).max(1024).optional(),
  }).strict(),
);
export const ManagedPasskeyRegisterMutation = /* @__PURE__ */ defineSchema(() =>
  ManagedSignInMutation.extend({
    challengeId: z.string().min(16).max(128),
    response: ManagedPasskeyCredentialResponse,
    name: z.string().trim().min(1).max(80).optional(),
  }).strict(),
);
export const ManagedPasskeyRemoveMutation = /* @__PURE__ */ defineSchema(() =>
  ManagedSignInMutation.extend({
    passkeyId: primitives.uuid,
  }).strict(),
);
export const ManagedPasskeyMutationResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    // True when this change linked passkey sign-in to the account for the
    // first time: every session ends, as for any new sign-in method.
    reauthenticationRequired: primitives.boolean,
    notification: z.enum(["sent", "failed", "outcome_unknown", "none"]),
  }),
);
export const ManagedSignInMutationResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    reauthenticationRequired: z.literal(true),
    notification: z.enum(["sent", "failed", "outcome_unknown"]),
  }),
);
export const ManagedSignInConnectResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ url: z.string().url() }),
);
