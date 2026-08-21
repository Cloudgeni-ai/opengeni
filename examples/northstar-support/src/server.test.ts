import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { staticResponse } from "./server";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Northstar production static serving", () => {
  test("serves precompressed hashed assets and HEAD without streaming directories", async () => {
    const root = await fixture();
    const asset = await staticResponse(
      new Request("https://demo.opengeni.ai/assets/app-abc123.js", {
        headers: { "accept-encoding": "br, gzip" },
      }),
      "/assets/app-abc123.js",
      root,
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-encoding")).toBe("gzip");
    expect(asset.headers.get("vary")).toBe("Accept-Encoding");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(
      await new Response(asset.body!.pipeThrough(new DecompressionStream("gzip"))).text(),
    ).toBe("export const ready = true;\n");

    const identity = await staticResponse(
      new Request("https://demo.opengeni.ai/assets/app-abc123.js"),
      "/assets/app-abc123.js",
      root,
    );
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(await identity.text()).toBe("export const ready = true;\n");

    const head = await staticResponse(
      new Request("https://demo.opengeni.ai/", { method: "HEAD" }),
      "/",
      root,
    );
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("cache-control")).toBe("no-cache");

    const directory = await staticResponse(
      new Request("https://demo.opengeni.ai/assets/"),
      "/assets/",
      root,
    );
    expect(directory.status).toBe(404);
  });

  test("does not turn missing assets or path traversal into the SPA shell", async () => {
    const root = await fixture();
    expect(
      (
        await staticResponse(
          new Request("https://demo.opengeni.ai/assets/missing.js"),
          "/assets/missing.js",
          root,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await staticResponse(
          new Request("https://demo.opengeni.ai/%2e%2e%2fsecret"),
          "/%2e%2e%2fsecret",
          root,
        )
      ).status,
    ).toBe(404);
    const spa = await staticResponse(
      new Request("https://demo.opengeni.ai/inbox/TKT-2847"),
      "/inbox/TKT-2847",
      root,
    );
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("Northstar");
    expect(spa.headers.get("cache-control")).toBe("no-cache");
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "northstar-static-"));
  roots.push(root);
  await mkdir(join(root, "assets"));
  const js = "export const ready = true;\n";
  await Bun.write(join(root, "index.html"), "<!doctype html><title>Northstar</title>");
  await Bun.write(join(root, "assets", "app-abc123.js"), js);
  await Bun.write(join(root, "assets", "app-abc123.js.gz"), Bun.gzipSync(js));
  return root;
}
