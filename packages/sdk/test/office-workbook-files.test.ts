import { describe, expect, test } from "bun:test";
import { runOfficeCode } from "../src/office/executor";
import {
  bytesToBase64,
  joinSlices,
  workbookCopyFilename,
  XLSX_CONTENT_TYPE,
} from "../src/office/workbook-file";
import { WorkbookLink, type WorkbookFiles } from "../src/office/workbook-link";
import type { RetainedArtifactReference } from "../src/types";

const teaser = {
  artifactId: "44444444-4444-4444-8444-444444444444",
  contentType: XLSX_CONTENT_TYPE,
} as RetainedArtifactReference;

function link(input: {
  files?: WorkbookFiles;
  readFile?: () => Promise<Uint8Array>;
  value?: unknown;
}) {
  const runs: { code: string; files: unknown }[] = [];
  const instance = new WorkbookLink({
    ticket: () => Promise.reject(new Error("unused")),
    onState: () => undefined,
    ...(input.files ? { files: input.files } : {}),
    readFile: input.readFile ?? (async () => new Uint8Array([80, 75, 3, 4])),
    run: async (code, files) => {
      runs.push({ code, files });
      return { ok: true, value: input.value ?? null, logs: [], durationMs: 1 };
    },
  });
  return { instance, runs };
}

describe("workbook files", () => {
  test("agent code gets the chat files as `files`", async () => {
    const result = await runOfficeCode(
      "return files.map((file) => file.name + ':' + file.base64);",
      async (batch) => batch({}),
      {},
      undefined,
      [{ artifactId: "a", name: "Teaser.xlsx", contentType: XLSX_CONTENT_TYPE, base64: "UEs=" }],
    );
    expect(result).toMatchObject({ ok: true, value: ["Teaser.xlsx:UEs="] });
  });

  test("downloads the files, runs the code, then uploads a copy with the chat's scope", async () => {
    const uploads: unknown[] = [];
    const { instance, runs } = link({
      files: {
        download: async (artifact) => {
          expect(artifact.artifactId).toBe(teaser.artifactId);
          return new Uint8Array([1, 2, 3]);
        },
        upload: async (file) => {
          uploads.push(file);
          return { id: "55555555-5555-4555-8555-555555555555" };
        },
      },
    });
    const result = await instance.execute({
      code: "return 1",
      files: [{ name: "Teaser.xlsx", artifact: teaser }],
      saveCopy: { filename: "Fjordlager model", scope: "workspace" },
    });
    expect(runs).toEqual([
      {
        code: "return 1",
        files: [
          {
            artifactId: teaser.artifactId,
            name: "Teaser.xlsx",
            contentType: XLSX_CONTENT_TYPE,
            base64: "AQID",
          },
        ],
      },
    ]);
    expect(uploads).toEqual([
      {
        filename: "Fjordlager model.xlsx",
        contentType: XLSX_CONTENT_TYPE,
        data: new Uint8Array([80, 75, 3, 4]),
        scope: "workspace",
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      copy: { fileId: "55555555-5555-4555-8555-555555555555", filename: "Fjordlager model.xlsx" },
    });
  });

  test("a failed copy keeps the code's result and says why", async () => {
    const { instance } = link({
      value: 7,
      files: {
        download: async () => new Uint8Array(),
        upload: async () => {
          throw new Error("File upload timed out. Retry the upload.");
        },
      },
    });
    expect(
      await instance.execute({
        code: "return 7",
        files: [],
        saveCopy: { filename: "Book.xlsx", scope: "personal" },
      }),
    ).toMatchObject({
      ok: true,
      value: 7,
      copy: { error: "File upload timed out. Retry the upload." },
    });
  });

  test("an add-in without file access refuses file work before running anything", async () => {
    const { instance, runs } = link({});
    const result = await instance.execute({
      code: "return 1",
      files: [],
      saveCopy: { filename: "Book", scope: "personal" },
    });
    expect(result).toMatchObject({ ok: false, error: { name: "FilesUnavailable" } });
    expect(runs).toEqual([]);
  });

  test("copy names always end in .xlsx and carry no path characters", () => {
    expect(workbookCopyFilename("Quarterly rent roll")).toBe("Quarterly rent roll.xlsx");
    expect(workbookCopyFilename("Budget.xlsm")).toBe("Budget.xlsx");
    expect(workbookCopyFilename("../a/b:c.xlsx")).toBe(".. a b c.xlsx");
    expect(workbookCopyFilename("  ")).toBe("Workbook.xlsx");
  });

  test("joins Office's slices and encodes large files", () => {
    expect(joinSlices([[1, 2], new Uint8Array([3])])).toEqual(new Uint8Array([1, 2, 3]));
    const big = new Uint8Array(200_000).map((_, index) => index % 251);
    expect(Buffer.from(bytesToBase64(big), "base64")).toEqual(Buffer.from(big));
  });
});
