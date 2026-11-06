import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  compareVersions,
  parseStablePointer,
  readPinnedXaiClientVersion,
  rewriteXaiClientVersion,
  XAI_CONSTANTS_FILE,
} from "./xai-client-version-pin";

const root = resolve(import.meta.dir, "..");

describe("Grok client version pin", () => {
  test("reads and rewrites the pin in the constants file", async () => {
    const source = await readFile(resolve(root, XAI_CONSTANTS_FILE), "utf8");
    const pinned = readPinnedXaiClientVersion(source);
    expect(compareVersions(pinned, "1.0.13")).toBeGreaterThanOrEqual(0);
    const rewritten = rewriteXaiClientVersion(source, "9.8.7");
    expect(readPinnedXaiClientVersion(rewritten)).toBe("9.8.7");
    expect(rewritten.replace('"9.8.7"', `"${pinned}"`)).toBe(source);
  });

  test("accepts only a bare version as the stable pointer", () => {
    expect(parseStablePointer("1.0.70\n")).toBe("1.0.70");
    expect(parseStablePointer("1.0.70\r\n")).toBe("1.0.70");
    expect(parseStablePointer("<html>")).toBeNull();
    expect(parseStablePointer("1.0")).toBeNull();
    expect(parseStablePointer("")).toBeNull();
  });

  test("orders versions numerically", () => {
    expect(compareVersions("1.0.70", "1.0.8")).toBe(1);
    expect(compareVersions("1.0.8", "1.0.70")).toBe(-1);
    expect(compareVersions("1.1.0", "1.1.0")).toBe(0);
  });
});
