import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  CapabilityCatalogItem,
  ConnectionMetadata,
  OwnResource,
  OwnResourceReachWorkspace,
} from "@opengeni/sdk";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterAll(() => GlobalRegistrator.unregister());

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MyThings, planTitle, whereItWorksSummary } = await import("./my-things");

function row(
  name: string,
  on: boolean,
  extra: Partial<OwnResourceReachWorkspace> = {},
): OwnResourceReachWorkspace {
  return {
    workspaceId: name.toLowerCase(),
    name,
    personal: false,
    current: false,
    on,
    alwaysOn: false,
    canChange: true,
    ...extra,
  };
}

const personal = row("Personal", true, { personal: true, alwaysOn: true, canChange: false });

test("a plan's title never repeats its provider", () => {
  expect(planTitle("claude", "max")).toBe("Claude Max");
  expect(planTitle("codex", "PRO")).toBe("Codex Pro");
  expect(planTitle("xai", "supergrok")).toBe("SuperGrok");
  expect(planTitle("xai", "supergrok_heavy")).toBe("SuperGrok Heavy");
  expect(planTitle("claude", null)).toBe("Claude");
  expect(planTitle("other", "team")).toBe("Other Team");
  expect(planTitle(null, null)).toBe("Model plan");
});

test("the summary names where your own thing works, in a few words", () => {
  expect(whereItWorksSummary([personal])).toBe("Works only in your Personal workspace");
  expect(whereItWorksSummary([{ ...personal, on: false }])).toBe("Turned off everywhere");
  expect(whereItWorksSummary([personal, row("Design", true)])).toBe(
    "Works in your Personal workspace and Design",
  );
  expect(whereItWorksSummary([personal, row("Design", true), row("Support", true)])).toBe(
    "Works in all your workspaces",
  );
  expect(
    whereItWorksSummary([
      personal,
      row("Design", true),
      row("Support", true),
      row("Finance", true),
      row("Sales", false),
    ]),
  ).toBe("Works in your Personal workspace, Design and 2 more");
});

const LOGIN = "11111111-1111-4111-8111-111111111111";

const resources: OwnResource[] = [
  {
    resourceKind: "connection",
    resourceId: LOGIN,
    name: "sam@example.com",
    provider: "mail.example.com",
    plan: null,
    workspaces: [personal, row("Design", true, { current: true })],
  },
  {
    resourceKind: "connection",
    resourceId: "22222222-2222-4222-8222-222222222222",
    name: "sam@example.com",
    provider: "tracker.example.com",
    plan: null,
    workspaces: [personal],
  },
  {
    resourceKind: "subscription_connection",
    resourceId: "33333333-3333-4333-8333-333333333333",
    name: "sam@example.com",
    provider: "xai",
    plan: "supergrok",
    workspaces: [personal],
  },
  {
    resourceKind: "connected_machine",
    resourceId: "44444444-4444-4444-8444-444444444444",
    name: "studio-mac",
    provider: null,
    plan: null,
    workspaces: [{ ...personal, alwaysOn: false, canChange: true }, row("Design", false)],
  },
];

function client(listed: OwnResource[] | Error) {
  return {
    listOwnResources: mock(async () => {
      if (listed instanceof Error) throw listed;
      return { resources: listed };
    }),
    listCapabilities: mock(async () => ({
      items: [
        {
          name: "Mail",
          connectionRef: {
            authoritySource: "user",
            kind: "oauth",
            providerDomain: "mail.example.com",
          },
        } as unknown as CapabilityCatalogItem,
      ],
      installations: [],
    })),
    listOwnConnectionAccounts: mock(async () => [
      {
        id: LOGIN,
        authorityId: "55555555-5555-4555-8555-555555555555",
        subjectId: "user:sam",
        kind: "oauth",
        providerDomain: "mail.example.com",
        metadata: {},
      } as unknown as ConnectionMetadata,
    ]),
    getOwnResourceReach: mock(async () => {
      throw new Error("My things passes each row's workspaces; it shouldn't read them again.");
    }),
    setOwnResourceReach: mock(async () => {
      throw new Error("not used");
    }),
  };
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  await act(async () => {});
  await act(async () => {});
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("My things groups your logins, plans and machines and names each one", async () => {
  const fake = client(resources);
  const view = await render(<MyThings client={fake} workspaceId="design" />);
  const headings = [...view.container.querySelectorAll("h2")].map((node) => node.textContent);
  expect(headings).toEqual(["Logins", "Model plans", "Machines"]);
  const text = view.container.textContent ?? "";
  // A login this workspace lists a connector for is named by its app.
  expect(text).toContain("Mail");
  expect(text).toContain("sam@example.com · Works in your Personal workspace and Design");
  // One it doesn't keeps its service's address.
  expect(text).toContain("tracker.example.com");
  expect(text).toContain("SuperGrok");
  expect(text).not.toContain("Supergrok");
  expect(text).toContain("studio-mac");
  expect(text).toContain("Works only in your Personal workspace");
  expect(fake.getOwnResourceReach).not.toHaveBeenCalled();
  await view.unmount();
});

test("My things says when you have nothing of your own", async () => {
  const view = await render(<MyThings client={client([])} workspaceId="design" />);
  expect(view.container.textContent).toContain("Nothing of your own yet");
  await view.unmount();
});

test("My things says it couldn't load and can try again", async () => {
  const fake = client(new Error("The service didn't answer."));
  const view = await render(<MyThings client={fake} workspaceId="design" />);
  expect(view.container.textContent).toContain("Couldn't load your things");
  const retry = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  );
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  await act(async () => {});
  expect(fake.listOwnResources).toHaveBeenCalledTimes(2);
  await view.unmount();
});
