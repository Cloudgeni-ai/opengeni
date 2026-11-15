import { useCallback, useEffect, useState } from "react";
import type { ChatClient, ConnectionMetadata } from "@opengeni/sdk";
import type { OwnResource, OwnResourceReachWorkspace } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { isPersonalGitHubConnection } from "@opengeni/contracts/personal-github";
import { Button } from "../../ui/button";
import { DetailFooterConfirm } from "../../ui/detail-sheet";
import { Disclosure } from "../../ui/disclosure";
import { EmptyState } from "../../ui/empty-state";
import { Notice } from "../../ui/notice";
import { Section, SectionStack } from "../../ui/section";
import { Skeleton } from "../../ui/skeleton";
import { userErrorText } from "../../ui/api-error";
import { matchingConnectionAccounts } from "./capabilities/session-connection-accounts";
import {
  OWN_WHERE_IT_WORKS_DESCRIPTION,
  OwnWhereItWorks,
  useOwnResourceReach,
  type OwnReachClient,
} from "./own-where-it-works";

/**
 * "My things": every one of your own logins, model plans and machines in the
 * organization, and the workspaces where each works for your own messages.
 * Nobody else's messages ever use them. Each opens the same "Where it works"
 * switches its own page has.
 */
export type MyThingsClient = OwnReachClient &
  Pick<
    ChatClient<OpenGeniBrowserClient>,
    | "listOwnResources"
    | "listCapabilities"
    | "listOwnConnectionAccounts"
    | "deleteConnection"
    | "disconnectPersonalGitHub"
  >;

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; resources: OwnResource[] };

const PLAN_PROVIDERS: Readonly<Record<string, string>> = {
  codex: "Codex",
  claude: "Claude",
  xai: "SuperGrok",
};

/**
 * A plan's title from its provider and the plan the provider reports:
 * "Claude Max", "Codex Pro", and "SuperGrok Heavy" for `supergrok_heavy`,
 * never repeating the provider's name.
 */
export function planTitle(provider: string | null, plan: string | null): string {
  const words = (value: string | null) =>
    (value ?? "")
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  const name = PLAN_PROVIDERS[provider ?? ""] ?? (words(provider).join(" ") || "Model plan");
  const planWords = words(plan);
  if (planWords[0]?.toLowerCase() === name.toLowerCase()) planWords.shift();
  return [name, ...planWords].join(" ");
}

function workspaceLabel(row: OwnResourceReachWorkspace): string {
  return row.personal ? "your Personal workspace" : row.name;
}

