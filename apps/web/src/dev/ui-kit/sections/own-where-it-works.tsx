import { useMemo } from "react";
import type { OwnResourceReachKind, OwnResourceReachWorkspace } from "@opengeni/sdk";
import {
  OwnWhereItWorksCard,
  OwnWhereItWorksSection,
  type OwnReachClient,
} from "@opengeni/react/app/components/own-where-it-works";

import { KitSection, StateCell, StatesGrid } from "../kit";

/* ----------------------------------------------------------------------------
   "Where it works" for your own login, plan or machine, rendered by the real
   components against an in-memory client. Switching a row saves after a short
   delay; the "fails" fixture refuses every change so the revert shows.
   -------------------------------------------------------------------------- */

const PERSONAL: OwnResourceReachWorkspace = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  name: "Personal",
  personal: true,
  current: false,
  on: true,
  alwaysOn: true,
  canChange: false,
};
const WORKSPACES: OwnResourceReachWorkspace[] = [
  PERSONAL,
  {
    workspaceId: "22222222-2222-4222-8222-222222222222",
    name: "Design preview",
    personal: false,
    current: true,
    on: true,
    alwaysOn: false,
    canChange: true,
  },
  {
    workspaceId: "33333333-3333-4333-8333-333333333333",
    name: "Customer support and operations, Northern Europe",
    personal: false,
    current: false,
    on: false,
    alwaysOn: false,
    canChange: true,
  },
  {
    workspaceId: "44444444-4444-4444-8444-444444444444",
    name: "Finance",
    personal: false,
    current: false,
    on: false,
    alwaysOn: false,
    canChange: false,
  },
];

type Fixture = "ready" | "loading" | "error" | "fails" | "machine";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function useFixtureClient(fixture: Fixture): OwnReachClient {
  return useMemo(() => {
    const rows =
      fixture === "machine"
        ? WORKSPACES.map((row) =>
            row.personal ? { ...row, alwaysOn: false, canChange: true } : row,
          )
        : WORKSPACES;
    const client: OwnReachClient = {
      getOwnResourceReach: async (
        _workspaceId: string,
        resource: { resourceKind: OwnResourceReachKind; resourceId: string },
      ) => {
        if (fixture === "loading") return await new Promise<never>(() => {});
        await wait(300);
        if (fixture === "error") throw new Error("The service didn't answer. Try again.");
        return { ...resource, workspaces: rows };
      },
      setOwnResourceReach: async (workspaceId: string, request: { on: boolean }) => {
        await wait(600);
        if (fixture === "fails")
          throw new Error("You can't add your own things in this workspace anymore.");
        const row = rows.find((each) => each.workspaceId === workspaceId) ?? PERSONAL;
        return { workspace: { ...row, on: request.on } };
      },
    };
    return client;
  }, [fixture]);
}

function Section({ fixture }: { fixture: Fixture }) {
  const client = useFixtureClient(fixture);
  return (
    <OwnWhereItWorksSection
      client={client}
      workspaceId={WORKSPACES[1]!.workspaceId}
      resourceKind="subscription_connection"
      resourceId="55555555-5555-4555-8555-555555555555"
      name="My Claude"
    />
  );
}

function Card({ fixture }: { fixture: Fixture }) {
  const client = useFixtureClient(fixture);
  return (
    <OwnWhereItWorksCard
      client={client}
      workspaceId={WORKSPACES[1]!.workspaceId}
      resourceKind="connected_machine"
      resourceId="66666666-6666-4666-8666-666666666666"
      name="studio-mac"
    />
  );
}

export default function OwnWhereItWorksKitSection() {
  return (
    <KitSection sectionKey="own-where-it-works">
      <StatesGrid columns={2}>
        <StateCell label="Plan page" align="stretch" span="full">
          <Section fixture="ready" />
        </StateCell>
        <StateCell label="Machine page card" align="stretch" span="full">
          <Card fixture="machine" />
        </StateCell>
        <StateCell label="Loading" align="stretch">
          <Section fixture="loading" />
        </StateCell>
        <StateCell label="Couldn't load" align="stretch">
          <Section fixture="error" />
        </StateCell>
        <StateCell label="A change is refused" align="stretch" span="full">
          <Section fixture="fails" />
        </StateCell>
      </StatesGrid>
    </KitSection>
  );
}
