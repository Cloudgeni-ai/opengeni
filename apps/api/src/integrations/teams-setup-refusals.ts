import { nestedErrorRecords, nestedPostgresSqlState } from "@opengeni/db";
import { ApiHttpError } from "../http/api-error";

/**
 * `details.code` of a refusal from Teams organization setup or account
 * linking. Its message is written for the person at the setup page or link
 * dialog: what happened and what to do next, never which workspace, account or
 * person holds a conflicting connection. `details.reason` says which refusal.
 */
export const TEAMS_CONNECTION_REFUSED_CODE = "teams_connection_refused";

const REFUSALS = {
  // The Microsoft administrator sign-in (TeamsAdminProofError codes).
  state_invalid: [400, "This Microsoft sign-in expired. Start again from the setup link in Teams."],
  state_expired: [400, "This Microsoft sign-in expired. Start again from the setup link in Teams."],
  state_mismatch: [
    400,
    "This Microsoft sign-in belongs to another setup. Start again from the setup link in Teams.",
  ],
  consumer_tenant: [
    403,
    "Only a work or school Microsoft 365 organization can connect Microsoft Teams to Opengeni.",
  ],
  token_exchange_failed: [
    400,
    "Microsoft sign-in couldn't be verified. Start again from the setup link in Teams.",
  ],
  id_token_invalid: [
    400,
    "Microsoft sign-in couldn't be verified. Start again from the setup link in Teams.",
  ],
  tenant_mismatch: [
    403,
    "Sign in to Microsoft with your account in the Teams organization you're connecting.",
  ],
  user_mismatch: [403, "Sign in to Microsoft with the same account you use in Teams."],
  not_tenant_admin: [
    403,
    "Only a Microsoft 365 Global Administrator or Teams Administrator can connect your organization. Ask your admin to message Opengeni in Teams and select Connect your organization. If your admin role must be activated first, activate it and try again.",
  ],
  // The setup link and the chosen workspace.
  setup_link_invalid: [
    400,
    "This setup link is invalid or expired. Message Opengeni in Teams to get a new setup link.",
  ],
  microsoft_sign_in_required: [
    400,
    "Sign in to Microsoft to connect your organization. Start again from the setup link in Teams.",
  ],
  setup_unavailable: [
    403,
    "Opengeni can't be connected for this Teams organization yet. Contact Opengeni support.",
  ],
  shared_workspace_required: [
    422,
    "Connect Teams from a shared workspace, not a Personal workspace.",
  ],
  workspace_linked_elsewhere: [
    409,
    "This workspace is linked to another Teams organization. Choose another workspace.",
  ],
  // The organization's existing connection.
  connected_elsewhere: [
    409,
    "Opengeni is already connected for this Teams organization in another workspace. An admin of that workspace can disconnect it first.",
  ],
  linked_elsewhere: [
    409,
    "This Teams organization is linked to another workspace. Reconnect it in that workspace.",
  ],
  move_requires_global_admin: [
    409,
    "This Teams organization was connected to another workspace and is disconnected. Reconnect it in that workspace, or ask a Microsoft 365 Global Administrator to connect it here.",
  ],
  already_connected: [
    409,
    "Opengeni is already connected for this Teams organization. Message Opengeni in Teams to link your account.",
  ],
  connection_changed: [
    409,
    "This Teams organization's connection changed while you were connecting it. Start again from the setup link in Teams.",
  ],
  setup_link_used: [
    409,
    "This setup link was already used. Message Opengeni in Teams to get a new setup link.",
  ],
  // Account links: one Teams account per Opengeni account in a workspace.
  opengeni_account_linked: [
    409,
    "Your Opengeni account is already linked to a different Teams account in this workspace. Unlink it and connect again, or sign in to Opengeni with another account.",
  ],
  teams_account_linked: [
    409,
    "Your Teams account is already linked to a different Opengeni account in this workspace. Sign in to Opengeni with that account and try again.",
  ],
  link_opengeni_account_linked: [
    409,
    "Your Opengeni account is already linked to a different Teams account in this workspace. Unlink it in the Teams integration, then message Opengeni in Teams to get a new link.",
  ],
  link_used: [409, "This link was already used. Message Opengeni in Teams to get a new link."],
  link_changed: [
    409,
    "The Teams connection for this workspace changed while you were linking. Message Opengeni in Teams to get a new link.",
  ],
  // The Microsoft sign-in that proves an account link's Teams identity.
  link_sign_in_required: [
    400,
    "Sign in to Microsoft with the account you use in Teams to link it. Open the link from Teams again.",
  ],
  link_sign_in_expired: [
    400,
    "This Microsoft sign-in expired or belongs to another link. Open the link from Teams again.",
  ],
  link_sign_in_failed: [
    400,
    "Microsoft sign-in couldn't be verified. Open the link from Teams again.",
  ],
  link_consumer_tenant: [
    403,
    "Opengeni can only link a work or school Microsoft account. Sign in to Teams with one and message Opengeni again.",
  ],
  // With workspace routing, any active full member of the organization that
  // connected Teams can link; nobody else can.
  link_not_organization_member: [
    403,
    "You need an Opengeni account in the organization that connected Teams. Ask your Opengeni administrator for an invite.",
  ],
  // Replaced by a message that names both accounts when they are known.
  link_identity_mismatch: [
    403,
    "This link is for a different Teams account than the Microsoft account you signed in with. If the link is yours, open it again and sign in to Microsoft with the account you use in Teams. Otherwise, message Opengeni in Teams to get a link for your own account.",
  ],
} as const satisfies Record<string, readonly [400 | 403 | 409 | 422, string]>;

