import { afterEach, describe, expect, jest, test } from "bun:test";
import { act, createElement, useLayoutEffect, type ReactNode } from "react";
import { ApprovalSurface } from "../src";
import { OpenGeniApiError, type SessionEvent, type ToolActionReview } from "@opengeni/sdk";
import {
  approvalsDecidable,
  approvalsFromRequiresAction,
  projectPendingApprovals,
  type PendingApproval,
} from "../src/approvals";
import {
  registerDom,
  renderComponent,
  withVirtualClock,
  type RenderedComponent,
} from "./render-hook";

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

describe("approvalsDecidable", () => {
  test("a pause's approvals stay decidable while a sibling decision resumes the turn", () => {
    for (const status of ["requires_action", "running", "queued", "recovering", "waiting_capacity"])
      expect(approvalsDecidable(status)).toBe(true);
    for (const status of ["idle", "failed", "cancelled", "terminated", null, undefined])
      expect(approvalsDecidable(status)).toBe(false);
  });
});

describe("ApprovalSurface", () => {
  test.each(["saved", "legacy", "no host review"] as const)(
    "%s reviews keep their card and focus across unrelated event projections",
    async (kind) => {
      let calls = 0;
      const loadReview = async () => {
        calls++;
        if (kind === "legacy") throw new OpenGeniApiError(404, "Review not found");
        // A host with no review for this approval keeps the standard card.
        if (kind === "no host review") return null;
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

  test("a waiting action whose review offers no decision says so and re-reads it, never a silent footer", async () => {
    // Read while a sibling decision resumed the turn: pending, but no actions.
    const reads: ToolActionReview[] = [
      { ...savedReview(), availableActions: [] },
      { ...savedReview(), availableActions: ["approve", "reject"] },
    ];
    let calls = 0;
    const loadReview = async () => reads[Math.min(calls++, reads.length - 1)]!;
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        approvals: [approval],
        loadReview,
        onApprove: noDecision,
        onReject: noDecision,
      }),
    );
    await act(async () => undefined);
    const text = () => mounted!.container.textContent ?? "";
    const buttons = () =>
      [...mounted!.container.querySelectorAll("button")].map((button) => button.textContent);
    expect(text()).toContain("This action can't be decided yet.");
    expect(buttons()).toContain("Try again");
    expect(buttons()).not.toContain("Approve action");
    // Try again (or the automatic re-read) fetches the review again; once it
    // offers decisions the buttons are back without re-entering the chat.
    const retry = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )!;
    await act(async () => retry.click());
    await act(async () => undefined);
    expect(calls).toBe(2);
    expect(buttons()).toEqual(expect.arrayContaining(["Decline", "Approve action"]));
    expect(text()).not.toContain("This action can't be decided yet.");
  });

  test("re-reading an undecided action keeps its notice and focus while the approval is re-created", async () => {
    let calls = 0;
    let answer: (review: ToolActionReview) => void = () => undefined;
    const loadReview = () =>
      calls++ === 0
        ? Promise.resolve({ ...savedReview(), availableActions: [] } as ToolActionReview)
        : new Promise<ToolActionReview>((resolve) => {
            answer = resolve;
          });
    // Event projection hands the surface an equal, newly created approval.
    const render = () =>
      createElement(ApprovalSurface, {
        approvals: [{ ...approval }],
        loadReview,
        onApprove: noDecision,
        onReject: noDecision,
      });
    mounted = await renderComponent(render());
    await act(async () => undefined);
    await mounted.rerender(render());
    const retry = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )!;
    retry.focus();
    await act(async () => retry.click());
    expect(calls).toBe(2);
    expect(mounted.container.textContent).toContain("This action can't be decided yet.");
    expect(mounted.container.textContent).not.toContain("Loading action details");
    expect(document.activeElement).toBe(retry);
    await act(async () => answer(savedReview()));
    expect(
      [...mounted.container.querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual(expect.arrayContaining(["Decline", "Approve action"]));
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

describe("ApprovalSurface: approve or decline all", () => {
  const item = (id: string): PendingApproval => ({
    id,
    name: "projects.update",
    arguments: { projectId: id },
  });
  const reviewOf = (id: string, overrides: Partial<ToolActionReview> = {}): ToolActionReview => ({
    ...savedReview(`Update ${id}`),
    id,
    ...overrides,
  });
  const buttons = () => [...mounted!.container.querySelectorAll("button")];
  const buttonNamed = (label: string) => buttons().find((value) => value.textContent === label);
  const settle = async () => {
    for (let index = 0; index < 4; index++) await act(async () => await Promise.resolve());
  };

  test("offers one decision per action only with two or more it can include, reading each review once", async () => {
    const reads: string[] = [];
    const loadReview = async (value: PendingApproval) => {
      reads.push(value.id);
      return reviewOf(value.id);
    };
    const props = { loadReview, onApprove: noDecision, onReject: noDecision };
    mounted = await renderComponent(
      createElement(ApprovalSurface, { ...props, approvals: [item("a")] }),
    );
    await settle();
    expect(buttonNamed("Approve all 1")).toBeUndefined();
    expect(buttonNamed("Decline all")).toBeUndefined();
    await mounted.rerender(
      createElement(ApprovalSurface, { ...props, approvals: [item("a"), item("b"), item("c")] }),
    );
    await settle();
    expect(buttonNamed("Approve all 3")).not.toBeUndefined();
    expect(buttonNamed("Decline all")).not.toBeUndefined();
    // The selected card and the bulk buttons share one read of each review.
    expect([...reads].sort()).toEqual(["a", "b", "c"]);
  });

  test("includes only actions this person may decide, each through its own decision", async () => {
    const reviews: Record<string, () => Promise<ToolActionReview>> = {
      a: async () => reviewOf("a"),
      owner: async () => reviewOf("owner", { availableActions: ["reject"] }),
      denied: async () => {
        throw new OpenGeniApiError(403, "Access denied");
      },
      between: async () => reviewOf("between", { availableActions: [] }),
      b: async () => reviewOf("b"),
    };
    const question: PendingApproval = {
      ...item("question"),
      elicitation: {
        round: 1,
        server: "Linear",
        mode: "form",
        message: "Which team?",
        requestedSchema: { type: "object", properties: {} },
      } as never,
    };
    const approved: string[] = [];
    const declined: string[] = [];
    const approvals = [
      item("a"),
      item("owner"),
      item("denied"),
      item("between"),
      question,
      item("b"),
    ];
    const render = () =>
      createElement(ApprovalSurface, {
        approvals,
        loadReview: (value) => reviews[value.id]!(),
        onApprove: (value) => {
          approved.push(value.id);
        },
        onReject: (value) => {
          declined.push(value.id);
        },
      });
    mounted = await renderComponent(render());
    await settle();
    expect(buttonNamed("Approve all 2")).not.toBeUndefined();
    await act(async () => buttonNamed("Approve all 2")!.click());
    await settle();
    expect(approved).toEqual(["a", "b"]);
    expect(declined).toEqual([]);
    await act(async () => buttonNamed("Decline all")!.click());
    await settle();
    // Decline reaches what each card can decline, never one it can't decide
    // or one just approved.
    expect(declined).toEqual(["owner", "question"]);
  });

  test("keeps going past a failure, which stays waiting, selected and named", async () => {
    const approvals = [item("a"), item("b"), item("c")];
    const approved: string[] = [];
    const props = {
      loadReview: async (value: PendingApproval) => reviewOf(value.id),
      onApprove: async (value: PendingApproval) => {
        if (value.id === "b") throw new OpenGeniApiError(422, "Only its owner can approve this");
        approved.push(value.id);
      },
      onReject: noDecision,
    };
    mounted = await renderComponent(createElement(ApprovalSurface, { ...props, approvals }));
    await settle();
    await act(async () => buttonNamed("Approve all 3")!.click());
    await settle();
    expect(approved).toEqual(["a", "c"]);
    // The server removes what it decided; the failed one is still waiting.
    await mounted.rerender(createElement(ApprovalSurface, { ...props, approvals: [item("b")] }));
    await settle();
    const alert = mounted.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't approve Update b");
    expect(mounted.container.querySelector('[data-approval-id="b"]')).not.toBeNull();
    expect(buttonNamed("Approve action")?.hasAttribute("disabled")).toBe(false);
  });

  test("a run decides what was shown: arrivals wait, resolved or changed ones are skipped", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const sent: string[] = [];
    const props = {
      loadReview: async (value: PendingApproval) => reviewOf(value.id),
      onApprove: (value: PendingApproval) => {
        sent.push(value.id);
        const gate = deferred<void>();
        gates.set(value.id, gate);
        return gate.promise;
      },
      onReject: noDecision,
    };
    const start = [item("a"), item("b"), item("c"), item("d")];
    mounted = await renderComponent(createElement(ApprovalSurface, { ...props, approvals: start }));
    await settle();
    await act(async () => buttonNamed("Approve all 4")!.click());
    await settle();
    expect(sent).toEqual(["a"]);
    expect(mounted.container.textContent).toContain("Approving 1 of 4…");
    // Every card waits while the run sends.
    expect(buttonNamed("Approve action")?.hasAttribute("disabled")).toBe(true);
    // Meanwhile: b is decided elsewhere, c's facts change, e arrives.
    const changed = { ...item("c"), arguments: { projectId: "other" } };
    await mounted.rerender(
      createElement(ApprovalSurface, {
        ...props,
        approvals: [item("a"), changed, item("d"), item("e")],
      }),
    );
    await act(async () => gates.get("a")!.resolve());
    await settle();
    expect(sent).toEqual(["a", "d"]);
    // Already decided elsewhere is not a failure.
    await act(async () => gates.get("d")!.reject(new OpenGeniApiError(409, "Already decided")));
    await settle();
    expect(sent).toEqual(["a", "d"]);
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    expect(mounted.container.querySelector("[data-og-approval-bulk-progress]")).toBeNull();
    // What changed or arrived is offered on its own afterwards.
    expect(buttonNamed("Approve all 2")).not.toBeUndefined();
  });

  test("a decided action is never sent again while the host still lists it", async () => {
    const sent: string[] = [];
    const approvals = [item("a"), item("b")];
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        approvals,
        loadReview: async (value) => reviewOf(value.id),
        // The host accepts each decision but has not removed it yet.
        onApprove: (value) => {
          sent.push(value.id);
        },
        onReject: noDecision,
      }),
    );
    await settle();
    await act(async () => buttonNamed("Approve all 2")!.click());
    await settle();
    expect(sent).toEqual(["a", "b"]);
    expect(buttonNamed("Approve all 2")).toBeUndefined();
    expect(buttonNamed("Decline all")).toBeUndefined();
    // Its card waits for the removal, as a single decision does.
    const card = buttons().find((value) => value.textContent?.includes("Approving"));
    expect(card?.hasAttribute("disabled")).toBe(true);
    await act(async () => card?.click());
    expect(sent).toEqual(["a", "b"]);
  });

  test("an unreadable review or lost arguments can be declined in bulk, never approved", async () => {
    const approved: string[] = [];
    const declined: string[] = [];
    const lost: PendingApproval = { id: "lost", name: "projects.update" };
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        approvals: [item("a"), item("unreadable"), lost, item("b")],
        loadReview: async (value) => {
          if (value.id === "unreadable") throw new OpenGeniApiError(503, "Unavailable");
          if (value.id === "lost") throw new OpenGeniApiError(404, "Review not found");
          return reviewOf(value.id);
        },
        onApprove: (value) => {
          approved.push(value.id);
        },
        onReject: (value) => {
          declined.push(value.id);
        },
      }),
    );
    await settle();
    await act(async () => buttonNamed("Approve all 2")!.click());
    await settle();
    expect(approved).toEqual(["a", "b"]);
    await mounted.rerender(
      createElement(ApprovalSurface, {
        approvals: [item("unreadable"), lost],
        loadReview: async (value) => {
          if (value.id === "unreadable") throw new OpenGeniApiError(503, "Unavailable");
          throw new OpenGeniApiError(404, "Review not found");
        },
        onApprove: (value) => {
          approved.push(value.id);
        },
        onReject: (value) => {
          declined.push(value.id);
        },
      }),
    );
    await settle();
    await act(async () => buttonNamed("Decline all")!.click());
    await settle();
    expect(declined).toEqual(["unreadable", "lost"]);
    expect(approved).toEqual(["a", "b"]);
  });

  test("a waiting action read between states is read again, so the count catches up", async () => {
    await withVirtualClock(async () => {
      const reads: Record<string, number> = {};
      mounted = await renderComponent(
        createElement(ApprovalSurface, {
          approvals: [item("a"), item("b"), item("c")],
          loadReview: async (value) => {
            reads[value.id] = (reads[value.id] ?? 0) + 1;
            // b and c are first read while the chat moves between states.
            return value.id !== "a" && reads[value.id] === 1
              ? reviewOf(value.id, { availableActions: [] })
              : reviewOf(value.id);
          },
          onApprove: noDecision,
          onReject: noDecision,
        }),
      );
      await settle();
      expect(buttonNamed("Approve all 3")).toBeUndefined();
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      await settle();
      expect(buttonNamed("Approve all 3")).not.toBeUndefined();
      expect(reads).toEqual({ a: 1, b: 2, c: 2 });
    });
  });

  test("leaving the chat stops a run", async () => {
    const sent: string[] = [];
    const gate = deferred<void>();
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        approvals: [item("a"), item("b")],
        onApprove: (value) => {
          sent.push(value.id);
          return gate.promise;
        },
        onReject: noDecision,
      }),
    );
    await act(async () => buttonNamed("Approve all 2")!.click());
    const current = mounted;
    mounted = null;
    await current.unmount();
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual(["a"]);
  });
});
