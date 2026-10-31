import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import {
  availableDescription,
  availableGroups,
  availableValue,
  failedSentence,
  loadAvailableHere,
  type AvailableHereClient,
  type AvailableThing,
} from "./available-here-model";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";

function fakeClient(overrides: Partial<Record<string, () => Promise<unknown>>> = {}) {
  const fallback: Record<string, () => Promise<unknown>> = {
    listCapabilities: async () => ({
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
          name: "Tracker",
          connectionRef: {
            providerDomain: "tracker.example.com",
            kind: "api_key",
            subjectScope: "workspace",
          },
        },
        { id: "docs", name: "Docs", connectionRef: null },
        { id: "off", name: "Turned off", connectionRef: null },
        { id: "skill", name: "A Skill", connectionRef: null },
      ],
      installations: [
        { id: "i1", capabilityId: "gmail", kind: "mcp", status: "active" },
        { id: "i2", capabilityId: "tracker", kind: "mcp", status: "active" },
        { id: "i3", capabilityId: "docs", kind: "plugin", status: "active" },
        { id: "i4", capabilityId: "off", kind: "mcp", status: "disabled" },
        { id: "i5", capabilityId: "skill", kind: "skill", status: "active" },
      ],
    }),
    listMachines: async () => ({
      activeSandboxId: null,
      activeEpoch: 0,
      machines: [
        {
          sandboxId: "m1",
          enrollmentId: "e1",
          name: "build-box",
          scope: "workspace",
          state: "offline",
          isSessionGroup: false,
        },
        {
          sandboxId: "m2",
          enrollmentId: "e2",
          name: "shared-gpu",
          scope: "organization",
          state: "online",
          isSessionGroup: false,
        },
        {
          sandboxId: "m3",
          enrollmentId: "e3",
          name: "studio-mac",
          scope: "user",
          state: "online",
          isSessionGroup: false,
        },
        {
          sandboxId: "m4",
          enrollmentId: null,
          name: "session box",
          scope: "workspace",
          state: "online",
          isSessionGroup: true,
        },
      ],
    }),
    listRigs: async () => [
      { id: "r1", name: "Web app", scope: "workspace", status: "active" },
      { id: "r2", name: "Old", scope: "workspace", status: "revoked" },
    ],
    requestJson: async () => ({
      vaults: [
        { id: "v1", name: "Team logins", ownerKind: "workspace", syncStatus: "ok" },
        { id: "v2", name: "Company", ownerKind: "organization", syncStatus: "auth_expired" },
        { id: "v3", name: "Mine", ownerKind: "user", syncStatus: "ok" },
        { id: "v4", name: "Task vault", ownerKind: "task", syncStatus: "ok" },
      ],
    }),
    listWorkspaceSkills: async () => ({
      skills: [
        { id: "s1", scope: "organization", status: "active" },
        { id: "s2", scope: "organization", status: "active" },
        { id: "s3", scope: "workspace", status: "active" },
        { id: "s4", scope: "user", status: "inactive" },
      ],
      nextCursor: null,
    }),
    listKnowledgeEntries: async () => ({ entries: [], nextCursor: null }),
  };
  return { ...fallback, ...overrides } as unknown as AvailableHereClient;
}

const NAMES = { workspace: "Design", organization: "Acme", personal: false };