export type TeamsConnectionRefusal = keyof typeof REFUSALS;

const ERROR_CODES = {
  400: "validation_failed",
  403: "forbidden",
  409: "conflict",
  422: "validation_failed",
} as const;

/**
 * A Teams setup or account-link refusal whose message the page shows as is.
 * `message` replaces the default sentence with a more specific one.
 */
export function teamsConnectionRefused(
  reason: TeamsConnectionRefusal,
  message: string = REFUSALS[reason][1],
): ApiHttpError {
  const status = REFUSALS[reason][0];
  return new ApiHttpError(status, {
    code: ERROR_CODES[status],
    message,
    retryable: false,
    outcomeUnknown: false,
    details: { code: TEAMS_CONNECTION_REFUSED_CODE, reason },
  });
}

/**
 * An account link opened by a different Microsoft account than the Teams
 * account it is for. Names the Teams account (its display name from the link)
 * and the Microsoft account that signed in, when known, so whoever was sent
 * someone else's link sees whose it is.
 */
export function teamsLinkIdentityMismatch(
  teamsName: string | null | undefined,
  signedInAs: string | null | undefined,
): ApiHttpError {
  const next = "Otherwise, message Opengeni in Teams to get a link for your own account.";
  if (teamsName && signedInAs)
    return teamsConnectionRefused(
      "link_identity_mismatch",
      `This link is for the Teams account “${teamsName}”, but you signed in to Microsoft as ${signedInAs}. If that Teams account is yours, open the link again and sign in to Microsoft with it. ${next}`,
    );
  if (teamsName)
    return teamsConnectionRefused(
      "link_identity_mismatch",
      `This link is for the Teams account “${teamsName}”, not the Microsoft account you signed in with. If that Teams account is yours, open the link again and sign in to Microsoft with it. ${next}`,
    );
  if (signedInAs)
    return teamsConnectionRefused(
      "link_identity_mismatch",
      `This link is for a different Teams account than ${signedInAs}, the Microsoft account you signed in with. If the link is yours, open it again and sign in to Microsoft with the account you use in Teams. ${next}`,
    );
  return teamsConnectionRefused("link_identity_mismatch");
}

/**
 * Which account-link rule a failed install or link write broke, from the
 * database error: the single-use proof nonce, one Teams account per Opengeni
 * account in a workspace, or one Opengeni account per Teams account. "other"
 * for another unique violation (a concurrent change), null for anything else.
 */
export function teamsLinkConflict(
  error: unknown,
): "proof_used" | "opengeni_account_linked" | "teams_account_linked" | "other" | null {
  if ((error as { message?: unknown } | null)?.message === "teams_identity_already_linked")
    return "teams_account_linked";
  if (nestedPostgresSqlState(error) !== "23505") return null;
  let constraint: unknown;
  for (const record of nestedErrorRecords(error)) {
    constraint = record.constraint_name;
    if (typeof constraint === "string") break;
  }
  if (constraint === "teams_bot_proofs_pkey") return "proof_used";
  if (constraint === "teams_bot_links_workspace_id_subject_id_key")
    return "opengeni_account_linked";
  if (constraint === "teams_bot_links_pkey") return "teams_account_linked";
  return "other";
}
