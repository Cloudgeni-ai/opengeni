import type { ModelConnectionAccessPolicy } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useEffect, useState } from "react";

import type { ConnectionAccessKind } from "@/components/connection-access-settings";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { Disclosure } from "@/components/ui/disclosure";
import { CheckboxField } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";

/* ----------------------------------------------------------------------------
   Connect account, step two: which workspaces can use what you connect.
   Connecting creates an organization account; by default every workspace in
   the organization can use it (new ones too), and "Only selected workspaces"
   limits it from the start. The choice is the account's own "Available in"
   (connection-access-settings.tsx), so it stays editable on the account page.

   Personal workspaces are one all-or-nothing choice ("Personal workspaces":
   everyone's), because an organization account can't be limited to one
   person's Personal workspace. Organization API keys never reach Personal
   workspaces, so for them that choice is shown off, with the reason.

   Owning the account by this workspace instead is under Advanced: it is only
   needed for separate billing or keys for one team, Codex Apps, or redeeming
   Codex usage limit resets.
   -------------------------------------------------------------------------- */

export type ConnectAudience =
  | { kind: "everyone" }
  | { kind: "selected"; workspaceIds: string[]; personalWorkspaces: boolean }
  /** Owned by this workspace, not the organization (Advanced). */
  | { kind: "workspace" };

export const EVERYONE: ConnectAudience = { kind: "everyone" };

/** Which providers' organization accounts can serve Personal workspaces. */
export function personalWorkspacesSupported(kind: ConnectionAccessKind): boolean {
  return kind === "codex" || kind === "supergrok";
}

/** Why an organization API key can't be offered to Personal workspaces. */
export const PERSONAL_KEYS_REASON = "Organization API keys can't be used in Personal workspaces.";

/** The organization's shared workspaces, for the "Only selected workspaces" list. */
export function useOrganizationWorkspaces(
  client: OpenGeniBrowserClient,
  organizationId: string,
  enabled: boolean,
): { workspaces: { id: string; name: string }[] | null; error: boolean } {
  const [state, setState] = useState<{
    workspaces: { id: string; name: string }[] | null;
    error: boolean;
  }>({ workspaces: null, error: false });
  useEffect(() => {
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
  }, [client, organizationId, enabled]);
  return state;
}

/** Why the choice can't be connected yet, or null. */
export function audienceBlockedReason(audience: ConnectAudience): string | null {
  if (audience.kind !== "selected") return null;
  return audience.workspaceIds.length === 0 && !audience.personalWorkspaces
    ? "Choose at least one workspace."
    : null;
}

/** The account's "Available in" for a choice. Null keeps the default (every workspace). */
export function audiencePolicy(
  audience: ConnectAudience,
  kind: ConnectionAccessKind,
): Pick<ModelConnectionAccessPolicy, "allowedWorkspaces" | "allowPersonalWorkspaces"> | null {
  if (audience.kind !== "selected") return null;
  return {
    allowedWorkspaces: audience.workspaceIds,
    allowPersonalWorkspaces: personalWorkspacesSupported(kind) && audience.personalWorkspaces,
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
  const limited = audiencePolicy(audience, target.kind);
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
 * "Who can use it" at the top of a provider's connect step. `here` is the
 * workspace the page is open in: in a shared workspace it is checked first
 * under "Only selected workspaces"; in a Personal workspace the copy says
 * truthfully whether the account reaches it.
 */
export function ConnectAudienceFields({
  kind,
  organizationName,
  here,
  workspaces,
  value,
  onChange,
  workspaceOwned,
  disabled = false,
}: {
  kind: ConnectionAccessKind;
  organizationName: string;
  here: { id: string; name: string; personal: boolean };
  /** The organization's shared workspaces; null while loading. */
  workspaces: { id: string; name: string }[] | null;
  value: ConnectAudience;
  onChange: (next: ConnectAudience) => void;
  /**
   * The Advanced choice to own the account by this workspace instead. Null
   * hides it (the viewer can't connect here, or the provider can't).
   */
  workspaceOwned: { description: string } | null;
  disabled?: boolean;
}) {
  const personalSupported = personalWorkspacesSupported(kind);
  const choice = value.kind === "workspace" ? "workspace" : value.kind;
  const selected = value.kind === "selected" ? value : null;
  const everyoneDescription = personalSupported
    ? "Every workspace, including new ones and everyone's Personal workspace."
    : here.personal
      ? "Every shared workspace, including new ones. Not this one: organization API keys can't be used in Personal workspaces."
      : `Every shared workspace, including new ones. ${PERSONAL_KEYS_REASON}`;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ChoiceCards
        label="Which workspaces can use it"
        description={`Owners and admins of ${organizationName} can see and change it on its account page.`}
        value={choice === "workspace" ? "" : choice}
        disabled={disabled}
        onValueChange={(next) =>
          onChange(
            next === "selected"
              ? {
                  kind: "selected",
                  workspaceIds: here.personal ? [] : [here.id],
                  personalWorkspaces: personalSupported && here.personal,
                }
              : EVERYONE,
          )
        }
      >
        <ChoiceCard
          value="everyone"
          title={`All workspaces in ${organizationName}`}
          description={everyoneDescription}
        />
        <ChoiceCard
          value="selected"
          title="Only selected workspaces"
          description="Other workspaces can't use it for new work."
        />
      </ChoiceCards>
      {selected ? (
        <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
          <legend className="mb-2 text-xs leading-4.5 font-medium text-fg">Workspaces</legend>
          {workspaces === null ? (
            <Skeleton className="h-5 w-48 rounded-md" />
          ) : (
            workspaces.map((workspace) => (
              <CheckboxField
                key={workspace.id}
                label={
                  workspace.id === here.id ? `${workspace.name} (this workspace)` : workspace.name
                }
                disabled={disabled}
                checked={selected.workspaceIds.includes(workspace.id)}
                onCheckedChange={(checked) =>
                  onChange({
                    ...selected,
                    workspaceIds: checked
                      ? [...new Set([...selected.workspaceIds, workspace.id])]
                      : selected.workspaceIds.filter((id) => id !== workspace.id),
                  })
                }
              />
            ))
          )}
          <CheckboxField
            label="Personal workspaces"
            description={
              personalSupported
                ? "Everyone's private Personal workspace, yours too. It's all of them or none."
                : PERSONAL_KEYS_REASON
            }
            disabled={disabled || !personalSupported}
            checked={personalSupported && selected.personalWorkspaces}
            onCheckedChange={(checked) => onChange({ ...selected, personalWorkspaces: checked })}
          />
        </fieldset>
      ) : null}
      {workspaceOwned ? (
        <Disclosure
          title="Advanced"
          summary={
            value.kind === "workspace"
              ? `Owned by ${here.personal ? "your Personal workspace" : here.name}`
              : "Who owns the account"
          }
          defaultOpen={value.kind === "workspace"}
        >
          <CheckboxField
            label={
              here.personal
                ? "Connect for your Personal workspace only"
                : `Connect for ${here.name} only`
            }
            description={workspaceOwned.description}
            disabled={disabled}
            checked={value.kind === "workspace"}
            onCheckedChange={(checked) => onChange(checked ? { kind: "workspace" } : EVERYONE)}
          />
        </Disclosure>
      ) : null}
    </div>
  );
}