/** Where it works, in a few words: "Works in your Personal workspace and Design". */
export function whereItWorksSummary(workspaces: readonly OwnResourceReachWorkspace[]): string {
  const on = workspaces.filter((row) => row.on);
  if (on.length === 0) return "Turned off everywhere";
  if (workspaces.length > 2 && on.length === workspaces.length)
    return "Works in all your workspaces";
  const names = on.map(workspaceLabel);
  if (names.length === 1) return `Works only in ${names[0]}`;
  if (names.length === 2) return `Works in ${names[0]} and ${names[1]}`;
  return `Works in ${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * Which app each of your logins signs in to ("Gmail"), from this workspace's
 * connectors. A login for a connector this workspace doesn't list keeps its
 * service's address. Also each login itself, which says where to remove it.
 */
async function loginDetails(client: MyThingsClient, workspaceId: string) {
  const [catalog, accounts] = await Promise.all([
    client.listCapabilities(workspaceId),
    client.listOwnConnectionAccounts(workspaceId, { includeInactive: true }),
  ]);
  const names = new Map<string, string>();
  for (const item of catalog.items) {
    if (!item.connectionRef || item.connectionRef.authoritySource === "host") continue;
    for (const account of matchingConnectionAccounts(item.connectionRef, accounts)) {
      if (!names.has(account.id)) names.set(account.id, item.name);
    }
  }
  // Only your own logins; a shared account in this workspace isn't yours to remove here.
  const logins = new Map(
    accounts
      .filter((account) => account.subjectId !== null)
      .map((account) => [account.id, account]),
  );
  return { names, logins };
}

/**
 * Remove one of your own logins where it was added, for every workspace it
 * works in. Your own GitHub account has its own disconnect.
 */
export async function removeOwnLogin(
  client: Pick<MyThingsClient, "deleteConnection" | "disconnectPersonalGitHub">,
  login: ConnectionMetadata,
): Promise<void> {
  if (isPersonalGitHubConnection(login)) {
    await client.disconnectPersonalGitHub(login.workspaceId, login.id, {
      expectedVersion: login.version,
      idempotencyKey: crypto.randomUUID(),
    });
    return;
  }
  await client.deleteConnection(login.workspaceId, login.id);
}

function useMyThings(client: MyThingsClient, workspaceId: string) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [appNames, setAppNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [logins, setLogins] = useState<ReadonlyMap<string, ConnectionMetadata>>(new Map());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    // A reload after a change keeps the list on screen.
    setState((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
    client
      .listOwnResources(workspaceId)
      .then((listed) => {
        if (current) setState({ status: "ready", resources: listed.resources });
      })
      .catch((error: unknown) => {
        if (current)
          setState({
            status: "error",
            message: userErrorText(error, "Couldn't load your things."),
          });
      });
    // Names are a nicety: without them a login shows its service's address.
    // Without its login, a row offers no Remove.
    loginDetails(client, workspaceId)
      .then((details) => {
        if (!current) return;
        setAppNames(details.names);
        setLogins(details.logins);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [attempt, client, workspaceId]);

  return {
    state,
    appNames,
    logins,
    retry: useCallback(() => setAttempt((count) => count + 1), []),
  };
}

function titleAndAccount(
  resource: OwnResource,
  appNames: ReadonlyMap<string, string>,
): { title: string; account: string | null } {
  switch (resource.resourceKind) {
    case "connection":
      return {
        title: appNames.get(resource.resourceId) ?? resource.provider ?? resource.name,
        account: resource.name === resource.provider ? null : resource.name,
      };
    case "subscription_connection": {
      return {
        title: planTitle(resource.provider, resource.plan),
        account: resource.name === resource.provider ? null : resource.name,
      };
    }
    case "connected_machine":
      return { title: resource.name, account: null };
  }
}

function MyThingRow({
  client,
  workspaceId,
  resource,
  appNames,
  login,
  onRemoved,
}: {
  client: MyThingsClient;
  workspaceId: string;
  resource: OwnResource;
  appNames: ReadonlyMap<string, string>;
  /** The login this row is, when it can be removed. */
  login: ConnectionMetadata | null;
  onRemoved: () => void;
}) {
  const reach = useOwnResourceReach({
    client,
    workspaceId,
    resourceKind: resource.resourceKind,
    resourceId: resource.resourceId,
    initialWorkspaces: resource.workspaces,
  });
  const { title, account } = titleAndAccount(resource, appNames);
  const where = reach.state.status === "ready" ? whereItWorksSummary(reach.state.workspaces) : null;
  const summary = [account, where].filter((part): part is string => Boolean(part)).join(" · ");
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const removable = login !== null && login.status !== "revoked";
  const remove = async () => {
    if (!login) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await removeOwnLogin(client, login);
      setConfirming(false);
      onRemoved();
    } catch (error) {
      setRemoveError(userErrorText(error, "Couldn't remove this login."));
    } finally {
      setRemoving(false);
    }
  };
  return (
    <Disclosure
      variant="sheet"
      title={title}
      summary={summary}
      loading={reach.state.status === "loading"}
      sheetDescription={account ?? undefined}
      onOpenChange={(open) => {
        if (open) return;
        setConfirming(false);
        setRemoveError(null);
      }}
      sheetFooterStart={
        removable ? (
          <Button
            type="button"
            variant="ghost"
            className="-ml-3 text-danger hover:bg-danger/10 hover:text-danger pointer-coarse:h-11"
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
        ) : undefined
      }
      sheetFooterConfirm={
        removable && confirming ? (
          <DetailFooterConfirm
            title={`Remove ${account ? `${title} (${account})` : title}?`}
            description="It stops working in all your workspaces. You can sign in again anytime."
            confirmLabel={removing ? "Removing…" : "Remove"}
            pending={removing}
            onCancel={() => {
              setConfirming(false);
              setRemoveError(null);
            }}
            onConfirm={() => void remove()}
          />
        ) : undefined
      }
    >
      <p className="m-0 text-xs leading-4.5 text-fg-muted">{OWN_WHERE_IT_WORKS_DESCRIPTION}</p>
      <OwnWhereItWorks name={account ? `${title} (${account})` : title} reach={reach} />
      {removeError ? (
        <div role="alert">
          <Notice tone="failed">{removeError}</Notice>
        </div>
      ) : null}
    </Disclosure>
  );
}

const GROUPS = [
  {
    kind: "connection",
    title: "Logins",
    description: "Your own sign-ins to apps like Gmail or Linear.",
  },
  {
    kind: "subscription_connection",
    title: "Model plans",
    description:
      "Your own Codex, Claude or SuperGrok subscriptions. They pay for your own messages.",
  },
  {
    kind: "connected_machine",
    title: "Machines",
    description: "Your own computers. The agent runs on them only for your own messages.",
  },
] as const;

export function MyThings({ client, workspaceId }: { client: MyThingsClient; workspaceId: string }) {
  const { state, appNames, logins, retry } = useMyThings(client, workspaceId);

  if (state.status === "loading") {
    return (
      <Section title="Logins" aria-busy="true">
        {[0, 1, 2].map((key) => (
          <div key={key} className="flex flex-col gap-1.5 py-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        ))}
      </Section>
    );
  }
  if (state.status === "error") {
    return (
      <Notice
        tone="waiting"
        title="Couldn't load your things"
        action={
          <Button type="button" size="sm" variant="outline" onClick={retry}>
            Try again
          </Button>
        }
      >
        {state.message}
      </Notice>
    );
  }
  if (state.resources.length === 0) {
    return (
      <EmptyState
        variant="page"
        title="Nothing of your own yet"
        description="Logins, model plans and machines you add as Only me show up here, with the workspaces where each one works."
      />
    );
  }
  return (
    <SectionStack>
      {GROUPS.map((group) => {
        const resources = state.resources.filter(
          (resource) => resource.resourceKind === group.kind,
        );
        if (resources.length === 0) return null;
        return (
          <Section key={group.kind} title={group.title} description={group.description}>
            {resources.map((resource) => (
              <MyThingRow
                key={resource.resourceId}
                client={client}
                workspaceId={workspaceId}
                resource={resource}
                appNames={appNames}
                login={
                  resource.resourceKind === "connection"
                    ? (logins.get(resource.resourceId) ?? null)
                    : null
                }
                onRemoved={retry}
              />
            ))}
          </Section>
        );
      })}
    </SectionStack>
  );
}
