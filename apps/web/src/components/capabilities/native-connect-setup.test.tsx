import { expect, mock, test } from "bun:test";
import { useState } from "react";
import type { ConnectAttempt, ConnectTransport } from "@opengeni/connect";
import {
  registerDom,
  renderComponent,
  flush,
} from "../../../../../packages/react/test/render-hook";

registerDom();
const { NativeConnectSetup, nativeConnectApiInput } =
  await import("@opengeni/react/app/components/capabilities/native-connect-setup");

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
    advance: mock(
      async (
        _workspaceId: string,
        _id: string,
        _input: Parameters<ConnectTransport["advance"]>[2],
      ) => attempt,
    ),
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

test("a reconnect that asks for more access sends it and never resumes a plain reconnect", async () => {
  const compose = "https://www.googleapis.com/auth/gmail.compose";
  const account = {
    id: "gmail-account",
    version: 1,
    providerId: "gmail",
    ownership: "personal" as const,
    label: "Gmail",
    status: "auth_needed" as const,
  };
  // An older plain reconnect of the same account is still pending.
  const api = transport([{ ...attempt, providerId: "gmail", ownership: "personal", account }]);
  const request = {
    scope: { workspaceId: "workspace", transport: api },
    providerId: "gmail",
    ownership: "personal" as const,
    returnUrl: "http://localhost/session",
    idempotencyKey: "more-access",
    reconnectAccountId: account.id,
    requestedScopes: [compose],
  };
  expect(nativeConnectApiInput(request)).toMatchObject({
    reconnectAccountId: account.id,
    requestedScopes: [compose],
  });
  // Additional access only ever travels with a reconnect.
  expect(nativeConnectApiInput({ ...request, reconnectAccountId: undefined })).not.toHaveProperty(
    "requestedScopes",
  );
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

test("closing the dialog while a built-in integration finishes setup still completes it", async () => {
  // The account is saved; the tools are still being added ("Finishing setup…").
  const connected: ConnectAttempt = {
    ...attempt,
    providerId: "microsoft-sharepoint",
    ownership: "personal",
    revision: 2,
    state: "connected_but_incomplete",
    credentialsCommitted: true,
    completionRequirement: "integration",
    nextAction: { type: "none" },
    installationTarget: { instanceKey: "account-sharepoint", displayName: "SharePoint" },
    account: {
      id: "account",
      providerId: "microsoft-sharepoint",
      ownership: "personal",
      label: "Bendik Nyheim",
      status: "connected",
    },
  };
  const preview: ConnectAttempt = {
    ...connected,
    revision: 3,
    state: "preview",
    nextAction: {
      type: "preview",
      previewId: "preview",
      contentHash: "hash",
      operations: [{ id: "listSites", label: "List sites", kind: "read" }],
    },
  };
  const complete: ConnectAttempt = {
    ...connected,
    revision: 4,
    state: "complete",
    integrationInstalled: true,
  };
  // A server: the dialog's in-flight step is applied even though the closed
  // dialog never reads its answer; a stale revision is refused.
  let server = connected;
  let releaseFirst: () => void = () => {};
  const api = transport([connected]);
  api.get.mockImplementation(async () => server);
  api.advance.mockImplementation(async (_workspaceId, _id, input) => {
    if (input.expectedRevision !== server.revision) throw new Error("409 stale revision");
    if (input.action.type === "retry") {
      server = preview;
      if (input.expectedRevision === 2 && api.advance.mock.calls.length === 1)
        await new Promise<void>((resolve) => (releaseFirst = resolve));
      return server;
    }
    if (input.action.type === "install") {
      expect(input.action.operationIds).toEqual(["listSites"]);
      server = complete;
      return server;
    }
    throw new Error("unexpected step");
  });
  const onClose = mock(() => {});
  const onComplete = mock((_attempt: ConnectAttempt) => {});
  const request = {
    scope: { workspaceId: "workspace", transport: api },
    providerId: "microsoft-sharepoint",
    ownership: "personal" as const,
    returnUrl: "http://localhost/capabilities",
    idempotencyKey: "sharepoint",
    displayName: "SharePoint",
    installationTarget: { instanceKey: "account-sharepoint", displayName: "SharePoint" },
  };
  // Like every host: closing removes the dialog (and its controller).
  function Host() {
    const [open, setOpen] = useState(true);
    return open ? (
      <NativeConnectSetup
        transport={api}
        workspaceId="workspace"
        request={request}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        onComplete={onComplete}
      />
    ) : null;
  }
  const view = await renderComponent(<Host />);
  try {
    await flush(20);
    expect(document.body.textContent).toContain("Finishing setup");
    expect(api.advance).toHaveBeenCalledTimes(1);
    // The person presses X mid-finish.
    const close = Array.from(document.querySelectorAll("button")).find(
      (node) => node.textContent?.trim() === "Close",
    );
    expect(close).toBeDefined();
    close!.click();
    await flush(20);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Finishing setup");
    releaseFirst();
    for (let i = 0; i < 40 && onComplete.mock.calls.length === 0; i++) {
      await flush(5);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(api.cancel).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[0]).toMatchObject({
      state: "complete",
      integrationInstalled: true,
    });
    expect(server).toEqual(complete);
  } finally {
    await view.unmount();
  }
});
