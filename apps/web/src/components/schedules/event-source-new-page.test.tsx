import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

GlobalRegistrator.register({ url: "https://example.test" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const WORKSPACE_ID = "workspace-1";
let githubStatus = "unbound";
const navigated: string[] = [];
const created: unknown[] = [];
const context = {
  accessContext: { subjectId: "user-1" },
  clientConfig: { mcpServers: [] },
  workspaceCapabilityCatalog: [],
  client: {
    getGitHubApp: async () => ({ status: githubStatus }),
    createEventSource: async (_workspace: string, request: unknown) => {
      created.push(request);
      return { source: { id: "source-1", name: "GitHub", awaitingSigningSecret: false } };
    },
  },
};
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => context,
  useOptionalAppContext: () => context,
}));
mock.module("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
  useNavigate: () => (options: { href?: string }) => {
    navigated.push(options.href ?? "");
  },
  useRouter: () => ({}),
}));
mock.module("./schedule-parts", () => ({
  inAppClick: () => () => undefined,
  newEventSourcePath: (_workspace: string, kind?: string) => `/sources/new?kind=${kind ?? ""}`,
  useScheduleAccess: () => ({ canManage: true }),
  useScheduleNavigation: () => ({
    newSource: () => undefined,
    sources: () => undefined,
    source: () => undefined,
  }),
}));
mock.module("./use-event-sources", () => ({
  useEventTriggersEnabled: () => true,
  useEventSourceLogo: () => () => null,
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EventSourceNewPage } = await import("./event-source-new-page");

afterAll(() => GlobalRegistrator.unregister());

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  navigated.length = 0;
  created.length = 0;
});

async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderGitHub() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<EventSourceNewPage workspaceId={WORKSPACE_ID} kind="github" />);
    await flush();
  });
  return container;
}

const buttons = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].map((button) => button.textContent?.trim());

test("without GitHub connected, Connect GitHub is the page's one action", async () => {
  githubStatus = "unbound";
  const container = await renderGitHub();
  expect(container.textContent).toContain("GitHub isn't connected to this workspace yet.");
  expect(buttons(container).filter((label) => label === "Connect GitHub")).toHaveLength(1);
  expect(buttons(container)).not.toContain("Add GitHub");
  const connect = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Connect GitHub",
  )!;
  await act(async () => {
    connect.click();
    await flush();
  });
  expect(navigated).toEqual([`/workspaces/${WORKSPACE_ID}/plugins?open=integration:github`]);
  expect(created).toEqual([]);
});

test("with GitHub connected, the page adds the source", async () => {
  githubStatus = "bound";
  const container = await renderGitHub();
  expect(container.textContent).not.toContain("GitHub isn't connected");
  expect(buttons(container)).toContain("Add GitHub");
  expect(buttons(container)).not.toContain("Connect GitHub");
});
