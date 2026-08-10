import { describe, expect, test } from "bun:test";
import type { AttemptToolResult } from "@opengeni/contracts";

import { createOpenGeniCodemode, type CodemodeCallOptions, type CodemodeClient } from "../src";

const artifact = {
  id: "a".repeat(32),
  modality: "spreadsheet" as const,
  title: "Plan",
  lifecycle: "active" as const,
  headSequence: 0,
  stateHash: `sha256:${"b".repeat(64)}`,
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
};

describe("authored artifact CodeMode facade", () => {
  test("creates, edits, inspects, and exports through exact artifacts paths", async () => {
    const fake = fakeClient((path) => {
      if (path === "artifacts.create") return result(artifact);
      if (path === "artifacts.apply") {
        return result({
          artifact: { ...artifact, headSequence: 1 },
          transaction: {
            id: "c".repeat(32),
            clientTransactionId: "call-1",
            sequenceStart: 1,
            sequenceEnd: 1,
            stateHash: `sha256:${"d".repeat(64)}`,
            committedAt: "2026-08-10T10:00:01.000Z",
            replayed: false,
          },
        });
      }
      if (path === "artifacts.inspect") {
        return result({ artifact: { ...artifact, headSequence: 1 }, projection: { sheets: 1 } });
      }
      if (path === "artifacts.export") {
        return result({
          artifact,
          versionId: "version-1",
          jobId: "job-1",
          sourceHeadSequence: 1,
          sourceStateHash: `sha256:${"d".repeat(64)}`,
          state: "pending",
        });
      }
      if (path === "artifacts.exportStatus") {
        return result({
          artifact,
          versionId: "version-1",
          jobId: "job-1",
          sourceHeadSequence: 1,
          sourceStateHash: `sha256:${"d".repeat(64)}`,
          state: "succeeded",
          errorCode: null,
          file: { fileId: "11111111-1111-4111-8111-111111111111" },
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const openGeni = createOpenGeniCodemode(fake.client);
    const workbook = await openGeni.artifacts.create("spreadsheet", "Plan");
    await workbook.apply([
      { kind: "sheet.create", sheetId: "1".repeat(32) as never, name: "Data", after: null },
    ]);
    expect(
      await workbook.inspect({
        kind: "workbook-metadata",
        query: { maxSheets: 16, maxBytes: 16_384 },
      }),
    ).toMatchObject({ projection: { sheets: 1 } });
    const exported = await workbook.export("xlsx");
    expect(exported).toMatchObject({
      sourceHeadSequence: 1,
      sourceStateHash: `sha256:${"d".repeat(64)}`,
    });
    expect(await exported.status()).toMatchObject({
      state: "succeeded",
      file: { fileId: "11111111-1111-4111-8111-111111111111" },
    });

    expect(fake.calls.map((call) => call.path)).toEqual([
      "artifacts.create",
      "artifacts.apply",
      "artifacts.inspect",
      "artifacts.export",
      "artifacts.exportStatus",
    ]);
    expect(fake.calls[1]?.args).toMatchObject({
      artifactId: artifact.id,
      modality: "spreadsheet",
      expectedHeadSequence: artifact.headSequence,
      expectedStateHash: artifact.stateHash,
      commands: [{ kind: "sheet.create", name: "Data" }],
    });
  });

  test("resolves immutable modality once when using an artifact by id", async () => {
    const fake = fakeClient((path) => {
      if (path === "artifacts.get") return result(artifact);
      if (path === "artifacts.inspect") return result({ artifact, projection: { ok: true } });
      throw new Error(`Unexpected path: ${path}`);
    });
    const workbook = createOpenGeniCodemode(fake.client).artifacts.use(artifact.id);

    await workbook.inspect({
      kind: "workbook-metadata",
      query: { maxSheets: 16, maxBytes: 16_384 },
    });
    await workbook.inspect({
      kind: "workbook-metadata",
      query: { maxSheets: 16, maxBytes: 16_384 },
    });

    expect(fake.calls.map((call) => call.path)).toEqual([
      "artifacts.get",
      "artifacts.inspect",
      "artifacts.inspect",
    ]);
  });

  test("creates canonical stable and document object ids without a server round trip", () => {
    const ids = createOpenGeniCodemode(fakeClient(() => result({})).client).artifacts.ids;

    expect(ids.stable()).toMatch(/^(?!0{16})[0-9a-f]{16}(?!0{16}$)[0-9a-f]{16}$/u);
    expect(ids.document("paragraph", "42")).toMatch(/^p\/000000000000002a[0-9a-f]{16}$/u);
    expect(ids.document("tracked-change", 42n)).toMatch(/^chg\/000000000000002a[0-9a-f]{16}$/u);
    expect(() => ids.document("table", "01")).toThrow("unsigned decimal integer");
    expect(() => ids.document("table", -1)).toThrow("unsigned decimal integer");
  });
});

function result(
  structuredContent: NonNullable<AttemptToolResult["structuredContent"]>,
): AttemptToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function fakeClient(execute: (path: string, args: Record<string, unknown>) => AttemptToolResult): {
  client: CodemodeClient;
  calls: Array<{ path: string; args: Record<string, unknown>; options: CodemodeCallOptions }>;
} {
  const calls: Array<{
    path: string;
    args: Record<string, unknown>;
    options: CodemodeCallOptions;
  }> = [];
  const client = {
    callPath: async (
      path: readonly string[],
      args: Record<string, unknown>,
      options: CodemodeCallOptions,
    ) => {
      calls.push({ path: path.join("."), args, options });
      return execute(path.join("."), args);
    },
  } as CodemodeClient;
  return { client, calls };
}
