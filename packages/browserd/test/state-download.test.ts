import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BrowserStateDownloadError,
  downloadBrowserStateArtifact,
  validateDownloadAuthority,
} from "../src";

describe("browser state download transport", () => {
  test("downloads exactly the authorized immutable byte envelope", async () => {
    const bytes = Buffer.from("authenticated-encrypted-browser-profile", "utf8");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(bytes, {
          headers: { "content-length": String(bytes.byteLength) },
        });
      },
    });
    const directory = await mkdtemp("/tmp/ogb-state-download-");
    const path = join(directory, "profile.ogbs");
    try {
      await downloadBrowserStateArtifact(
        path,
        authority(`${server.url}/profile?signature=private`),
        bytes.byteLength,
      );
      expect(await readFile(path)).toEqual(bytes);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed on truncation, excess bytes, redirects, and expired grants", async () => {
    const directory = await mkdtemp("/tmp/ogb-state-download-fail-");
    const path = join(directory, "profile.ogbs");
    const server = Bun.serve({
      port: 0,
      fetch(request): Response {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/redirect") {
          return new Response(null, {
            status: 302,
            headers: { location: "/exact" },
          });
        }
        const bytes = pathname === "/short" ? Buffer.from("123") : Buffer.from("12345");
        return new Response(bytes);
      },
    });
    try {
      await expect(
        downloadBrowserStateArtifact(path, authority(`${server.url}/short`), 5),
      ).rejects.toBeInstanceOf(BrowserStateDownloadError);
      await expect(stat(path)).rejects.toThrow();
      await expect(
        downloadBrowserStateArtifact(path, authority(`${server.url}/exact`), 3),
      ).rejects.toBeInstanceOf(BrowserStateDownloadError);
      await expect(stat(path)).rejects.toThrow();
      await expect(
        downloadBrowserStateArtifact(path, authority(`${server.url}/redirect`), 5),
      ).rejects.toBeInstanceOf(BrowserStateDownloadError);
      expect(() =>
        validateDownloadAuthority(
          {
            url: `${server.url}/exact`,
            expiresAt: "2026-08-10T00:00:00.000Z",
          },
          new Date("2026-08-10T00:00:01.000Z"),
        ),
      ).toThrow("expired");
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function authority(url: string) {
  return {
    url,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}
