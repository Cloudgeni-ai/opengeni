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
