import { useMemo } from "react";
import { OpenGeniApiError } from "@opengeni/sdk";
import { AvailableHere } from "@/components/settings/available-here";
import type { AvailableHereClient } from "@/components/settings/available-here-model";

import { KitSection, StateCell, StatesGrid } from "../kit";

/* ----------------------------------------------------------------------------
   Available here: the real page against an in-memory client. "partial" fails
   the rigs list; "member" can't open Models and can't read machines.
   -------------------------------------------------------------------------- */

const WORKSPACE = "22222222-2222-4222-8222-222222222222";

type Fixture = "ready" | "personal" | "loading" | "error" | "partial" | "member" | "empty";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function denied(): never {
  throw new OpenGeniApiError(403, '{"error":"missing permission"}');
}

function useFixtureClient(fixture: Fixture): AvailableHereClient {
  return useMemo(() => {
    const empty = fixture === "empty";
    async function settle() {
      if (fixture === "loading") await new Promise<never>(() => {});
      await wait(250);
      if (fixture === "error") throw new Error("The service didn't answer. Try again.");
    }
    const client = {
      listCapabilities: async () => {
        await settle();
        if (empty) return { items: [], installations: [] };
        return {
          items: [
            {
              id: "gmail",
              name: "Gmail",
              connectionRef: {
                providerDomain: "gmail.example.com",
                kind: "oauth",
                subjectScope: "subject",
              },
            },
            {
              id: "tracker",
              name: "Issue tracker",
              connectionRef: {
                providerDomain: "tracker.example.com",
                kind: "api_key",
                subjectScope: "workspace",
              },
            },
          ],
          installations: [
            { id: "i1", capabilityId: "gmail", kind: "mcp", status: "active" },
            { id: "i2", capabilityId: "tracker", kind: "mcp", status: "active" },
          ],
        };
      },
      listMachines: async () => {
        await settle();
        if (fixture === "member") denied();
        if (empty) return { activeSandboxId: null, activeEpoch: 0, machines: [] };
        return {
          activeSandboxId: null,
          activeEpoch: 0,
          machines: [
            {
              sandboxId: "m1",
              enrollmentId: "e1",
              name: "build-box",
              scope: "workspace",
              state: "online",
              isSessionGroup: false,
            },
            {
              sandboxId: "m2",
              enrollmentId: "e2",
              name: "shared-gpu-rig-north-europe-01",
              scope: "organization",
              state: "reconnecting",
              isSessionGroup: false,
            },
            {
              sandboxId: "m3",
              enrollmentId: "e3",
              name: "studio-mac",
              scope: "user",
              state: "offline",
              isSessionGroup: false,
            },
          ],
        };
      },
      listRigs: async () => {
        await settle();
        if (fixture === "partial") throw new OpenGeniApiError(503, '{"error":"unavailable"}');
        if (empty) return [];
        return [
          { id: "r1", name: "Web app", scope: "workspace", status: "active" },
          { id: "r2", name: "Data pipeline", scope: "organization", status: "active" },
        ];
      },
      requestJson: async () => {
        await settle();
        if (empty) return { vaults: [] };
        return {
          vaults: [
            { id: "v1", name: "Team logins", ownerKind: "workspace", syncStatus: "ok" },
            {
              id: "v2",
              name: "Company accounts",
              ownerKind: "organization",
              syncStatus: "auth_expired",
            },
            { id: "v3", name: "My passwords", ownerKind: "user", syncStatus: "ok" },
          ],
        };
      },
      listWorkspaceSkills: async () => {
        await settle();
        if (empty) return { skills: [], nextCursor: null };
        return {
          skills: [
            ...Array.from({ length: 12 }, (_, index) => ({
              id: `o${index}`,
              scope: "organization",
              status: "active",
            })),
            ...Array.from({ length: 4 }, (_, index) => ({
              id: `w${index}`,
              scope: "workspace",
              status: "active",
            })),
            { id: "u1", scope: "user", status: "active" },
          ],
          nextCursor: null,
        };
      },
      listKnowledgeEntries: async () => {
        await settle();
        return { entries: empty ? [] : [{ id: "k" }], nextCursor: null };
      },
    };
    return client as unknown as AvailableHereClient;
  }, [fixture]);
}

function Example({ fixture }: { fixture: Fixture }) {
  const client = useFixtureClient(fixture);
  const personal = fixture === "personal";
  return (
    <AvailableHere
      client={client}
      workspaceId={WORKSPACE}
      workspaceName={personal ? "Personal" : "Design preview"}
      organizationName="Acme Robotics"
      personal={personal}
      canOpenModels={fixture !== "member"}
      onOpen={() => undefined}
    />
  );
}

export default function AvailableHereKitSection() {
  return (
    <KitSection sectionKey="available-here">
      <StatesGrid columns={2}>
        <StateCell label="A shared workspace" align="stretch" span="full">
          <Example fixture="ready" />
        </StateCell>
        <StateCell label="Your Personal workspace" align="stretch" span="full">
          <Example fixture="personal" />
        </StateCell>
        <StateCell label="Can't open Models or list machines (a viewer)" align="stretch">
          <Example fixture="member" />
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