describe("loadAvailableHere", () => {
  test("reads each kind and keeps only what agents here can use", async () => {
    const { things, failed } = await loadAvailableHere(fakeClient(), WORKSPACE);
    expect(failed).toEqual([]);
    expect(things.map((thing) => `${thing.kind}:${thing.owner}:${thing.name}`).sort()).toEqual(
      [
        "connector:workspace:Docs",
        "connector:workspace:Gmail",
        "connector:workspace:Tracker",
        "machine:organization:shared-gpu",
        "machine:workspace:build-box",
        "machine:you:studio-mac",
        "rig:workspace:Web app",
        "skills:organization:Skills",
        "skills:workspace:Skills",
        "vault:organization:Company",
        "vault:workspace:Team logins",
        "vault:you:Mine",
      ].sort(),
    );
    const gmail = things.find((thing) => thing.name === "Gmail");
    expect(gmail?.login).toBe("own");
    expect(things.find((thing) => thing.name === "Tracker")?.login).toBe("shared");
    expect(things.find((thing) => thing.key === "skills:organization")?.count).toBe(2);
  });

  test("lists the organization's connectors that reach here, and Only me connectors carried in", async () => {
    const organizationItem = (
      id: string,
      login: string,
      lifecycleStatus: "ready" | "available" | "unavailable",
    ) => ({
      id,
      name: id,
      kind: "mcp",
      enabled: lifecycleStatus === "ready",
      connectionRef: null,
      lifecycle: { status: lifecycleStatus, managedBy: "organization" },
      metadata: { organizationConnector: { id: `oc-${id}`, login } },
    });
    const { things } = await loadAvailableHere(
      fakeClient({
        listCapabilities: async () => ({
          items: [
            organizationItem("Drive", "each_person", "ready"),
            organizationItem("Search", "organization_key", "ready"),
            organizationItem("Status", "none", "ready"),
            organizationItem("Broken", "organization_key", "unavailable"),
            // Turned off in this workspace: agents here can't use it.
            organizationItem("Muted", "each_person", "available"),
            // The workspace's own installation of it is what agents use.
            organizationItem("Tracker", "organization_key", "ready"),
            {
              id: "Tracker",
              name: "Tracker",
              kind: "mcp",
              enabled: true,
              connectionRef: null,
              lifecycle: { status: "ready", managedBy: "workspace" },
              metadata: {},
            },
            {
              id: "Calendar",
              name: "Calendar",
              kind: "mcp",
              enabled: true,
              connectionRef: { providerDomain: "calendar.example.com", subjectScope: "subject" },
              lifecycle: { status: "ready", managedBy: "workspace" },
              metadata: { personalExtension: { originWorkspaceName: "Design" } },
            },
          ],
          installations: [{ id: "i1", capabilityId: "Tracker", kind: "mcp", status: "active" }],
        }),
      }),
      WORKSPACE,
    );
    const connectors = things
      .filter((thing) => thing.kind === "connector")
      .map((thing) => `${thing.owner}:${thing.name}:${thing.login}:${thing.state}`)
      .sort();
    expect(connectors).toEqual(
      [
        "organization:Broken:shared:Unavailable",
        "organization:Drive:own:null",
        "organization:Search:shared:null",
        "organization:Status:null:null",
        "workspace:Tracker:null:null",
        "you:Calendar:own:null",
      ].sort(),
    );
  });

  test("leaves out a kind the viewer may not read, and reports any other failure", async () => {
    const { things, failed } = await loadAvailableHere(
      fakeClient({
        listMachines: async () => {
          throw new OpenGeniApiError(403, '{"error":"missing permission"}');
        },
        listRigs: async () => {
          throw new OpenGeniApiError(500, '{"error":"boom"}');
        },
      }),
      WORKSPACE,
    );
    expect(things.some((thing) => thing.kind === "machine")).toBe(false);
    expect(failed).toEqual(["rig"]);
    expect(failedSentence(failed)).toBe("Couldn't load rigs.");
    expect(failedSentence(["machine", "vault", "skills"])).toBe(
      "Couldn't load machines, vaults and Skills.",
    );
  });

  test("finds Knowledge in each scope that has some", async () => {
    const { things } = await loadAvailableHere(
      fakeClient({
        listKnowledgeEntries: (async (_workspaceId: string, request: { scope: string }) => ({
          entries: request.scope === "workspace" ? [] : [{ id: "k" }],
          nextCursor: null,
        })) as unknown as () => Promise<unknown>,
      }),
      WORKSPACE,
    );
    expect(things.filter((thing) => thing.kind === "knowledge").map((thing) => thing.open)).toEqual(
      [
        { page: "knowledge", scope: "organization" },
        { page: "knowledge", scope: "personal" },
      ],
    );
  });
});

function sample(
  partial: Partial<AvailableThing> & Pick<AvailableThing, "kind" | "owner" | "name">,
) {
  return {
    key: `${partial.kind}:${partial.owner}:${partial.name}`,
    state: null,
    login: null,
    count: null,
    open: { page: "machines" },
    ...partial,
  } as AvailableThing;
}

