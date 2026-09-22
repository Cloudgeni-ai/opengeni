import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { WorkspaceArtifactOperationError } from "@opengeni/db";
import { retryWhileMissing } from "@opengeni/storage";
import { readArtifactObject } from "../src/site-uploads";

// Exercise the private production streaming boundary without a database or a
// duplicate implementation. AST selection keeps this seam exact and fail-fast.
const source = readFileSync(new URL("../src/site-uploads.ts", import.meta.url), "utf8");
const parsed = parseSync("site-uploads.ts", source);
expect(parsed.errors).toEqual([]);
const declaration = parsed.program.body.find(
  (node) => node.type === "FunctionDeclaration" && node.id?.name === "freeze",
);
if (!declaration) throw new Error("Site freeze boundary missing");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
  source.slice(declaration.start, declaration.end),
);
const freeze = new Function(
  "readArtifactObject",
  "WorkspaceArtifactOperationError",
  "retryWhileMissing",
  `${compiled}; return freeze;`,
)(readArtifactObject, WorkspaceArtifactOperationError, retryWhileMissing) as (
  storage: unknown,
  from: string,
  to: string,
  contentType: string,
  optional?: boolean,
) => Promise<number | null>;

function fixture(created = true, visibilityMisses = Infinity) {
  const bytes = new TextEncoder().encode("<h1>Site</h1>");
  let writes = 0;
  let destinationReads = 0;
  const storage = {
    maxSinglePutSizeBytes: 10000,
    headObject: async (key: string) => {
      if (key === "upload") return { ContentLength: bytes.length, VersionToken: "source-version" };
      destinationReads++;
      return writes && destinationReads > visibilityMisses
        ? { ContentLength: 42, VersionToken: "winner-version" }
        : null;
    },
    getObjectRange: async ({ expectedVersionToken }: { expectedVersionToken: string }) => {
      expect(expectedVersionToken).toBe("source-version");
      return { bytes, versionToken: "source-version" };
    },
    putObjectStreamIfAbsent: async ({ chunks }: { chunks: AsyncIterable<Uint8Array> }) => {
      writes++;
      for await (const chunk of chunks) expect(chunk).toEqual(bytes);
      return created;
    },
  };
  return { storage, bytes, writes: () => writes, destinationReads: () => destinationReads };
}

test("a committed Site write needs no following HEAD to prove success", async () => {
  const f = fixture();
  await expect(freeze(f.storage, "upload", "frozen", "text/html")).resolves.toBe(f.bytes.length);
  expect(f.writes()).toBe(1);
  expect(f.destinationReads()).toBe(1);
});

test("a conditional conflict observes the winner after a transient visibility miss without rewriting", async () => {
  const f = fixture(false, 2);
  await expect(freeze(f.storage, "upload", "frozen", "text/html")).resolves.toBe(42);
  expect(f.writes()).toBe(1);
  expect(f.destinationReads()).toBe(3);
});

test("a failed PUT is not converted into success or blindly retried", async () => {
  const f = fixture();
  const failure = new Error("storage write failed");
  f.storage.putObjectStreamIfAbsent = async () => {
    throw failure;
  };
  await expect(freeze(f.storage, "upload", "frozen", "text/html")).rejects.toBe(failure);
  expect(f.destinationReads()).toBe(1);
});

test("an existing frozen winner is reused without reading or writing the mutable upload", async () => {
  const f = fixture();
  f.storage.headObject = async (key) => {
    expect(key).toBe("frozen");
    return { ContentLength: 42, VersionToken: "winner-version" };
  };
  await expect(freeze(f.storage, "upload", "frozen", "text/html")).resolves.toBe(42);
  expect(f.writes()).toBe(0);
});

test("a conflict with a permanently missing winner fails clearly and never rewrites", async () => {
  const f = fixture(false);
  await expect(freeze(f.storage, "upload", "frozen", "text/html")).rejects.toThrow(
    "Retry publication with the same upload",
  );
  expect(f.writes()).toBe(1);
  expect(f.destinationReads()).toBe(9);
});

test("source version changes still fail the transfer", async () => {
  const f = fixture();
  f.storage.getObjectRange = async () => ({ bytes: f.bytes, versionToken: "changed" });
  await expect(freeze(f.storage, "upload", "frozen", "text/html")).rejects.toThrow(
    "changed during transfer",
  );
});

test("invalid UTF-8 still rejects the upload", async () => {
  const f = fixture();
  const bytes = new Uint8Array(f.bytes.length).fill(255);
  f.storage.getObjectRange = async () => ({ bytes, versionToken: "source-version" });
  await expect(freeze(f.storage, "upload", "frozen", "text/html")).rejects.toThrow();
});

test("optional absent source stays optional and causes no writes", async () => {
  const f = fixture();
  f.storage.headObject = async () => null;
  await expect(freeze(f.storage, "upload", "frozen", "application/json", true)).resolves.toBeNull();
  expect(f.writes()).toBe(0);
});
