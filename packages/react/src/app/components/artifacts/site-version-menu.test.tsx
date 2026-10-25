import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type {
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactEvent,
  WorkspaceArtifactVersion,
} from "@opengeni/sdk";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const rollbacks: unknown[] = [];
const toasts: Array<[string, string]> = [];
let rollback: () => Promise<unknown> = async () => ({});
mock.module("../../app-context", () => ({
  useAppContext: () => ({
    client: {
      rollbackWorkspaceArtifact: async (...args: unknown[]) => {
        rollbacks.push(args);
        return await rollback();
      },
    },
    authSession: { user: { name: "Bendik" } },
  }),
}));
mock.module("../../lib/toast", () => ({
  toast: {
    success: (text: string) => toasts.push(["success", text]),
    error: (text: string) => toasts.push(["error", text]),
  },
}));
mock.module("../../lib/use-artifact-catalog", () => ({ invalidateArtifactCatalog: () => {} }));
mock.module("../../lib/navigation", () => ({
  Link: ({ children, ...props }: { children: ReactNode; search?: object; params?: object }) => (
    <a href={JSON.stringify({ params: props.params, search: props.search })}>{children}</a>
  ),
}));
mock.module("../../../ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    asChild,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    asChild?: boolean;
  }) =>
    asChild ? (
      children
    ) : (
      <button type="button" role="menuitem" disabled={disabled} onClick={onSelect}>
        {children}
      </button>
    ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DropdownMenuMeta: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuCheck: ({ checked }: { checked: boolean }) => (checked ? <span>✓</span> : null),
}));
mock.module("../../../ui/relative-time", () => ({ RelativeTime: () => <time /> }));

let module: typeof import("./site-version-menu");
let ownsDom = false;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  module = await import("./site-version-menu");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
});
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  rollbacks.length = 0;
  toasts.length = 0;
  rollback = async () => ({});
});

const version = (revision: number): WorkspaceArtifactVersion =>
  ({
    id: `version-${revision}`,
    revision,
    createdAt: `2026-10-23T12:0${revision}:00Z`,
  }) as WorkspaceArtifactVersion;
const event = (
  type: WorkspaceArtifactEvent["type"],
  from: number | null,
  to: number,
  minute: number,
): WorkspaceArtifactEvent =>
  ({
    id: `event-${type}-${to}-${minute}`,
    type,
    fromVersionId: from === null ? null : `version-${from}`,
    toVersionId: `version-${to}`,
    createdAt: `2026-10-23T12:${String(minute).padStart(2, "0")}:00Z`,
  }) as WorkspaceArtifactEvent;
const site = (
  live: number,
  revisions: number[],
  events: WorkspaceArtifactEvent[] = [],
  status: "active" | "archived" = "active",
) =>
  ({
    artifact: { id: "site", title: "Usage", status, currentVersion: version(live) },
    versions: revisions.map(version),
    events,
  }) as unknown as WorkspaceArtifactDetailResponse;

test("Undo goes back to the version live before the last publish", () => {
  expect(module.siteUndoTarget(site(5, [5, 4, 3], [event("published", 4, 5, 10)]))?.id).toBe(
    "version-4",
  );
  // Without history of the change, the revision before.
  expect(module.siteUndoTarget(site(5, [5, 4, 3]))?.id).toBe("version-4");
  // A first version has nothing to go back to.
  expect(module.siteUndoTarget(site(1, [1], [event("published", null, 1, 1)]))).toBeNull();
});

test("Undo after an Undo goes forward again: a restore is a change like a publish", () => {
  const restored = site(
    4,
    [5, 4, 3],
    [event("published", 4, 5, 10), event("rolled_back", 5, 4, 11)],
  );
  expect(module.siteUndoTarget(restored)?.id).toBe("version-5");
  // The newest change to the live version counts, not an older one.
  const again = site(
    4,
    [5, 4, 3],
    [event("published", 3, 4, 5), event("published", 4, 5, 10), event("rolled_back", 5, 4, 11)],
  );
  expect(module.siteUndoTarget(again)?.id).toBe("version-5");
});

