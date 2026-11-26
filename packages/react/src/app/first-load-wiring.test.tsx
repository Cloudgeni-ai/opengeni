// The web app's first load, wired as the console wires it: the app state (its
// API client, bootstrap config read and retained shared reads), the workspace
// integrations, the composer's + menu, the chat's connection accounts and the
// capability flags. They mount moments apart and need the same catalog,
// accounts and config: each is requested once. A change reads afresh.
import { afterEach, describe, expect, test } from "bun:test";
import type { ChatClient, ClientConfig } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { forwardRef, type ComponentProps } from "react";

import { actRun, flush, registerDom, renderComponent } from "../../test/render-hook";
import { useClientConfigFlags } from "../hooks/use-client-config-flags";
import { createSlackLinkPrepareController, useAppState, type AppStateHost } from "./app-state";
import { AppContext } from "./app-context";
import { useConnectionAccounts } from "./components/capabilities/use-connection-accounts";
import { WorkspaceComposerPlus } from "./components/workspace-composer-plus";
import { configurePageAppHost } from "./lib/app-host";
import { browserPage, type NavigationHost } from "./lib/navigation";
import { useWorkspaceIntegrations } from "./lib/use-workspace-integrations";

registerDom();

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

const location = { pathname: "/", search: {}, searchStr: "", hash: "", state: {} };
configurePageAppHost({
  navigation: {
    useNavigate: () => async () => {},
    useLocation: () => location,
    useRouterState: ({ select }: { select: (state: { location: typeof location }) => unknown }) =>
      select({ location }),
    useRouter: () => ({ state: { location } }),
    useSearch: () => ({}),
    Link: forwardRef<HTMLAnchorElement>((props, ref) => <a ref={ref} {...props} />),
    stringifySearch: () => "",
    page: browserPage,
  } as unknown as NavigationHost,
});

const mail = {
  id: "mcp:mail",
  name: "Mail",
  kind: "mcp",
  enabled: true,
  runtime: { available: true, mcpServerId: "mail" },
  lifecycle: { readiness: "ready" },
  connectionRef: { providerDomain: "example.com", subjectScope: "subject" },
};

function countingHost() {
  const reads = { config: 0, capabilities: 0, accounts: 0 };
  const api = { accounts: [{ id: "one", status: "active", providerDomain: "example.com" }] };
  const config = {
    deploymentRevision: "rev-1",
    defaultModel: "gpt-5.6-sol",
    allowedModels: ["gpt-5.6-sol"],
    models: [],
    mcpServers: [],
    auth: { mode: "none" },
  } as unknown as ClientConfig;
  const client = new Proxy(
    {
      getAccessContext: async () => ({
        mode: "managed",
        subjectId: "user:1",
        defaultWorkspaceId: WORKSPACE_ID,
        defaultAccountId: ACCOUNT_ID,
        accountGrants: [],
        workspaceGrants: [
          {
            workspaceId: WORKSPACE_ID,
            accountId: ACCOUNT_ID,
            subjectId: "user:1",
            permissions: ["connections:read", "workspace:read"],
          },
        ],
      }),
      listWorkspaces: async () => [{ id: WORKSPACE_ID, name: "Platform", settings: {} }],
      getClientConfig: async () => {
        reads.config += 1;
        return config;
      },
      listCapabilities: async () => {
        reads.capabilities += 1;
        return { items: [mail] };
      },
      listOwnConnectionAccounts: async () => {
        reads.accounts += 1;
        return api.accounts.map((account) => ({
          ...account,
          subjectId: "user:1",
          authorityId: "authority",
        }));
      },
      catalogAssetUrl: () => null,
      getGitHubApp: async () => ({ configured: false, status: "unconfigured", installations: [] }),
      personalGitHubStatus: async () => ({ enabled: false, connection: null, reviewUrl: null }),
      listApiIntegrations: async () => ({ integrations: [] }),
    } as Record<string, unknown>,
    { get: (target, key) => target[key as string] ?? (async () => ({})) },
  ) as unknown as ChatClient<OpenGeniBrowserClient>;
  const noop = async () => {};
  const host = {
    authority: "host",
    createOpenGeniClient: () => client,
    // The bootstrap's own read, before the API client exists for every caller.
    fetchClientConfig: async () => config,
    captureProductEvent: () => {},
    fetchAuthSession: async () => null,
    signInEmail: noop,
    signUpEmail: noop,
    signOutManaged: noop,
    startManagedSocialSignIn: noop,
    configureManagedActorEpoch: () => {},
    getStoredAccessKey: () => null,
    setStoredAccessKey: () => {},
    clearStoredAccessKey: () => {},
    slackLink: createSlackLinkPrepareController(null),
    initialInvalidSlackLinkQueryWorkspaceId: null,
  } as unknown as AppStateHost;
  return { host, reads, api };
}

