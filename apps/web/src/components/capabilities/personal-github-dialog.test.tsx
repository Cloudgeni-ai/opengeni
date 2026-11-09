import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { PersonalGitHubRepositoryCatalogItem } from "@opengeni/sdk";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

mock.module("@opengeni/react/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-dialog>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const { PersonalGitHubDialog } = await import("./personal-github-dialog");

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

function repository(
  repositoryId: string,
  fullName: string,
  overrides: Partial<PersonalGitHubRepositoryCatalogItem> = {},
): PersonalGitHubRepositoryCatalogItem {
  return {
    repositoryId,
    fullName,
    canonicalUrl: `https://github.com/${fullName}`,
    defaultBranch: "main",
    visibility: "private",
    private: true,
    archived: false,
    disabled: false,
    permissions: { pull: true, push: false, admin: false, maintain: false, triage: false },
    selectedAccess: null,
    ...overrides,
  };
}

describe("PersonalGitHubDialog", () => {
  test("keeps repository choice compact and never offers stale write authority", async () => {
    const maintainable = repository("101", "octocat/maintained", {
      permissions: { pull: true, push: false, admin: false, maintain: true, triage: false },
    });
    const nowReadOnly = repository("102", "octocat/read-only", { selectedAccess: "write" });
    const onSave = mock(async () => true);
    const onOpenChange = mock((_open: boolean) => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <PersonalGitHubDialog
            open
            onOpenChange={onOpenChange}
            login="octocat"
            repositories={[maintainable, nowReadOnly]}
            busy={false}
            onSave={onSave}
            onReconnect={() => undefined}
            onDisconnect={() => undefined}
          />,
        );
      });
      const allow = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Allow octocat/maintained"]',
      );
      await act(async () => allow?.click());
      const save = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save repositories",
      );
      await act(async () => save?.click());
      expect(onSave).toHaveBeenCalledWith(
        [
          { repositoryId: "101", fullName: "octocat/maintained", access: "write" },
          { repositoryId: "102", fullName: "octocat/read-only", access: "read" },
        ],
        null,
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  test("All my repositories keeps the per-repository choice for later", async () => {
    const saved = {
      ...repository("102", "octocat/kept"),
      selectedAccess: "read" as const,
      selectionGeneration: 3,
      selectedAt: "2026-11-01T00:00:00.000Z",
      lastVerifiedAt: "2026-11-01T00:00:00.000Z",
    };
    // In All my repositories the catalog marks every repository usable.
    const listed = repository("101", "octocat/other", { selectedAccess: "read" });
    const onSave = mock(async () => true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const select = (label: string) =>
      container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    const change = async (element: HTMLSelectElement, value: string) =>
      await act(async () => {
        element.value = value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
    try {
      await act(async () => {
        root.render(
          <PersonalGitHubDialog
            open
            onOpenChange={() => undefined}
            login="octocat"
            repositories={[listed]}
            savedRepositories={[saved]}
            allRepositoriesAccess="write"
            allRepositoriesAvailable
            busy={false}
            onSave={onSave}
            onReconnect={() => undefined}
            onDisconnect={() => undefined}
          />,
        );
      });
      expect(select("Repositories Opengeni may use").value).toBe("all");
      expect(select("Access to all repositories").value).toBe("write");
      expect(container.querySelector('input[aria-label="Find a GitHub repository"]')).toBeNull();
      await change(select("Access to all repositories"), "read");
      const save = () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "Save repositories")!
          .click();
      await act(async () => save());
      expect(onSave).toHaveBeenLastCalledWith(
        [{ repositoryId: "102", fullName: "octocat/kept", access: "read" }],
        "read",
      );
      // Back to chosen repositories: the saved choice is still there.
      await change(select("Repositories Opengeni may use"), "chosen");
      expect(
        container
          .querySelector('button[aria-label="Remove octocat/kept"]')
          ?.getAttribute("aria-pressed"),
      ).toBe("true");
      await act(async () => save());
      expect(onSave).toHaveBeenLastCalledWith(
        [{ repositoryId: "102", fullName: "octocat/kept", access: "read" }],
        null,
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("offers All my repositories only where the deployment allows it", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = async (allRepositoriesAvailable: boolean) =>
      await act(async () => {
        root.render(
          <PersonalGitHubDialog
            open
            onOpenChange={() => undefined}
            login="octocat"
            repositories={[repository("101", "octocat/one")]}
            allRepositoriesAvailable={allRepositoriesAvailable}
            busy={false}
            onSave={async () => true}
            onReconnect={() => undefined}
            onDisconnect={() => undefined}
          />,
        );
      });
    const modeSelect = () =>
      container.querySelector('select[aria-label="Repositories Opengeni may use"]');
    try {
      await render(false);
      expect(modeSelect()).toBeNull();
      expect(container.querySelector('button[aria-label="Allow octocat/one"]')).not.toBeNull();
      await render(true);
      expect(modeSelect()).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("searches GitHub past the loaded list", async () => {
    const onSearch = mock(async (_query: string) => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <PersonalGitHubDialog
            open
            onOpenChange={() => undefined}
            login="octocat"
            repositories={[]}
            busy={false}
            onSave={async () => true}
            onSearch={onSearch}
            onReconnect={() => undefined}
            onDisconnect={() => undefined}
          />,
        );
      });
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Find a GitHub repository"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(
          input,
          "acme/wid",
        );
        const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
        const onChange = reactPropsKey
          ? (
              input as unknown as Record<
                string,
                { onChange?: (event: { target: HTMLInputElement }) => void }
              >
            )[reactPropsKey]?.onChange
          : undefined;
        if (onChange) onChange({ target: input });
        else input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 350)));
      expect(onSearch).toHaveBeenCalledWith("acme/wid");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("names the identity and says when repositories are still loading", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const dialog = (loading: boolean) => (
      <PersonalGitHubDialog
        open
        onOpenChange={() => undefined}
        login="octocat"
        repositories={[]}
        loading={loading}
        busy={false}
        onSave={async () => true}
        onReconnect={() => undefined}
        onDisconnect={() => undefined}
      />
    );
    try {
      await act(async () => root.render(dialog(true)));
      expect(container.querySelector("h2")?.textContent).toBe("Your GitHub");
      expect(container.textContent).toContain("Choose the repos Opengeni may use as you.");
      expect(container.textContent).toContain("Loading repositories…");
      await act(async () => root.render(dialog(false)));
      expect(container.textContent).toContain("No repositories found.");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
