import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OrganizationComputeReach } from "@opengeni/sdk";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import * as FormDialogModule from "@opengeni/react/ui/form-dialog";

// Keep the test independent of Radix portal mounting: the same form frame,
// rendered in place while open.
mock.module("@opengeni/react/ui/form-dialog", () => ({
  ...FormDialogModule,
  FormDialog: ({
    open,
    onOpenChange,
    size: _size,
    ...frame
  }: Parameters<typeof FormDialogModule.FormDialog>[0]) =>
    open ? (
      <FormDialogModule.FormFrame
        variant="dialog"
        {...frame}
        onSubmitted={() => onOpenChange(false)}
      />
    ) : null,
}));

const { OrganizationComputeReachDialog, organizationComputeReachSummary, reachNarrows } =
  await import("./organization-compute-reach-dialog");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const HOME = "11111111-1111-4111-8111-111111111111";
const DESIGN = "22222222-2222-4222-8222-222222222222";
const OPS = "33333333-3333-4333-8333-333333333333";

function reach(
  allowedWorkspaceIds: string[] | null,
  allowPersonalWorkspaces: boolean,
  allowManagedWorkspaces?: boolean,
): OrganizationComputeReach {
  return {
    homeWorkspaceId: HOME,
    allowedWorkspaceIds,
    allowPersonalWorkspaces,
    ...(allowManagedWorkspaces === undefined ? {} : { allowManagedWorkspaces }),
  };
}

const client = {
  getOrganizationAdministrationOverview: async () => ({
    workspaces: [
      { id: HOME, name: "Home" },
      { id: DESIGN, name: "Design" },
      { id: OPS, name: "Ops" },
    ],
  }),
} as never;

async function render(node: ReactNode): Promise<{ root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return { root };
}

async function submit() {
  await act(async () => {
    document.querySelector("form")!.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("where an organization machine or rig works", () => {
  test("the row value counts the workspace it lives in", () => {
    expect(organizationComputeReachSummary(reach(null, true))).toBe("All workspaces + Personal");
    expect(organizationComputeReachSummary(reach([], false))).toBe("1 workspace");
    expect(organizationComputeReachSummary(reach([DESIGN, HOME], false))).toBe("2 workspaces");
    expect(organizationComputeReachSummary(reach([], false, true))).toBe(
      "1 workspace + Product-managed",
    );
    expect(organizationComputeReachSummary(reach(null, false, true))).toBe("All workspaces");
  });

  test("narrowing is anything that takes it away from somewhere it works now", () => {
    expect(reachNarrows(reach(null, true), { workspaceIds: null, personalWorkspaces: true })).toBe(
      false,
    );
    expect(
      reachNarrows(reach(null, true), { workspaceIds: [DESIGN], personalWorkspaces: true }),
    ).toBe(true);
    expect(reachNarrows(reach(null, true), { workspaceIds: null, personalWorkspaces: false })).toBe(
      true,
    );
    expect(
      reachNarrows(reach([DESIGN], false), {
        workspaceIds: [DESIGN, OPS],
        personalWorkspaces: true,
      }),
    ).toBe(false);
    expect(
      reachNarrows(reach([DESIGN], false), { workspaceIds: [HOME], personalWorkspaces: false }),
    ).toBe(true);
    const managed = reach([], false, true);
    expect(reachNarrows(managed, { workspaceIds: [], personalWorkspaces: false })).toBe(false);
    expect(reachNarrows(managed, { workspaceIds: [], personalWorkspaces: false }, false)).toBe(
      true,
    );
    expect(reachNarrows(managed, { workspaceIds: null, personalWorkspaces: false }, false)).toBe(
      false,
    );
  });

  test("its home stays ticked, and saving sends the picked shared workspaces", async () => {
    const save = mock(
      async (next: { allowedWorkspaceIds: string[] | null; allowPersonalWorkspaces: boolean }) =>
        reach(next.allowedWorkspaceIds, next.allowPersonalWorkspaces),
    );
    const onSaved = mock((_reach: OrganizationComputeReach) => undefined);
    const { root } = await render(
      <OrganizationComputeReachDialog
        open
        onOpenChange={() => undefined}
        client={client}
        kind="machine"
        name="Build box"
        reach={reach([OPS], true)}
        organizationId="org"
        organizationName="Acme"
        hereId={DESIGN}
        save={save}
        onSaved={onSaved}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Where can Build box be used?");
    expect(text).toContain("Belongs to Acme. Organization owners and admins manage it.");
    expect(text).toContain("It was connected from this workspace, so it always works there.");
    expect(text).not.toContain("stop using it");

    // Members' Personal workspaces off: that takes it away, so it says so.
    const personal = Array.from(document.querySelectorAll("label")).find(
      (label) => label.textContent === "Personal workspaces",
    );
    await act(async () => {
      document.getElementById(personal!.htmlFor)!.click();
    });
    expect(document.body.textContent).toContain(
      "Chats and schedules in the workspaces you take away stop using it from their next turn.",
    );

    await submit();
    expect(save).toHaveBeenCalledWith({
      allowedWorkspaceIds: [OPS],
      allowPersonalWorkspaces: false,
    });
    expect(onSaved).toHaveBeenCalledWith(reach([OPS], false));
    await act(async () => root.unmount());
  });

  test("all product-managed workspaces is a choice when the server has it", async () => {
    const save = mock(
      async (next: {
        allowedWorkspaceIds: string[] | null;
        allowPersonalWorkspaces: boolean;
        allowManagedWorkspaces?: boolean;
      }) =>
        reach(next.allowedWorkspaceIds, next.allowPersonalWorkspaces, next.allowManagedWorkspaces),
    );
    const { root } = await render(
      <OrganizationComputeReachDialog
        open
        onOpenChange={() => undefined}
        client={client}
        kind="rig"
        name="Python 3.13"
        reach={reach([], false, false)}
        organizationId="org"
        organizationName="Acme"
        hereId={HOME}
        save={save}
      />,
    );
    expect(document.body.textContent).toContain(
      "Every workspace your product manages, including new ones.",
    );
    const managed = Array.from(document.querySelectorAll("label")).find(
      (label) => label.textContent === "All product-managed workspaces",
    );
    await act(async () => {
      document.getElementById(managed!.htmlFor)!.click();
    });
    await submit();
    expect(save).toHaveBeenCalledWith({
      allowedWorkspaceIds: [],
      allowPersonalWorkspaces: false,
      allowManagedWorkspaces: true,
    });
    await act(async () => root.unmount());
  });

  test("an older server's reach has no product-managed choice and saves without it", async () => {
    const save = mock(async () => reach([OPS], false));
    const { root } = await render(
      <OrganizationComputeReachDialog
        open
        onOpenChange={() => undefined}
        client={client}
        kind="machine"
        name="Build box"
        reach={reach([OPS], false)}
        organizationId="org"
        organizationName="Acme"
        hereId={HOME}
        save={save}
      />,
    );
    expect(document.body.textContent).not.toContain("All product-managed workspaces");
    await submit();
    expect(save).toHaveBeenCalledWith({ allowedWorkspaceIds: [OPS], allowPersonalWorkspaces: false });
    await act(async () => root.unmount());
  });
});
