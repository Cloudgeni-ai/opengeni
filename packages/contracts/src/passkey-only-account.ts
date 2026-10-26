// Kept free of schema imports: the always-loaded app shell uses this check,
// and pulling the schema library into the first page load costs every visit.

/**
 * Accounts created with only a passkey have no email address. Their stored
 * address is a unique placeholder under this reserved `.invalid` domain
 * (RFC 2606), which no mail can reach and no person or organization domain
 * can match. Never show it; show the person's name instead.
 */
export const PASSKEY_ONLY_ACCOUNT_EMAIL_DOMAIN = "passkey.invalid";

export function passkeyOnlyAccountEmail(authUserId: string): string {
  return `${authUserId.toLowerCase()}@${PASSKEY_ONLY_ACCOUNT_EMAIL_DOMAIN}`;
}

export function isPasskeyOnlyAccountEmail(email: string | null | undefined): boolean {
  return (
    typeof email === "string" &&
    email.toLowerCase().endsWith(`@${PASSKEY_ONLY_ACCOUNT_EMAIL_DOMAIN}`)
  );
}
