import { describe, expect, test } from "bun:test";
import type { AtlassianSelectedSource } from "@opengeni/contracts/atlassian";
import { atlassianKnowledgeSourceIdentity, inventoryAtlassianSource } from "../src/atlassian";

const source: AtlassianSelectedSource = {
  id: "confluence_space:cloud-1:20000",
  cloudId: "cloud-1",
  siteName: "OpenGeni Lab",
  siteUrl: "https://opengeni-lab.atlassian.net",
  resourceId: "20000",
  key: "SD",
  name: "Software development",
  kind: "confluence_space",
  destination: {
    authorityKind: "workspace",
    authorityAccountId: "00000000-0000-4000-8000-000000000001",
    authorityWorkspaceId: "00000000-0000-4000-8000-000000000002",
    authoritySubjectId: null,
    collectionId: null,
  },
  syncCadence: "hourly",
  syncEnabled: true,
  configGeneration: 1,
  readPolicy: "allow",
  selectedAt: "2026-08-11T00:00:00.000Z",
};

describe("Atlassian knowledge source", () => {
  test("keeps tenant, source and workspace authority stable", () => {
    expect(
      atlassianKnowledgeSourceIdentity({
        source,
        accountId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        connectionSubjectId: "user-1",
      }),
    ).toEqual({
      providerKey: "atlassian",
      externalTenantId: "cloud-1",
      externalSourceId: source.id,
      sourceKind: "atlassian-confluence-space",
      sourceUri: "https://opengeni-lab.atlassian.net/wiki/spaces/SD",
      scope: {
        kind: "workspace",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        subjectId: null,
      },
    });
  });

  test("continues cursor pagination without duplicating prior pages", async () => {
    const cursors: Array<string | null> = [];
    const result = await inventoryAtlassianSource({
      cloudId: "cloud-1",
      source,
      limits: { maxItems: 10, maxApiRequests: 10, maxElapsedMs: 10_000, pageSize: 2 },
      checkpoint: null,
      listPage: async (cursor) => {
        cursors.push(cursor);
        return cursor === null
          ? {
              items: [
                {
                  id: "1",
                  key: "1",
                  title: "Overview",
                  version: "2",
                  createdAt: "2026-08-01T00:00:00.000Z",
                  updatedAt: "2026-08-02T00:00:00.000Z",
                  webUrl: "https://opengeni-lab.atlassian.net/wiki/spaces/SD/pages/1",
                },
              ],
              nextCursor: "next-1",
            }
          : {
              items: [
                {
                  id: "2",
                  key: "2",
                  title: "Runbook",
                  version: "1",
                  createdAt: "2026-08-03T00:00:00.000Z",
                  updatedAt: "2026-08-03T00:00:00.000Z",
                  webUrl: "https://opengeni-lab.atlassian.net/wiki/spaces/SD/pages/2",
                },
              ],
              nextCursor: null,
            };
      },
    });
    expect(cursors).toEqual([null, "next-1"]);
    expect(result.status).toBe("complete");
    expect(result.entries.map((entry) => entry.externalObjectId)).toEqual([
      "confluence_space:1",
      "confluence_space:2",
    ]);
    expect(result.entries[0]?.transfer.contentType).toBe("text/markdown");
  });

  test("checkpoints the exact next cursor at the item limit", async () => {
    const result = await inventoryAtlassianSource({
      cloudId: "cloud-1",
      source,
      limits: { maxItems: 1, maxApiRequests: 10, maxElapsedMs: 10_000, pageSize: 1 },
      checkpoint: null,
      listPage: async () => ({
        items: [
          {
            id: "1",
            key: "1",
            title: "Overview",
            version: "1",
            createdAt: null,
            updatedAt: null,
            webUrl: "https://opengeni-lab.atlassian.net/wiki/spaces/SD/pages/1",
          },
        ],
        nextCursor: "next-1",
      }),
    });
    expect(result.status).toBe("paused");
    expect(result.stopReason).toBe("item_limit");
    expect(result.checkpoint?.cursor).toBe("next-1");
  });
});
