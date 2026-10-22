import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "@opengeni/db";
import { getDocumentInventory, type DocumentInventoryInput } from "../src";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "..", "src", "index.ts"), "utf8");
const inventorySource = source.slice(
  source.indexOf("export async function getDocumentInventory"),
  source.indexOf("export async function getDocumentBase"),
);

describe("document inventory bounds", () => {
  test.each([
    ["baseLimit", 100],
    ["topicLimit", 100],
    ["topicMaxChars", 256],
  ] as const)("validates %s before accessing the database", async (field, maximum) => {
    let databaseReads = 0;
    const databaseBoundary = new Error("database boundary reached");
    const db = new Proxy({} as Database, {
      get() {
        databaseReads += 1;
        throw databaseBoundary;
      },
    });
    const valid: DocumentInventoryInput = { baseLimit: 1, topicLimit: 1, topicMaxChars: 1 };
    for (const value of [-1, 0, 1.5, maximum + 1, NaN, Infinity]) {
      await expect(
        getDocumentInventory(db, "workspace", { ...valid, [field]: value }),
      ).rejects.toThrow(`${field} must be an integer between 1 and ${maximum}`);
      expect(databaseReads).toBe(0);
    }
    // Both accepted boundaries must get past validation; rejecting every input
    // would otherwise make the negative cases green without preserving the API.
    for (const value of [1, maximum]) {
      const before = databaseReads;
      await expect(
        getDocumentInventory(db, "workspace", { ...valid, [field]: value }),
      ).rejects.toBe(databaseBoundary);
      expect(databaseReads).toBeGreaterThan(before);
    }
  });

  test("projects only aggregate columns and bounds base/topic rows in SQL", () => {
    expect(inventorySource).toContain("count(*)::int");
    expect(inventorySource).toContain("count(distinct ${schema.documents.id})::int");
    expect(inventorySource).toContain("max(${schema.documents.updatedAt})");
    expect(inventorySource).toContain("${schema.documents.authorityKind} = 'organization'");
    expect(inventorySource).toContain("${schema.documents.authorityKind} = 'workspace'");
    expect(inventorySource).toContain("${schema.documents.authorityKind} = 'personal'");
    expect(inventorySource).toContain(".limit(baseLimit)");
    expect(inventorySource).toContain(".limit(topicLimit + 1)");
    expect(
      inventorySource.match(/documentAccessConditions\(workspaceId, input\.access\)/g),
    ).toHaveLength(2);
    expect(inventorySource).toContain(".where(documentWhere)");
    expect(inventorySource).toMatch(/\.where\(\s*and\(\s*documentWhere,/);
    expect(inventorySource).not.toContain(".select()");
    expect(inventorySource).not.toContain("mapDocument(");
  });

  test("retains JSON type and extracts only non-empty string topic elements", () => {
    expect(inventorySource).toContain("jsonb_array_elements(${schema.documents.topics})");
    expect(inventorySource).toContain("jsonb_typeof(topic.value) = 'string'");
    expect(inventorySource).toContain("topic.value #>> '{}'");
    expect(inventorySource).toContain(
      "btrim(regexp_replace(normalize(${topicStringValue}, NFKC), '[[:space:]]+', ' ', 'g'))",
    );
    expect(inventorySource).toContain("left(${topicNormalizedName}, ${topicMaxChars})");
    expect(inventorySource).toContain("nullif(${topicNormalizedName}, '') is not null");
    expect(inventorySource).not.toContain("nullif(btrim(${topicStringValue}), '') is not null");
    expect(inventorySource).toContain("count(distinct ${schema.documents.id})::int");
    expect(inventorySource).not.toContain("jsonb_array_elements_text");
  });
});
