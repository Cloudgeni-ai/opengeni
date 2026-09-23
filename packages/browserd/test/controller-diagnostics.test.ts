import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainControllerDiagnostic } from "../src/controller-diagnostics";

test("retains only two bounded owner-only controller logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "controller-diagnostics-test-"));
  try {
    for (const line of ["first\n", "second\n", "third\n"])
      retainControllerDiagnostic(root, line, 8);
    const path = join(root, "controller-errors.jsonl");
    expect(await readFile(path, "utf8")).toBe("third\n");
    expect(await readFile(`${path}.1`, "utf8")).toBe("second\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
