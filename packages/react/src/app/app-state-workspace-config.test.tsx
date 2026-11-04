import { describe, expect, test } from "bun:test";
import { forwardRef } from "react";
import type { ClientConfig } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { actRun, flush, registerDom, renderHook } from "../../test/render-hook";
import { inferenceFeatureRestriction } from "../inference-region";
import { createOpenGeniText } from "../messages/runtime";
import { createSlackLinkPrepareController, useAppState, type AppStateHost } from "./app-state";
import { capabilityAvailability } from "./lib/agent-capabilities";
import { configurePageAppHost } from "./lib/app-host";
import { browserPage, type NavigationHost } from "./lib/navigation";

registerDom();

const t = createOpenGeniText();
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

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

/**
 * The server answers the boot read (no workspace) with nothing restricted and
 * the open EU-only workspace's read with what it switched off, as
 * `GET /v1/config/client` does.
 */
function configSource() {
  const reads: (string | undefined)[] = [];
  let euOnly = true;
  const base = {
    deploymentRevision: "rev-1",
    defaultModel: "gpt-5.6-sol",
    allowedModels: ["gpt-5.6-sol"],
    models: [
      {
        id: "gpt-5.6-sol",
        label: "gpt-5.6-sol",
        provider: "openai",
        providerLabel: "OpenAI",
        api: "responses",
      },
    ],
    defaultReasoningEffort: "medium",
    allowedReasoningEfforts: ["medium"],
    mcpServers: [],
    fileUploads: { enabled: true, maxSizeBytes: 1024 },
    auth: { mode: "none" },
  } as unknown as ClientConfig;
  const fetchClientConfig = async (_signal?: AbortSignal, workspaceId?: string) => {
    reads.push(workspaceId);
    if (!workspaceId || !euOnly) {
      return {
        ...base,
        inferenceFeatures: [{ id: "web_search", available: true, unavailableReason: null }],
        agentConfig: { capabilities: [{ id: "webSearch", available: true }] },
      } as unknown as ClientConfig;
    }
    return {
      ...base,
      inferenceFeatures: [
        { id: "web_search", available: false, unavailableReason: "region_restricted" },
      ],
      agentConfig: {
        capabilities: [{ id: "webSearch", available: false, code: "region_restricted" }],
      },
      codeSearch: { available: false, workspaceDefault: "off" },
    } as unknown as ClientConfig;
  };
  return {
    reads,
    fetchClientConfig,
    turnOff: () => {
      euOnly = false;
    },
  };
}

function host(source: ReturnType<typeof configSource>): AppStateHost {
  const client = new Proxy(
    {
      getAccessContext: async () => ({
        subjectId: "user:1",
        defaultWorkspaceId: WORKSPACE_ID,
        grants: [],
      }),
      listWorkspaces: async () => [{ id: WORKSPACE_ID, name: "Platform", settings: {} }],
    } as Record<string, unknown>,
    { get: (target, key) => target[key as string] ?? (async () => ({})) },
  ) as unknown as OpenGeniBrowserClient;
  const noop = async () => {};
  return {
    authority: "host",
    createOpenGeniClient: () => client,
    fetchClientConfig: source.fetchClientConfig,
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
}

describe("the app's client config for an EU-only workspace", () => {
  test("comes from the open workspace's read, and again after the setting changes", async () => {
    const source = configSource();
    const appHost = host(source);
    const rendered = await renderHook(
      () => useAppState(appHost, { bootstrapSuspended: false }),
      undefined,
    );
    try {
      for (let i = 0; i < 20 && !rendered.result.current.appContext; i++) await flush(10);
      const before = rendered.result.current.appContext!;
      // Boot read: no workspace yet, nothing restricted.
      expect(inferenceFeatureRestriction(t, before.clientConfig, "web_search")).toBeNull();

      await actRun(() => before.prepareWorkspaceTransition(WORKSPACE_ID));
      for (let i = 0; i < 20 && !source.reads.includes(WORKSPACE_ID); i++) await flush(10);
      await flush(10);
      const open = rendered.result.current.appContext!;
      expect(inferenceFeatureRestriction(t, open.clientConfig, "web_search")).toBe(
        "Not supported in EU",
      );
      expect(
        capabilityAvailability(open.clientConfig.agentConfig).unavailableReason("webSearch"),
      ).toBe("Not supported in EU");
      expect(open.clientConfig.codeSearch?.available).toBe(false);

      // Turned off in organization settings: the open workspace is read again.
      source.turnOff();
      await actRun(() => open.refreshWorkspaceConfig?.());
      await flush(20);
      const after = rendered.result.current.appContext!;
      expect(inferenceFeatureRestriction(t, after.clientConfig, "web_search")).toBeNull();
      expect(source.reads.filter((read) => read === WORKSPACE_ID)).toHaveLength(2);
    } finally {
      await rendered.unmount();
    }
  });
});
