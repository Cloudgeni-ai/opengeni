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

test("uploaded source visibility misses do not become invalid-JSON errors", async () => {
  const json = JSON.stringify({
    entrypoint: "index.html",
    files: [{ path: "index.html", content: "<h1>Hi</h1>" }],
  });
  let reads = 0;
  const storage = {
    getObjectBytes: async () => (++reads === 1 ? null : { bytes: new TextEncoder().encode(json) }),
  };
  await expect(
    validateSiteSource(storage as never, "source.json", json.length),
  ).resolves.toBeUndefined();
  expect(reads).toBe(2);
});

test("source read failures retain their cause without retrying", async () => {
  let reads = 0;
  const error = new Error("storage denied");
  const storage = {
    getObjectBytes: async () => {
      reads++;
      throw error;
    },
  };
  await expect(validateSiteSource(storage as never, "source.json", 10)).rejects.toBe(error);
  expect(reads).toBe(1);
});
