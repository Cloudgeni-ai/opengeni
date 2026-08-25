import type { Settings } from "@opengeni/config";

const encoder = new TextEncoder();

/**
 * Prove that the stable invited-user setup bearer can be constructed before an
 * invitation commits. Provider availability is intentionally outside this
 * precondition: the durable delivery journal records a failed or ambiguous
 * transport outcome after the invitation exists.
 */
export function assertOrganizationUserSetupDeliveryConfigured(settings: Settings): void {
  requiredSetupSecret(settings);
  requiredPublicBaseUrl(settings);
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
    to: input.recipientEmail,
    subject: `Join ${input.organizationName} on OpenGeni`,
    text: `${greeting}\n\nYou have been invited to ${input.organizationName} as ${role}.\n\n${workspaceSummary}\n\nThis invitation grants only the organization role and shared workspace access listed above. It never shares anyone's Personal workspace.\n\nSet up your account: ${input.setupUrl}\n\nIf you already have an OpenGeni account, sign in and accept the invitation instead.`,
    html: `<p>${escapeHtml(greeting)}</p><p>You have been invited to <strong>${escapeHtml(input.organizationName)}</strong> as ${escapeHtml(role)}.</p>${workspaceHtml}<p>This invitation grants only the organization role and shared workspace access listed above. It never shares anyone's Personal workspace.</p><p><a href="${escapeHtml(input.setupUrl)}">Set up your account</a></p><p>If you already have an OpenGeni account, sign in and accept the invitation instead.</p>`,
  };
}

export async function organizationUserSetupPayloadDigest(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<string> {
  return await sha256Hex(
    JSON.stringify({
      version: 1,
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
