import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "..", "src", "index.ts"), "utf8");
const inventorySource = source.slice(
  source.indexOf("export async function getDocumentInventory"),
  source.indexOf("export async function getDocumentBase"),
);

describe("document inventory bounds", () => {
  test("validates every row and label limit before opening the RLS query", () => {
    const rlsAt = inventorySource.indexOf("return await withWorkspaceRls");
    expect(source).toContain("DOCUMENT_INVENTORY_MAX_BASE_LIMIT = 100");
    expect(source).toContain("DOCUMENT_INVENTORY_MAX_TOPIC_LIMIT = 100");
    expect(source).toContain("DOCUMENT_INVENTORY_MAX_TOPIC_CHARS = 256");
    expect(inventorySource.indexOf("input.baseLimit")).toBeLessThan(rlsAt);
    expect(inventorySource.indexOf("input.topicLimit")).toBeLessThan(rlsAt);
    expect(inventorySource.indexOf("input.topicMaxChars")).toBeLessThan(rlsAt);
  });

  test("projects only aggregate columns and bounds base/topic rows in SQL", () => {
    expect(inventorySource).toContain("count(*)::int");
    expect(inventorySource).toContain("count(distinct ${schema.documents.id})::int");
    expect(inventorySource).toContain("max(${schema.documents.updatedAt})");
    expect(inventorySource).toContain(".limit(baseLimit)");
    expect(inventorySource).toContain(".limit(topicLimit + 1)");
    expect(inventorySource.match(/documentAccessConditions\(input\.access\)/g)).toHaveLength(2);
    expect(inventorySource).toContain(".where(documentWhere)");
    expect(inventorySource).toMatch(/\.where\(\s*and\(\s*documentWhere,/);
    expect(inventorySource).not.toContain(".select()");
    expect(inventorySource).not.toContain("mapDocument(");
  });

  test("retains JSON type and extracts only non-empty string topic elements", () => {
    expect(inventorySource).toContain("jsonb_array_elements(${schema.documents.topics})");
    expect(inventorySource).toContain("jsonb_typeof(topic.value) = 'string'");
    expect(inventorySource).toContain("topic.value #>> '{}'");
    expect(inventorySource).toContain("normalize(${topicStringValue}, NFKC)");
    expect(inventorySource).toContain("count(distinct ${schema.documents.id})::int");
    expect(inventorySource).not.toContain("jsonb_array_elements_text");
  });
});
