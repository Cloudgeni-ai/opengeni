import { useCallback, useEffect, useState } from "react";
import type { OwnResource, OwnResourceReachWorkspace } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Button } from "../../ui/button";
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
    OpenGeniBrowserClient,
    "listOwnResources" | "listCapabilities" | "listOwnConnectionAccounts"
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
 * service's address.
 */
async function loginAppNames(client: MyThingsClient, workspaceId: string) {
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
  return names;
}

function useMyThings(client: MyThingsClient, workspaceId: string) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [appNames, setAppNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
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
    loginAppNames(client, workspaceId)
      .then((names) => {
        if (current) setAppNames(names);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [attempt, client, workspaceId]);

  return { state, appNames, retry: useCallback(() => setAttempt((count) => count + 1), []) };
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
}: {
  client: MyThingsClient;
  workspaceId: string;
  resource: OwnResource;
  appNames: ReadonlyMap<string, string>;
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
  return (
    <Disclosure
      variant="sheet"
      title={title}
      summary={summary}
      loading={reach.state.status === "loading"}
      sheetDescription={account ?? undefined}
    >
      <p className="m-0 text-xs leading-4.5 text-fg-muted">{OWN_WHERE_IT_WORKS_DESCRIPTION}</p>
      <OwnWhereItWorks name={account ? `${title} (${account})` : title} reach={reach} />
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
  const { state, appNames, retry } = useMyThings(client, workspaceId);

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
              />
            ))}
          </Section>
        );
      })}
    </SectionStack>
  );
}
