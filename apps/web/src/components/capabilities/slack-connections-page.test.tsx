import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import * as SonnerPackage from "sonner";

// React reads the DOM when it loads (input events), so register first.
GlobalRegistrator.register({ url: "https://example.test/workspaces/w/capabilities" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "66666666-6666-4666-8666-666666666666";

let botsLoad: () => Promise<unknown> = async () => {
  throw new OpenGeniApiError(503, "{}", { code: "service_unavailable" });
};
const botLoads = mock(() => botsLoad());
const served: Record<string, unknown> = {
  connectTransport: () => ({}),
  listAvailableOpenGeniSlackBots: botLoads,
  listOpenGeniSlackAgents: async () => ({ agents: [], routingEnabled: true }),
};
// Anything else the page asks for is refused, as a server without it would.
const client = new Proxy(served, {
  get: (target, property) =>
    typeof property !== "string" || property in target || property === "then"
      ? Reflect.get(target, property)
      : async () => {
          throw new OpenGeniApiError(404, "{}");
        },
});
const context = {
  client,
  workspaces: [{ id: WORKSPACE_ID, accountId: ACCOUNT_ID, kind: "shared", name: "Platform" }],
  managedSelfContext: null,
  accessContext: {
    mode: "managed",
    subjectId: "subject-a",
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId: WORKSPACE_ID,
        accountId: ACCOUNT_ID,
        subjectId: "subject-a",
        permissions: ["workspace:admin", "connections:read", "connections:write"],
      },
    ],
    defaultAccountId: ACCOUNT_ID,
    defaultWorkspaceId: WORKSPACE_ID,
  },
};
mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }),
}));

const { SlackConnectionsPage } = await import("./slack-connections-page");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

function button(host: ParentNode, label: string) {
  const match = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

test("after the Slack workspaces fail to load, Create agent opens a form that says why and retries", async () => {
  const refresh = mock(async () => undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <SlackConnectionsPage
        workspaceId={WORKSPACE_ID}
        items={[]}
        connections={null}
        connectionsLoadFailed
        bindings={[]}
        refresh={refresh}
        onRuntimeChanged={() => undefined}
        onBack={() => undefined}
      />,
    ),
  );
  await settle();
  // Not "Add a Slack workspace": nothing says there is none.
  expect(host.textContent).toContain("Couldn't load all Slack connections");
  expect(host.textContent).not.toContain("Add a Slack workspace to create Slack agents.");

  await act(async () => button(host, "Create agent").click());
  await settle();
  expect(host.textContent).toContain("New Slack agent");
  expect(host.textContent).toContain("Couldn't load all Slack connections");
  expect(host.textContent).not.toContain("Add a Slack workspace");
  expect(button(host, "Create agent").disabled).toBe(true);

  // Retry loads both again: the shared bots and this workspace's connections.
  const loadsBefore = botLoads.mock.calls.length;
  botsLoad = async () => ({
    connections: [
      { id: CONNECTION_ID, accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID, status: "active" },
    ],
    organizationSharedConnectionIds: [],
  });
  await act(async () => button(host, "Retry").click());
  await settle();
  expect(botLoads.mock.calls.length).toBe(loadsBefore + 1);
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  host.remove();
});
