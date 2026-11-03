import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniApiError } from "@opengeni/sdk";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { SharedOverview } = await import("./shared-overview");
type Destination = Parameters<Parameters<typeof SharedOverview>[0]["onOpen"]>[0];

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.replaceChildren();
});

const HERE = "22222222-2222-4222-8222-222222222222";
const SALES = "44444444-4444-4444-8444-444444444444";
const OPS = "55555555-5555-4555-8555-555555555555";

type Fixture = "listsAll" | "listsHere" | "nothingHere" | "allFail";

const forbidden = () => new OpenGeniApiError(403, '{"error":"missing permission account:admin"}');

const reach = (
  homeWorkspaceId: string,
  allowedWorkspaceIds: string[] | null,
  allowPersonalWorkspaces = false,
) => ({ homeWorkspaceId, allowedWorkspaceIds, allowPersonalWorkspaces });

const companyAccounts = {
  id: "v1",
  name: "Company accounts",
  ownerKind: "organization",
  syncStatus: "ok",
  availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
};

function client(fixture: Fixture) {
  if (fixture === "allFail") {
    const fail = async () => {
      throw new OpenGeniApiError(503, '{"error":"The service is busy. Try again in a minute."}');
    };
    return {
      listCapabilities: fail,
      listOrganizationMachines: fail,
      listOrganizationRigs: fail,
      listMachines: fail,
      listRigs: fail,
      requestJson: fail,
      listWorkspaceSkills: fail,
      listKnowledgeEntries: fail,
    } as never;
  }
  const owner = fixture === "listsAll";
  const nothingHere = fixture === "nothingHere";
  return {
    listCapabilities: async () => ({ items: [], installations: [] }),
    listOrganizationMachines: async () => {
      if (!owner) throw forbidden();
      return {
        complete: true,
        machines: [
          { id: "e1", sandboxId: "m1", name: "shared-gpu", reach: reach(HERE, null) },
          { id: "e4", sandboxId: "m4", name: "ops-runner", reach: reach(OPS, []) },
        ],
      };
    },
    listOrganizationRigs: async () => {
      if (!owner) throw forbidden();
      return {
        complete: true,
        rigs: [{ id: "r3", name: "Sales demo", reach: reach(SALES, [], true) }],
      };
    },
    listMachines: async () => ({
      machines: nothingHere
        ? []
        : [
            {
              sandboxId: "m1",
              enrollmentId: "e1",
              name: "shared-gpu",
              scope: "organization",
              state: "online",
              isSessionGroup: false,
              reach: reach(HERE, null),
            },
            {
              sandboxId: "m2",
              enrollmentId: "e2",
              name: "studio-mac",
              scope: "user",
              state: "online",
              isSessionGroup: false,
            },
          ],
    }),
    listRigs: async () => [],
    listWorkspaceSkills: async () => ({
      skills: nothingHere
        ? []
        : [
            { id: "s1", scope: "organization", status: "active", availableHere: true },
            { id: "s2", scope: "organization", status: "active", availableHere: false },
          ],
      nextCursor: null,
    }),
    listKnowledgeEntries: async () => ({
      entries: nothingHere ? [] : [{ id: "k1" }],
      nextCursor: null,
    }),
    requestJson: async (_method: string, path: string) => {
      if (path.endsWith("/organization-vaults")) {
        if (!owner) throw forbidden();
        return {
          complete: true,
          vaults: [
            companyAccounts,
            {
              id: "v2",
              name: "Sales logins",
              ownerKind: "organization",
              syncStatus: "ok",
              availability: { allowedWorkspaceIds: [SALES], allowPersonalWorkspaces: false },
            },
            {
              id: "v3",
              name: "Ops keys",
              ownerKind: "organization",
              syncStatus: "auth_expired",
              availability: { allowedWorkspaceIds: [OPS], allowPersonalWorkspaces: false },
            },
          ],
        };
      }
      return { vaults: nothingHere ? [] : [companyAccounts] };
    },
  } as never;
}

