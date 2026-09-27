import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act } from "react";
import { createRoot } from "react-dom/client";

mock.module("sonner", () => ({
  toast: { success: mock(() => undefined), error: mock(() => undefined) },
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { ConnectionAccessFormPage, ConnectionAccessRows, useConnectionAccess } =
  await import("./connection-access-settings");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

for (const kind of ["codex", "supergrok", "vercel_gateway", "openrouter"] as const) {
  test(`${kind} saves individual workspace and model choices on the connection`, async () => {
    let policy = {
      allowedModels: null as string[] | null,
      allowedWorkspaces: null as string[] | null,
      allowPersonalWorkspaces: true,
      version: 1,
    };
    const writes: unknown[] = [];
    const client = Object.assign(new OpenGeniBrowserClient({ baseUrl: "http://localhost" }), {
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
    });
    let closed = 0;
    function Page({ editing }: { editing: boolean }) {
      const access = useConnectionAccess({
        client,
        organizationId: "org",
        kind,
        connectionId: "account",
      });
      return editing ? (
        <ConnectionAccessFormPage
          access={access}
          organization
          canManage
          name="Team plan"
          onClose={() => {
            closed += 1;
          }}
        />
      ) : (
        <ConnectionAccessRows access={access} organization canManage onEdit={() => undefined} />
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const choose = async (text: string) =>
      act(async () => {
        const radio = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
          (candidate) => candidate.textContent?.includes(text),
        );
        const label = [...container.querySelectorAll("label")].find(
          (candidate) => candidate.textContent === text,
        );
        const target =
          radio ?? (label ? (document.getElementById(label.htmlFor) ?? undefined) : undefined);
        expect(target).toBeDefined();
        target!.click();
      });
    try {
      await act(async () => root.render(<Page editing={false} />));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(container.textContent).toContain("All shared workspaces");
      expect(container.textContent).toContain("All models, including new ones");
      if (kind === "codex" || kind === "supergrok")
        expect(container.textContent).toContain("+ Personal");

      await act(async () => root.render(<Page editing />));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(container.textContent).not.toContain("Engineering");
      await choose("Only the workspaces I choose");
      expect(container.textContent).toContain("Finance");
      await choose("Finance");
      const modelsOnly = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].filter(
        (radio) => radio.textContent?.includes("Only the models I choose"),
      );
      await act(async () => modelsOnly[0]!.click());
      await choose("Model B");
      const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Save",
      )!;
      await act(async () => save.closest("form")!.requestSubmit());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(writes).toEqual([
        {
          allowedModels: ["model-a"],
          allowedWorkspaces: ["workspace-a"],
          allowPersonalWorkspaces: true,
          version: 1,
        },
      ]);
      expect(closed).toBe(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}
