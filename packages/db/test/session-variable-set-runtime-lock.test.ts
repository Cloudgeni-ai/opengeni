import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

describe("post-start session Variable Set runtime fence", () => {
  test("serializes replacement with first lease creation and holder publication", () => {
    const source = readFileSync(join(repoRoot, "packages/db/src/index.ts"), "utf8");
    const updateStart = source.indexOf("export async function updateSessionVariableSets(");
    const updateEnd = source.indexOf("export async function countRigs(", updateStart);
    const acquireStart = source.indexOf("async function acquireLeaseOnce(");
    const acquireEnd = source.indexOf("export async function acquireLease(", acquireStart);
    const updateSource = source.slice(updateStart, updateEnd);
    const acquireSource = source.slice(acquireStart, acquireEnd);

    expect(updateSource).toContain(
      "await lockSandboxLeaseAdmission(tx, input.workspaceId, session.sandboxGroupId)",
    );
    expect(updateSource).toContain("from sandbox_leases");
    expect(updateSource).toContain("for update");
    expect(updateSource.indexOf("for update")).toBeLessThan(
      updateSource.indexOf("from sandbox_lease_holders holder"),
    );
    expect(acquireSource).toContain(
      "await lockSandboxLeaseAdmission(tx, workspaceId, sandboxGroupId)",
    );
    expect(acquireSource.indexOf("lockSandboxLeaseAdmission")).toBeLessThan(
      acquireSource.indexOf("insert into sandbox_leases"),
    );
  });
});
