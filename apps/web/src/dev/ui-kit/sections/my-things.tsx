import { useMemo } from "react";
import type {
  CapabilityCatalogItem,
  ConnectionMetadata,
  OwnResource,
  OwnResourceReachWorkspace,
} from "@opengeni/sdk";
import { MyThings, type MyThingsClient } from "@opengeni/react/app/components/my-things";

import { KitSection, StateCell, StatesGrid } from "../kit";

/* ----------------------------------------------------------------------------
   My things: every one of your own logins, plans and machines, rendered by the
   real component against an in-memory client. Opening a row shows its "Where
   it works" switches; the "fails" fixture refuses every change.
   -------------------------------------------------------------------------- */

const CURRENT = "22222222-2222-4222-8222-222222222222";

function workspaces(on: { design: boolean; support: boolean }): OwnResourceReachWorkspace[] {
  return [
    {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      name: "Personal",
      personal: true,
      current: false,
      on: true,
      alwaysOn: true,
      canChange: false,
    },
    {
      workspaceId: CURRENT,
      name: "Design preview",
      personal: false,
      current: true,
      on: on.design,
      alwaysOn: false,
      canChange: true,
    },
    {
      workspaceId: "33333333-3333-4333-8333-333333333333",
      name: "Customer support and operations, Northern Europe",
      personal: false,
      current: false,
      on: on.support,
      alwaysOn: false,
      canChange: true,
    },
  ];
}

const GMAIL_LOGIN = "55555555-5555-4555-8555-555555555551";

const RESOURCES: OwnResource[] = [
  {
    resourceKind: "connection",
    resourceId: GMAIL_LOGIN,
    name: "sam.lee@example.com",
    provider: "gmail.example.com",
    plan: null,
    workspaces: workspaces({ design: true, support: false }),
  },
  {
    resourceKind: "connection",
    resourceId: "55555555-5555-4555-8555-555555555552",
    name: "sam@example.com",
    provider: "tracker.example.com",
    plan: null,
    workspaces: workspaces({ design: true, support: true }),
  },
  {
    resourceKind: "subscription_connection",
    resourceId: "55555555-5555-4555-8555-555555555553",
    name: "sam.lee@example.com",
    provider: "claude",
    plan: "max",
    workspaces: workspaces({ design: false, support: false }),
  },
  {
    resourceKind: "connected_machine",
    resourceId: "55555555-5555-4555-8555-555555555554",
    name: "studio-mac",
    provider: null,
    plan: null,
    workspaces: workspaces({ design: true, support: false }).map((row) =>
      row.personal ? { ...row, alwaysOn: false, canChange: true } : row,
    ),
  },
];

// One connector this workspace lists, so the Gmail login is named by its app.
const CATALOG_ITEM = {
  name: "Gmail",
  connectionRef: { authoritySource: "user", kind: "oauth", providerDomain: "gmail.example.com" },
} as unknown as CapabilityCatalogItem;
const GMAIL_ACCOUNT = {
  id: GMAIL_LOGIN,
  authorityId: "66666666-6666-4666-8666-666666666666",
  subjectId: "user:sam",
  kind: "oauth",
  providerDomain: "gmail.example.com",
  metadata: {},
} as unknown as ConnectionMetadata;

type Fixture = "ready" | "loading" | "error" | "empty" | "fails";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function useFixtureClient(fixture: Fixture): MyThingsClient {
  return useMemo(() => {
    const client: MyThingsClient = {
      listOwnResources: async () => {
        if (fixture === "loading") return await new Promise<never>(() => {});
        await wait(300);
        if (fixture === "error") throw new Error("The service didn't answer. Try again.");
        return { resources: fixture === "empty" ? [] : RESOURCES };
      },
      listCapabilities: async () => ({ items: [CATALOG_ITEM], installations: [] }),
      listOwnConnectionAccounts: async () => [GMAIL_ACCOUNT],
      getOwnResourceReach: async (_workspaceId, resource) => {
        await wait(300);
        const found = RESOURCES.find((each) => each.resourceId === resource.resourceId);
        return { ...resource, workspaces: found?.workspaces ?? [] };
      },
      setOwnResourceReach: async (workspaceId, request) => {
        await wait(600);
        if (fixture === "fails")
          throw new Error("You can't add your own things in this workspace anymore.");
        const row = RESOURCES[0]!.workspaces.find((each) => each.workspaceId === workspaceId);
        return { workspace: { ...row!, on: request.on } };
      },
    };
    return client;
  }, [fixture]);
}

function Example({ fixture }: { fixture: Fixture }) {
  const client = useFixtureClient(fixture);
  return <MyThings client={client} workspaceId={CURRENT} />;
}

export default function MyThingsKitSection() {
  return (
    <KitSection sectionKey="my-things">
      <StatesGrid columns={2}>
        <StateCell label="Logins, a plan and a machine" align="stretch" span="full">
          <Example fixture="ready" />
        </StateCell>
        <StateCell label="Loading" align="stretch">
          <Example fixture="loading" />
        </StateCell>
        <StateCell label="Couldn't load" align="stretch">
          <Example fixture="error" />
        </StateCell>
        <StateCell label="Nothing yet" align="stretch">
          <Example fixture="empty" />
        </StateCell>
        <StateCell label="A change is refused" align="stretch">
          <Example fixture="fails" />
        </StateCell>
      </StatesGrid>
    </KitSection>
  );
}
