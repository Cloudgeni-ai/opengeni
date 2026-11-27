import { z } from "zod";

export const AiProcessingConsentPlatform = z.enum([
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "office",
  "web",
]);
export type AiProcessingConsentPlatform = z.infer<typeof AiProcessingConsentPlatform>;

const DisclosureVersion = z.string().regex(/^[a-f0-9]{64}$/u);

export const AiProcessingDisclosure = z.object({
  version: DisclosureVersion,
  title: z.string(),
  body: z.string(),
  providers: z.array(z.string()),
  privacyUrl: z.url().nullable(),
});
export type AiProcessingDisclosure = z.infer<typeof AiProcessingDisclosure>;

export const GrantAiProcessingConsentRequest = z.strictObject({
  version: z.string().min(1).max(128),
});
export type GrantAiProcessingConsentRequest = z.infer<typeof GrantAiProcessingConsentRequest>;

export const AiProcessingConsentResponse = z.object({
  required: z.boolean(),
  disclosure: AiProcessingDisclosure,
  consent: z
    .object({
      version: DisclosureVersion,
      grantedAt: z.iso.datetime(),
      platform: AiProcessingConsentPlatform,
    })
    .nullable(),
});
export type AiProcessingConsentResponse = z.infer<typeof AiProcessingConsentResponse>;

export const AI_PROCESSING_CONSENT_REQUIRED = "ai_processing_consent_required" as const;
export const AI_PROCESSING_CONSENT_VERSION_MISMATCH =
  "ai_processing_consent_version_mismatch" as const;
