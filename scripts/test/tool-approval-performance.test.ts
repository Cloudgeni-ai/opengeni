import { expect, test } from "bun:test";
import { toolReviewAction, toolReviewFields, toolReviewDetails } from "@opengeni/contracts";
import { collectIdPages, planIdBatches } from "@opengeni/codemode";

for (const count of [1, 4, 5, 600, 1001, 10_000]) {
  test(`${count} selected IDs have a compact review and complete bounded detail pages`, async () => {
    const ids = Array.from({ length: count }, (_, index) => `synthetic-message-${index}`);
    let reads = 0;
    const selected = await collectIdPages(async (token) => {
      reads++;
      const offset = Number(token ?? 0),
        next = offset + 500;
      return {
        ids: ids.slice(offset, next),
        ...(next < ids.length ? { nextPageToken: String(next) } : {}),
      };
    });
    expect(reads).toBe(Math.ceil(count / 500));
    const plan = planIdBatches(selected);
    expect(plan.batches.flatMap((batch) => [...batch.ids])).toEqual(ids);
    expect(plan.batches.every((batch) => batch.ids.length <= 1000)).toBe(true);
    const args = { messageIds: selected, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] };
    const context = { kind: "gmail" as const };
    const primary = {
      ...toolReviewAction("batch_modify_messages", args, context),
      ...toolReviewFields(args, context),
    };
    expect(primary.selectionCount).toBe(count);
    expect(Buffer.byteLength(JSON.stringify(primary))).toBeLessThan(32 * 1024);
    const selection = primary.fields.find((field) => field.path === "/messageIds");
    if (count <= 4) {
      expect(selection).toMatchObject({ preview: ids.join(", "), count, truncated: false });
    } else {
      expect(selection).toMatchObject({
        preview: `${count.toLocaleString("en-US")} items`,
        count,
        truncated: true,
      });
      expect(JSON.stringify(primary)).not.toContain("synthetic-message-");
    }
    const restored: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = toolReviewDetails(args, context, "/messageIds", offset);
      expect(page.items.length).toBeLessThanOrEqual(25);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(32 * 1024);
      restored.push(...page.items.map((item) => item.value));
      offset = page.nextOffset;
    }
    expect(restored).toEqual(ids);
  });
}
