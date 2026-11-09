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
  // Its own logo wins over the catalog's.
  { id: "cap-own", name: "Own", logoSrc: "/own.svg" },
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
    catalogItem("mcp:own", {
      runtime: { available: true, mcpServerId: "cap-own" },
      logoAssetPath: "catalog-own.svg",
    }),
    // Chosen earlier, no longer a connected app, still in the catalog.
    catalogItem("mcp:retired", {
      name: "Retired",
      enabled: false,
      runtime: { available: false, mcpServerId: "cap-retired" },
      logoAssetPath: "retired.svg",
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

async function render(
  mcpServerIds: string[],
  update = mock((_patch: unknown) => {}),
  options: { disabled?: boolean; existingChat?: boolean; inheritsChatSettings?: boolean } = {},
) {
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
          disabled={options.disabled}
          existingChat={options.existingChat ?? false}
          inheritsChatSettings={options.inheritsChatSettings ?? false}
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
  expect(label(button)).toBe("Connectors9");
  // A chosen app that is no longer connected is flagged on the control itself.
  expect(button.getAttribute("aria-label")).toBe("Connectors: 9 on, 1 unavailable. Change");
  // At most three logos, real ones first.
  const stack = [...button.querySelectorAll("[data-logo]")].map((tile) =>
    tile.getAttribute("data-logo"),
  );
  expect(stack).toEqual(["/assets/posthog.svg", "/assets/gmail.svg", "/assets/grafana.svg"]);
});

test("the menu lists every connected app with its real logo and turns them on and off", async () => {
  const update = await render(["cap-posthog", "cap-retired", "gone-server"]);
  expect(connectorsButton()!.getAttribute("aria-label")).toBe(
    "Connectors: 3 on, 2 unavailable. Change",
  );
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
    ["Own", "false"],
    // Chosen apps that are no longer connected stay visible, by their catalog
    // name where the catalog still knows them, so they can be removed.
    ["RetiredUnavailable", "true"],
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
  expect(logo("Own")).toBe("/own.svg");
  expect(logo("Retired")).toBe("/assets/retired.svg");
  expect(logo("gone-server")).toBe("");

  await act(async () => (items[3] as HTMLElement).click());
  expect(update).toHaveBeenLastCalledWith({
    mcpServerIds: ["cap-posthog", "cap-retired", "gone-server", "api_openapi_gmail_one"],
  });
  await act(async () => (items[9] as HTMLElement).click());
  expect(update).toHaveBeenLastCalledWith({ mcpServerIds: ["cap-posthog", "cap-retired"] });
});

test("with nothing on, the control still opens the list", async () => {
  await render([]);
  expect(connectorsButton()!.getAttribute("aria-label")).toBe("Connectors: none on. Change");
  const menu = await openConnectors();
  expect(menu.querySelectorAll('[role="menuitemcheckbox"]').length).toBe(8);
});

test("disabled, existing-chat and chat-settings forms keep their rules", async () => {
  await render(["cap-posthog"], undefined, { disabled: true });
  expect(connectorsButton()!.disabled).toBe(true);
  await act(async () => root?.unmount());

  // Posting into an existing chat: no context row, connectors still chosen here.
  await render(["cap-posthog"], undefined, { existingChat: true });
  expect(document.querySelector('[aria-label="What the runs work with"]')).toBeNull();
  expect(connectorsButton()).not.toBeNull();
  await act(async () => root?.unmount());

  // A reusable chat owns its tools: no Connectors control at all.
  await render(["cap-posthog"], undefined, { inheritsChatSettings: true });
  expect(connectorsButton()).toBeNull();
  expect(document.body.textContent).toContain("Uses this chat's model, tools and machine.");
});