async function render(fixture: Fixture, canOpenDeveloper = true) {
  const opened: Destination[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      createElement(SharedOverview, {
        client: client(fixture),
        organizationName: "Acme",
        place: {
          workspaceId: HERE,
          workspaceName: "Design",
          personal: false,
          workspaces: [
            { id: HERE, name: "Design" },
            { id: SALES, name: "Sales" },
            { id: OPS, name: "Ops" },
          ],
          accessibleWorkspaceIds: new Set([HERE, SALES]),
          personalWorkspaceId: null,
        },
        canOpenDeveloper,
        onOpen: (destination: Destination) => opened.push(destination),
      }),
    );
  });
  // Let every list settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, opened };
}

function rowNamed(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>("[data-slot='setting-nav-row']")].find(
    (candidate) => candidate.textContent?.includes(name),
  );
  if (!row) throw new Error(`no row named ${name}`);
  return row;
}

describe("Shared", () => {
  test("lists what the organization shares and where each works", async () => {
    const { container, opened } = await render("listsAll");
    const headings = [...container.querySelectorAll("h2, h3")].map((each) => each.textContent);
    expect(headings).toEqual([
      "Models",
      "Machines and sandbox environments",
      "Vaults",
      "Skills and Knowledge",
      "Developer",
    ]);
    expect(container.textContent).not.toContain("In every workspace");
    // Only the organization's own things: not the viewer's own machine.
    expect(container.textContent).not.toContain("studio-mac");

    expect(rowNamed(container, "shared-gpu").textContent).toContain(
      "Works in every shared workspace, not in Personal workspaces.",
    );
    // One that doesn't work here is listed with where it works.
    const ops = rowNamed(container, "ops-runner");
    expect(ops.textContent).toContain("Works in Ops. You aren't in a workspace it works in.");
    expect(ops.querySelector("button")).toBeNull();
    const demo = rowNamed(container, "Sales demo");
    expect(demo.textContent).toContain(
      "Works in Sales, and in Personal workspaces. Opens in Sales.",
    );
    expect(demo.textContent).toContain("Sandbox environment");

    expect(rowNamed(container, "Company accounts").textContent).toContain(
      "Works in every workspace, Personal workspaces included.",
    );
    expect(rowNamed(container, "Sales logins").textContent).toContain(
      "Works in Sales. Opens in Sales.",
    );
    const opsKeys = rowNamed(container, "Ops keys");
    expect(opsKeys.textContent).toContain("Sign-in expired");
    expect(opsKeys.querySelector("button")).toBeNull();

    expect(rowNamed(container, "Skills").textContent).toContain(
      "1 of them doesn't work in Design.",
    );
    expect(rowNamed(container, "Knowledge").textContent).toContain(
      "The organization's Knowledge that works in Design.",
    );

    for (const name of [
      "shared-gpu",
      "Sales demo",
      "Company accounts",
      "Sales logins",
      "Skills",
      "Knowledge",
      "Models and who pays",
    ]) {
      await act(async () => {
        rowNamed(container, name).querySelector("button")!.click();
      });
    }
    expect(opened).toEqual([
      { page: "machines" },
      { page: "rig", rigId: "r3", workspaceId: SALES },
      { page: "vault", vaultId: "v1" },
      { page: "vault", vaultId: "v2", workspaceId: SALES },
      { page: "plugins", section: "skills" },
      { page: "knowledge", scope: "organization" },
      { page: "models" },
    ]);
  });

  test("someone the organization-wide lists refuse sees the ones that work here, and is told who sees all", async () => {
    const { container } = await render("listsHere", false);
    const seeAll =
      "Organization owners and admins manage them and see every one; here are the ones that work in Design.";
    expect(container.textContent?.split(seeAll).length).toBe(3);
    expect(container.textContent).toContain("shared-gpu");
    expect(container.textContent).not.toContain("ops-runner");
    expect(container.textContent).toContain("Company accounts");
    expect(container.textContent).not.toContain("Sales logins");
    expect(container.textContent).not.toContain("Webhooks and credential provider");
  });

  test("says when none of it works here", async () => {
    const { container } = await render("nothingHere");
    expect(container.textContent?.split("None work in Design.").length).toBe(3);
    expect(container.textContent).toContain("None of Acme's Skills or Knowledge work in Design.");
  });

  test("when nothing loads, one notice says so", async () => {
    const { container } = await render("allFail");
    expect(container.textContent).toContain("Couldn't load what's shared");
    expect(container.textContent).not.toContain("Couldn't load machines");
    expect(container.textContent).toContain("Try again");
  });
});
