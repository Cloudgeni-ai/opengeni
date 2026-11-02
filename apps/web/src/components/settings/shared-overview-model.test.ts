import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import {
  coverageDescription,
  emptyGroupSentence,
  loadSharedOverview,
  reachDescription,
  reachSentence,
  sharedFailedSentence,
  sharedOpen,
  skillsDescription,
  worksIn,
  type SharedOverviewClient,
  type SharedPlace,
  type SharedReach,
} from "./shared-overview-model";

const HERE = "22222222-2222-4222-8222-222222222222";
const DESIGN = "33333333-3333-4333-8333-333333333333";
const SALES = "44444444-4444-4444-8444-444444444444";
const OPS = "55555555-5555-4555-8555-555555555555";
const LEGAL = "66666666-6666-4666-8666-666666666666";
const MINE = "77777777-7777-4777-8777-777777777777";
const SOMEONES_PERSONAL = "88888888-8888-4888-8888-888888888888";

const vault = (
  id: string,
  name: string,
  ownerKind: string,
  availability: unknown,
  syncStatus = "ok",
) => ({ id, name, ownerKind, availability, syncStatus });

const reach = (
  homeWorkspaceId: string,
  allowedWorkspaceIds: string[] | null,
  allowPersonalWorkspaces = false,
) => ({ homeWorkspaceId, allowedWorkspaceIds, allowPersonalWorkspaces });

const forbidden = () => new OpenGeniApiError(403, '{"error":"missing permission account:admin"}');
const busy = () =>
  new OpenGeniApiError(503, '{"error":"The service is busy. Try again in a minute."}');

type Overrides = Partial<Record<string, (...args: never[]) => Promise<unknown>>>;

