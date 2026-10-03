import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { KnowledgeEntryRecord } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReviewItem, ReviewQueue } from "./knowledge-review";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const entryId = "00000000-0000-4000-8000-000000000002";
const revisionId = "00000000-0000-4000-8000-000000000003";
const renewedRevisionId = "00000000-0000-4000-8000-000000000004";
const batchId = "00000000-0000-4000-8000-000000000005";
const createdAt = "2026-09-28T00:00:00.000Z";

function proposal(revision = revisionId): KnowledgeEntryRecord {
  return {
    id: entryId,
    scope: "workspace",
    version: revision === revisionId ? 1 : 2,
    publishedRevisionId: null,
    latestRevisionId: revision,
    archived: false,
    createdAt,
    updatedAt: createdAt,
    revision: {
      id: revision,
      entryId,
      number: revision === revisionId ? 1 : 2,
      previousRevisionId: revision === revisionId ? null : revisionId,
      restoredFromRevisionId: null,
      createdAt,
      createdBySessionId: null,
      reviewBatchId: batchId,
      outcome: "pending",
      change: "upsert",
      entry: {
        title: "Unsupported claim",
        kind: "note",
        content: revision === revisionId ? "Original proposal" : "Renewed proposal",
        evidence: [],
        groupIds: [],
        relationships: [],
      },
    },
  };
}

function queue(record: KnowledgeEntryRecord): ReviewQueue {
  const { entry, ...revision } = record.revision;
  const item: ReviewItem = {
    kind: "knowledge",
    key: `knowledge:${record.id}`,
    title: record.revision.entry.title,
    createdAt,
    origin: { kind: "none", name: "Review batch" },
    batch: {
      id: batchId,
      sessionId: null,
      scheduledTaskId: null,
      scheduledTaskRunId: null,
      title: "Review batch",
      scope: "workspace",
      pendingCount: 1,
      createdAt,
    },
    entry: {
      ...record,
      excerpts: [],
      revision: {
        ...revision,
        kind: entry.kind,
        title: entry.title,
        preview: entry.content,
        groupIds: entry.groupIds,
        sourceKind: null,
      },
    },
  };
  return {
    items: [item],
    groups: [{ key: "batch", origin: item.origin, items: [item] }],
    count: 1,
    partial: false,
    loading: false,
    error: null,
    reload() {},
  };
}

let pending: KnowledgeEntryRecord | null = null;
const reads: { id: string; view?: string }[] = [];
let missingReads = 0;
let decisions = 0;
let finishDecision = async () => {};
let decisionError: Error | null = null;
const client = {
  async getKnowledgeEntry(_workspace: string, id: string, options: { view?: string }) {
    reads.push({ id, view: options.view });
    if (!pending) {
      missingReads++;
      throw new OpenGeniApiError(404, "The proposal is no longer pending");
    }
    return pending;
  },
  async reviewKnowledgeEntry() {
    decisions++;
    if (decisionError) throw decisionError;
    // The server commits before the response arrives at the browser.
    pending = null;
    await finishDecision();
    return {};
  },
};
mock.module("@/context", () => ({ useAppContext: () => ({ client }) }));
const { ReviewTab } = await import("./knowledge-review");

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function scenario() {
  const original = proposal();
  pending = original;
  reads.length = 0;
  missingReads = 0;
  decisions = 0;
  finishDecision = async () => {};
  decisionError = null;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let replaceQueue!: (next: ReviewQueue) => void;
  function Harness() {
    const [value, setValue] = useState(() => queue(original));
    replaceQueue = setValue;
    return (
      <ReviewTab
        workspaceId={workspaceId}
        queue={value}
        emptyDescription="Changes wait for review."
        onOpenLearning={() => {}}
        onOpenEntry={() => {}}
        onChanged={() => {}}
      />
    );
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Harness }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  await settle();
  // The list reads nothing; opening a row opens the change's page, which
  // reads the proposal once.
  expect(reads).toEqual([]);
  const row = container.querySelector<HTMLButtonElement>("[data-slot=list-row] [data-row-action]");
  expect(row).not.toBeNull();
  await act(async () => row!.click());
  await settle();
  expect(reads).toEqual([{ id: entryId, view: "needs_review" }]);
  return {
    container,
    original,
    async reject() {
      const button = [...container.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Reject",
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
      await settle();
    },
    async refresh(record = original) {
      // A fresh API response supplies new objects for the same revision.
      await act(async () => replaceQueue(queue(record)));
      await settle();
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("equivalent queue objects do not reread a proposal, but a renewed revision does", async () => {
  const view = await scenario();
  try {
    await view.refresh();
    expect(reads).toHaveLength(1);
    pending = proposal(renewedRevisionId);
    await view.refresh(pending);
    expect(reads).toHaveLength(2);
    expect(view.container.textContent).toContain("Renewed proposal");
    expect(missingReads).toBe(0);
  } finally {
    await view.close();
  }
});

test("a committed rejection with a delayed response cannot be reread by an equivalent queue refresh", async () => {
  const view = await scenario();
  let release!: () => void;
  finishDecision = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  try {
    await view.reject();
    expect(pending).toBeNull();
    await view.refresh();
    expect(reads).toHaveLength(1);
    expect(missingReads).toBe(0);
    expect(view.container.textContent).not.toContain("Couldn't load this change");
    await act(async () => release());
    await settle();
    expect(view.container.textContent).toContain("You're all caught up");
    expect(decisions).toBe(1);
  } finally {
    release?.();
    await view.close();
  }
});

test("stale snapshots cannot resurrect a rejected revision while a new revision remains reviewable", async () => {
  const view = await scenario();
  try {
    await view.reject();
    expect(view.container.textContent).toContain("You're all caught up");
    await view.refresh();
    await view.refresh();
    expect(view.container.textContent).toContain("You're all caught up");
    expect(reads).toHaveLength(1);
    expect(missingReads).toBe(0);
    pending = proposal(renewedRevisionId);
    await view.refresh(pending);
    // The renewed proposal is back on the list, not the rejected one.
    expect(view.container.textContent).not.toContain("You're all caught up");
    const row = view.container.querySelector<HTMLButtonElement>(
      "[data-slot=list-row] [data-row-action]",
    );
    await act(async () => row!.click());
    await settle();
    expect(view.container.textContent).toContain("Renewed proposal");
    expect(view.container.textContent).not.toContain("You're all caught up");
    expect(decisions).toBe(1);
  } finally {
    await view.close();
  }
});

test("a failed rejection leaves the proposal visible and its action error discoverable", async () => {
  const view = await scenario();
  decisionError = new Error("Review service unavailable");
  try {
    await view.reject();
    await view.refresh();
    expect(view.container.textContent).toContain("Original proposal");
    expect(view.container.textContent).toContain("Review service unavailable");
    expect(view.container.textContent).not.toContain("You're all caught up");
    expect(missingReads).toBe(0);
    expect(reads).toHaveLength(1);
  } finally {
    await view.close();
  }
});
