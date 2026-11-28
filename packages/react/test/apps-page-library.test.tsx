import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ArtifactLibrary } = await import("../src/app/components/artifacts/artifact-library");
const { WORKSPACE_ID, appContext, fakeAgentsClient, AgentsTestHost } =
  await import("./agents-test-kit");

afterAll(() => GlobalRegistrator.unregister());

let mounted: { root: Root; container: HTMLElement } | null = null;
afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  await act(async () => current.root.unmount());
  current.container.remove();
  mounted = null;
});

async function render(loading: boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () =>
    root.render(
      <AgentsTestHost context={appContext(fakeAgentsClient([]))}>
        <ArtifactLibrary
          workspaceId={WORKSPACE_ID}
          items={[]}
          filters={{ q: "", kind: "site", status: "active", sort: "updated" } as never}
          onFiltersChange={() => undefined}
          loading={loading}
          onRetry={() => undefined}
          empty={{ title: "No apps yet", description: "Ask an agent to make one." }}
          lead={<div data-lead="">Ready-made</div>}
          listTitle="Your apps"
        />
      </AgentsTestHost>,
    ),
  );
  return container;
}

test("the Apps page's library puts Ready-made under its search bar, then Your apps", async () => {
  const container = await render(true);
  const search = container.querySelector("input[aria-label='Search artifacts by title']")!;
  const lead = container.querySelector("[data-lead]")!;
  expect(search.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const text = container.textContent ?? "";
  expect(text.indexOf("Ready-made")).toBeLessThan(text.indexOf("Your apps"));
});

test("with no apps yet, Your apps says so under Ready-made", async () => {
  const container = await render(false);
  const text = container.textContent ?? "";
  expect(text.indexOf("Ready-made")).toBeLessThan(text.indexOf("Your apps"));
  expect(text.indexOf("Your apps")).toBeLessThan(text.indexOf("No apps yet"));
});