function fakeClient(overrides: Overrides = {}) {
  const knowledgeScopes: string[] = [];
  const skillPages: (string | undefined)[] = [];
  const fallback: Overrides = {
    listCapabilities: async () => ({ items: [], installations: [] }),
    // The organization's machines and sandbox environments wherever they work.
    listOrganizationMachines: async () => ({
      complete: true,
      machines: [
        { id: "e1", sandboxId: "m1", name: "shared-gpu", reach: reach(HERE, null) },
        { id: "e4", sandboxId: "m4", name: "ops-runner", reach: reach(OPS, []) },
      ],
    }),
    listOrganizationRigs: async () => ({
      complete: true,
      rigs: [
        { id: "r3", name: "Sales demo", reach: reach(SALES, [SALES], true) },
        { id: "r1", name: "Data pipeline", reach: reach(HERE, null, true) },
      ],
    }),
    // A workspace's own lists: what works here, whoever it belongs to.
    listMachines: async () => ({
      machines: [
        {
          sandboxId: "m1",
          enrollmentId: "e1",
          name: "shared-gpu",
          scope: "organization",
          state: "offline",
          isSessionGroup: false,
          reach: reach(HERE, null),
        },
        {
          sandboxId: "m2",
          enrollmentId: "e2",
          name: "build-box",
          scope: "workspace",
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
      ],
    }),
    listRigs: async () => [
      {
        id: "r1",
        name: "Data pipeline",
        scope: "organization",
        status: "active",
        reach: reach(HERE, null, true),
      },
      { id: "r2", name: "Web app", scope: "workspace", status: "active", reach: null },
    ],
    listWorkspaceSkills: (async (_workspaceId: string, options: { cursor?: string }) => {
      skillPages.push(options.cursor);
      return options.cursor
        ? {
            skills: [{ id: "s4", scope: "organization", status: "active", availableHere: false }],
            nextCursor: null,
          }
        : {
            skills: [
              { id: "s1", scope: "organization", status: "active", availableHere: true },
              { id: "s2", scope: "organization", status: "active", availableHere: true },
              { id: "s3", scope: "workspace", status: "active", availableHere: true },
              { id: "s5", scope: "organization", status: "archived", availableHere: false },
            ],
            nextCursor: "page-2",
          };
    }) as never,
    listKnowledgeEntries: (async (_workspaceId: string, options: { scope: string }) => {
      knowledgeScopes.push(options.scope);
      return { entries: [{ id: "k" }], nextCursor: null };
    }) as never,
    requestJson: (async (_method: string, path: string) => {
      if (path.endsWith("/organization-vaults")) {
        return {
          complete: true,
          vaults: [
            vault("v2", "Sales logins", "organization", {
              allowedWorkspaceIds: [SALES],
              allowPersonalWorkspaces: false,
            }),
            vault(
              "v1",
              "Company accounts",
              "organization",
              { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
              "auth_expired",
            ),
          ],
        };
      }
      return {
        vaults: [
          vault("v1", "Company accounts", "organization", {
            allowedWorkspaceIds: null,
            allowPersonalWorkspaces: true,
          }),
          vault("v3", "Team logins", "workspace", null),
        ],
      };
    }) as never,
  };
  return {
    client: { ...fallback, ...overrides } as unknown as SharedOverviewClient,
    knowledgeScopes,
    skillPages,
  };
}

const place = (overrides: Partial<SharedPlace> = {}): SharedPlace => ({
  workspaceId: HERE,
  workspaceName: "Design preview",
  personal: false,
  workspaces: [
    { id: HERE, name: "Design preview" },
    { id: SALES, name: "Sales" },
    { id: DESIGN, name: "Design" },
    { id: OPS, name: "Ops" },
    { id: LEGAL, name: "Legal" },
  ],
  accessibleWorkspaceIds: new Set([HERE, SALES, MINE]),
  personalWorkspaceId: MINE,
  ...overrides,
});

describe("loadSharedOverview", () => {
  test("an owner gets every organization machine, sandbox environment and vault wherever it works", async () => {
    const { client, knowledgeScopes, skillPages } = fakeClient();
    const result = await loadSharedOverview(client, HERE);
    // Machines, then sandbox environments, each by name; never the workspace's or someone's own.
    expect(result.compute.map((item) => [item.kind, item.name])).toEqual([
      ["machine", "ops-runner"],
      ["machine", "shared-gpu"],
      ["rig", "Data pipeline"],
      ["rig", "Sales demo"],
    ]);
    expect(result.compute[0]).toMatchObject({ key: "machine:e4", id: "e4" });
    expect(result.compute[0]?.reach).toEqual(reach(OPS, []));
    expect(result.computeCoverage).toBe("all");
    expect(result.vaults.map((each) => each.name)).toEqual(["Company accounts", "Sales logins"]);
    expect(result.vaults[0]?.state).toBe("Sign-in expired");
    expect(result.vaultCoverage).toBe("all");
    // Every page of Skills; the organization's active ones, and how many don't work here.
    expect(skillPages).toEqual([undefined, "page-2"]);
    expect(result.skills).toEqual({ count: 3, notHere: 1 });
    // Only the organization's Knowledge is probed.
    expect(knowledgeScopes).toEqual(["organization"]);
    expect(result.knowledgeHere).toBe(true);
    expect(result.failed).toEqual([]);
  });

  test("someone the organization-wide lists refuse gets the organization's things that work here", async () => {
    const { client } = fakeClient({
      listOrganizationMachines: async () => {
        throw forbidden();
      },
      listOrganizationRigs: async () => {
        throw forbidden();
      },
      requestJson: (async (_method: string, path: string) => {
        if (path.endsWith("/organization-vaults")) throw forbidden();
        return {
          vaults: [
            vault("v1", "Company accounts", "organization", {
              allowedWorkspaceIds: null,
              allowPersonalWorkspaces: true,
            }),
            vault("v3", "Team logins", "workspace", null),
          ],
        };
      }) as never,
    });
    const result = await loadSharedOverview(client, HERE);
    expect(result.compute.map((item) => [item.kind, item.id])).toEqual([
      ["machine", "e1"],
      ["rig", "r1"],
    ]);
    expect(result.computeCoverage).toBe("here-admins-see-all");
    expect(result.vaults.map((each) => each.name)).toEqual(["Company accounts"]);
    expect(result.vaultCoverage).toBe("here-admins-see-all");
    expect(result.failed).toEqual([]);
  });

  test("a server that can't list them all yet says the list is the ones that work here", async () => {
    const { client } = fakeClient({
      listOrganizationRigs: async () => ({ complete: false, rigs: [] }),
      requestJson: (async () => ({ complete: false, vaults: [] })) as never,
    });
    const result = await loadSharedOverview(client, HERE);
    expect(result.computeCoverage).toBe("here");
    expect(result.vaultCoverage).toBe("here");
  });

  test("a list that fails is reported by kind; one the viewer may not read is left out", async () => {
    const { client } = fakeClient({
      listOrganizationRigs: async () => {
        throw busy();
      },
      listOrganizationMachines: async () => {
        throw forbidden();
      },
      listMachines: async () => {
        throw new OpenGeniApiError(403, '{"error":"missing permission"}');
      },
      listKnowledgeEntries: async () => {
        throw busy();
      },
    });
    const result = await loadSharedOverview(client, HERE);
    expect(result.failed).toEqual(["rig", "knowledge"]);
    expect(result.failureMessage).toBeTruthy();
    expect(result.compute).toEqual([]);
    expect(result.knowledgeHere).toBe(false);
    expect(result.skills).toEqual({ count: 3, notHere: 1 });
  });

  test("no organization Skills and no organization Knowledge here", async () => {
    const { client } = fakeClient({
      listWorkspaceSkills: async () => ({
        skills: [{ id: "s3", scope: "workspace", status: "active", availableHere: true }],
        nextCursor: null,
      }),
      listKnowledgeEntries: async () => ({ entries: [], nextCursor: null }),
    });
    const result = await loadSharedOverview(client, HERE);
    expect(result.skills).toBeNull();
    expect(result.knowledgeHere).toBe(false);
  });
});

describe("where each works", () => {
  const everywhere: SharedReach = { allowedWorkspaceIds: null, allowPersonalWorkspaces: true };
  const sharedOnly: SharedReach = { allowedWorkspaceIds: null, allowPersonalWorkspaces: false };
  const salesAndPersonal: SharedReach = {
    allowedWorkspaceIds: [SALES],
    allowPersonalWorkspaces: true,
  };

  test("a Personal workspace follows the switch; a shared one follows the list; home always", () => {
    expect(worksIn(null, { id: MINE, personal: true })).toBe(true);
    expect(worksIn(everywhere, { id: MINE, personal: true })).toBe(true);
    expect(worksIn(sharedOnly, { id: MINE, personal: true })).toBe(false);
    expect(worksIn(sharedOnly, { id: HERE, personal: false })).toBe(true);
    expect(worksIn(salesAndPersonal, { id: MINE, personal: true })).toBe(true);
    expect(worksIn(salesAndPersonal, { id: HERE, personal: false })).toBe(false);
    expect(worksIn(salesAndPersonal, { id: SALES, personal: false })).toBe(true);
    expect(worksIn(reach(OPS, []), { id: OPS, personal: false })).toBe(true);
    expect(worksIn(reach(OPS, []), { id: HERE, personal: false })).toBe(false);
    expect(worksIn(reach(MINE, []), { id: MINE, personal: true })).toBe(true);
  });

  test("says where, naming at most a few workspaces", () => {
    const names = place().workspaces;
    expect(reachSentence(null, names)).toBe("Works in every workspace.");
    expect(reachSentence(everywhere, names)).toBe(
      "Works in every workspace, Personal workspaces included.",
    );
    expect(reachSentence(sharedOnly, names)).toBe(
      "Works in every shared workspace, not in Personal workspaces.",
    );
    expect(reachSentence(salesAndPersonal, names)).toBe(
      "Works in Sales, and in Personal workspaces.",
    );
    expect(
      reachSentence(
        { allowedWorkspaceIds: [SALES, DESIGN], allowPersonalWorkspaces: false },
        names,
      ),
    ).toBe("Works in Design and Sales.");
    expect(
      reachSentence(
        { allowedWorkspaceIds: [SALES, DESIGN, OPS, LEGAL], allowPersonalWorkspaces: false },
        names,
      ),
    ).toBe("Works in Design, Legal, Ops and Sales.");
    expect(
      reachSentence(
        { allowedWorkspaceIds: [SALES, DESIGN, OPS, LEGAL, HERE], allowPersonalWorkspaces: false },
        names,
      ),
    ).toBe("Works in Design, Design preview, Legal and 2 more.");
    // A deleted workspace is no longer a place.
    expect(
      reachSentence(
        {
          allowedWorkspaceIds: ["99999999-9999-4999-8999-999999999999"],
          allowPersonalWorkspaces: false,
        },
        names,
      ),
    ).toBe("Doesn't work in any workspace yet.");
    expect(reachSentence({ allowedWorkspaceIds: [], allowPersonalWorkspaces: true }, names)).toBe(
      "Works only in Personal workspaces.",
    );
  });

  test("a machine or sandbox environment always works where it came from", () => {
    const names = place().workspaces;
    expect(reachSentence(reach(OPS, []), names)).toBe("Works in Ops.");
    expect(reachSentence(reach(OPS, [SALES]), names)).toBe("Works in Ops and Sales.");
    expect(reachSentence(reach(OPS, [OPS, SALES], true), names)).toBe(
      "Works in Ops and Sales, and in Personal workspaces.",
    );
    // Connected from someone's Personal workspace, which isn't a shared one.
    expect(reachSentence(reach(SOMEONES_PERSONAL, []), names)).toBe(
      "Works only in the workspace it was added from.",
    );
    expect(reachSentence(reach(SOMEONES_PERSONAL, [SALES]), names)).toBe(
      "Works in Sales, and in the workspace it was added from.",
    );
    expect(reachSentence(reach(SOMEONES_PERSONAL, null), names)).toBe(
      "Works in every shared workspace, and in the workspace it was added from.",
    );
    // The Personal workspaces switch already covers it.
    expect(reachSentence(reach(SOMEONES_PERSONAL, [], true), names)).toBe(
      "Works only in Personal workspaces.",
    );
  });

  test("opens here when it works here, else in the first workspace it works in that the viewer can open", () => {
    expect(sharedOpen(everywhere, place())).toEqual({ workspaceId: HERE, workspaceName: null });
    expect(sharedOpen(salesAndPersonal, place())).toEqual({
      workspaceId: SALES,
      workspaceName: "Sales",
    });
    expect(sharedOpen({ allowedWorkspaceIds: [], allowPersonalWorkspaces: true }, place())).toEqual(
      { workspaceId: MINE, workspaceName: "your Personal workspace" },
    );
    expect(
      sharedOpen({ allowedWorkspaceIds: [OPS], allowPersonalWorkspaces: false }, place()),
    ).toBe(null);
    // Its home workspace has it even when the list doesn't name it.
    expect(sharedOpen(reach(SALES, []), place())).toEqual({
      workspaceId: SALES,
      workspaceName: "Sales",
    });
    expect(sharedOpen(reach(HERE, []), place())).toEqual({
      workspaceId: HERE,
      workspaceName: null,
    });
    // From a Personal workspace, something kept out of Personal workspaces opens in a shared one.
    expect(
      sharedOpen(
        sharedOnly,
        place({ workspaceId: MINE, workspaceName: "Personal", personal: true }),
      ),
    ).toEqual({ workspaceId: HERE, workspaceName: "Design preview" });
  });

  test("the row says where it works and, when that's elsewhere, where it opens", () => {
    expect(reachDescription(everywhere, place())).toBe(
      "Works in every workspace, Personal workspaces included.",
    );
    expect(reachDescription(salesAndPersonal, place())).toBe(
      "Works in Sales, and in Personal workspaces. Opens in Sales.",
    );
    expect(
      reachDescription({ allowedWorkspaceIds: [OPS], allowPersonalWorkspaces: false }, place()),
    ).toBe("Works in Ops. You aren't in a workspace it works in.");
  });

  test("says when the list is only the ones that work here", () => {
    expect(coverageDescription("all", place())).toBe(
      "Each works only where its Available in says. Organization owners and admins manage them.",
    );
    expect(coverageDescription("here", place())).toBe(
      "Each works only where its Available in says. Organization owners and admins manage them. Here are the ones that work in Design preview.",
    );
    expect(
      coverageDescription(
        "here-admins-see-all",
        place({ personal: true, workspaceName: "Personal" }),
      ),
    ).toBe(
      "Each works only where its Available in says. Organization owners and admins manage them and see every one; here are the ones that work in your Personal workspace.",
    );
    expect(emptyGroupSentence("all", place(), "Acme has no vaults yet.")).toBe(
      "Acme has no vaults yet.",
    );
    expect(emptyGroupSentence("here-admins-see-all", place(), "Acme has no vaults yet.")).toBe(
      "None work in Design preview.",
    );
  });

  test("the Skills row says how many don't work here", () => {
    expect(skillsDescription({ count: 1, notHere: 0 }, place())).toBe(
      "It works in Design preview.",
    );
    expect(skillsDescription({ count: 4, notHere: 0 }, place())).toBe(
      "All of them work in Design preview.",
    );
    expect(skillsDescription({ count: 4, notHere: 1 }, place())).toBe(
      "1 of them doesn't work in Design preview.",
    );
    expect(skillsDescription({ count: 4, notHere: 3 }, place())).toBe(
      "3 of them don't work in Design preview.",
    );
    expect(skillsDescription({ count: 2, notHere: 2 }, place({ personal: true }))).toBe(
      "None of them work in your Personal workspace.",
    );
  });

  test("names what didn't load", () => {
    expect(sharedFailedSentence(["rig"])).toBe("Couldn't load sandbox environments.");
    expect(sharedFailedSentence(["machine", "vault"])).toBe("Couldn't load machines and vaults.");
  });
});
