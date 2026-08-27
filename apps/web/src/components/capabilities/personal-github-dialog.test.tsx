import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { PersonalGitHubRepositoryCatalogItem } from "@opengeni/sdk";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

mock.module("@/components/ui/dialog", () => ({
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
      expect(onSave).toHaveBeenCalledWith([
        { repositoryId: "101", fullName: "octocat/maintained", access: "write" },
        { repositoryId: "102", fullName: "octocat/read-only", access: "read" },
      ]);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
