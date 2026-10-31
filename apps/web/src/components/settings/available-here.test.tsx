import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniApiError } from "@opengeni/sdk";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { AvailableHere } = await import("./available-here");
type Destination = Parameters<Parameters<typeof AvailableHere>[0]["onOpen"]>[0];

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.replaceChildren();
});

const WORKSPACE = "22222222-2222-4222-8222-222222222222";

function client(options: { rigsFail?: boolean; allFail?: boolean } = {}) {
  if (options.allFail) {
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
    listCapabilities: async () => ({
      items: [{ id: "gmail", name: "Gmail", connectionRef: { subjectScope: "subject" } }],
      installations: [{ id: "i1", capabilityId: "gmail", kind: "mcp", status: "active" }],
    }),
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
          state: "offline",
          isSessionGroup: false,
        },
      ],
    }),
    listRigs: async () => {
      if (options.rigsFail) throw new OpenGeniApiError(500, '{"error":"boom"}');
      return [{ id: "r1", name: "Web app", scope: "workspace", status: "active" }];
    },
    requestJson: async () => ({ vaults: [] }),
    listWorkspaceSkills: async () => {
      throw new OpenGeniApiError(403, '{"error":"missing permission"}');
    },
    listKnowledgeEntries: async () => ({ entries: [], nextCursor: null }),
  } as never;
}

async function render(props: { canOpenModels: boolean; rigsFail?: boolean; allFail?: boolean }) {
  const opened: Destination[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      createElement(AvailableHere, {
        client: client({ rigsFail: props.rigsFail ?? false, allFail: props.allFail ?? false }),
        workspaceId: WORKSPACE,
        workspaceName: "Design",
        organizationName: "Acme",
        personal: false,
        canOpenModels: props.canOpenModels,
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

describe("Available here", () => {
  test("groups what agents here can use by who it belongs to, and opens each thing's page", async () => {
    const { container, opened } = await render({ canOpenModels: true });
    const headings = [...container.querySelectorAll("h2, h3")].map((each) => each.textContent);
    expect(headings).toEqual(["Models", "Belongs to Design", "Shared by Acme", "Yours"]);
    expect(rowNamed(container, "Gmail").textContent).toContain(
      "Each person signs in with their own account. Admins of Design manage it.",
    );
    expect(rowNamed(container, "studio-mac").textContent).toContain("Machine · Offline");
    // A kind the viewer may not read (Skills here) is simply not shown.
    expect(container.textContent).not.toContain("Skills");
    expect(container.textContent).not.toContain("didn't load");

    await act(async () => {
      rowNamed(container, "Web app").querySelector("button")!.click();
    });
    await act(async () => {
      rowNamed(container, "Models and who pays").querySelector("button")!.click();
    });
    expect(opened).toEqual([{ page: "rig", rigId: "r1" }, { page: "models" }]);
  });

  test("someone who can't open Models is told who manages them", async () => {
    const { container } = await render({ canOpenModels: false });
    const models = rowNamed(container, "Models and who pays");
    expect(models.querySelector("button")).toBeNull();
    expect(models.textContent).toContain(
      "Admins of Design and organization owners and admins manage these.",
    );
  });

  test("a list that fails says so above everything that did load", async () => {
    const { container } = await render({ canOpenModels: true, rigsFail: true });
    expect(container.textContent).toContain("Couldn't load rigs. Everything else is below.");
    expect(container.textContent).toContain("Gmail");
    expect(container.textContent).not.toContain("Web app");
  });

  test("when nothing loads, one notice says so instead of naming every kind", async () => {
    const { container } = await render({ canOpenModels: true, allFail: true });
    expect(container.textContent).toContain("Couldn't load what's available here");
    expect(container.textContent).not.toContain("Couldn't load connectors");
    expect(container.textContent).toContain("Try again");
  });
});
