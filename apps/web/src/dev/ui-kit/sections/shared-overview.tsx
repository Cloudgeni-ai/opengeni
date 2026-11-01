import { useMemo } from "react";
import { OpenGeniApiError } from "@opengeni/sdk";
import { SharedOverview } from "@/components/settings/shared-overview";
import type {
  SharedOverviewClient,
  SharedPlace,
} from "@/components/settings/shared-overview-model";

import { KitSection, StateCell, StatesGrid } from "../kit";

/* ----------------------------------------------------------------------------
   Organization settings › Shared: the real page against an in-memory client.
   "admin" is an organization admin who isn't an owner, so only the machines,
   sandbox environments and vaults that work here are listed; "partial" fails
   the sandbox environments list.
   -------------------------------------------------------------------------- */

const HERE = "22222222-2222-4222-8222-222222222222";
const SALES = "44444444-4444-4444-8444-444444444444";
const FINANCE = "55555555-5555-4555-8555-555555555555";
const SUPPORT = "66666666-6666-4666-8666-666666666666";
const RESEARCH = "77777777-7777-4777-8777-777777777777";
const LEGAL = "88888888-8888-4888-8888-888888888888";
const MINE = "99999999-9999-4999-8999-999999999999";
const SOMEONES_PERSONAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Fixture = "owner" | "admin" | "loading" | "error" | "partial" | "empty";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const reach = (
  homeWorkspaceId: string,
  allowedWorkspaceIds: string[] | null,
  allowPersonalWorkspaces = false,
) => ({ homeWorkspaceId, allowedWorkspaceIds, allowPersonalWorkspaces });

const MACHINES = [
  {
    id: "e1",
    sandboxId: "m1",
    name: "shared-gpu-rig-north-europe-01",
    reach: reach(HERE, null, true),
  },
  { id: "e2", sandboxId: "m2", name: "build-farm", reach: reach(HERE, [SALES, FINANCE]) },
  { id: "e3", sandboxId: "m3", name: "legal-scanner", reach: reach(LEGAL, []) },
  { id: "e5", sandboxId: "m5", name: "studio-mac-mini", reach: reach(SOMEONES_PERSONAL, []) },
];

const RIGS = [
  { id: "r1", name: "Data pipeline", reach: reach(HERE, null) },
  { id: "r2", name: "Sales demo", reach: reach(SALES, [], true) },
];

const forbidden = () => new OpenGeniApiError(403, '{"error":"missing permission account:admin"}');

const VAULTS = [
  {
    id: "v1",
    name: "Company accounts",
    ownerKind: "organization",
    syncStatus: "ok",
    availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
  },
  {
    id: "v2",
    name: "Sales tools",
    ownerKind: "organization",
    syncStatus: "ok",
    availability: { allowedWorkspaceIds: [SALES], allowPersonalWorkspaces: true },
  },
  {
    id: "v3",
    name: "Finance and payroll integrations for the Nordic subsidiaries",
    ownerKind: "organization",
    syncStatus: "auth_expired",
    availability: {
      allowedWorkspaceIds: [FINANCE, SUPPORT, RESEARCH, LEGAL, SALES],
      allowPersonalWorkspaces: false,
    },
  },
  {
    id: "v4",
    name: "Legal archive",
    ownerKind: "organization",
    syncStatus: "ok",
    availability: { allowedWorkspaceIds: [LEGAL], allowPersonalWorkspaces: false },
  },
];

function useFixtureClient(fixture: Fixture): SharedOverviewClient {
  return useMemo(() => {
    const empty = fixture === "empty";
    async function settle() {
      if (fixture === "loading") await new Promise<never>(() => {});
      await wait(250);
      if (fixture === "error") throw new Error("The service didn't answer. Try again.");
    }
    const client = {
      listCapabilities: async () => ({ items: [], installations: [] }),
      listOrganizationMachines: async () => {
        await settle();
        if (fixture === "admin") throw forbidden();
        return { complete: true, machines: empty ? [] : MACHINES };
      },
      listOrganizationRigs: async () => {
        await settle();
        if (fixture === "admin") throw forbidden();
        if (fixture === "partial") throw new OpenGeniApiError(503, '{"error":"unavailable"}');
        return { complete: true, rigs: empty ? [] : RIGS };
      },
      listMachines: async () => {
        await settle();
        if (empty) return { activeSandboxId: null, activeEpoch: 0, machines: [] };
        return {
          activeSandboxId: null,
          activeEpoch: 0,
          machines: MACHINES.slice(0, 2).map((machine) => ({
            sandboxId: machine.sandboxId,
            enrollmentId: machine.id,
            name: machine.name,
            scope: "organization",
            state: "online",
            isSessionGroup: false,
            reach: machine.reach,
          })),
        };
      },
      listRigs: async () => {
        await settle();
        if (empty) return [];
        return [{ ...RIGS[0]!, scope: "organization", status: "active" }];
      },
      listWorkspaceSkills: async () => {
        await settle();
        if (empty) return { skills: [], nextCursor: null };
        return {
          skills: Array.from({ length: 12 }, (_, index) => ({
            id: `o${index}`,
            scope: "organization",
            status: "active",
            // The Skills list holds the ones that work elsewhere for the people who manage them.
            availableHere: fixture === "admin" ? true : index < 9,
          })),
          nextCursor: null,
        };
      },
      listKnowledgeEntries: async () => {
        await settle();
        return { entries: empty ? [] : [{ id: "k" }], nextCursor: null };
      },
      requestJson: async (_method: string, path: string) => {
        await settle();
        if (path.endsWith("/organization-vaults")) {
          if (fixture === "admin") {
            throw new OpenGeniApiError(403, '{"error":"missing permission account:admin"}');
          }
          return { complete: true, vaults: empty ? [] : VAULTS };
        }
        return { vaults: empty ? [] : VAULTS.slice(0, 1) };
      },
    };
    return client as unknown as SharedOverviewClient;
  }, [fixture]);
}

const PLACE: SharedPlace = {
  workspaceId: HERE,
  workspaceName: "Design preview",
  personal: false,
  workspaces: [
    { id: HERE, name: "Design preview" },
    { id: SALES, name: "Sales" },
    { id: FINANCE, name: "Finance" },
    { id: SUPPORT, name: "Support" },
    { id: RESEARCH, name: "Research" },
    { id: LEGAL, name: "Legal" },
  ],
  accessibleWorkspaceIds: new Set([HERE, SALES, FINANCE, MINE]),
  personalWorkspaceId: MINE,
};

function Example({ fixture }: { fixture: Fixture }) {
  const client = useFixtureClient(fixture);
  return (
    <SharedOverview
      client={client}
      organizationName="Acme Robotics"
      place={PLACE}
      canOpenDeveloper={fixture !== "admin"}
      onOpen={() => undefined}
    />
  );
}

export default function SharedOverviewKitSection() {
  return (
    <KitSection sectionKey="shared-overview">
      <StatesGrid columns={2}>
        <StateCell label="An organization owner" align="stretch" span="full">
          <Example fixture="owner" />
        </StateCell>
        <StateCell label="An admin who isn't an owner" align="stretch">
          <Example fixture="admin" />
        </StateCell>
        <StateCell label="One list didn't load" align="stretch">
          <Example fixture="partial" />
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
      </StatesGrid>
    </KitSection>
  );
}
