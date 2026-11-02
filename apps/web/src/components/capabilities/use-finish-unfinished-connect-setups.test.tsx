import { afterEach, expect, mock, test } from "bun:test";
import type { ConnectAttempt } from "@opengeni/connect";

import { flush, registerDom, renderHook } from "../../../../../packages/react/test/render-hook";

const context: { client: unknown } = { client: {} };
const success = mock((_message: string) => {});
mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({ toast: { success, error: mock(() => {}) } }));

const { useFinishUnfinishedConnectSetups } = await import("./use-api-integration-accounts");

registerDom();
afterEach(() => document.body.replaceChildren());

const completed: ConnectAttempt = {
  id: "attempt",
  workspaceId: "workspace",
  providerId: "microsoft-sharepoint",
  ownership: "personal",
  revision: 3,
  state: "complete",
  credentialsCommitted: true,
  integrationInstalled: true,
  completionRequirement: "integration",
  nextAction: { type: "none" },
  installationTarget: { instanceKey: "account-1", displayName: "SharePoint" },
  expiresAt: "2030-01-01T00:00:00Z",
};

test("opening Capabilities finishes a setup left without its tools and says so", async () => {
  const finishUnfinished = mock(async (_workspaceId: string) => [completed]);
  context.client = { connectTransport: () => ({ finishUnfinished }) };
  const refresh = mock(async () => {});
  const onRuntimeChanged = mock(() => {});
  const hook = await renderHook(
    () => useFinishUnfinishedConnectSetups({ workspaceId: "workspace", refresh, onRuntimeChanged }),
    {},
  );
  await flush();
  expect(finishUnfinished).toHaveBeenCalledTimes(1);
  expect(finishUnfinished.mock.calls[0]![0]).toBe("workspace");
  expect(success).toHaveBeenCalledWith("SharePoint connected");
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(onRuntimeChanged).toHaveBeenCalledTimes(1);
  await hook.unmount();
});

test("nothing left to finish shows nothing", async () => {
  success.mockClear();
  const finishUnfinished = mock(async () => []);
  context.client = { connectTransport: () => ({ finishUnfinished }) };
  const refresh = mock(async () => {});
  const hook = await renderHook(
    () =>
      useFinishUnfinishedConnectSetups({
        workspaceId: "workspace",
        refresh,
        onRuntimeChanged: () => {},
      }),
    {},
  );
  await flush();
  expect(finishUnfinished).toHaveBeenCalledTimes(1);
  expect(success).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  await hook.unmount();
});
