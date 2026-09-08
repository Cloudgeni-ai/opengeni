import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionAccessSettings } from "./connection-access-settings";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

for (const kind of ["codex", "supergrok", "vercel_gateway", "openrouter"] as const) {
  test(`${kind} saves individual workspace and model choices on the connection`, async () => {
    let policy = {
      allowedModels: null as string[] | null,
      allowedWorkspaces: null as string[] | null,
      allowPersonalWorkspaces: true,
      version: 1,
    };
    const writes: unknown[] = [];
    const client = {
      requestJson: async (method: string, path: string, body: typeof policy) => {
        expect(path).toBe(`/v1/organizations/org/model-connections/${kind}/account/access`);
        if (method === "PUT") {
          writes.push(body);
          policy = { ...body, version: 2 };
          return policy;
        }
        return {
          policy,
          models: [
            { id: "model-a", label: "Model A" },
            { id: "model-b", label: "Model B" },
          ],
          workspaces: [
            { id: "workspace-a", name: "Engineering" },
            { id: "workspace-b", name: "Finance" },
          ],
          personalWorkspacesSupported: kind === "codex" || kind === "supergrok",
        };
      },
    } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const clickLabel = async (text: string) =>
      act(async () => {
        const label = [...container.querySelectorAll("label")].find(
          (candidate) => candidate.textContent === text,
        );
        expect(label).toBeDefined();
        label!.querySelector<HTMLInputElement>("input")!.click();
      });
    try {
      await act(async () =>
        root.render(
          <ConnectionAccessSettings
            client={client}
            organizationId="org"
            kind={kind}
            connectionId="account"
            canManage
          />,
        ),
      );
      expect(container.textContent).not.toContain("Engineering");
      await act(async () => {
        container.querySelector<HTMLButtonElement>("button")!.click();
      });
      await clickLabel("All shared workspaces, including new ones");
      await clickLabel("Finance");
      await clickLabel("All supported models, including new ones");
      await clickLabel("Model B");
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Save access")!
          .click(),
      );
      expect(writes).toEqual([
        {
          allowedModels: ["model-a"],
          allowedWorkspaces: ["workspace-a"],
          allowPersonalWorkspaces: true,
          version: 1,
        },
      ]);
      expect(container.textContent).toContain("1 models enabled");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}
