import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

/** The build-time proof that `uuidgen` exists and prints a random (v4) UUID. */
const UUIDGEN_SMOKE =
  "uuidgen | grep -Eqx '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'";

describe("sandbox shell tools", () => {
  test("both sandbox images install uuidgen and prove it prints a v4 UUID during the build", async () => {
    const dockerfiles = await Promise.all(
      ["docker/sandbox.Dockerfile", "docker/desktop.Dockerfile"].map(async (path) => ({
        path,
        source: await readFile(resolve(root, path), "utf8"),
      })),
    );
    for (const { path, source } of dockerfiles) {
      // On Debian, uuidgen ships in uuid-runtime; util-linux alone lacks it.
      expect({ path, installs: /\buuid-runtime\b/u.test(source) }).toEqual({
        path,
        installs: true,
      });
      const smoke = source.indexOf(UUIDGEN_SMOKE);
      expect({ path, smoke: smoke >= 0 }).toEqual({ path, smoke: true });
      // The proof runs in the same layer that installs the package.
      const layerStart = source.lastIndexOf("\nRUN ", smoke);
      expect(source.slice(layerStart, smoke)).toContain("uuid-runtime");
    }
  });

  test("the smoke pattern accepts only a version 4 UUID", () => {
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    expect(UUIDGEN_SMOKE).toContain(pattern.source.slice(1, -1));
    expect(pattern.test(crypto.randomUUID())).toBe(true);
    expect(pattern.test("")).toBe(false);
    // A time-based (v1) UUID, as `uuidgen -t` prints, is refused.
    expect(pattern.test("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(false);
  });
});
