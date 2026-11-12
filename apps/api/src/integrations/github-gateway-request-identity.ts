import { githubRestPathSegments } from "./github-gateway-requests";

/**
 * Fields GitHub's secret endpoints take that are fresh on every run of the
 * same command: `gh secret set` seals the value with libsodium's sealed box,
 * which uses a new ephemeral key each time, so `encrypted_value` never repeats,
 * and `key_id` names whichever public key the client fetched.
 */
const SEALED_SECRET_FIELDS = ["encrypted_value", "key_id"] as const;

/** What the approval card shows instead of the ciphertext. */
export const SEALED_SECRET_PLACEHOLDER = "[sealed]";

const SECRET_APPS = new Set(["actions", "dependabot", "codespaces"]);

/**
 * `PUT` of one secret: a repository's (`/repos/{owner}/{repo}` or
 * `/repositories/{id}`) Actions, Dependabot or Codespaces secret, an
 * environment's secret, an organization's secret, or the person's
 * Codespaces secret.
 */
function isSecretWrite(method: string, pathname: string): boolean {
  if (method !== "PUT") return false;
  const segments = githubRestPathSegments(pathname);
  const tail = (scope: string[]) => {
    const [app, secrets, name, ...rest] = scope;
    if (secrets !== "secrets" || !name || rest.length > 0) return false;
    return SECRET_APPS.has(app ?? "");
  };
  const environmentTail = (scope: string[]) => {
    const [environments, environment, secrets, name, ...rest] = scope;
    return (
      environments === "environments" &&
      !!environment &&
      secrets === "secrets" &&
      !!name &&
      rest.length === 0
    );
  };
  if (segments[0] === "repos" && segments[1] && segments[2]) {
    const scope = segments.slice(3);
    return tail(scope) || environmentTail(scope);
  }
  if (segments[0] === "repositories" && segments[1]) {
    const scope = segments.slice(2);
    return tail(scope) || environmentTail(scope);
  }
  if (segments[0] === "orgs" && segments[1]) return tail(segments.slice(2));
  if (segments[0] === "user") return tail(segments.slice(1)) && segments[1] === "codespaces";
  return false;
}

/**
 * The body of a secret write without its ciphertext, or null when the request
 * is not one. Everything else in it (an organization secret's visibility and
 * selected repositories) is kept.
 */
export function sealedSecretBody(
  method: string,
  pathname: string,
  parsedBody: unknown,
): Record<string, unknown> | null {
  if (
    parsedBody === null ||
    typeof parsedBody !== "object" ||
    Array.isArray(parsedBody) ||
    typeof (parsedBody as Record<string, unknown>).encrypted_value !== "string" ||
    !isSecretWrite(method, pathname)
  ) {
    return null;
  }
  const body = { ...(parsedBody as Record<string, unknown>) };
  for (const field of SEALED_SECRET_FIELDS) delete body[field];
  return body;
}

/**
 * What a gateway request's approval binds to: the digest's body part, and the
 * body the approval card shows (also part of the approval ledger's
 * fingerprint of the request). Most requests are bound byte for byte. A secret
 * write is bound to everything but its ciphertext, so the person approves
 * "set secret X" once and the agent's retry of the same command, re-sealed
 * with fresh randomness, matches it. The method and path (repository,
 * environment and secret name) stay in the digest, so the match never reaches
 * a different secret.
 */
export function gatewayRequestApprovalBody(
  method: string,
  pathname: string,
  bodyBytes: Uint8Array | null,
  parsedBody: unknown,
): { digest: unknown; review: unknown } {
  const sealed = bodyBytes === null ? null : sealedSecretBody(method, pathname, parsedBody);
  if (sealed === null) return { digest: bodyBytes, review: parsedBody };
  return {
    digest: { sealedSecret: sealed },
    review: { ...sealed, encrypted_value: SEALED_SECRET_PLACEHOLDER },
  };
}
