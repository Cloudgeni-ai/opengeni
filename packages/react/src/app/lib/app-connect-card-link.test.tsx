import { expect, mock, test } from "bun:test";
import type { ToolGatewaySiteSetupItem } from "@opengeni/sdk";
import { flush, registerDom, renderComponent } from "../../../test/render-hook";

registerDom();

const item: ToolGatewaySiteSetupItem = {
  key: "connect:0123456789abcdef01234567",
  action: "connect",
  connector: "Gmail",
  capabilityId: "capability-gmail",
  connectionId: null,
  account: null,
  shared: false,
  tools: [{ serverId: "gmail", toolName: "send_message" }],
  openUrl: null,
};
const opened: string[] = [];
const consentHost = {
  connectForToolCall: async (input: { connect: { capabilityId: string } }) => {
    opened.push(input.connect.capabilityId);
    return true;
  },
  recoverToolCall: async () => true,
};
let consent: typeof consentHost | null = null;

mock.module("./app-api", () => ({
  useAppApi: () => ({ request: async () => ({ version: 1, items: [item] }) }),
}));
mock.module("./site-tool-consent", () => ({ useSiteToolConsentHost: () => consent }));
mock.module("./console-site", () => ({
  notifySiteToolReadinessChanged: () => {},
  subscribeSiteToolReadiness: () => () => {},
  subscribeSiteConnectCardShow: () => () => {},
}));
const { AppConnectCard } = await import("./app-connect-card");

test("a published App's ?connect= waits for the console's dialogs, then opens once", async () => {
  opened.length = 0;
  consent = null;
  let handled = 0;
  const card = (key: string) => (
    <AppConnectCard
      workspaceId="workspace"
      siteId="site-wait"
      versionId="version-1"
      connectKey={key}
      onConnectKeyHandled={() => void handled++}
    />
  );
  const view = await renderComponent(card(item.key));
  await flush(10);
  // The list is loaded but nothing can open a dialog yet: the link waits.
  expect(opened).toEqual([]);
  expect(handled).toBe(0);
  consent = consentHost;
  await view.rerender(card(item.key));
  await flush(10);
  expect(opened).toEqual(["capability-gmail"]);
  expect(handled).toBe(1);
  // Once handled, later renders don't open it again.
  await view.rerender(card(item.key));
  await flush(10);
  expect(opened).toEqual(["capability-gmail"]);
  await view.unmount();
});

test("a ?connect= key the card doesn't list is dropped without opening anything", async () => {
  opened.length = 0;
  consent = consentHost;
  let handled = 0;
  const view = await renderComponent(
    <AppConnectCard
      workspaceId="workspace"
      siteId="site-unknown"
      versionId="version-1"
      connectKey="connect:ffffffffffffffffffffffff"
      onConnectKeyHandled={() => void handled++}
    />,
  );
  await flush(10);
  expect(opened).toEqual([]);
  expect(handled).toBe(1);
  await view.unmount();
});
