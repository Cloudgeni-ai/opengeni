import type { SignupAttribution } from "@opengeni/contracts";

import type { OnboardingIntent } from "./onboarding-journey";

/** Where first-run setup hands the person over once the gate opens. */
export type OnboardingCompletion = Readonly<{ to: string }>;

const PRODUCT_HUNT = /^product[-_.]?hunt$/i;

/**
 * Product Hunt visitors mostly come to build: preselect "a product" for them.
 * Only a closed, first-touch campaign token is read, never a URL.
 */
export function onboardingIntentFromAttribution(
  attribution: SignupAttribution | null,
): OnboardingIntent | null {
  if (!attribution) return null;
  const tokens = [attribution.ref, attribution.utmSource];
  return tokens.some((token) => typeof token === "string" && PRODUCT_HUNT.test(token))
    ? "build"
    : null;
}

/**
 * Where first-run setup continues inside the app, on the first-agent page: a
 * product's questions, or (own work, or Skip) the ready moment that says what
 * the person got and starts them off.
 */
export function onboardingDestination(
  personalWorkspaceId: string,
  use: "product" | "work" | null,
): OnboardingCompletion {
  return {
    to: `/workspaces/${personalWorkspaceId}/first-agent?step=${use === "product" ? "product" : "ready"}`,
  };
}

/** The shared workspace a product's agent lives in, so API keys can reach it. */
export const DEVELOPMENT_WORKSPACE_NAME = "Development";

/**
 * The organization-name suggestion: the person's first name plus
 * "'s organization" ("Ada's organization", "James's organization"), or the
 * email's local part when there is no name. Empty when neither is known.
 */
export function defaultOrganizationName(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const first = name?.trim().split(/\s+/u)[0] ?? "";
  const local = email?.trim().split("@")[0]?.split("+")[0] ?? "";
  const owner = first || local;
  return owner ? `${owner}'s organization` : "";
}
