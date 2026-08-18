import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const versions = readFileSync("packages/contracts/src/editable-artifact-versions.ts", "utf8");
const registry = readFileSync("packages/contracts/src/editable-artifact-codec-registry.ts", "utf8");
const runtime = readFileSync("packages/artifact-tool/src/runtime.ts", "utf8");
const adapter = readFileSync(
  "packages/sdk/src/editable-artifacts/worker/kernel-adapter.ts",
  "utf8",
);

describe("editable artifact version boundaries", () => {
  test("keeps direct workbook and durable collaboration snapshots on independent axes", () => {
    expect(versions).toContain("SPREADSHEET_KERNEL_SNAPSHOT_VERSION");
    expect(versions).toContain("SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION");
    expect(versions).not.toContain("SPREADSHEET_ARTIFACT_SNAPSHOT_VERSION");

    expect(registry).toContain("snapshotVersion: SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION");
    expect(registry).not.toContain("SPREADSHEET_KERNEL_SNAPSHOT_VERSION");
    expect(runtime).toContain("kernelSnapshotVersion: SPREADSHEET_KERNEL_SNAPSHOT_VERSION");
    expect(runtime).toContain(
      "collaborationSnapshotVersion: SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION",
    );
    expect(adapter).toContain(
      "normalized.kernelSnapshotVersion !== SPREADSHEET_KERNEL_SNAPSHOT_VERSION",
    );
    expect(adapter).toContain(
      "normalized.collaborationSnapshotVersion !== SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION",
    );
  });
});
