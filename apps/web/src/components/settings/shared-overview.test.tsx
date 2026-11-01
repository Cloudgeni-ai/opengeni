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

type Fixture = "owner" | "admin" | "allFail";

function client(fixture: Fixture) {
  if (fixture === "allFail") {
    const fail = async () => {
      throw new OpenGeniApiError(503, '{"error":"The service is busy. Try again in a minute."}');
    };
    return {
      listCapabilities: fail,
      listMachines: fail,
      listRigs: fail,
      requestJson: fail,
      listWorkspaceSkills: fail,
      listKnowledgeEntries: fail,
    } as never;
  }
  return {
    listCapabilities: async () => ({ items: [], installations: [] }),
    listMachines: async () => ({
      machines: [
        {
          sandboxId: "m1",
          enrollmentId: "e1",
          name: "shared-gpu",
          scope: "organization",
          state: "online",
          isSessionGroup: false,
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
      skills: [{ id: "s1", scope: "organization", status: "active" }],
      nextCursor: null,
    }),
    listKnowledgeEntries: async () => ({ entries: [], nextCursor: null }),
    requestJson: async (_method: string, path: string) => {
      if (path.endsWith("/organization-vaults")) {
        if (fixture === "admin") {
          throw new OpenGeniApiError(403, '{"error":"missing permission account:admin"}');
        }
        return {
          complete: true,
          vaults: [
            {
              id: "v1",
              name: "Company accounts",
              ownerKind: "organization",
              syncStatus: "ok",
              availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
            },
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
      return {
        vaults: [
          {
            id: "v1",
            name: "Company accounts",
            ownerKind: "organization",
            syncStatus: "ok",
            availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
          },
        ],
      };
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
  test("lists what the organization shares and where each vault works", async () => {
    const { container, opened } = await render("owner");
    const headings = [...container.querySelectorAll("h2, h3")].map((each) => each.textContent);
    expect(headings).toEqual(["Models", "In every workspace", "Vaults", "Developer"]);
    // Only the organization's own things: not the viewer's own machine.
    expect(container.textContent).toContain("shared-gpu");
    expect(container.textContent).not.toContain("studio-mac");
    expect(rowNamed(container, "Company accounts").textContent).toContain(
      "Works in every workspace, Personal workspaces included.",
    );
    expect(rowNamed(container, "Sales logins").textContent).toContain(
      "Works in Sales. Opens in Sales.",
    );
    const ops = rowNamed(container, "Ops keys");
    expect(ops.textContent).toContain("Works in Ops. You aren't in a workspace it works in.");
    expect(ops.textContent).toContain("Sign-in expired");
    expect(ops.querySelector("button")).toBeNull();

    for (const name of ["Company accounts", "Sales logins", "shared-gpu", "Models and who pays"]) {
      await act(async () => {
        rowNamed(container, name).querySelector("button")!.click();
      });
    }
    expect(opened).toEqual([
      { page: "vault", vaultId: "v1" },
      { page: "vault", vaultId: "v2", workspaceId: SALES },
      { page: "machines" },
      { page: "models" },
    ]);
  });

  test("an admin who isn't an owner sees the vaults that work here, and is told owners see all", async () => {
    const { container } = await render("admin", false);
    expect(container.textContent).toContain(
      "Organization owners manage them and see every one; here are the ones that work in Design.",
    );
    expect(container.textContent).toContain("Company accounts");
    expect(container.textContent).not.toContain("Sales logins");
    expect(container.textContent).not.toContain("Webhooks and credential provider");
  });

  test("when nothing loads, one notice says so", async () => {
    const { container } = await render("allFail");
    expect(container.textContent).toContain("Couldn't load what's shared");
    expect(container.textContent).not.toContain("Couldn't load machines");
    expect(container.textContent).toContain("Try again");
  });
});
