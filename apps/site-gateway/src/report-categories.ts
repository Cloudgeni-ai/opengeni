import type { SiteAbuseCategory } from "@opengeni/contracts";

/** Labels for SiteAbuseCategory, in form order. */
export const SITE_ABUSE_CATEGORIES: readonly { value: SiteAbuseCategory; label: string }[] = [
  { value: "phishing", label: "Phishing or credential theft" },
  { value: "malware", label: "Malware or harmful downloads" },
  { value: "spam", label: "Spam or scam" },
  { value: "illegal", label: "Illegal content" },
  { value: "harassment", label: "Harassment or hate" },
  { value: "copyright", label: "Copyright or trademark" },
  { value: "other", label: "Something else" },
];

export function isAbuseCategory(value: unknown): value is SiteAbuseCategory {
  return SITE_ABUSE_CATEGORIES.some((category) => category.value === value);
}
