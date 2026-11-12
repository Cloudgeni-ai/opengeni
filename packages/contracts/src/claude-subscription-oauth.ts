import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const ClaudeSubscriptionSetupTokenRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      token: primitives.string.trim().min(1).max(16384),
      scope: z.enum(["workspace", "user"]).default("workspace"),
      label: primitives.string.trim().max(200).nullable().optional(),
      reconnectAccountId: primitives.optionalUuid,
      expectedCredentialVersion: z.number().int().positive().optional(),
    })
    .strict()
    .refine(
      (request) =>
        Boolean(request.reconnectAccountId) === (request.expectedCredentialVersion !== undefined),
      { message: "Replacing a setup token requires its account and credential version." },
    ),
);
export type ClaudeSubscriptionSetupTokenRequest = z.infer<
  typeof ClaudeSubscriptionSetupTokenRequest
>;

/**
 * Add an Anthropic API key to the Claude account pool (SUB-KEY-01). The key
 * becomes an account of its Anthropic organization; every request it serves
 * spends that organization's API credits, so placement uses it only after
 * included subscription allowance. Replacing names the account and its
 * credential version, and takes a key of the same Anthropic organization.
 */
export const ClaudeSubscriptionApiKeyRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      apiKey: primitives.string.trim().min(1).max(1024),
      scope: z.enum(["workspace", "user"]).default("workspace"),
      label: primitives.string.trim().max(200).nullable().optional(),
      reconnectAccountId: primitives.optionalUuid,
      expectedCredentialVersion: z.number().int().positive().optional(),
    })
    .strict()
    .refine(
      (request) =>
        Boolean(request.reconnectAccountId) === (request.expectedCredentialVersion !== undefined),
      { message: "Replacing an API key requires its account and credential version." },
    ),
);
export type ClaudeSubscriptionApiKeyRequest = z.infer<typeof ClaudeSubscriptionApiKeyRequest>;

export const ClaudeSubscriptionOAuthStartRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      scope: z.enum(["workspace", "user"]).default("workspace"),
      reconnectAccountId: primitives.optionalUuid,
    })
    .strict(),
);
export type ClaudeSubscriptionOAuthStartRequest = z.infer<
  typeof ClaudeSubscriptionOAuthStartRequest
>;

export const ClaudeSubscriptionOAuthStartResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      attemptId: primitives.uuid,
      authorizationUrl: z.string().url(),
      expiresAt: primitives.dateTime,
    })
    .strict(),
);
export type ClaudeSubscriptionOAuthStartResponse = z.infer<
  typeof ClaudeSubscriptionOAuthStartResponse
>;

export const ClaudeSubscriptionOAuthCompleteRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      attemptId: primitives.uuid,
      code: primitives.string.trim().min(1).max(4096),
    })
    .strict(),
);
export type ClaudeSubscriptionOAuthCompleteRequest = z.infer<
  typeof ClaudeSubscriptionOAuthCompleteRequest
>;

export const ClaudeSubscriptionOAuthCompleteResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      connected: z.literal(true),
      accountId: primitives.uuid,
      scope: z.enum(["organization", "workspace", "user"]),
      credentialVersion: primitives.positiveInteger,
    })
    .strict(),
);
export type ClaudeSubscriptionOAuthCompleteResponse = z.infer<
  typeof ClaudeSubscriptionOAuthCompleteResponse
>;
