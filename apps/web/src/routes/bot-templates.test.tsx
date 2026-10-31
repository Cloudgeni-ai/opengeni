import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as RouterPackage from "@tanstack/react-router";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

const navigate = mock((_options: unknown) => Promise.resolve());
const context: { current: Record<string, unknown> } = { current: {} };
let useInSlack: ((template: { id: string }) => void) | undefined;

mock.module("@tanstack/react-router", () => ({ ...RouterPackage, useNavigate: () => navigate }));
mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => context.current }));
mock.module("@opengeni/react/app/components/bots/bot-templates-page", () => ({
  BotTemplatesPage: (props: { onUseInSlack?: (template: { id: string }) => void }) => {
    useInSlack = props.onUseInSlack;
    return null;
  },
}));

const { BotTemplatesRoute } = await import("./bot-templates");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function renderAs(permissions: string[], kind: "shared" | "personal" = "shared") {
  context.current = {
    workspaces: [{ id: WORKSPACE_ID, accountId: ACCOUNT_ID, kind, name: "Platform" }],
    managedSelfContext: null,
    accessContext: {
      mode: "managed",
      subjectId: "subject-a",
      accountGrants: [],
      workspaceGrants: [
        { workspaceId: WORKSPACE_ID, accountId: ACCOUNT_ID, subjectId: "subject-a", permissions },
      ],
      defaultAccountId: ACCOUNT_ID,
      defaultWorkspaceId: WORKSPACE_ID,
    },
  };
  useInSlack = undefined;
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<BotTemplatesRoute workspaceId={WORKSPACE_ID} />));
  await act(async () => root.unmount());
}

test("workspace admins can start a Slack agent from a template", async () => {
  await renderAs(["workspace:admin"]);
  expect(useInSlack).toBeFunction();
  useInSlack!({ id: "template-1" });
  expect(navigate).toHaveBeenCalledWith({
    href: `/workspaces/${WORKSPACE_ID}/plugins?open=integration%3Aslack&slackAgentTemplate=template-1`,
  });
});

test("members and Personal workspaces don't see Use in Slack", async () => {
  await renderAs(["sessions:create"]);
  expect(useInSlack).toBeUndefined();
  await renderAs(["workspace:admin"], "personal");
  expect(useInSlack).toBeUndefined();
});
