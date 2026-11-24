import { expect, test } from "bun:test";
import { INLINE_APP_SOURCE_MAX_BYTES, inlineAppSource } from "../src/site-uploads";

function storage(objects: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    getObjectBytes: async (key: string) => {
      reads.push(key);
      if (key === "broken") throw new Error("storage down");
      const text = objects[key];
      return text === undefined
        ? null
        : { bytes: new TextEncoder().encode(text), contentType: "text/plain" };
    },
  };
}

const ref = (sourceKey: string | null, sizeBytes: number, sourceSizeBytes: number | null) => ({
  contentKey: "page.html",
  sourceKey,
  version: { sizeBytes, sourceSizeBytes },
});

test("a small app's source and server code come back as text, so no download is needed", async () => {
  const objects = { "source.json": '{"title":"Issues"}', "a.js": "export default 1", "b.js": "x" };
  const result = await inlineAppSource(storage(objects), ref("source.json", 999, 18), [
    { key: "a.js", sizeBytes: 16 },
    { key: "b.js", sizeBytes: 1 },
  ]);
  expect(result).toEqual({ page: '{"title":"Issues"}', server: ["export default 1", "x"] });
});

test("without source JSON the HTML is the page", async () => {
  const result = await inlineAppSource(
    storage({ "page.html": "<main>hi</main>" }),
    ref(null, 15, null),
    [],
  );
  expect(result).toEqual({ page: "<main>hi</main>", server: [] });
});

test("what does not fit the budget, or cannot be read, is left to its signed URL", async () => {
  const store = storage({ "page.html": "<main>big</main>", "a.js": "small", "c.js": "\uFFFD" });
  const result = await inlineAppSource(store, ref(null, INLINE_APP_SOURCE_MAX_BYTES + 1, null), [
    { key: "a.js", sizeBytes: 5 },
    { key: "broken", sizeBytes: 5 },
    { key: "missing", sizeBytes: 5 },
    { key: "huge.js", sizeBytes: INLINE_APP_SOURCE_MAX_BYTES },
  ]);
  expect(result).toEqual({ page: null, server: ["small", null, null, null] });
  // Oversized objects are never read.
  expect(store.reads).not.toContain("page.html");
  expect(store.reads).not.toContain("huge.js");
});

test("text that is not valid UTF-8 is left out", async () => {
  const result = await inlineAppSource(
    {
      getObjectBytes: async () => ({ bytes: new Uint8Array([0xff, 0xfe]), contentType: "x" }),
    },
    ref(null, 2, null),
    [],
  );
  expect(result.page).toBeNull();
});
