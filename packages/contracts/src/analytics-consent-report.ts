/**
 * Wire grammar of the content-free analytics consent beacon
 * (`POST /v1/analytics-consent`).
 *
 * When a person answers the web console's optional-analytics banner, the
 * browser reports only the closed decision so the API can count choices in
 * `opengeni_analytics_consent_total{decision}`. The count shows how much of
 * the audience the consent-gated analytics providers never see. A report
 * carries no identifier, URL, cookie, or user content, and the web client and
 * the API route both validate against these exact values.
 */
export const ANALYTICS_CONSENT_PATH = "/v1/analytics-consent";

export const ANALYTICS_CONSENT_DECISIONS = ["granted", "denied"] as const;
export type AnalyticsConsentDecision = (typeof ANALYTICS_CONSENT_DECISIONS)[number];

/** Largest accepted report body. A valid report is under 32 bytes. */
export const ANALYTICS_CONSENT_REPORT_MAX_BYTES = 128;

export type AnalyticsConsentReport = { decision: AnalyticsConsentDecision };
