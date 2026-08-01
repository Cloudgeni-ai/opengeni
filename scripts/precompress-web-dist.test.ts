import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { precompressWebDist } from "./precompress-web-dist";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("web asset precompression", () => {
  test("writes deterministic gzip siblings only for useful text assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-precompress-"));
    roots.push(root);
    await Bun.write(join(root, "app.js"), "export const value = 1;\n".repeat(200));
    await Bun.write(join(root, "small.css"), "x{}");
    await Bun.write(join(root, "binary.bin"), new Uint8Array(2_048));

    expect(await precompressWebDist(root)).toBe(1);
    const first = new Uint8Array(await Bun.file(join(root, "app.js.gz")).arrayBuffer());
    expect(await precompressWebDist(root)).toBe(1);
    const second = new Uint8Array(await Bun.file(join(root, "app.js.gz")).arrayBuffer());
    expect(first).toEqual(second);
    expect(await Bun.file(join(root, "small.css.gz")).exists()).toBe(false);
    expect(await Bun.file(join(root, "binary.bin.gz")).exists()).toBe(false);
  });
});
