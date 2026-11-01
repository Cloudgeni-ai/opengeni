import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApiIntegrationInstallationSummary } from "@opengeni/react/app/types";

const ws = "44444444-4444-4444-8444-444444444444";
const subjectId = "accounts-test-member";
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => ({
    client: { connectTransport: () => ({}) },
    accessContext: {
      subjectId,
      workspaceGrants: [
        {
          workspaceId: ws,
          subjectId,
          accountId: "org",
          permissions: ["workspace:read", "connections:write"],
        },
      ],
      accountGrants: [],
    },
  }),
}));
const { useApiIntegrationAccounts } = await import("./use-api-integration-accounts");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

function account(
  instanceKey: string,
  patch: Partial<ApiIntegrationInstallationSummary> = {},
): ApiIntegrationInstallationSummary {
  return {
    capabilityId: "api:linear-like",
    pluginKey: "integration/linear-like",
    installationVersion: 2,
    instanceId: `00000000-0000-4000-8000-0000000000${instanceKey.length}${instanceKey.length}`,
    instanceKey,
    displayName: `Linear — ${instanceKey}`,
    instanceVersion: 3,
    serverId: `api_linear_like__${instanceKey}`,
    name: "Linear",
    description: null,
    protocol: "graphql",
    definitionId: "linear-graphql",
    definitionProvenance: "workspace",
    providerDomain: "linear.example.test",
    baseUrl: "https://linear.example.test/graphql",
    sourceUrl: "https://linear.example.test/graphql",
    connected: true,
    requiresConnection: true,
    connectionId: "00000000-0000-4000-8000-000000000040",
    ownership: "workspace",
    allowedTools: ["query_issues"],
    toolCount: 1,
    approvalRequiredToolCount: 0,
    revisionId: "graphql:linear-revision",
    contentSha256: "b".repeat(64),
    ...patch,
  };
}

test("an account offers Remove exactly when the server says the viewer may remove it", async () => {
  let labels: Record<string, string[]> = {};
  function Harness() {
    const controller = useApiIntegrationAccounts({
      workspaceId: ws,
      definitionId: "linear-graphql",
      definitions: [],
      instances: [
        // The member's own account.
        account("mine", { canRemove: true }),
        // An admin's, another person's or an unknown installer's account.
        account("theirs", { canRemove: false }),
        // An older server that sends no flag: the viewer's permission stands in.
        account("older"),
      ],
      canManage: true,
      canChange: false,
    });
    labels = Object.fromEntries(
      controller.accessItems.map((item) => [
        item.id,
        (item.actions ?? []).map((action) => action.label),
      ]),
    );
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));
  try {
    expect(labels).toEqual({ mine: ["Remove"], theirs: [], older: ["Remove"] });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