describe("availableGroups", () => {
  test("a shared workspace groups its own, the organization's and yours, in that order", () => {
    const groups = availableGroups(
      [
        sample({ kind: "machine", owner: "you", name: "studio-mac" }),
        sample({ kind: "vault", owner: "organization", name: "Company" }),
        sample({ kind: "machine", owner: "workspace", name: "build-box" }),
        sample({ kind: "connector", owner: "workspace", name: "Gmail" }),
      ],
      NAMES,
    );
    expect(groups.map((group) => group.title)).toEqual([
      "Belongs to Design",
      "Shared by Acme",
      "Yours",
    ]);
    // Kinds in a fixed order: connectors before machines.
    expect(groups[0]!.things.map((each) => each.name)).toEqual(["Gmail", "build-box"]);
    expect(groups[1]!.description).toBe(
      "Acme shares these with Design. Any message here can use them. Organization owners manage them.",
    );
    expect(groups[2]!.description).toBe(
      "Only your own messages here use these, never anyone else's. Only you manage them.",
    );
  });

  test("a group with nothing in it is left out", () => {
    const groups = availableGroups(
      [sample({ kind: "rig", owner: "organization", name: "Shared rig" })],
      NAMES,
    );
    expect(groups.map((group) => group.owner)).toEqual(["organization"]);
  });

  test("a Personal workspace's own things and yours are one group, with one Skills and one Knowledge row", () => {
    const groups = availableGroups(
      [
        sample({ kind: "skills", owner: "workspace", name: "Skills", count: 2 }),
        sample({ kind: "skills", owner: "you", name: "Skills", count: 3 }),
        sample({
          kind: "knowledge",
          owner: "workspace",
          name: "Knowledge",
          open: { page: "knowledge", scope: "workspace" },
        }),
        sample({
          kind: "knowledge",
          owner: "you",
          name: "Knowledge",
          open: { page: "knowledge", scope: "personal" },
        }),
        sample({ kind: "machine", owner: "workspace", name: "laptop" }),
        sample({ kind: "vault", owner: "organization", name: "Company" }),
      ],
      { ...NAMES, personal: true },
    );
    expect(groups.map((group) => group.title)).toEqual(["Yours", "Shared by Acme"]);
    expect(groups[1]!.description).toBe(
      "Acme shares these with your Personal workspace. Organization owners manage them.",
    );
    const yours = groups[0]!.things;
    expect(yours.map((each) => `${each.kind}:${each.name}`)).toEqual([
      "machine:laptop",
      "skills:Skills",
      "knowledge:Knowledge",
    ]);
    expect(yours.find((each) => each.kind === "skills")?.count).toBe(5);
    expect(yours.find((each) => each.kind === "knowledge")?.open).toEqual({ page: "knowledge" });
  });
});

describe("row words", () => {
  test("a workspace's own thing says who changes it, by kind", () => {
    expect(
      availableDescription(
        sample({ kind: "connector", owner: "workspace", name: "Gmail", login: "own" }),
        NAMES,
      ),
    ).toBe("Each person signs in with their own account. Admins of Design manage it.");
    expect(
      availableDescription(
        sample({ kind: "connector", owner: "workspace", name: "Tracker", login: "shared" }),
        NAMES,
      ),
    ).toBe("Everyone's messages here use the same login. Admins of Design manage it.");
    expect(
      availableDescription(sample({ kind: "machine", owner: "workspace", name: "box" }), NAMES),
    ).toBe("Admins of Design manage it.");
    expect(
      availableDescription(sample({ kind: "vault", owner: "workspace", name: "v" }), NAMES),
    ).toBe("Members and admins of Design can change it.");
    expect(
      availableDescription(sample({ kind: "skills", owner: "workspace", name: "Skills" }), NAMES),
    ).toBe("Members and admins of Design can change them.");
  });

  test("the organization's and your own say it once, in their group", () => {
    expect(
      availableDescription(sample({ kind: "machine", owner: "organization", name: "gpu" }), NAMES),
    ).toBe("");
    expect(availableDescription(sample({ kind: "vault", owner: "you", name: "Mine" }), NAMES)).toBe(
      "",
    );
  });

  test("the value is the kind and its state, or a count for Skills", () => {
    expect(
      availableValue(
        sample({ kind: "machine", owner: "workspace", name: "box", state: "Offline" }),
      ),
    ).toBe("Machine · Offline");
    expect(availableValue(sample({ kind: "rig", owner: "workspace", name: "Web" }))).toBe("Rig");
    expect(
      availableValue(sample({ kind: "skills", owner: "workspace", name: "Skills", count: 12 })),
    ).toBe("12");
    expect(
      availableValue(sample({ kind: "knowledge", owner: "workspace", name: "Knowledge" })),
    ).toBe("");
  });
});
