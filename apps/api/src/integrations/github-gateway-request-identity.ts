import { githubRestPathSegments } from "./github-gateway-requests";

/**
 * Fields GitHub's secret endpoints take that are fresh on every run of the
 * same command: `gh secret set` seals the value with libsodium's sealed box,
 * which uses a new ephemeral key each time, so `encrypted_value` never repeats,
 * and `key_id` names whichever public key the client fetched.
 */
const SEALED_SECRET_FIELDS = new Set(["encrypted_value", "key_id"]);

/** `PUT …/secrets/{name}`: repository, environment, organization, Dependabot, Codespaces. */
function isSecretWrite(method: string, pathname: string): boolean {
  if (method !== "PUT") return false;
  const segments = githubRestPathSegments(pathname);
  return segments.length >= 3 && segments[segments.length - 2] === "secrets";
}

/**
 * What an approval of a gateway request's body binds to. Most bodies are bound
 * byte for byte. A secret write is bound to everything but its ciphertext, so
 * the person approves "set secret X" once and the agent's retry of the same
 * command, re-sealed with fresh randomness, matches it. The method and path
 * (repository, environment and secret name) stay in the digest, so the match
 * never reaches a different secret.
 */
export function gatewayRequestBodyIdentity(
  method: string,
  pathname: string,
  bodyBytes: Uint8Array | null,
  parsedBody: unknown,
): unknown {
  if (
    bodyBytes !== null &&
    isSecretWrite(method, pathname) &&
    parsedBody !== null &&
    typeof parsedBody === "object" &&
    !Array.isArray(parsedBody) &&
    typeof (parsedBody as Record<string, unknown>).encrypted_value === "string"
  ) {
    const rest = Object.fromEntries(
      Object.entries(parsedBody as Record<string, unknown>).filter(
        ([key]) => !SEALED_SECRET_FIELDS.has(key),
      ),
    );
    return { sealedSecret: rest };
  }
  return bodyBytes;
}
