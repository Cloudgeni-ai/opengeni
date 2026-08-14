import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";

import type { IntegrationDefinitionSummary } from "@/types";

const context: {
  client: OpenGeniCoreClient;
  accessContext: {
    subjectId: string;
    accountGrants: [];
    workspaceGrants: [];
  };
} = {
  client: {} as OpenGeniCoreClient,
  accessContext: {
    subjectId: "user:caller",
    accountGrants: [],
    workspaceGrants: [],
  },
};

mock.module("@/context", () => ({
  useAppContext: () => context,
}));

mock.module("@/components/capabilities/integration-control-center-view", () => ({
  IntegrationControlCenterView: ({
    workspaceId,
    definitions,
    loading,
  }: {
    workspaceId: string;
    definitions: IntegrationDefinitionSummary[];
    loading: boolean;
  }) => (
    <div data-workspace-id={workspaceId} data-loading={String(loading)}>
      {definitions.map((candidate) => candidate.name).join(",")}
    </div>
  ),
}));

const { IntegrationControlCenter } = await import("./integration-control-center");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

describe("Integration Control Center load ownership", () => {
  test("does not let a stale workspace response overwrite the current workspace", async () => {
    const definitionsA = deferred<{ definitions: IntegrationDefinitionSummary[] }>();
    const instancesA = deferred<{ integrations: [] }>();
    const definitionsB = deferred<{ definitions: IntegrationDefinitionSummary[] }>();
    const instancesB = deferred<{ integrations: [] }>();
    const listIntegrationDefinitionsA = mock(async () => await definitionsA.promise);
    const listApiIntegrationsA = mock(async () => await instancesA.promise);
    const listIntegrationDefinitionsB = mock(async () => await definitionsB.promise);
    const listApiIntegrationsB = mock(async () => await instancesB.promise);
    const clientA = {
      listIntegrationDefinitions: listIntegrationDefinitionsA,
      listApiIntegrations: listApiIntegrationsA,
    } as unknown as OpenGeniCoreClient;
    const clientB = {
      listIntegrationDefinitions: listIntegrationDefinitionsB,
      listApiIntegrations: listApiIntegrationsB,
    } as unknown as OpenGeniCoreClient;
    context.client = clientA;
    const rendered = await renderControlCenter({ workspaceId: "workspace-a" });
    try {
      await waitFor(
        () =>
          listIntegrationDefinitionsA.mock.calls.length === 1 &&
          listApiIntegrationsA.mock.calls.length === 1,
      );

      context.client = clientB;
      await rendered.rerender({ workspaceId: "workspace-b" });
      await waitFor(
        () =>
          listIntegrationDefinitionsB.mock.calls.length === 1 &&
          listApiIntegrationsB.mock.calls.length === 1,
      );

      await act(async () => {
        definitionsB.resolve({
          definitions: [integrationDefinition("definition-b", "Workspace B")],
        });
        instancesB.resolve({ integrations: [] });
        await Promise.resolve();
      });
      await waitFor(() => rendered.container.textContent === "Workspace B");

      await act(async () => {
        definitionsA.resolve({
          definitions: [integrationDefinition("definition-a", "Workspace A")],
        });
        instancesA.resolve({ integrations: [] });
        await Promise.resolve();
      });
      await act(async () => await Bun.sleep(0));

      const view = rendered.container.querySelector<HTMLElement>("[data-workspace-id]");
      expect(view?.dataset.workspaceId).toBe("workspace-b");
      expect(view?.dataset.loading).toBe("false");
      expect(rendered.container.textContent).toBe("Workspace B");
      expect(rendered.container.textContent).not.toContain("Workspace A");
    } finally {
      await rendered.unmount();
    }
  });
});

async function renderControlCenter(
  props: Partial<ComponentProps<typeof IntegrationControlCenter>> = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (
    nextProps: Partial<ComponentProps<typeof IntegrationControlCenter>> = props,
  ) => {
    await act(async () => {
      root.render(
        <IntegrationControlCenter
          workspaceId="workspace-a"
          connections={[]}
          canManage
          onChanged={() => undefined}
          {...nextProps}
        />,
      );
      await Promise.resolve();
    });
  };
  await render();
  return {
    container,
    rerender: render,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      document.body.replaceChildren();
    },
  };
}

function integrationDefinition(id: string, name: string): IntegrationDefinitionSummary {
  return {
    id,
    name,
    summary: `${name} integration`,
    protocol: "openapi",
    provider: { id: "google", domain: `${id}.example.com` },
    authentication: { kind: "oauth2", scopes: [] },
    facets: [],
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => await Bun.sleep(0));
  }
  throw new Error("Timed out waiting for Integration Control Center state");
}
