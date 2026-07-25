type CodexRedemptionConfirmationClaims = {
  version: 1;
  attemptId: string;
  workspaceId: string;
  credentialId: string;
  creditId: string;
  subjectId: string;
  browserSessionHash: string;
  expiresAt: number;
};

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(value, "base64url"));
  } catch {
    return null;
  }
}

async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index]! ^ right[index]!;
  }
  return diff === 0;
}

export async function hashCodexBrowserSession(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(sessionId));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Five-minute, session-bound, HMAC-confirmed browser mutation token. */
export async function signCodexRedemptionConfirmation(
  secret: string,
  claims: CodexRedemptionConfirmationClaims,
): Promise<string> {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  return `${payload}.${base64UrlEncode(await hmac(secret, payload))}`;
}

export async function verifyCodexRedemptionConfirmation(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<CodexRedemptionConfirmationClaims | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const supplied = base64UrlDecode(signature);
  const encodedClaims = base64UrlDecode(payload);
  if (!supplied || !encodedClaims) return null;
  if (!constantTimeEqual(supplied, await hmac(secret, payload))) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(encodedClaims));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object") return null;
  const value = claims as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.attemptId !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.credentialId !== "string" ||
    typeof value.creditId !== "string" ||
    typeof value.subjectId !== "string" ||
    typeof value.browserSessionHash !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt * 1000 <= now
  ) {
    return null;
  }
  return value as CodexRedemptionConfirmationClaims;
}

export type { CodexRedemptionConfirmationClaims };
