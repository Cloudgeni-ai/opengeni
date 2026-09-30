import { z } from "zod";

export const ClaudeSubscriptionOAuthStartResponse = z
  .object({
    attemptId: z.string().uuid(),
    authorizationUrl: z.string().url(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ClaudeSubscriptionOAuthStartResponse = z.infer<
  typeof ClaudeSubscriptionOAuthStartResponse
>;

export const ClaudeSubscriptionOAuthCompleteRequest = z
  .object({
    attemptId: z.string().uuid(),
    code: z.string().trim().min(1).max(4096),
  })
  .strict();
export type ClaudeSubscriptionOAuthCompleteRequest = z.infer<
  typeof ClaudeSubscriptionOAuthCompleteRequest
>;

export const ClaudeSubscriptionOAuthCompleteResponse = z
  .object({
    connected: z.literal(true),
    credentialVersion: z.number().int().positive(),
  })
  .strict();
export type ClaudeSubscriptionOAuthCompleteResponse = z.infer<
  typeof ClaudeSubscriptionOAuthCompleteResponse
>;
