import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CapabilityCatalogItem, Session } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useSessionConnectionAuthorities } from "./use-session-connection-authorities";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const slack = {
  id: "slack",
  name: "Slack",
  enabled: true,
  connectionRef: { subjectScope: "subject", providerDomain: "slack.com", kind: "oauth2" },
  runtime: { mcpServerId: "slack" },
} as CapabilityCatalogItem;
const session = {
  id: "chat",
  workspaceId: "workspace",
  connectionContext: { visibility: "workspace", authorityEpoch: 4 },
  tools: [{ id: "slack", kind: "mcp" }],
} as Session;
const grant = {
  mode: "session",
  status: "active",
  action: "connection.use",
  targetSessionId: "chat",
  targetWorkspaceId: "workspace",
  authorityEpoch: 4,
  context: "workspace_shared",
  delegation: {
    authorityId: "authority",
    grantId: "grant",
    organizationId: "organization",
    workspaceId: "workspace",
    sessionId: "chat",
    action: "connection.use",
    mode: "session",
    context: "workspace_shared",
    authorityEpoch: 4,
    authorityGeneration: 1,
    grantGeneration: 1,
  } as const,
};

test("a selected connected personal account remains reviewable until its exact chat grant is restored; revocation restores review", async () => {
  let grants: unknown[] = [];
  let fail = false;
  const client = {
    listConnections: async () => [
      {
        id: "connection",
        subjectId: "owner",
        status: "active",
        authorityId: "authority",
        providerDomain: "slack.com",
        kind: "oauth2",
      },
    ],
    listUserResourceAuthorities: async () => {
      if (fail) throw new Error("lookup failed");
      return {
        authorities: [
          { resourceId: "connection", authorityId: "authority", status: "active", grants },
        ],
      };
    },
  } as unknown as OpenGeniBrowserClient;
  let current!: ReturnType<typeof useSessionConnectionAuthorities>;
  function Harness({ value, catalog }: { value: Session; catalog: CapabilityCatalogItem[] }) {
    current = useSessionConnectionAuthorities(client, value, catalog);
    return <div>{current.needsReview.map((item) => item.name).join(",")}</div>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const catalog = [slack];
  const render = async (value = session, items = catalog) => {
    await act(async () => {
      root.render(<Harness value={value} catalog={items} />);
    });
    await act(async () => {
      await current.refresh();
    });
  };
  try {
    await render();
    expect(current.selections).toEqual([]);
    expect(current.needsReview.map((item) => item.id)).toEqual(["slack"]);
    grants = [grant];
    await act(async () => {
      await current.refresh();
    });
    expect(current.needsReview).toEqual([]);
    expect(current.selections).toEqual([
      { serverId: "slack", connectionId: "connection", userDelegation: grant.delegation },
    ]);
    grants = [{ ...grant, status: "revoked" }];
    await act(async () => {
      await current.refresh();
    });
    expect(current.needsReview).toEqual([slack]);
    expect(current.selections).toEqual([]);
    fail = true;
    await act(async () => {
      await current.refresh();
    });
    expect(current.error).toBe("lookup failed");
    expect(current.needsReview).toEqual([]);
    fail = false;
    await render({ ...session, tools: [] });
    expect(current.needsReview).toEqual([]);
    await render(session, [
      { ...slack, connectionRef: { ...slack.connectionRef!, authoritySource: "host" } },
    ]);
    expect(current.needsReview).toEqual([]);
    await render({ ...session, connectionContext: undefined, tenancy: undefined });
    expect(current.needsReview).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
