import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { registerDom } from "../../../../../packages/react/test/render-hook";

registerDom();

const workspaceId = "workspace-example";
// A realistic long list: built-ins, catalog MCPs, an API integration known only
// by its catalog id and one only by its provider's domain.
const toolMcpServers = [
  { id: "files", name: "files" },
  { id: "docs", name: "docs" },
  { id: "cap-posthog", name: "PostHog" },
  { id: "api_openapi_gmail_one", name: "Gmail", capabilityId: "api:gmail" },
  { id: "api_openapi_grafana_prod", name: "Grafana Production", providerDomain: "grafana.com" },
  { id: "cap-linear", name: "Linear" },
  { id: "cap-slack", name: "Slack" },
];
const catalogItem = (id: string, extra: Record<string, unknown>) => ({
  id,
  kind: "mcp",
  name: id,
  enabled: true,
  runtime: { available: true, mcpServerId: null },
  ...extra,
});
const context = {
  client: { catalogAssetUrl: (path: string | null) => (path ? `/assets/${path}` : null) },
  clientConfig: {},
  accessContext: null,
  githubRepos: [] as unknown[],
  toolMcpServers,
  workspaceCapabilityCatalog: [
    catalogItem("mcp:posthog", {
      runtime: { available: true, mcpServerId: "cap-posthog" },
      logoAssetPath: "posthog.svg",
    }),
    catalogItem("api:gmail", { kind: "api", logoAssetPath: "gmail.svg" }),
    catalogItem("api:grafana", {
      kind: "api",
      providerDomain: "grafana.com",
      logoAssetPath: "grafana.svg",
    }),
    catalogItem("mcp:linear", {
      runtime: { available: true, mcpServerId: "cap-linear" },
      logoAssetPath: "linear.png",
    }),
  ],
};
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => context,
  useOptionalAppContext: () => context,
}));
mock.module("@opengeni/react/app/lib/use-workspace-rigs", () => ({
  useWorkspaceRigs: () => ({ rigs: [], loading: false }),
}));
// The tile's image never loads in happy-dom; record which logo it was given.
mock.module("@opengeni/react/app/components/capabilities/capability-logo", () => ({
  CapabilityLogo: ({ src }: { src: string | null }) => <i data-logo={src ?? ""} />,
}));
mock.module("@opengeni/react/app/components/pickers", () => ({ ModelPicker: () => null }));

const { ComposerField } = await import("./schedule-composer");
const { TooltipProvider } = await import("@opengeni/react/ui/tooltip");

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function render(mcpServerIds: string[], update = mock((_patch: unknown) => {})) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <TooltipProvider>
        <ComposerField
          workspaceId={workspaceId}
          draft={
            {
              prompt: "",
              resources: [],
              rigId: null,
              mcpServerIds,
              model: "example-model",
              modelFollowsDefault: true,
              reasoningEffort: "medium",
            } as never
          }
          update={update}
          modelRows={[]}
          defaultModelSelection={null}
          modelsLoading={false}
          modelsError={null}
          existingChat={false}
          inheritsChatSettings={false}
        />
      </TooltipProvider>,
    ),
  );
  return update;
}

/** Text without the logo tiles' monograms. */
function label(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const tile of copy.querySelectorAll('[data-slot="logo-tile"], [aria-hidden="true"]'))
    tile.remove();
  return copy.textContent ?? "";
}

const connectorsButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label^="Connectors:"]');

async function openConnectors() {
  await act(async () => {
    connectorsButton()!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  return document.querySelector('[role="menu"]')!;
}

test("enabled connectors collapse into one control instead of a pill each", async () => {
  const all = toolMcpServers.map((server) => server.id).concat("gone-server");
  await render(all);
  // No removable pill per connector, and no context row just for them.
  expect(document.querySelector('button[aria-label^="Remove "]')).toBeNull();
  expect(document.querySelector('[aria-label="What the runs work with"]')).toBeNull();
  const button = connectorsButton()!;
  expect(label(button)).toBe("Connectors8");
  expect(button.getAttribute("aria-label")).toBe(
    "Connectors: 8 on, Uploaded files, Knowledge library, PostHog, Gmail, Grafana Production, Linear, Slack, gone-server. Change",
  );
  // At most three logos, real ones first.
  const stack = [...button.querySelectorAll("[data-logo]")].map((tile) =>
    tile.getAttribute("data-logo"),
  );
  expect(stack).toEqual(["/assets/posthog.svg", "/assets/gmail.svg", "/assets/grafana.svg"]);
});

test("the menu lists every connected app with its real logo and turns them on and off", async () => {
  const update = await render(["cap-posthog", "gone-server"]);
  const menu = await openConnectors();
  const items = [...menu.querySelectorAll('[role="menuitemcheckbox"]')];
  expect(items.map((item) => [label(item), item.getAttribute("aria-checked")])).toEqual([
    ["Uploaded filesRead files uploaded to the workspace. Needs Workspace files on.", "false"],
    ["Knowledge librarySearch the workspace's documents. Needs Knowledge on.", "false"],
    ["PostHog", "true"],
    ["Gmail", "false"],
    ["Grafana Production", "false"],
    ["Linear", "false"],
    ["Slack", "false"],
    // A chosen app that is no longer connected stays visible, so it can be removed.
    ["gone-serverUnavailable", "true"],
  ]);
  const logo = (name: string) =>
    items
      .find((item) => label(item).startsWith(name))
      ?.querySelector("[data-logo]")
      ?.getAttribute("data-logo");
  expect(logo("Gmail")).toBe("/assets/gmail.svg");
  expect(logo("Grafana Production")).toBe("/assets/grafana.svg");
  expect(logo("Linear")).toBe("/assets/linear.png");

  await act(async () => (items[3] as HTMLElement).click());
  expect(update).toHaveBeenLastCalledWith({
    mcpServerIds: ["cap-posthog", "gone-server", "api_openapi_gmail_one"],
  });
  await act(async () => (items[7] as HTMLElement).click());
  expect(update).toHaveBeenLastCalledWith({ mcpServerIds: ["cap-posthog"] });
});

test("with nothing on, the control still opens the list", async () => {
  await render([]);
  expect(connectorsButton()!.getAttribute("aria-label")).toBe("Connectors: none on. Change");
  const menu = await openConnectors();
  expect(menu.querySelectorAll('[role="menuitemcheckbox"]').length).toBe(7);
});
