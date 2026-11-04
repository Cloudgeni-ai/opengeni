import { afterEach, expect, test } from "bun:test";
import type { ToolActionReview } from "@opengeni/sdk";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

// Radix picks its layout-effect implementation at import time: load after the DOM exists.
const { ToolActionReviewCard } = await import("../src/components/tool-action-review");

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await current.unmount();
});

function review(overrides: Partial<ToolActionReview>): ToolActionReview {
  return {
    version: 1,
    id: "approval-1",
    actionDigest: "digest",
    revision: "revision-1",
    status: "pending",
    title: "Post a message to the channel",
    accountLabel: "alice@example.test",
    effects: [],
    samples: [],
    fields: [],
    moreFields: 0,
    reason: "This action asks first by default.",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    approveLabel: "Post",
    availableActions: ["approve", "reject"],
    detailsAvailable: true,
    ...overrides,
  } as ToolActionReview;
}

async function render(value: ToolActionReview): Promise<HTMLElement> {
  mounted = await renderComponent(
    <ToolActionReviewCard review={value} onApprove={() => undefined} onReject={() => undefined} />,
  );
  await flush();
  return mounted.container;
}

function buttons(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")].map((button) => button.textContent ?? "");
}

test("an action on another person's own account offers only Decline and says who approves", async () => {
  const container = await render(
    review({
      availableActions: ["reject"],
      approvedBy: "account_owner",
      accountOwnerLabel: "Alice Example",
    }),
  );
  expect(buttons(container).some((label) => label.includes("Post"))).toBe(false);
  expect(container.textContent).toContain("Only Alice Example can approve this");
  expect(container.textContent).not.toContain("couldn't be recovered");
});

test("without the owner's name it still says who approves", async () => {
  const container = await render(
    review({ availableActions: ["reject"], approvedBy: "account_owner" }),
  );
  expect(container.textContent).toContain("Only the person whose own account this runs on");
});

test("the account's owner keeps Approve", async () => {
  const container = await render(review({}));
  expect(buttons(container).some((label) => label.includes("Post"))).toBe(true);
  expect(container.textContent).not.toContain("can approve this");
});

test("the owner is told when an action in a shared chat waits for them", async () => {
  const container = await render(review({ approvedBy: "you" }));
  expect(buttons(container).some((label) => label.includes("Post"))).toBe(true);
  expect(container.textContent).toContain("only you can approve it");
});
