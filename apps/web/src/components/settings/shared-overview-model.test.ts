import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import {
  loadSharedOverview,
  sharedFailedSentence,
  vaultDescription,
  vaultOpen,
  vaultReachSentence,
  vaultsDescription,
  vaultWorksIn,
  type SharedOverviewClient,
  type SharedPlace,
  type SharedVault,
} from "./shared-overview-model";

const HERE = "22222222-2222-4222-8222-222222222222";
const DESIGN = "33333333-3333-4333-8333-333333333333";
const SALES = "44444444-4444-4444-8444-444444444444";
const OPS = "55555555-5555-4555-8555-555555555555";
const LEGAL = "66666666-6666-4666-8666-666666666666";
const MINE = "77777777-7777-4777-8777-777777777777";

const vault = (
  id: string,
  name: string,
  ownerKind: string,
  availability: unknown,
  syncStatus = "ok",
) => ({ id, name, ownerKind, availability, syncStatus });

type Overrides = Partial<Record<string, (...args: never[]) => Promise<unknown>>>;

function fakeClient(overrides: Overrides = {}) {
  const knowledgeScopes: string[] = [];
  const fallback: Overrides = {
    listCapabilities: async () => ({ items: [], installations: [] }),
    listMachines: async () => ({
      machines: [
        {
          sandboxId: "m1",
          enrollmentId: "e1",
          name: "shared-gpu",
          scope: "organization",
          state: "offline",
          isSessionGroup: false,
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
      { id: "r1", name: "Data pipeline", scope: "organization", status: "active" },
      { id: "r2", name: "Web app", scope: "workspace", status: "active" },
    ],
    listWorkspaceSkills: async () => ({
      skills: [
        { id: "s1", scope: "organization", status: "active" },
        { id: "s2", scope: "organization", status: "active" },
        { id: "s3", scope: "workspace", status: "active" },
      ],
      nextCursor: null,
    }),
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
  test("keeps the organization's own things and lists every organization vault", async () => {
    const { client, knowledgeScopes } = fakeClient();
    const result = await loadSharedOverview(client, HERE);
    expect(result.everywhere.map((thing) => [thing.kind, thing.name])).toEqual([
      ["machine", "shared-gpu"],
      ["rig", "Data pipeline"],
      ["skills", "Skills"],
      ["knowledge", "Knowledge"],
    ]);
    expect(result.everywhere.find((thing) => thing.kind === "skills")?.count).toBe(2);
    expect(result.everywhere.find((thing) => thing.kind === "machine")?.state).toBe("Offline");
    // Only the organization's Knowledge is probed.
    expect(knowledgeScopes).toEqual(["organization"]);
    expect(result.vaults.map((each) => each.name)).toEqual(["Company accounts", "Sales logins"]);
    expect(result.vaults[0]?.state).toBe("Sign-in expired");
    expect(result.vaultCoverage).toBe("all");
    expect(result.failed).toEqual([]);
  });

  test("an admin who isn't an owner gets the organization vaults that work here", async () => {
    const { client } = fakeClient({
      requestJson: (async (_method: string, path: string) => {
        if (path.endsWith("/organization-vaults")) {
          throw new OpenGeniApiError(403, '{"error":"missing permission account:admin"}');
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
    });
    const result = await loadSharedOverview(client, HERE);
    expect(result.vaults.map((each) => each.name)).toEqual(["Company accounts"]);
    expect(result.vaultCoverage).toBe("here-owners-see-all");
    expect(result.failed).toEqual([]);
  });

  test("a server that can't list them all yet says the list is the ones that work here", async () => {
    const { client } = fakeClient({
      requestJson: (async () => ({ complete: false, vaults: [] })) as never,
    });
    expect((await loadSharedOverview(client, HERE)).vaultCoverage).toBe("here");
  });

  test("a list that fails is reported by kind; one the viewer may not read is left out", async () => {
    const { client } = fakeClient({
      listRigs: async () => {
        throw new OpenGeniApiError(503, '{"error":"The service is busy. Try again in a minute."}');
      },
      listMachines: async () => {
        throw new OpenGeniApiError(403, '{"error":"missing permission"}');
      },
    });
    const result = await loadSharedOverview(client, HERE);
    expect(result.failed).toEqual(["rig"]);
    expect(result.failureMessage).toBeTruthy();
    expect(result.everywhere.map((thing) => thing.kind)).toEqual(["skills", "knowledge"]);
  });
});

describe("where a vault works", () => {
  const everywhere = { allowedWorkspaceIds: null, allowPersonalWorkspaces: true };
  const sharedOnly = { allowedWorkspaceIds: null, allowPersonalWorkspaces: false };
  const salesAndPersonal = { allowedWorkspaceIds: [SALES], allowPersonalWorkspaces: true };

  test("a Personal workspace follows the switch; a shared one follows the list", () => {
    expect(vaultWorksIn(everywhere, { id: MINE, personal: true })).toBe(true);
    expect(vaultWorksIn(sharedOnly, { id: MINE, personal: true })).toBe(false);
    expect(vaultWorksIn(sharedOnly, { id: HERE, personal: false })).toBe(true);
    expect(vaultWorksIn(salesAndPersonal, { id: MINE, personal: true })).toBe(true);
    expect(vaultWorksIn(salesAndPersonal, { id: HERE, personal: false })).toBe(false);
    expect(vaultWorksIn(salesAndPersonal, { id: SALES, personal: false })).toBe(true);
  });

  test("says where, naming at most a few workspaces", () => {
    const names = place().workspaces;
    expect(vaultReachSentence(everywhere, names)).toBe(
      "Works in every workspace, Personal workspaces included.",
    );
    expect(vaultReachSentence(sharedOnly, names)).toBe(
      "Works in every shared workspace, not in Personal workspaces.",
    );
    expect(vaultReachSentence(salesAndPersonal, names)).toBe(
      "Works in Sales, and in Personal workspaces.",
    );
    expect(
      vaultReachSentence(
        { allowedWorkspaceIds: [SALES, DESIGN], allowPersonalWorkspaces: false },
        names,
      ),
    ).toBe("Works in Design and Sales.");
    expect(
      vaultReachSentence(
        { allowedWorkspaceIds: [SALES, DESIGN, OPS, LEGAL], allowPersonalWorkspaces: false },
        names,
      ),
    ).toBe("Works in Design, Legal, Ops and Sales.");
    expect(
      vaultReachSentence(
        { allowedWorkspaceIds: [SALES, DESIGN, OPS, LEGAL, HERE], allowPersonalWorkspaces: false },
        names,
      ),
    ).toBe("Works in Design, Design preview, Legal and 2 more.");
    // A deleted workspace is no longer a place.
    expect(
      vaultReachSentence(
        {
          allowedWorkspaceIds: ["99999999-9999-4999-8999-999999999999"],
          allowPersonalWorkspaces: false,
        },
        names,
      ),
    ).toBe("Doesn't work in any workspace yet.");
    expect(
      vaultReachSentence({ allowedWorkspaceIds: [], allowPersonalWorkspaces: true }, names),
    ).toBe("Works only in Personal workspaces.");
  });

  const shared = (availability: SharedVault["availability"]): SharedVault => ({
    id: "v",
    name: "Vault",
    state: null,
    availability,
  });

  test("opens here when it works here, else in the first workspace it works in that the viewer can open", () => {
    expect(vaultOpen(shared(everywhere), place())).toEqual({
      workspaceId: HERE,
      workspaceName: null,
    });
    expect(vaultOpen(shared(salesAndPersonal), place())).toEqual({
      workspaceId: SALES,
      workspaceName: "Sales",
    });
    expect(
      vaultOpen(shared({ allowedWorkspaceIds: [], allowPersonalWorkspaces: true }), place()),
    ).toEqual({ workspaceId: MINE, workspaceName: "your Personal workspace" });
    expect(
      vaultOpen(shared({ allowedWorkspaceIds: [OPS], allowPersonalWorkspaces: false }), place()),
    ).toBeNull();
    // From a Personal workspace, a vault kept out of Personal workspaces opens in a shared one.
    expect(
      vaultOpen(
        shared(sharedOnly),
        place({ workspaceId: MINE, workspaceName: "Personal", personal: true }),
      ),
    ).toEqual({ workspaceId: HERE, workspaceName: "Design preview" });
  });

  test("the row says where it works and, when that's elsewhere, where it opens", () => {
    expect(vaultDescription(shared(everywhere), place())).toBe(
      "Works in every workspace, Personal workspaces included.",
    );
    expect(vaultDescription(shared(salesAndPersonal), place())).toBe(
      "Works in Sales, and in Personal workspaces. Opens in Sales.",
    );
    expect(
      vaultDescription(
        shared({ allowedWorkspaceIds: [OPS], allowPersonalWorkspaces: false }),
        place(),
      ),
    ).toBe("Works in Ops. You aren't in a workspace it works in.");
  });

  test("says when the list is only the ones that work here", () => {
    expect(vaultsDescription("all", place())).toBe(
      "Each works only where its Available in says. Organization owners and admins manage them.",
    );
    expect(vaultsDescription("here", place())).toBe(
      "Each works only where its Available in says. Organization owners and admins manage them. Here are the ones that work in Design preview.",
    );
    expect(
      vaultsDescription(
        "here-owners-see-all",
        place({ personal: true, workspaceName: "Personal" }),
      ),
    ).toBe(
      "Each works only where its Available in says. Organization owners and admins manage them and see every one; here are the ones that work in your Personal workspace.",
    );
  });

  test("names what didn't load", () => {
    expect(sharedFailedSentence(["rig"])).toBe("Couldn't load rigs.");
    expect(sharedFailedSentence(["machine", "vault"])).toBe("Couldn't load machines and vaults.");
  });
});
