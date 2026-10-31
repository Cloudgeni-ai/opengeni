import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

/** The build-time proof that `uuidgen` exists and prints a random (v4) UUID. */
const UUIDGEN_SMOKE =
  "uuidgen | grep -Eqx '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'";

const DOCKERFILES = ["docker/sandbox.Dockerfile", "docker/desktop.Dockerfile"];

async function dockerfiles(): Promise<Array<{ path: string; source: string }>> {
  return Promise.all(
    DOCKERFILES.map(async (path) => ({
      path,
      source: await readFile(resolve(root, path), "utf8"),
    })),
  );
}

/** The RUN instruction that contains `index`. */
function layerAt(source: string, index: number): string {
  const start = source.lastIndexOf("\nRUN ", index);
  const next = source.slice(index).search(/\n(?:RUN|COPY|ENV|ARG|FROM|WORKDIR|USER) /u);
  return source.slice(start, next < 0 ? source.length : index + next);
}

describe("sandbox shell tools", () => {
  test("both sandbox images install uuidgen and prove it prints a v4 UUID during the build", async () => {
    for (const { path, source } of await dockerfiles()) {
      // On Debian, uuidgen ships in uuid-runtime; util-linux alone lacks it.
      expect({ path, installs: /\buuid-runtime\b/u.test(source) }).toEqual({
        path,
        installs: true,
      });
      const smoke = source.indexOf(UUIDGEN_SMOKE);
      expect({ path, smoke: smoke >= 0 }).toEqual({ path, smoke: true });
      // The proof runs in the same layer that installs the package.
      expect(layerAt(source, smoke)).toContain("uuid-runtime");
    }
  });

  test("both sandbox images install the PDF page tools and run them during the build", async () => {
    for (const { path, source } of await dockerfiles()) {
      // AnyDoc's Markdown has no page boundaries; pdftotext -f/-l and pdfinfo do.
      const smoke = source.indexOf("pdftotext -v");
      expect({ path, smoke: smoke >= 0 }).toEqual({ path, smoke: true });
      const layer = layerAt(source, smoke);
      expect(layer).toMatch(/\bpoppler-utils\b/u);
      expect(layer).toContain("pdfinfo -v");
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
