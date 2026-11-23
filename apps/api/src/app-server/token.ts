import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A run's capability for its calls back to Opengeni: which run, workspace,
 * app and version it is for, and until when. The API mints it when it starts
 * a run and checks it on every call the gateway forwards; it is HMAC-signed
 * with a key derived from the gateway secret, so nothing else can make one.
 */
export type AppServerRunClaims = {
  runId: string;
  accountId: string;
  workspaceId: string;
  siteId: string;
  versionId: string;
  /** Expiry, unix milliseconds. */
  expiresAt: number;
};

const PURPOSE = "opengeni-app-server-run-token-v1";

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update(PURPOSE).digest();
}

function mac(secret: string, payload: string): string {
  return createHmac("sha256", key(secret)).update(payload).digest("base64url");
}

export function mintAppServerRunToken(secret: string, claims: AppServerRunClaims): string {
  const payload = Buffer.from(
    JSON.stringify([
      claims.runId,
      claims.accountId,
      claims.workspaceId,
      claims.siteId,
      claims.versionId,
      claims.expiresAt,
    ]),
  ).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

/** The claims of a valid, unexpired token signed with one of `secrets`; null otherwise. */
export function verifyAppServerRunToken(
  secrets: ReadonlyArray<string | null | undefined>,
  token: string,
  now = Date.now(),
): AppServerRunClaims | null {
  if (token.length > 2048) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const received = Buffer.from(signature);
  let valid = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from(mac(secret, payload));
    if (expected.length === received.length && timingSafeEqual(expected, received)) valid = true;
  }
  if (!valid) return null;
  let fields: unknown;
  try {
    fields = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !Array.isArray(fields) ||
    fields.length !== 6 ||
    !fields.slice(0, 5).every((field) => typeof field === "string") ||
    typeof fields[5] !== "number"
  )
    return null;
  const [runId, accountId, workspaceId, siteId, versionId, expiresAt] = fields as [
    string,
    string,
    string,
    string,
    string,
    number,
  ];
  if (expiresAt <= now) return null;
  return { runId, accountId, workspaceId, siteId, versionId, expiresAt };
}
