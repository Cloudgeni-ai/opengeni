import { useCallback, useEffect, useState } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { UserResourceAuthoritySummary } from "@opengeni/sdk";
import { SettingRow } from "@opengeni/react/ui/setting-row";
import { Switch } from "@opengeni/react/ui/switch";

/**
 * The shared workspace where a person sees one of their own subscriptions.
 * There they can turn it on for the messages they send themselves (D-53).
 */
export type OwnTurnsPlace = { workspaceId: string; workspaceName: string };

type OwnTurnsClient = Pick<
  OpenGeniBrowserClient,
  "listUserResourceAuthorities" | "issueUserResourceGrant" | "revokeUserResourceGrant"
>;

type OwnTurnsState = {
  loading: boolean;
  on: boolean;
  authorityId: string | null;
  grantId: string | null;
  error: string | null;
};

const ACTION = "subscription_connection.use";

/** The standing grant that turns the account on in this workspace, if any. */
function standingGrant(
  authority: UserResourceAuthoritySummary,
  workspaceId: string,
  now: number,
): string | null {
  const grant = authority.grants.find(
    (each) =>
      each.targetWorkspaceId === workspaceId &&
      each.action === ACTION &&
      each.mode === "always" &&
      each.context === "workspace_shared" &&
      each.status === "active" &&
      (each.expiresAt === null || Date.parse(each.expiresAt) > now),
  );
  return grant?.grantId ?? null;
}

async function findAuthority(
  client: OwnTurnsClient,
  workspaceId: string,
  connectionId: string,
): Promise<UserResourceAuthoritySummary | null> {
  let cursor: string | undefined;
  // Bounded: a person has few subscriptions, and a broken cursor must not loop.
  for (let page = 0; page < 20; page += 1) {
    const listed = await client.listUserResourceAuthorities(workspaceId, {
      resourceKind: "subscription_connection",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const found = listed.authorities.find(
      (authority) => authority.resourceId === connectionId && authority.status === "active",
    );
    if (found) return found;
    if (!listed.nextCursor) return null;
    cursor = listed.nextCursor;
  }
  return null;
}

/**
 * Turn one of your own subscriptions on for your own messages in a shared
 * workspace. Being turned on is a standing grant there; your Personal
 * workspace needs none.
 */
export async function turnOnOwnSubscription(
  client: OwnTurnsClient,
  workspaceId: string,
  connectionId: string,
): Promise<string> {
  const authority = await findAuthority(client, workspaceId, connectionId);
  if (!authority) throw new Error("This account isn't listed as yours yet. Try again.");
  const existing = standingGrant(authority, workspaceId, Date.now());
  if (existing) return existing;
  const issued = await client.issueUserResourceGrant(workspaceId, authority.authorityId, {
    scope: "user",
    resourceKind: "subscription_connection",
    mode: "always",
    context: "workspace_shared",
    workspaceSharedAcknowledged: true,
  });
  return issued.grant.grantId;
}

export function useOwnSubscriptionTurns(
  client: OwnTurnsClient,
  place: OwnTurnsPlace | undefined,
  connectionId: string,
) {
  const workspaceId = place?.workspaceId;
  const [state, setState] = useState<OwnTurnsState>({
    loading: Boolean(workspaceId),
    on: false,
    authorityId: null,
    grantId: null,
    error: null,
  });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    findAuthority(client, workspaceId, connectionId)
      .then((authority) => {
        if (!live) return;
        const grantId = authority ? standingGrant(authority, workspaceId, Date.now()) : null;
        setState({
          loading: false,
          on: grantId !== null,
          authorityId: authority?.authorityId ?? null,
          grantId,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Couldn't load this setting.",
        }));
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, connectionId]);

  const setOn = useCallback(
    async (next: boolean) => {
      if (!workspaceId || pending) return;
      const before = state;
      // The switch moves at once; a failure puts it back and says why.
      setState({ ...before, on: next, error: null });
      setPending(true);
      try {
        if (next) {
          const grantId = await turnOnOwnSubscription(client, workspaceId, connectionId);
          setState((current) => ({ ...current, on: true, grantId }));
        } else if (before.grantId) {
          await client.revokeUserResourceGrant(workspaceId, before.grantId);
          setState((current) => ({ ...current, on: false, grantId: null }));
        }
      } catch (error) {
        setState({
          ...before,
          error: error instanceof Error ? error.message : "Couldn't change this setting.",
        });
      } finally {
        setPending(false);
      }
    },
    [client, connectionId, pending, state, workspaceId],
  );

  return { ...state, pending, setOn };
}

/** "Use for my messages here", on your own account's page in a shared workspace. */
export function OwnSubscriptionTurnsRow({
  client,
  place,
  connectionId,
  name,
}: {
  client: OwnTurnsClient;
  place: OwnTurnsPlace;
  connectionId: string;
  name: string;
}) {
  const turns = useOwnSubscriptionTurns(client, place, connectionId);
  return (
    <SettingRow
      label={`Use for my messages in ${place.workspaceName}`}
      description={
        turns.error ??
        "The agent uses this account first when you send a message here, in shared chats too. Messages from other people never use it."
      }
      control={
        <Switch
          aria-label={`Use ${name} for my messages in ${place.workspaceName}`}
          showStateText
          checked={turns.on}
          pending={turns.loading || turns.pending}
          disabled={turns.loading || turns.authorityId === null}
          onCheckedChange={(next) => void turns.setOn(next)}
        />
      }
    />
  );
}
