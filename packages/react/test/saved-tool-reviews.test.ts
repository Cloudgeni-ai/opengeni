import { expect, test } from "bun:test";
import type { ToolActionReview, ToolReviewDetailsPage } from "@opengeni/sdk";
import { savedToolReviewLoaders } from "../src/components/saved-tool-reviews";

const review = (id: string, actionDigest: string): ToolActionReview =>
  ({
    version: 1,
    id,
    actionDigest,
    revision: "revision-1",
    status: "pending",
    title: "Delete a calendar event",
    effects: [],
    fields: [],
    moreFields: 0,
    reason: "",
    createdAt: "",
    updatedAt: "",
    approveLabel: "Approve action",
    availableActions: ["approve", "reject"],
    detailsAvailable: true,
  }) as ToolActionReview;

const page = (id: string): ToolReviewDetailsPage =>
  ({ version: 1, id, actionDigest: "a".repeat(64), path: "", entries: [] }) as never;

test("saved reviews read the server; host reviews keep the host's own", async () => {
  const serverReads: string[] = [];
  const detailReads: string[] = [];
  const loaders = savedToolReviewLoaders({
    readReview: async (id) => {
      serverReads.push(id);
      return review(id, "a".repeat(64));
    },
    readDetails: async (value) => {
      detailReads.push(value.id);
      return page(value.id);
    },
    loadReview: async (approval) => (approval.name === "hosted" ? review(approval.id, "") : null),
  });
  const saved = await loaders.loadReview({ id: "code-mode", name: "delete_event" });
  expect(saved?.actionDigest).toBe("a".repeat(64));
  const hosted = await loaders.loadReview({
    id: "hosted-call",
    name: "hosted",
    arguments: { title: "Lunch" },
  });
  expect(serverReads).toEqual(["code-mode"]);

  await loaders.loadDetails(saved!, "", 0);
  expect(detailReads).toEqual(["code-mode"]);
  // Without the host's details loader, its review opens the call's own arguments.
  const inline = await loaders.loadDetails(hosted!, "", 0);
  expect(detailReads).toEqual(["code-mode"]);
  expect(JSON.stringify(inline)).toContain("Lunch");
});
