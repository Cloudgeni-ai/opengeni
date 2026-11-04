import type { ModelConnectionAccessPolicy } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback, useEffect, useState } from "react";

import type { ConnectionAccessKind } from "@/components/connection-access-settings";
import {
  WorkspaceReachFields,
  type WorkspaceReach,
} from "@opengeni/react/app/components/workspace-reach";

/* ----------------------------------------------------------------------------
   Connect account, step two: which workspaces can use what you connect.
   Connecting creates an organization account; by default every workspace in
   the organization can use it (new ones too, and members' Personal
   workspaces), and "Selected workspaces" limits it from the start. The choice
   is the account's own "Available in" (connection-access-settings.tsx), with
   the same control, so it stays editable on the account page.

   Personal workspaces are one all-or-nothing choice ("Personal workspaces":
   everyone's), because an organization account can't be limited to one
   person's Personal workspace. Subscriptions and API keys alike can serve
   them.

   Owning an account by one workspace is not a choice here: to a person it
   reads the same as "Selected workspaces" with that one ticked. It stays
   where it is genuinely needed, explained there: Codex Apps, redeeming Codex
   usage limit resets, an API key in a Personal workspace, and workspace admins
   who can't connect for everyone.
   -------------------------------------------------------------------------- */

export type ConnectAudience = WorkspaceReach;

/** A new organization account's default: every workspace, new ones and Personal ones too. */
export const EVERYONE: ConnectAudience = { workspaceIds: null, personalWorkspaces: true };

/** The organization's shared workspaces, for the "Only selected workspaces" list. */
export function useOrganizationWorkspaces(
  client: OpenGeniBrowserClient,
  organizationId: string,
  enabled: boolean,
): { workspaces: { id: string; name: string }[] | null; error: boolean; retry: () => void } {
  const [state, setState] = useState<{
    workspaces: { id: string; name: string }[] | null;
    error: boolean;
  }>({ workspaces: null, error: false });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    setState({ workspaces: null, error: false });
    if (!enabled || !organizationId) return;
    let live = true;
    client
      .getOrganizationAdministrationOverview(organizationId)
      .then((overview) => {
        if (live) {
          setState({
            workspaces: overview.workspaces.map(({ id, name }) => ({ id, name })),
            error: false,
          });
        }
      })
      .catch(() => {
        if (live) setState({ workspaces: null, error: true });
      });
    return () => {
      live = false;
    };
  }, [client, organizationId, enabled, attempt]);
  return { ...state, retry };
}

/** Why the choice can't be connected yet, or null. */
export function audienceBlockedReason(audience: ConnectAudience): string | null {
  return audience.workspaceIds !== null &&
    audience.workspaceIds.length === 0 &&
    !audience.personalWorkspaces
    ? "Choose at least one workspace."
    : null;
}

/** The account's "Available in" for a choice. Null keeps the default (every workspace, Personal too). */
export function audiencePolicy(
  audience: ConnectAudience,
): Pick<ModelConnectionAccessPolicy, "allowedWorkspaces" | "allowPersonalWorkspaces"> | null {
  if (audience.workspaceIds === null && audience.personalWorkspaces) return null;
  return {
    allowedWorkspaces: audience.workspaceIds === null ? null : [...audience.workspaceIds],
    allowPersonalWorkspaces: audience.personalWorkspaces,
  };
}

/**
 * Limits a just-connected organization account to the chosen workspaces. The
 * account exists by now (the connect routes take no "Available in"), so this
 * is the same save as the account page's Available in. Resolves false when it
 * couldn't be saved; the account then stays available in every workspace.
 */
export async function applyConnectAudience(
  client: OpenGeniBrowserClient,
  target: { organizationId: string; kind: ConnectionAccessKind; connectionId: string },
  audience: ConnectAudience,
): Promise<boolean> {
  const limited = audiencePolicy(audience);
  if (!limited) return true;
  const where = {
    scope: "organizations" as const,
    scopeId: target.organizationId,
    kind: target.kind,
    connectionId: target.connectionId,
  };
  try {
    const current = await client.getModelConnectionAccess(where);
    await client.updateModelConnectionAccess(where, { ...current.policy, ...limited });
    window.dispatchEvent(new Event("model-connections-changed"));
    return true;
  } catch {
    return false;
  }
}

/**
 * "Available in" at the top of a provider's connect step. `here` is the
 * workspace Connect account was opened from, if any. Switching to "Selected
 * workspaces" starts an explicit pick from there: a shared one is ticked, and
 * from a Personal one the Personal workspaces choice is; nothing else is
 * carried over from the every-workspace default.
 */
export function ConnectAudienceFields({
  organizationName,
  here,
  workspaces,
  workspacesError = false,
  onRetryWorkspaces,
  value,
  onChange,
  disabled = false,
}: {
  organizationName: string;
  here?: { id: string; name: string; personal: boolean } | null | undefined;
  /** The organization's shared workspaces; null while loading. */
  workspaces: { id: string; name: string }[] | null;
  /** The list couldn't be read: say so, with a way to try again. */
  workspacesError?: boolean;
  onRetryWorkspaces?: () => void;
  value: ConnectAudience;
  onChange: (next: ConnectAudience) => void;
  disabled?: boolean;
}) {
  return (
    <WorkspaceReachFields
      owner={{ kind: "organization", name: organizationName }}
      organizationName={organizationName}
      managedBy="Organization owners and admins manage it, and can change this later on its page."
      value={value}
      onChange={(next) =>
        onChange(
          value.workspaceIds === null && next.workspaceIds !== null
            ? { ...next, personalWorkspaces: Boolean(here?.personal) }
            : next,
        )
      }
      workspaces={workspaces}
      workspacesError={workspacesError}
      onRetryWorkspaces={onRetryWorkspaces}
      hereId={here && !here.personal ? here.id : null}
      seedSelected={() => (here && !here.personal ? [here.id] : [])}
      personalWorkspaces="choice"
      disabled={disabled}
    />
  );
}
