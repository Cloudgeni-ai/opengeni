const ACCOUNT_AUTH_MESSAGE_TYPES = [
  "opengeni-account-auth-complete",
  "opengeni-account-auth-cancel",
] as const;

export type AccountAuthPopupMessage = {
  type: (typeof ACCOUNT_AUTH_MESSAGE_TYPES)[number];
  transactionId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isAccountAuthTransactionId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function accountAuthPopupPath(transactionId: string): string {
  if (!isAccountAuthTransactionId(transactionId)) {
    throw new Error("A valid browser login transaction id is required");
  }
  return `/account-auth?transaction=${encodeURIComponent(transactionId)}`;
}

export function accountAuthPopupFeatures(
  view: Pick<Window, "screenX" | "screenY" | "outerWidth" | "outerHeight">,
): string {
  const width = 480;
  const height = 660;
  const left = Math.max(0, Math.round(view.screenX + (view.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(view.screenY + (view.outerHeight - height) / 2));
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

/**
 * Accept only the exact same-origin popup and the expected non-secret
 * transaction receipt. Projection, credential, and token-shaped extras are
 * rejected instead of being treated as browser authority.
 */
export function accountAuthPopupMessage(
  event: Pick<MessageEvent<unknown>, "data" | "origin" | "source">,
  expected: { origin: string; popup: Window; transactionId: string },
): AccountAuthPopupMessage | null {
  if (event.origin !== expected.origin || event.source !== expected.popup) return null;
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return null;
  const value = event.data as Record<string, unknown>;
  if (
    Object.keys(value).sort().join("\u0000") !== "transactionId\u0000type" ||
    !ACCOUNT_AUTH_MESSAGE_TYPES.includes(value.type as AccountAuthPopupMessage["type"]) ||
    value.transactionId !== expected.transactionId
  ) {
    return null;
  }
  return value as AccountAuthPopupMessage;
}

export function postAccountAuthPopupMessage(
  target: Window | null,
  origin: string,
  message: AccountAuthPopupMessage,
): boolean {
  if (!target || !isAccountAuthTransactionId(message.transactionId)) return false;
  target.postMessage(message, origin);
  return true;
}
