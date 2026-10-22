import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readInstalledFrom } from "../src/main/accounts";

describe("readInstalledFrom", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "installed-from-"));

  test("reads the server an install script left", () => {
    const dataDir = dir();
    writeFileSync(join(dataDir, "default-server"), "https://Opengeni.Example.com/\n");
    expect(readInstalledFrom(dataDir)).toBe("https://opengeni.example.com");
  });

  test("is empty without a hint or with a bad one", () => {
    expect(readInstalledFrom(dir())).toBe("");
    const dataDir = dir();
    writeFileSync(join(dataDir, "default-server"), "not a server address\n");
    expect(readInstalledFrom(dataDir)).toBe("");
  });
});