const composerProps = {
  workspaceId: WORKSPACE_ID,
  servers: [{ id: "mail", name: "Mail", connectionStatus: "ready" }],
  firstPartyTools: [],
  fileUploadsEnabled: false,
  onToolSelectionChange: () => {},
} as unknown as ComponentProps<typeof WorkspaceComposerPlus>;

let accounts: ReturnType<typeof useConnectionAccounts> | null = null;

function ChatAccounts(props: { catalog: (typeof mail)[] }) {
  const { client } = useAppStateContext();
  accounts = useConnectionAccounts(
    client,
    { id: "chat", workspaceId: WORKSPACE_ID, selectedIds: ["mail"] },
    props.catalog as never,
    true,
  );
  return null;
}

let current: ReturnType<typeof useAppState>["appContext"] = null;
function useAppStateContext() {
  return current!;
}

function Workspace(props: { catalog: (typeof mail)[]; chat: boolean }) {
  const context = useAppStateContext();
  useWorkspaceIntegrations(context, WORKSPACE_ID, true);
  useClientConfigFlags(context.client);
  return (
    <>
      <WorkspaceComposerPlus {...composerProps} />
      {props.chat ? <ChatAccounts catalog={props.catalog} /> : null}
    </>
  );
}

function Console(props: {
  host: AppStateHost;
  ready: boolean;
  catalog: (typeof mail)[];
  chat: boolean;
}) {
  const state = useAppState(props.host, { bootstrapSuspended: false });
  current = state.appContext;
  if (!current || !props.ready) return null;
  return (
    <AppContext.Provider value={current}>
      <Workspace catalog={props.catalog} chat={props.chat} />
    </AppContext.Provider>
  );
}

afterEach(() => {
  current = null;
  accounts = null;
});

describe("first load wiring", () => {
  test("the catalog, the accounts and the config are each requested once", async () => {
    const { host, reads, api } = countingHost();
    const catalog = [mail];
    const props = { host, ready: false, catalog, chat: false };
    const view = await renderComponent(<Console {...props} />);
    try {
      const ready = () => current !== null;
      for (let i = 0; i < 20 && !ready(); i++) await flush(10);
      await actRun(() => current!.prepareWorkspaceTransition(WORKSPACE_ID));
      // The workspace page mounts: its tool list and the composer.
      await view.rerender(<Console {...props} ready />);
      await flush(50);
      // The chat opens a moment later and lists its connection accounts.
      await view.rerender(<Console {...props} ready chat />);
      await flush(50);
      expect(accounts?.accountGroups[0]?.accounts.map((account) => account.id)).toEqual(["one"]);
      expect(reads).toEqual({ config: 0, capabilities: 1, accounts: 1 });

      // A catalog change (a connector added) re-reads the accounts at once.
      api.accounts = [
        ...api.accounts,
        { id: "two", status: "active", providerDomain: "example.com" },
      ];
      await view.rerender(<Console {...props} ready chat catalog={[{ ...mail }]} />);
      await flush(50);
      expect(reads.accounts).toBe(2);
      expect(accounts?.accountGroups[0]?.accounts.map((account) => account.id)).toEqual([
        "one",
        "two",
      ]);
    } finally {
      await view.unmount();
    }
  });
});
