import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWebHandler } from "./server";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production web handler", () => {
  test("serves compressed immutable assets and revalidating SPA fallbacks", async () => {
    const root = await fixture();
    const handler = createWebHandler(root);
    const asset = await handler(
      new Request("https://example.test/assets/app-abc123.js", {
        headers: { "accept-encoding": "br, gzip" },
      }),
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-encoding")).toBe("gzip");
    expect(asset.headers.get("vary")).toBe("Accept-Encoding");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(
      await new Response(asset.body!.pipeThrough(new DecompressionStream("gzip"))).text(),
    ).toBe("export const ready = true;\n");

    const route = await handler(new Request("https://example.test/workspaces/ws/sessions/id"));
    expect(route.headers.get("cache-control")).toBe("no-cache");
    expect(await route.text()).toContain("OpenGeni");
  });

  test("does not turn missing assets or path traversal into the SPA shell", async () => {
    const root = await fixture();
    const handler = createWebHandler(root);
    expect((await handler(new Request("https://example.test/assets/missing.js"))).status).toBe(404);
    expect((await handler(new Request("https://example.test/%2e%2e%2fsecret"))).status).toBe(400);
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opengeni-web-handler-"));
  roots.push(root);
  await mkdir(join(root, "assets"), { recursive: true });
  await Bun.write(join(root, "index.html"), "<!doctype html><title>OpenGeni</title>");
  await Bun.write(join(root, "assets/app-abc123.js"), "export const ready = true;\n");
  await Bun.write(
    join(root, "assets/app-abc123.js.gz"),
    Bun.gzipSync("export const ready = true;\n"),
  );
  return root;
}
