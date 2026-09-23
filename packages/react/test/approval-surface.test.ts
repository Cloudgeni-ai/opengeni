import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { ApprovalSurface } from "../src";
import { approvalsFromRequiresAction } from "../src/approvals";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await current.unmount();
});

const approval = {
  id: "approval-1",
  name: "projects.update",
  arguments: { projectId: "project-1" },
};

describe("ApprovalSurface", () => {
  test("readable persisted account labels do not replace the exact approval identity", async () => {
    const [pending] = approvalsFromRequiresAction({
      approvals: [
        {
          id: "exact-call",
          name: "a".repeat(64),
          arguments: { recordId: "record-1" },
          display: {
            toolName: "update_record",
            title: "Update record",
            accountLabel: "Documents — Workspace: Team inbox",
          },
        },
      ],
    });
    const seen: string[] = [];
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        approvals: [pending!],
        onApprove: (value) => {
          seen.push(value.id);
        },
        onReject: () => undefined,
      }),
    );
    expect(mounted.container.textContent).toContain("Update record");
    expect(mounted.container.textContent).toContain("Documents — Workspace: Team inbox");
    expect(mounted.container.textContent).not.toContain("a".repeat(64));
    const approve = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve",
    );
    await act(async () => approve!.click());
    expect(seen).toEqual(["exact-call"]);
    expect(pending?.name).toBe("a".repeat(64));
  });
  test("shows bounded action arguments in the default approval presentation", async () => {
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        approvals: [approval],
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );

    expect(mounted.container.textContent).toContain("projects › update");
    expect(mounted.container.textContent).toContain('"projectId": "project-1"');
  });

  test("supports host copy and presentation while returning the native approval", async () => {
    const approved: Array<typeof approval> = [];
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        approvals: [approval],
        onApprove: (value) => {
          approved.push(value as typeof approval);
        },
        onReject: () => undefined,
        messages: {
          title: "Godkjenning kreves",
          description: "Kontroller handlingen før agenten fortsetter.",
          approve: "Godkjenn",
          reject: "Avvis",
        },
        renderApproval: (value) => createElement("strong", null, `Oppdater prosjekt · ${value.id}`),
      }),
    );

    expect(mounted.container.textContent).toContain("Godkjenning kreves");
    expect(mounted.container.textContent).toContain("Oppdater prosjekt · approval-1");
    const approve = [...mounted.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Godkjenn"),
    );
    expect(approve).not.toBeUndefined();
    await act(async () => approve!.click());
    expect(approved).toEqual([approval]);
  });

  test("admits only one decision while the first callback is unresolved", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        approvals: [approval],
        onApprove: async () => {
          calls += 1;
          await pending;
        },
        onReject: () => undefined,
      }),
    );
    const approve = [...mounted.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Approve"),
    );
    expect(approve).not.toBeUndefined();
    await act(async () => {
      approve!.click();
      approve!.click();
      await Promise.resolve();
    });
    expect(calls).toBe(1);
    expect(approve?.textContent).toContain("Approving");
    release();
    await act(async () => await pending);
    expect(approve?.hasAttribute("disabled")).toBe(true);
    expect(approve?.textContent).toContain("Approving");
  });

  test("surfaces callback failures and permits an explicit retry", async () => {
    let calls = 0;
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        approvals: [approval],
        onApprove: async () => {
          calls += 1;
          throw new Error("Decision was not accepted");
        },
        onReject: () => undefined,
      }),
    );
    const approve = [...mounted.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Approve"),
    );
    expect(approve).not.toBeUndefined();

    await act(async () => {
      approve!.click();
      await Promise.resolve();
    });
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Decision was not accepted",
    );
    expect(approve?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      approve!.click();
      await Promise.resolve();
    });
    expect(calls).toBe(2);
  });
});
