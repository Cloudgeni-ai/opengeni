import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OrganizationIntegrationsSection } from "./organization-integrations-section";

if (!globalThis.document) GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const identity = {
  principalGeneration: 1,
  subjectId: "actor",
  organizationId: "org",
  workspaceId: "workspace",
};
const catalog = {
  integrations: [
    { key: "slack", label: "Slack", kind: "curated" },
    { key: "custom:mcp", label: "Custom MCP", kind: "custom" },
    { key: "custom:openapi", label: "Custom OpenAPI", kind: "custom" },
    { key: "custom:graphql", label: "Custom GraphQL", kind: "custom" },
  ],
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});
async function mount(
  update: (body: unknown) => Promise<unknown> = async () => ({
    mode: "restricted",
    allowedIntegrationKeys: [],
    revision: 2,
  }),
  initialMode = "restricted",
) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const client = {
    requestJson: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return method === "PUT"
        ? update(body)
        : path.endsWith("catalog")
          ? catalog
          : { mode: initialMode, allowedIntegrationKeys: [], revision: 1 };
    },
  } as Parameters<typeof OrganizationIntegrationsSection>[0]["client"];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = async (overrides = {}) =>
    act(async () =>
      root.render(
        <StrictMode>
          <OrganizationIntegrationsSection
            client={client}
            identity={identity}
            actorRole="owner"
            managedSession
            {...overrides}
          />
        </StrictMode>,
      ),
    );
  await render();
  return { calls, render };
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find((node) => node.textContent === text)!;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}

test("explicit save, labeled custom choices, and deny-all are distinct from filtered-empty", async () => {
  const { calls } = await mount();
  expect(host.textContent).toContain("Saving will block all new integration connections");
  expect(host.textContent).toContain("Custom MCP");
  expect(host.textContent).toContain("Custom OpenAPI");
  expect(host.textContent).toContain("Custom GraphQL");
  const checkbox = host.querySelector("input[type=checkbox]") as HTMLInputElement;
  expect(checkbox.closest("label")?.textContent).toContain("Slack");
  await click(checkbox);
  expect(host.textContent).toContain("1 selected");
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  await click(button("Save changes"));
  expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({
    mode: "restricted",
    allowedIntegrationKeys: ["slack"],
    expectedRevision: 1,
  });
});

test("uncertain saves lock edits and retry the exact operation and request", async () => {
  let attempts = 0;
  const { calls } = await mount(async () => {
    if (++attempts === 1) throw new Error("offline");
    return { mode: "restricted", allowedIntegrationKeys: ["slack"], revision: 2 };
  });
  await click(host.querySelector("input[type=checkbox]")!);
  await click(button("Save changes"));
  expect(host.textContent).toContain("1 selected");
  expect((host.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
  await click(button("Retry same save"));
  const writes = calls.filter((call) => call.method === "PUT");
  expect(writes).toHaveLength(2);
  expect(writes[0]!.body).toBe(writes[1]!.body);
  expect(host.textContent).toContain("Integration settings saved.");
});

test("switching from unrestricted to no selections explicitly saves deny-all", async () => {
  const { calls } = await mount(undefined, "unrestricted");
  const select = host.querySelector("select")!;
  expect((host.querySelector("input[type=checkbox]") as HTMLInputElement).disabled).toBe(true);
  await act(async () => {
    select.value = "restricted";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).toContain("Saving will block all new integration connections");
  await click(button("Save changes"));
  expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({
    mode: "restricted",
    allowedIntegrationKeys: [],
    expectedRevision: 1,
  });
});

test("revision conflict preserves draft and requires explicit refresh", async () => {
  await mount(async () => {
    throw { status: 409 };
  });
  await click(host.querySelector("input[type=checkbox]")!);
  await click(button("Save changes"));
  expect(host.textContent).toContain("1 selected");
  expect(button("Save changes").disabled).toBe(true);
  await click(button("Discard draft and refresh"));
  expect(host.textContent).toContain("0 selected");
});

test("a definite permission refusal is not presented as an uncertain save", async () => {
  const { calls } = await mount(async () => {
    throw { status: 403 };
  });
  await click(host.querySelector("input[type=checkbox]")!);
  await click(button("Save changes"));
  expect(host.textContent).toContain("no longer have permission");
  expect(host.textContent).not.toContain("Retry same save");
  expect((host.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

test("actor change ignores late save callbacks and non-admin sessions cannot read", async () => {
  let resolve!: (value: unknown) => void;
  const { calls, render } = await mount(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await click(host.querySelector("input[type=checkbox]")!);
  await click(button("Save changes"));
  await render({ identity: { ...identity, subjectId: "other", principalGeneration: 2 } });
  await act(async () =>
    resolve({ mode: "restricted", allowedIntegrationKeys: ["slack"], revision: 2 }),
  );
  expect(host.textContent).toContain("0 selected");
  expect(host.textContent).not.toContain("Integration settings saved.");
  const count = calls.length;
  await render({ managedSession: false });
  expect(calls).toHaveLength(count);
  expect(host.querySelector("select")).toBeNull();
});

test("StrictMode replay cannot let a stale initial read overwrite the current draft", async () => {
  let resolveFirst!: (value: unknown) => void;
  let reads = 0;
  const client = {
    requestJson: async (_method: string, path: string) => {
      if (path.endsWith("catalog")) return catalog;
      if (++reads === 1)
        return new Promise<unknown>((resolve) => {
          resolveFirst = resolve;
        });
      return { mode: "restricted", allowedIntegrationKeys: [], revision: 2 };
    },
  } as Parameters<typeof OrganizationIntegrationsSection>[0]["client"];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <StrictMode>
        <OrganizationIntegrationsSection
          client={client}
          identity={identity}
          actorRole="admin"
          managedSession
        />
      </StrictMode>,
    ),
  );
  await click(host.querySelector("input[type=checkbox]")!);
  await act(async () =>
    resolveFirst({ mode: "unrestricted", allowedIntegrationKeys: [], revision: 1 }),
  );
  expect(host.textContent).toContain("1 selected");
  expect(host.textContent).toContain("Unsaved changes");
});
