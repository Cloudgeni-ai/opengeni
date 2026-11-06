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
    "Only a work or school Microsoft 365 organization can connect Opengeni for Teams.",
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
  shared_workspace_required: [422, "Choose a shared workspace to connect Teams to."],
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
} as const satisfies Record<string, readonly [400 | 403 | 409 | 422, string]>;

export type TeamsConnectionRefusal = keyof typeof REFUSALS;

const ERROR_CODES = {
  400: "validation_failed",
  403: "forbidden",
  409: "conflict",
  422: "validation_failed",
} as const;

/** A Teams setup or account-link refusal whose message the page shows as is. */
export function teamsConnectionRefused(reason: TeamsConnectionRefusal): ApiHttpError {
  const [status, message] = REFUSALS[reason];
  return new ApiHttpError(status, {
    code: ERROR_CODES[status],
    message,
    retryable: false,
    outcomeUnknown: false,
    details: { code: TEAMS_CONNECTION_REFUSED_CODE, reason },
  });
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
