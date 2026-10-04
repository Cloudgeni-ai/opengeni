import type { OnboardingUseCase } from "./onboarding-use-case";

/**
 * The signup answer ("Add AI agents to my product" or "Run agents in the
 * cloud"), remembered in this browser per account and organization so the
 * new-chat page can lead with the matching suggestions. The server keeps the
 * answer only for analytics, so this is the one place the app reads it back;
 * without it (another device, cleared storage) people get the general set.
 */
const STORAGE_KEY = "opengeni.signupUseCase.v1";
/** Enough for every organization one browser realistically signs up. */
const MAX_ENTRIES = 20;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function entryKey(account: string, organizationId: string): string {
  return `${account.trim().toLowerCase()}|${organizationId}`;
}

function readEntries(): Record<string, OnboardingUseCase> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, OnboardingUseCase] =>
          entry[1] === "embed" || entry[1] === "cloud",
      ),
    );
  } catch {
    return {};
  }
}

export function rememberSignupUseCase(input: {
  account: string;
  organizationId: string;
  useCase: OnboardingUseCase;
}): void {
  const key = entryKey(input.account, input.organizationId);
  const entries = Object.entries(readEntries()).filter(([existing]) => existing !== key);
  entries.push([key, input.useCase]);
  try {
    storage()?.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries.slice(-MAX_ENTRIES))),
    );
  } catch {
    /* Private mode or a full store: the general suggestions still show. */
  }
}

/** Which starters the new-chat page leads with for this account and organization. */
export function signupStarterSet(
  account: string | null | undefined,
  organizationId: string | null | undefined,
): "general" | "product" {
  if (!account || !organizationId) return "general";
  return readEntries()[entryKey(account, organizationId)] === "embed" ? "product" : "general";
}
