import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, useLayoutEffect, type ReactNode } from "react";
import { ApprovalSurface } from "../src";
import { OpenGeniApiError, type SessionEvent, type ToolActionReview } from "@opengeni/sdk";
import {
  approvalsFromRequiresAction,
  projectPendingApprovals,
  type PendingApproval,
} from "../src/approvals";
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

function savedReview(title = "Update project"): ToolActionReview {
  return {
    version: 1,
    id: approval.id,
    actionDigest: "saved-action",
    revision: "revision-1",
    status: "pending",
    title,
    effects: [],
    samples: [],
    fields: [],
    moreFields: 0,
    reason: "Review this change.",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    approveLabel: "Approve action",
    availableActions: ["approve", "reject"],
    detailsAvailable: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const noDecision = () => undefined;

function LayoutObservation({ children, observe }: { children?: ReactNode; observe: () => void }) {
  useLayoutEffect(observe);
  return children;
}

describe("ApprovalSurface", () => {
  test.each(["saved", "legacy"] as const)(
    "%s reviews keep their card and focus across unrelated event projections",
    async (kind) => {
      let calls = 0;
      const loadReview = async () => {
        calls++;
        if (kind === "legacy") throw new OpenGeniApiError(404, "Review not found");
        return savedReview();
      };
      const events = [
        { type: "session.requiresAction", turnId: "turn-1", payload: { approvals: [approval] } },
      ] as SessionEvent[];
      const render = () =>
        createElement(ApprovalSurface, {
          approvals: projectPendingApprovals(events),
          loadReview,
          onApprove: noDecision,
          onReject: noDecision,
        });
      mounted = await renderComponent(render());
      const card = mounted.container.querySelector("[data-og-tool-review]");
      const button = [...mounted.container.querySelectorAll("button")].find(
        (value) => value.textContent === "Approve action",
      )!;
      button.focus();
      for (let index = 0; index < 5; index++) {
        events.push({
          type: "session.status.changed",
          payload: { status: "requires_action" },
        } as SessionEvent);
        await mounted.rerender(render());
        expect(calls).toBe(1);
        expect(mounted.container.querySelector("[data-og-tool-review]")).toBe(card);
        expect(mounted.container.textContent).not.toContain("Loading action details");
        expect(document.activeElement).toBe(button);
      }
    },
  );

  test("legacy full details keep the reader's focus across equal approval objects", async () => {
    let calls = 0;
    const loadReview = async () => {
      calls++;
      throw new OpenGeniApiError(404, "Review not found");
    };
    const render = () =>
      createElement(ApprovalSurface, {
        approvals: [structuredClone(approval)],
        loadReview,
        onApprove: noDecision,
        onReject: noDecision,
      });
    mounted = await renderComponent(render());
    const details = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Details",
    )!;
    await act(async () => details.click());
    const page = mounted.container.querySelector("[data-og-review-details]");
    const back = [...mounted.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Back to review"),
    )!;
    back.focus();
    await mounted.rerender(render());
    expect(calls).toBe(1);
    expect(mounted.container.querySelector("[data-og-review-details]")).toBe(page);
    expect(mounted.container.textContent).toContain("project-1");
    expect(document.activeElement).toBe(back);
  });

  test.each([
    { ...approval, arguments: { projectId: "project-2" } },
    { ...approval, name: "projects.delete" },
    { ...approval, display: { toolName: approval.name, accountLabel: "Another account" } },
    { ...approval, raw: { actionDigest: "changed-action" } },
  ])("changed approval facts hide old decisions before effects run: %j", async (changed) => {
    let calls = 0;
    const next = deferred<ToolActionReview>();
    const loadReview = () => (++calls === 1 ? Promise.resolve(savedReview()) : next.promise);
    const render = (value: PendingApproval, observe = () => {}) =>
      createElement(
        LayoutObservation,
        { observe },
        createElement(ApprovalSurface, {
          approvals: [value],
          loadReview,
          onApprove: noDecision,
          onReject: noDecision,
        }),
      );
    mounted = await renderComponent(render(approval));
    expect(mounted.container.textContent).toContain("Approve action");
    let textAtLayout = "";
    await mounted.rerender(
      render(changed, () => {
        textAtLayout = mounted!.container.textContent ?? "";
      }),
    );
    expect(calls).toBe(2);
    expect(textAtLayout).toContain("Loading action details");
    expect(textAtLayout).not.toContain("Approve action");
    await act(async () => next.resolve(savedReview("Review changed action")));
    expect(mounted.container.textContent).toContain("Review changed action");
  });

  test("a changed access loader invalidates the same approval and a late response cannot restore it", async () => {
    const old = deferred<ToolActionReview>();
    const current = deferred<ToolActionReview>();
    const firstLoader = () => old.promise;
    const secondLoader = () => current.promise;
    const render = (loadReview: typeof firstLoader) =>
      createElement(ApprovalSurface, {
        approvals: [structuredClone(approval)],
        loadReview,
        onApprove: noDecision,
        onReject: noDecision,
      });
    mounted = await renderComponent(render(firstLoader));
    await mounted.rerender(render(secondLoader));
    await act(async () => old.resolve(savedReview("Old account action")));
    expect(mounted.container.textContent).toContain("Loading action details");
    expect(mounted.container.textContent).not.toContain("Old account action");
    await act(async () => current.reject(new OpenGeniApiError(403, "Access denied")));
    expect(mounted.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(mounted.container.textContent).not.toContain("Approve action");
  });

  test("an access change removes an already loaded legacy decision immediately", async () => {
    const legacy = async () => {
      throw new OpenGeniApiError(404, "Review not found");
    };
    const denied = deferred<ToolActionReview>();
    const render = (loadReview: () => Promise<ToolActionReview>, observe = () => {}) =>
      createElement(
        LayoutObservation,
        { observe },
        createElement(ApprovalSurface, {
          approvals: [structuredClone(approval)],
          loadReview,
          onApprove: noDecision,
          onReject: noDecision,
        }),
      );
    mounted = await renderComponent(render(legacy));
    expect(mounted.container.textContent).toContain("Approve action");
    let textAtLayout = "";
    await mounted.rerender(
      render(
        () => denied.promise,
        () => {
          textAtLayout = mounted!.container.textContent ?? "";
        },
      ),
    );
    expect(textAtLayout).not.toContain("Approve action");
    expect(textAtLayout).toContain("Loading action details");
    await act(async () => denied.reject(new OpenGeniApiError(403, "Access denied")));
    expect(mounted.container.textContent).not.toContain("Approve action");
  });

  test("a failed review stays settled across projections and explicit retry fetches again", async () => {
    let calls = 0;
    const loadReview = async () => {
      if (++calls === 1) throw new OpenGeniApiError(503, "Unavailable");
      return savedReview();
    };
    const render = () =>
      createElement(ApprovalSurface, {
        approvals: [structuredClone(approval)],
        loadReview,
        onApprove: noDecision,
        onReject: noDecision,
      });
    mounted = await renderComponent(render());
    await mounted.rerender(render());
    expect(calls).toBe(1);
    expect(mounted.container.querySelector('[role="alert"]')).not.toBeNull();
    const retry = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )!;
    await act(async () => retry.click());
    expect(calls).toBe(2);
    expect(mounted.container.textContent).toContain("Approve action");
  });

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
      (button) => button.textContent === "Approve action",
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

    expect(mounted.container.textContent).toContain("Projects › update");
    const terms = [...mounted.container.querySelectorAll("dt")].map((node) => node.textContent);
    const values = [...mounted.container.querySelectorAll("dd")].map((node) => node.textContent);
    expect(terms).toEqual(["Project ID"]);
    expect(values).toEqual(["project-1"]);
    expect(mounted.container.textContent).not.toContain('"projectId"');

    const details = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Details",
    );
    await act(async () => {
      details!.click();
      await Promise.resolve();
    });
    expect(mounted.container.querySelector("[data-og-review-details]")).not.toBeNull();
    expect(mounted.container.textContent).toContain("project-1");
    expect(mounted.container.querySelector("pre")).toBeNull();
  });

  test("nested arguments navigate to complete values and hide credentials", async () => {
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        approvals: [
          {
            ...approval,
            arguments: {
              projectId: "project-1",
              patch: { name: "Renamed", apiKey: "secret-canary" },
            },
          },
        ],
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );
    expect(mounted.container.textContent).not.toContain("secret-canary");
    const field = [...mounted.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("2 fields"),
    );
    await act(async () => {
      field!.click();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).toContain("Renamed");
    expect(mounted.container.textContent).toContain("[Protected value]");
    expect(mounted.container.textContent).not.toContain("secret-canary");
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
      "The request could not be completed.",
    );
    expect(approve?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      approve!.click();
      await Promise.resolve();
    });
    expect(calls).toBe(2);
  });
  test("large queues render one action and release decision fencing after authoritative removal", async () => {
    const approvals = Array.from({ length: 100 }, (_, i) => ({ ...approval, id: `action-${i}` }));
    const calls: string[] = [];
    const props = {
      approvals,
      onApprove: (value: import("../src/approvals").PendingApproval) => {
        calls.push(value.id);
      },
      onReject: () => undefined,
    };
    mounted = await renderComponent(createElement(ApprovalSurface, props));
    expect(mounted.container.querySelectorAll("[data-og-tool-review]")).toHaveLength(1);
    const button = () =>
      [...mounted!.container.querySelectorAll("button")].find(
        (value) => value.textContent === "Approve action",
      )!;
    await act(async () => button().click());
    await mounted.rerender(
      createElement(ApprovalSurface, { ...props, approvals: approvals.slice(1) }),
    );
    await act(async () => button().click());
    expect(calls).toEqual(["action-0", "action-1"]);
  });

  test("older SDK reviews retain safe detail access on 404 but access refusals never enable buttons", async () => {
    const props = { approvals: [approval], onApprove: () => undefined, onReject: () => undefined };
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        ...props,
        loadReview: async () => {
          throw new OpenGeniApiError(404, "Review not found");
        },
      }),
    );
    expect(mounted.container.textContent).toContain("Approve action");
    await mounted.unmount();
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        ...props,
        loadReview: async () => {
          throw new OpenGeniApiError(403, "Access denied");
        },
      }),
    );
    expect(mounted.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(mounted.container.textContent).not.toContain("Approve action");
  });
  test.each([
    ["saved review whose arguments were lost", "decline-only"],
    ["review that failed to load", "load-error"],
    ["older approval without arguments", "no-arguments"],
  ] as const)("a %s can always be declined, so the chat is never stuck", async (_label, mode) => {
    const rejected: string[] = [];
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        approvals: [mode === "no-arguments" ? { id: approval.id, name: approval.name } : approval],
        loadReview: async () => {
          if (mode === "load-error") throw new Error("unavailable");
          if (mode === "no-arguments") throw new OpenGeniApiError(404, "Review not found");
          return { ...savedReview(), availableActions: ["reject" as const] };
        },
        onApprove: () => {
          throw new Error("must not approve");
        },
        onReject: (value) => {
          rejected.push(value.id);
        },
      }),
    );
    await act(async () => undefined);
    const buttons = [...mounted.container.querySelectorAll("button")].map(
      (value) => value.textContent,
    );
    expect(buttons).toContain("Decline");
    expect(buttons).not.toContain("Approve action");
    const decline = [...mounted.container.querySelectorAll("button")].find(
      (value) => value.textContent === "Decline",
    )!;
    await act(async () => decline.click());
    expect(rejected).toEqual([approval.id]);
  });
});
