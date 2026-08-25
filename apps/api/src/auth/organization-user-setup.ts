import type { Settings } from "@opengeni/config";

const encoder = new TextEncoder();

/**
 * Prove that invited-user setup delivery is configured BEFORE anything is
 * committed. `deriveOrganizationUserSetupToken` needs the invitation id, so it
 * can only run after the invitation row exists; without this precondition a
 * deployment missing either setting fails *after* that commit and leaves the
 * administrator with an outcome-unknown 500 and an invitation nobody was told
 * about. `OPENGENI_PUBLIC_BASE_URL` is only config-required in managed mode
 * when integrations are enabled, so this is reachable on a valid deployment.
 */
export function assertOrganizationUserSetupDeliveryConfigured(settings: Settings): void {
  requiredSetupSecret(settings);
  requiredPublicBaseUrl(settings);
}

export async function deriveOrganizationUserSetupToken(
  settings: Settings,
  input: { invitationId: string; operationId: string },
): Promise<{ token: string; digest: string; url: string }> {
  const secret = requiredSetupSecret(settings);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      `opengeni:organization-user-setup:v1:${input.operationId}:${input.invitationId}`,
    ),
  );
  const token = base64Url(new Uint8Array(signature));
  const digest = await sha256Hex(token);
  const url = new URL("/setup-account", requiredPublicBaseUrl(settings));
  url.hash = new URLSearchParams({ token }).toString();
  return { token, digest, url: url.toString() };
}

export async function organizationUserSetupRequestFingerprint(
  settings: Settings,
  input: { tokenDigest: string; name: string; password: string },
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(requiredSetupSecret(settings)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      JSON.stringify({
        tokenDigest: input.tokenDigest,
        name: input.name,
        password: input.password,
      }),
    ),
  );
  return hex(new Uint8Array(signature));
}

export async function selfServiceOrganizationSetupRequestFingerprint(input: {
  authUserId: string;
  organizationName: string;
}): Promise<string> {
  const actorSubjectId = `user:${input.authUserId}`;
  const organizationNameBytes = encoder.encode(input.organizationName);
  return await sha256Hex(
    `opengeni:self-service-organization:v1:${actorSubjectId}:${organizationNameBytes.byteLength}:${input.organizationName}`,
  );
}

export async function organizationUserSetupTokenDigest(token: string): Promise<string> {
  return await sha256Hex(token);
}

function requiredSetupSecret(settings: Settings): string {
  if (!settings.betterAuthSecret) {
    throw new Error("OPENGENI_BETTER_AUTH_SECRET is required for organization user setup");
  }
  return settings.betterAuthSecret;
}

function requiredPublicBaseUrl(settings: Settings): string {
  if (!settings.publicBaseUrl) {
    throw new Error("OPENGENI_PUBLIC_BASE_URL is required for organization user setup");
  }
  return settings.publicBaseUrl;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
