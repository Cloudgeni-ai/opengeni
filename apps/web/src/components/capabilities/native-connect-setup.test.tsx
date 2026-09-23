import { expect, mock, test } from "bun:test";
import type { ConnectAttempt, ConnectTransport } from "@opengeni/connect";
import {
  registerDom,
  renderComponent,
  flush,
} from "../../../../../packages/react/test/render-hook";

registerDom();
const { NativeConnectSetup, nativeConnectApiInput } = await import("./native-connect-setup");

const attempt: ConnectAttempt = {
  id: "attempt",
  workspaceId: "workspace",
  providerId: "slack-bot",
  ownership: "workspace",
  revision: 1,
  state: "requires_user_action",
  credentialsCommitted: false,
  integrationInstalled: false,
  completionRequirement: "provider_setup",
  nextAction: { type: "authorize", url: "https://slack.com/oauth/authorize" },
  expiresAt: "2030-01-01T00:00:00Z",
};
function transport(pending: ConnectAttempt[]) {
  return {
    catalog: mock(async () => []),
    accounts: mock(async () => []),
    pending: mock(async () => pending),
    begin: mock(
      async (_workspaceId: string, _input: Parameters<ConnectTransport["begin"]>[1]) => attempt,
    ),
    get: mock(async (_workspaceId: string, id: string) => ({ ...attempt, id })),
    advance: mock(async () => attempt),
    cancel: mock(async () => ({ ...attempt, state: "cancelled" as const })),
    disconnect: mock(async () => {}),
  } satisfies ConnectTransport;
}

test("native setup hands the exact completed account receipt to its completion handler", async () => {
  const api = transport([]);
  const completed: ConnectAttempt = {
    ...attempt,
    providerId: "slack-personal",
    state: "complete",
    credentialsCommitted: true,
    completionRequirement: "connection",
    nextAction: { type: "none" },
    account: {
      id: "account",
      version: 1,
      providerId: "slack-personal",
      ownership: "workspace",
      label: "Slack",
      status: "connected",
    },
  };
  api.begin.mockImplementation(async () => completed);
  const onComplete = mock(() => {});
  const view = await renderComponent(
    <NativeConnectSetup
      transport={api}
      workspaceId="workspace"
      request={{
        scope: { workspaceId: "workspace", transport: api },
        providerId: "slack-personal",
        ownership: "workspace",
        returnUrl: "http://localhost/plugins",
        idempotencyKey: "complete",
      }}
      onClose={() => {}}
      onComplete={onComplete}
    />,
  );
  try {
    await flush(20);
    expect(onComplete).toHaveBeenCalledWith(completed);
    expect(onComplete).toHaveBeenCalledTimes(1);
  } finally {
    await view.unmount();
  }
});

for (const count of [0, 1, 2])
  test(`native setup with ${count} matching pending attempts preserves explicit provider authorization`, async () => {
    const api = transport(
      Array.from({ length: count }, (_, i) => ({ ...attempt, id: `attempt-${i}` })),
    );
    const request = {
      scope: { workspaceId: "workspace", transport: api },
      providerId: "slack-bot",
      ownership: "workspace" as const,
      returnUrl: "http://localhost/plugins",
      idempotencyKey: "key",
      displayName: "Slack",
      logoUrl: "https://example.test/slack.png",
      authorizeLabel: "Continue to Slack",
    };
    const view = await renderComponent(
      <NativeConnectSetup
        transport={api}
        workspaceId="workspace"
        request={request}
        onClose={() => {}}
        onComplete={() => {}}
      />,
    );
    try {
      await flush(20);
      expect(api.begin).toHaveBeenCalledTimes(count === 0 ? 1 : 0);
      expect(api.get).toHaveBeenCalledTimes(count === 1 ? 1 : 0);
      if (count === 1) expect(api.get.mock.calls[0]?.[1]).toBe("attempt-0");
      expect(api.advance).not.toHaveBeenCalled();
      expect(api.cancel).not.toHaveBeenCalled();
      expect(nativeConnectApiInput(request)).not.toHaveProperty("logoUrl");
      expect(nativeConnectApiInput(request)).not.toHaveProperty("authorizeLabel");
    } finally {
      await view.unmount();
    }
  });

test("a pending setup for a different installation target does not replace the requested target", async () => {
  const api = transport([
    { ...attempt, installationTarget: { instanceKey: "older", displayName: "Older bot" } },
  ]);
  const request = {
    scope: { workspaceId: "workspace", transport: api },
    providerId: "slack-bot",
    ownership: "workspace" as const,
    returnUrl: "http://localhost/plugins",
    idempotencyKey: "new-key",
    installationTarget: { instanceKey: "new", displayName: "New bot" },
  };
  const view = await renderComponent(
    <NativeConnectSetup
      transport={api}
      workspaceId="workspace"
      request={request}
      onClose={() => {}}
      onComplete={() => {}}
    />,
  );
  try {
    await flush(20);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.begin).toHaveBeenCalledTimes(1);
    expect(api.begin.mock.calls[0]).toContainEqual(nativeConnectApiInput(request));
    expect(api.advance).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

test("resuming a single attempt retains the choice to start another account", async () => {
  const api = transport([attempt]);
  const request = {
    scope: { workspaceId: "workspace", transport: api },
    providerId: "slack-bot",
    ownership: "workspace" as const,
    returnUrl: "http://localhost/plugins",
    idempotencyKey: "new-key",
  };
  const view = await renderComponent(
    <NativeConnectSetup
      transport={api}
      workspaceId="workspace"
      request={request}
      onClose={() => {}}
      onComplete={() => {}}
    />,
  );
  try {
    await flush(20);
    const button = Array.from(document.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("Connect a different account"),
    );
    expect(button).toBeDefined();
    button!.click();
    await flush(20);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.begin).toHaveBeenCalledTimes(1);
    expect(api.advance).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});
