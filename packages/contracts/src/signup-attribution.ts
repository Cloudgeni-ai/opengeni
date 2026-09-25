import { z } from "zod";

/**
 * First-touch marketing parameters accepted on the web app landing URL. The
 * browser keeps them in memory only and forwards them with a sign-up request,
 * so nothing is written to the device before analytics consent.
 */
export const SIGNUP_ATTRIBUTION_URL_PARAMETERS = {
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  utmContent: "utm_content",
  ref: "ref",
} as const;

/** Maximum retained length of one attribution value. */
export const SIGNUP_ATTRIBUTION_VALUE_MAX_LENGTH = 100;

/**
 * Campaign labels are marketer-chosen tokens. A closed character set keeps
 * free text, email addresses, and URL payloads out of every sink.
 */
export const SIGNUP_ATTRIBUTION_VALUE_PATTERN = /^[A-Za-z0-9._~:/+ -]+$/;

const SignupAttributionValue = z
  .string()
  .trim()
  .min(1)
  .max(SIGNUP_ATTRIBUTION_VALUE_MAX_LENGTH)
  .regex(SIGNUP_ATTRIBUTION_VALUE_PATTERN);

export const SignupAttribution = z
  .object({
    utmSource: SignupAttributionValue.optional(),
    utmMedium: SignupAttributionValue.optional(),
    utmCampaign: SignupAttributionValue.optional(),
    utmContent: SignupAttributionValue.optional(),
    ref: SignupAttributionValue.optional(),
  })
  .strict();
export type SignupAttribution = z.infer<typeof SignupAttribution>;

/** Closed acquisition channels reported by server-side sign-up metrics. */
export const SIGNUP_ACQUISITION_SOURCES = ["producthunt", "website", "direct", "other"] as const;
export type SignupAcquisitionSource = (typeof SIGNUP_ACQUISITION_SOURCES)[number];

/**
 * Normalize untrusted first-touch attribution to a closed channel. Missing
 * attribution is `direct`; malformed or unrecognized attribution is `other`.
 */
export function signupAcquisitionSource(input: unknown): SignupAcquisitionSource {
  if (input === undefined || input === null) return "direct";
  const parsed = SignupAttribution.safeParse(input);
  if (!parsed.success) return "other";
  const attribution = parsed.data;
  const values = Object.values(attribution).filter((value) => value !== undefined);
  if (values.length === 0) return "direct";
  const source = attribution.utmSource?.toLowerCase();
  const medium = attribution.utmMedium?.toLowerCase();
  const ref = attribution.ref?.toLowerCase();
  if ([source, ref].some((value) => value !== undefined && isProductHunt(value))) {
    return "producthunt";
  }
  if (
    source === "opengeni.ai" ||
    source?.endsWith(".opengeni.ai") ||
    source === "opengeni" ||
    medium === "website"
  ) {
    return "website";
  }
  return "other";
}

function isProductHunt(value: string): boolean {
  const compact = value.replace(/[\s._-]/g, "");
  return compact === "ph" || compact.includes("producthunt");
}
