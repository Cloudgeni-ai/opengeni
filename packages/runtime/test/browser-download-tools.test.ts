import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BrowserDownload, Permission } from "@opengeni/contracts";
import { OpenGeniApiError, type InteractionTransport } from "@opengeni/sdk";
import { createInteractionAttemptToolDefinitions } from "../src/interaction-tools";

const workspaceId = randomUUID();
const sessionId = randomUUID();
const browserSessionId = randomUUID();
const downloadId = randomUUID();
const operationId = randomUUID();
const download: BrowserDownload = {
  id: downloadId,
  browserSessionId,
  controllerGeneration: "controller-1",
  targetId: "tab-1",
  filename: "synthetic.csv",
  status: "completed",
  receivedBytes: 12,
  totalBytes: 12,
  sha256: "a".repeat(64),
  version: 2,
  startedAt: "2026-08-10T12:00:00.000Z",
  settledAt: "2026-08-10T12:00:01.000Z",
  failureCode: null,
};
const listing = { browserSessionId, controllerGeneration: "controller-1", downloads: [download] };
const context = { operationId, caller: { kind: "model" as const, subjectId: "model:test" } };
const saveInput = { browserSessionId, downloadId, destinationPath: "exports/synthetic.csv" };
const saved = {
  download,
  destinationPath: saveInput.destinationPath,
  fileId: randomUUID(),
  operationId,
  replayed: false,
};

function definitions(
  transport: Partial<InteractionTransport> = {},
  permissions: Permission[] = ["sessions:read", "sessions:control", "files:upload"],
) {
  return createInteractionAttemptToolDefinitions({
    transport: transport as InteractionTransport,
    workspaceId,
    sessionId,
    selectedTools: ["browser_downloads", "browser_download_save"],
    permissions,
  });
}

describe("browser download attempt tools", () => {
  test("requires both save permissions without restricting read-only discovery", () => {
    for (const permissions of [[], ["sessions:control"], ["files:upload"]] as Permission[][]) {
      expect(definitions({}, permissions)).toHaveLength(0);
    }
    expect(
      definitions({}, ["sessions:read", "sessions:control"]).map((tool) => tool.identity.toolName),
    ).toEqual(["browser_downloads"]);
    expect(definitions().map((tool) => tool.identity.toolName)).toEqual([
      "browser_downloads",
      "browser_download_save",
    ]);
    expect(
      definitions({}, ["sessions:control", "files:upload"]).map((tool) => tool.identity.toolName),
    ).toEqual(["browser_download_save"]);
    expect(definitions()[0]!.annotations?.readOnlyHint).toBe(true);
    expect(definitions()[1]!.annotations?.readOnlyHint).toBe(false);
  });

  test("routes the exact resource and reuses the journaled save operation id", async () => {
    const calls: unknown[] = [];
    let saves = 0;
    const [read, save] = definitions({
      listBrowserDownloads: async (...args) => {
        calls.push(args);
        return listing;
      },
      getBrowserDownload: async (...args) => {
        calls.push(args);
        return download;
      },
      saveBrowserDownload: async (...args) => {
        calls.push(args);
        return { ...saved, replayed: saves++ > 0 };
      },
    });
    expect((await read!.execute({ browserSessionId }, context)).structuredContent).toEqual(listing);
    expect(
      (await read!.execute({ browserSessionId, operation: "get", downloadId }, context))
        .structuredContent,
    ).toEqual(download);
    expect((await save!.execute(saveInput, context)).structuredContent).toEqual(saved);
    expect((await save!.execute(saveInput, context)).structuredContent).toEqual({
      ...saved,
      replayed: true,
    });
    const request = { operationId, destinationPath: saveInput.destinationPath, overwrite: false };
    expect(calls).toEqual([
      [workspaceId, browserSessionId],
      [workspaceId, browserSessionId, downloadId],
      [workspaceId, browserSessionId, downloadId, request],
      [workspaceId, browserSessionId, downloadId, request],
    ]);
  });

  test("rejects invalid resource queries and non-relative destinations before dispatch", async () => {
    let calls = 0;
    const unexpected = async () => {
      calls++;
      throw new Error("Unexpected dispatch");
    };
    const [read, save] = definitions({
      listBrowserDownloads: unexpected,
      getBrowserDownload: unexpected,
      saveBrowserDownload: unexpected,
    });
    for (const args of [
      { browserSessionId, operation: "get" },
      { browserSessionId, operation: "list", downloadId },
    ]) {
      expect(await read!.execute(args, context)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "invalid_arguments" } },
      });
    }
    for (const destinationPath of [
      "../export.csv",
      "/workspace/export.csv",
      "exports/../export.csv",
    ]) {
      expect(await save!.execute({ ...saveInput, destinationPath }, context)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "invalid_arguments" } },
      });
    }
    expect(calls).toBe(0);
  });

  test("rejects another session, controller, download or save operation binding", async () => {
    for (const response of [
      { ...listing, browserSessionId: randomUUID() },
      { ...listing, controllerGeneration: "stale-controller" },
    ]) {
      const [read] = definitions({ listBrowserDownloads: async () => response });
      await expect(read!.execute({ browserSessionId }, context)).rejects.toThrow(
        "another session binding",
      );
    }
    const [read] = definitions({
      getBrowserDownload: async () => ({ ...download, id: randomUUID() }),
    });
    await expect(
      read!.execute({ browserSessionId, operation: "get", downloadId }, context),
    ).rejects.toThrow("another resource");
    for (const response of [
      { ...saved, operationId: randomUUID() },
      { ...saved, download: { ...download, browserSessionId: randomUUID() } },
      { ...saved, destinationPath: "other.csv" },
    ]) {
      const [, save] = definitions({ saveBrowserDownload: async () => response });
      await expect(save!.execute(saveInput, context)).rejects.toThrow("another operation binding");
    }
  });

  test("preserves definite unsupported and stale-controller refusals", async () => {
    for (const code of ["unsupported", "browser_controller_authority_changed"]) {
      const refusal = async () => {
        throw new OpenGeniApiError(422, "Browser download is unavailable", {
          code,
          retryable: false,
          outcomeUnknown: false,
        });
      };
      const [read, save] = definitions({
        listBrowserDownloads: refusal,
        saveBrowserDownload: refusal,
      });
      for (const [tool, args] of [
        [read!, { browserSessionId }],
        [save!, saveInput],
      ] as const) {
        expect(await tool.execute(args, context)).toMatchObject({
          isError: true,
          structuredContent: { error: { code, retryable: false } },
        });
      }
    }
  });

  test("does not convert uncertain save outcomes into a retryable result", async () => {
    const error = new OpenGeniApiError(503, "Save outcome unknown", { outcomeUnknown: true });
    const [, save] = definitions({
      saveBrowserDownload: async () => {
        throw error;
      },
    });
    await expect(save!.execute(saveInput, context)).rejects.toBe(error);
  });
});
