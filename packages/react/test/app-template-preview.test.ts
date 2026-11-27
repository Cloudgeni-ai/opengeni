import { describe, expect, test } from "bun:test";

import { templatePreviewFetch } from "../src/app/lib/app-template-preview";

const PREFIX = "/v1/workspaces/site-host/published-artifacts/current";
const now = new Date("2026-11-26T12:00:00Z");
const request = (path: string, body: unknown) => ({
  type: "opengeni.site.http" as never,
  requestId: "r",
  path: `${PREFIX}${path}`,
  method: "POST",
  headers: [] as [string, string][],
  body: JSON.stringify(body),
});

describe("ready-made app preview data", () => {
  const fetch = templatePreviewFetch(
    {
      entries: [
        { title: "Older", votes: 1, date: "{{today-1}}" },
        { title: "Newer", votes: 5, date: "{{today}}", started: "{{today}} 09:40 UTC" },
      ],
    },
    now,
  );

  test("lists the sample, sorted, with dates filled in", async () => {
    const response = await fetch(
      request("/data/query", {
        collection: "entries",
        sort: [{ field: "votes", direction: "desc" }],
        count: true,
      }),
    );
    const page = (await response.json()) as {
      records: Array<{ data: Record<string, unknown> }>;
      count: number;
    };
    expect(page.records.map((record) => record.data.title)).toEqual(["Newer", "Older"]);
    expect(page.records[0]?.data.date).toBe("2026-11-26");
    expect(page.records[0]?.data.started).toBe("2026-11-26 09:40 UTC");
    expect(page.records[1]?.data.date).toBe("2026-11-25");
    expect(page.count).toBe(2);
  });

  test("has nothing of the viewer's own, and unknown collections are empty", async () => {
    for (const body of [{ collection: "entries", scope: "own" }, { collection: "votes" }]) {
      const page = (await (await fetch(request("/data/query", body))).json()) as {
        records: unknown[];
      };
      expect(page.records).toEqual([]);
    }
  });

  test("refuses every write, so a preview saves nothing", async () => {
    const response = await fetch(
      request("/data/write", {
        operations: [{ op: "insert", collection: "entries", data: { title: "x" } }],
      }),
    );
    expect(response.status).toBe(403);
    const again = (await (
      await fetch(request("/data/query", { collection: "entries" }))
    ).json()) as { records: unknown[] };
    expect(again.records).toHaveLength(2);
  });
});
