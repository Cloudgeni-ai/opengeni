import { readResponseJsonBounded } from "@opengeni/network";
import { z } from "zod";

const Account = z
  .object({
    uuid: z.string().uuid(),
    email: z.string().trim().email().max(320).optional(),
    email_address: z.string().trim().email().max(320).optional(),
    has_claude_max: z.boolean().optional(),
    has_claude_pro: z.boolean().optional(),
  })
  .passthrough();
const Profile = z
  .object({
    account: Account,
    organization: z
      .object({
        organization_type: z.string().trim().min(1).max(128).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ClaudeSubscriptionProfile = {
  accountUuid: string;
  email: string | null;
  plan: string | null;
};

/** Only provider-reported identity; never derive email from a token or an organization name. */
export function parseClaudeSubscriptionProfile(value: unknown): ClaudeSubscriptionProfile | null {
  const parsed = Profile.safeParse(value);
  if (!parsed.success) return null;
  const { account, organization } = parsed.data;
  return {
    accountUuid: account.uuid,
    email: account.email ?? account.email_address ?? null,
    plan:
      organization?.organization_type ??
      (account.has_claude_max === true
        ? "claude_max"
        : account.has_claude_pro === true
          ? "claude_pro"
          : null),
  };
}

/** Optional profile read. A profile outage must not discard a valid sign-in. */
export async function fetchClaudeSubscriptionProfile(
  token: string,
  scopes: readonly string[],
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ClaudeSubscriptionProfile | null> {
  if (!scopes.includes("user:profile")) return null;
  try {
    const signal = AbortSignal.timeout(10_000);
    const response = await fetchImpl("https://api.anthropic.com/api/oauth/profile", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return parseClaudeSubscriptionProfile(
      await readResponseJsonBounded(response, 64 * 1024, "Claude profile", { signal }),
    );
  } catch {
    return null;
  }
}
