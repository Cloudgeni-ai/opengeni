import type { Settings } from "@opengeni/config";
import type { ManagedEmailTransport } from "@opengeni/core";

const encoder = new TextEncoder();

/**
 * Prove that the stable invited-user setup bearer can be constructed before an
 * invitation commits. Provider availability is intentionally outside this
 * precondition: the durable delivery journal records a failed or ambiguous
 * transport outcome after the invitation exists.
 */
export function assertOrganizationUserSetupDeliveryConfigured(
  settings: Settings,
  transport: ManagedEmailTransport,
): void {
  requiredSetupSecret(settings);
  requiredPublicBaseUrl(settings);
  assertManagedEmailTransportMetadata(transport);
}

/** Reject an invalid embedded-provider contract before any durable boundary. */
export function assertManagedEmailTransportMetadata(transport: ManagedEmailTransport): void {
  if (
    transport.sender.trim() !== transport.sender ||
    encoder.encode(transport.sender).byteLength < 3 ||
    encoder.encode(transport.sender).byteLength > 320
  ) {
    throw new Error("Managed email sender is invalid");
  }
  const { scope, retentionSeconds } = transport.idempotency;
  if (
    scope.trim() !== scope ||
    !/^[a-z0-9][a-z0-9:._-]*$/.test(scope) ||
    encoder.encode(scope).byteLength > 200 ||
    !Number.isInteger(retentionSeconds) ||
    retentionSeconds < 0 ||
    retentionSeconds > 31_536_000
  ) {
    throw new Error("Managed email idempotency contract is invalid");
  }
}

export async function deriveOrganizationUserSetupToken(
  settings: Settings,
  input: { invitationId: string; deliveryId: string },
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
      `opengeni:organization-user-setup-delivery:v1:${input.deliveryId}:${input.invitationId}`,
    ),
  );
  const token = base64Url(new Uint8Array(signature));
  const digest = await sha256Hex(token);
  const url = new URL("/setup-account", requiredPublicBaseUrl(settings));
  url.hash = new URLSearchParams({ token }).toString();
  return { token, digest, url: url.toString() };
}

export type OrganizationUserSetupEmailSnapshot = {
  senderEmail: string;
  recipientEmail: string;
  recipientName: string | null;
  organizationName: string;
  organizationRole: "owner" | "admin" | "member";
  sharedWorkspaceAccess: Array<{
    workspaceId: string;
    workspaceName: string;
    role: "viewer" | "member" | "admin";
  }>;
  setupUrl: string;
};

export function renderOrganizationUserSetupEmail(input: OrganizationUserSetupEmailSnapshot): {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
} {
  const greeting = input.recipientName ? `Hi ${input.recipientName},` : "Hello,";
  const role = titleCase(input.organizationRole);
  const workspaceSummary =
    input.sharedWorkspaceAccess.length === 0
      ? "No shared workspaces are assigned yet."
      : `Shared workspace access:\n${input.sharedWorkspaceAccess
          .map((workspace) => `- ${workspace.workspaceName}: ${titleCase(workspace.role)}`)
          .join("\n")}`;
  const workspaceHtml =
    input.sharedWorkspaceAccess.length === 0
      ? "<p>No shared workspaces are assigned yet.</p>"
      : `<p>Shared workspace access:</p><ul>${input.sharedWorkspaceAccess
          .map(
            (workspace) =>
              `<li>${escapeHtml(workspace.workspaceName)}: ${escapeHtml(titleCase(workspace.role))}</li>`,
          )
          .join("")}</ul>`;
  return {
    from: input.senderEmail,
    to: input.recipientEmail,
    subject: `You're invited to join ${input.organizationName} on OpenGeni`,
    text: `${greeting}\n\nYou've been invited to join ${input.organizationName} on OpenGeni as ${role}.\n\n${workspaceSummary}\n\nThis invitation grants only the organization role and shared workspace access listed above. It never shares anyone's Personal workspace.\n\nAccept invitation to ${input.organizationName}: ${input.setupUrl}\n\nYou'll sign in or create an account before joining. Already use OpenGeni? Open this invitation and choose Sign in and continue. OpenGeni will show the invitation immediately after you sign in.`,
    html: `<p>${escapeHtml(greeting)}</p><p>You've been invited to join <strong>${escapeHtml(input.organizationName)}</strong> on OpenGeni as ${escapeHtml(role)}.</p>${workspaceHtml}<p>This invitation grants only the organization role and shared workspace access listed above. It never shares anyone's Personal workspace.</p><p><a href="${escapeHtml(input.setupUrl)}">Accept invitation to ${escapeHtml(input.organizationName)}</a></p><p>You'll sign in or create an account before joining. Already use OpenGeni? Open this invitation and choose <strong>Sign in and continue</strong>. OpenGeni will show the invitation immediately after you sign in.</p>`,
  };
}

export async function organizationUserSetupPayloadDigest(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  providerIdempotencyScope: string;
}): Promise<string> {
  return await sha256Hex(
    JSON.stringify({
      version: 2,
      providerIdempotencyScope: input.providerIdempotencyScope,
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    }),
  );
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

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
