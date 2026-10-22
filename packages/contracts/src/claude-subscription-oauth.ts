import { defineSchema } from "./define-schema";
import { z } from "zod";

export const ClaudeSubscriptionSetupTokenRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      token: z.string().trim().min(1).max(16384),
      scope: z.enum(["workspace", "user"]).default("workspace"),
      label: z.string().trim().max(200).nullable().optional(),
      reconnectAccountId: z.string().uuid().optional(),
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
      reconnectAccountId: z.string().uuid().optional(),
    })
    .strict(),
);
export type ClaudeSubscriptionOAuthStartRequest = z.infer<
  typeof ClaudeSubscriptionOAuthStartRequest
>;

export const ClaudeSubscriptionOAuthStartResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      attemptId: z.string().uuid(),
      authorizationUrl: z.string().url(),
      expiresAt: z.string().datetime(),
    })
    .strict(),
);
export type ClaudeSubscriptionOAuthStartResponse = z.infer<
  typeof ClaudeSubscriptionOAuthStartResponse
>;

export const ClaudeSubscriptionOAuthCompleteRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      attemptId: z.string().uuid(),
      code: z.string().trim().min(1).max(4096),
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
      accountId: z.string().uuid(),
      scope: z.enum(["organization", "workspace", "user"]),
      credentialVersion: z.number().int().positive(),
    })
    .strict(),
);
export type ClaudeSubscriptionOAuthCompleteResponse = z.infer<
  typeof ClaudeSubscriptionOAuthCompleteResponse
>;
