import { isOnboardingUseCase, type OnboardingUseCase } from "./onboarding-use-case";

/**
 * The signup answer ("Get help with everyday things", "Add AI agents to my
 * product" or "Run agents in the cloud") decides which suggestions the
 * new-chat page leads with. The server keeps the person's current answer and
 * returns it with their memberships, so it follows them to every device. This
 * browser copy, per account and organization, is only a fallback for a server
 * that doesn't return it.
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
      Object.entries(parsed).filter((entry): entry is [string, OnboardingUseCase] =>
        isOnboardingUseCase(entry[1]),
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

/**
 * Which starters the new-chat page leads with for this account and
 * organization. `serverAnswer` is the membership's `signupUseCase`: when the
 * server keeps an answer it wins; only without one does the browser copy
 * decide. Only people who chose to build or run agents get the developer sets;
 * everyone else, including people who skipped the question or signed up before
 * it existed, gets the everyday set.
 */
export function signupStarterSet(
  account: string | null | undefined,
  organizationId: string | null | undefined,
  serverAnswer?: OnboardingUseCase | undefined,
): "everyday" | "general" | "product" {
  const answer =
    serverAnswer ??
    (account && organizationId ? readEntries()[entryKey(account, organizationId)] : undefined);
  return answer === "embed" ? "product" : answer === "cloud" ? "general" : "everyday";
}

type NewChatWording = {
  heading: string;
  placeholder: string;
  /** Composer copy overrides: the text box's screen-reader label. */
  composerMessages: { inputLabel: string };
};

/**
 * The new-chat heading, composer placeholder and composer label. Everyone gets
 * the same plain words about asking: a quick question and a long task both
 * start here, and the starters below (not the heading) are what follow the
 * signup answer. A constant, so passing it on doesn't change on every render.
 */
export const NEW_CHAT_WORDING: NewChatWording = {
  heading: "What can I help with?",
  placeholder: "Ask anything, or describe what you need…",
  composerMessages: { inputLabel: "Ask anything" },
};
