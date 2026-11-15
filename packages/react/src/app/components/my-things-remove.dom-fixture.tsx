// Run by my-things.test.tsx in its own process (Radix portals).
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
const { MyThings } = await import("./my-things");

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
        workspaceId: "home",
        version: 3,
        status: "active",
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
    deleteConnection: mock(async () => ({}) as ConnectionMetadata),
    disconnectPersonalGitHub: mock(async () => ({}) as ConnectionMetadata),
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

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  ) as HTMLButtonElement | undefined;
}

test("a login of your own can be removed from its sheet, after you confirm", async () => {
  const fake = client(resources);
  const view = await render(<MyThings client={fake} workspaceId="design" />);
  const loginRow = [...view.container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.startsWith("Mail"),
  );
  await act(async () => loginRow!.click());
  await act(async () => button("Remove")!.click());
  // Nothing is removed until you confirm.
  expect(fake.deleteConnection).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Remove Mail (sam@example.com)?");
  expect(document.body.textContent).toContain("It stops working in all your workspaces.");
  await act(async () => button("Remove")!.click());
  await act(async () => {});
  // Removed where it was added, so it stops working everywhere.
  expect(fake.deleteConnection).toHaveBeenCalledWith("home", LOGIN);
  expect(fake.listOwnResources).toHaveBeenCalledTimes(2);
  await view.unmount();
});

test("a login without its own account record, a plan or a machine offers no Remove", async () => {
  const fake = client(resources);
  const view = await render(<MyThings client={fake} workspaceId="design" />);
  const loginRow = [...view.container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.startsWith("tracker.example.com"),
  );
  await act(async () => loginRow!.click());
  expect(button("Remove")).toBeUndefined();
  expect(button("Done")).toBeDefined();
  await view.unmount();
});

test("a failed removal says so and keeps the login", async () => {
  const fake = client(resources);
  fake.deleteConnection.mockImplementation(async () => {
    throw new Error("The service didn't answer.");
  });
  const view = await render(<MyThings client={fake} workspaceId="design" />);
  const loginRow = [...view.container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.startsWith("Mail"),
  );
  await act(async () => loginRow!.click());
  await act(async () => button("Remove")!.click());
  await act(async () => button("Remove")!.click());
  await act(async () => {});
  expect(document.body.querySelector("[role=alert]")?.textContent).toBeTruthy();
  expect(fake.listOwnResources).toHaveBeenCalledTimes(1);
  await view.unmount();
});
