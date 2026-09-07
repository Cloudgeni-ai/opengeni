import { expect, test } from "bun:test";
import { MAX_SITE_SOURCE_BYTES, validateSiteSource } from "../src/site-uploads";

test("oversized source is rejected before buffering; HTML is not part of this limit", async () => {
  let read = false;
  const storage = {
    getObjectBytes: async () => {
      read = true;
      throw new Error("must not read");
    },
  };
  await expect(
    validateSiteSource(storage as never, "source.json", MAX_SITE_SOURCE_BYTES + 1),
  ).rejects.toThrow("64 MiB");
  expect(read).toBe(false);
});

test("source validation accepts editable files and rejects malformed JSON", async () => {
  for (const [json, valid] of [
    [
      JSON.stringify({
        entrypoint: "index.html",
        files: [{ path: "index.html", content: "<h1>Hi</h1>" }],
      }),
      true,
    ],
    ["not json", false],
  ] as const) {
    const storage = { getObjectBytes: async () => ({ bytes: new TextEncoder().encode(json) }) };
    const result = validateSiteSource(storage as never, "source.json", json.length);
    if (valid) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow("Source must be JSON");
  }
});
