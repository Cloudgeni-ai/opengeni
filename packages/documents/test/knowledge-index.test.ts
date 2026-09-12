import { expect, test } from "bun:test";
import { knowledgeIndexChunks } from "../src/knowledge-index";

test("excerpts retain exact source text and usable offsets across supplementary characters", () => {
  const content = " ".repeat(1199) + "🚀 Acme\u0000" + " terms".repeat(450) + "\n final clause  ";
  const chunks = [...knowledgeIndexChunks({ title: "Acme agreement", content })];
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks[0]!.end).toBe(1199);
  expect(chunks.at(-1)!.end).toBe(content.length);
  expect(chunks.at(-1)!.text).toEndWith("\n final clause  ");
  for (const chunk of chunks) {
    expect(chunk.text).toBe(content.slice(chunk.start, chunk.end));
    expect(chunk.embeddingInput).toStartWith("Acme agreement\n");
    expect(chunk.text.length).toBeLessThanOrEqual(1200);
    expect(chunk.field).toBe("content");
  }
  expect(chunks.some((chunk) => chunk.text.includes("🚀 Acme\u0000"))).toBe(true);
});

test("an empty group indexes its title without inventing a content quotation", () => {
  expect([...knowledgeIndexChunks({ title: "Billing API", content: "" })]).toEqual([
    {
      index: 0,
      field: "title",
      start: 0,
      end: 11,
      text: "Billing API",
      embeddingInput: "Billing API",
    },
  ]);
});