async function render(detail: WorkspaceArtifactDetailResponse, canPublish = true) {
  const onRestored = mock(() => {});
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <module.SiteVersionMenu
        workspaceId="space"
        siteId="site"
        detail={detail}
        canPublish={canPublish}
        onRestored={onRestored}
      />,
    ),
  );
  return { container, onRestored };
}
const item = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find((element) =>
    element.textContent?.includes(text),
  );

test("the chip names the live version and Undo restores the one before in one click", async () => {
  const { container, onRestored } = await render(
    site(5, [3, 4, 5], [event("published", 4, 5, 10)]),
  );
  const chip = container.querySelector("[data-site-version-chip]")!;
  expect(chip.textContent).toBe("v5");
  // Its accessible name starts with what it shows, for voice control.
  expect(chip.getAttribute("aria-label")).toBe("v5, version history and undo");
  // Newest first, the live one checked and not restorable.
  const rows = [...container.querySelectorAll("[role='menuitem']")].map((row) => row.textContent);
  expect(rows).toEqual(["Undo last changev4", "Version 5✓", "Version 4", "Version 3"]);
  expect(item(container, "Version 5")!.disabled).toBe(true);
  await act(async () => item(container, "Undo last change")!.click());
  expect(rollbacks).toHaveLength(1);
  const [workspaceId, siteId, request] = rollbacks[0] as [string, string, Record<string, string>];
  expect([workspaceId, siteId]).toEqual(["space", "site"]);
  expect(request).toMatchObject({
    versionId: "version-4",
    // Refused if someone else published meanwhile.
    expectedCurrentVersionId: "version-5",
    reason: "Undone from the Site view by Bendik",
  });
  expect(request.idempotencyKey).toBeString();
  expect(toasts).toEqual([["success", "Version 4 is live again"]]);
  // The view reads the Site again, which reloads the preview.
  expect(onRestored).toHaveBeenCalledTimes(1);
});

test("after an Undo, the menu offers to undo the restore, which goes forward again", async () => {
  const { container } = await render(
    site(4, [3, 4, 5], [event("published", 4, 5, 10), event("rolled_back", 5, 4, 11)]),
  );
  expect(item(container, "Undo last change")).toBeUndefined();
  expect(item(container, "Undo restore")!.textContent).toBe("Undo restorev5");
  await act(async () => item(container, "Undo restore")!.click());
  expect((rollbacks[0] as [string, string, object])[2]).toMatchObject({
    versionId: "version-5",
    expectedCurrentVersionId: "version-4",
  });
});

test("restoring any listed version goes through the same rollback", async () => {
  const { container } = await render(site(5, [3, 4, 5]));
  await act(async () => item(container, "Version 3")!.click());
  expect((rollbacks[0] as [string, string, object])[2]).toMatchObject({
    versionId: "version-3",
    reason: "Restored from the Site view by Bendik",
  });
});

test("when the Site changed meanwhile, it says so and shows the latest", async () => {
  rollback = async () => {
    throw new OpenGeniApiError(409, "conflict");
  };
  const { container, onRestored } = await render(site(5, [4, 5]));
  await act(async () => item(container, "Undo last change")!.click());
  expect(toasts).toEqual([["error", "The Site changed meanwhile"]]);
  expect(onRestored).toHaveBeenCalledTimes(1);
});

test("people who can't publish, and archived Sites, see the history without Undo or Restore", async () => {
  for (const [detail, canPublish] of [
    [site(5, [4, 5]), false],
    [site(5, [4, 5], [], "archived"), true],
  ] as const) {
    const { container } = await render(detail, canPublish);
    expect(item(container, "Undo last change")).toBeUndefined();
    expect(item(container, "Version 4")!.disabled).toBe(true);
    expect(container.querySelector("[data-site-version-chip]")!.getAttribute("aria-label")).toBe(
      "v5, version history",
    );
    expect(container.textContent).toContain("All versions");
    act(() => root?.unmount());
    root = null;
  }
  expect(rollbacks).toEqual([]);
});
