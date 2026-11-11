// `excel_run`: Office.js code, live in a workbook the person has open with an
// Excel add-in (office-workbooks.ts). The agent acts as the person its turn
// works for and reaches only that person's workbooks in the session's workspace.
import type { AccessGrant } from "@opengeni/contracts";
import {
  EXCEL_ADDIN_CAPABILITY_ID,
  excelAddin,
  requireLiveAgentAttemptAuthorization,
  type ApiRouteDeps,
  type ExcelAddin,
} from "@opengeni/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  OFFICE_RUN_DEFAULT_TIMEOUT_MS,
  OFFICE_RUN_MAX_TIMEOUT_MS,
  type OfficeRunExtras,
  type OfficeWorkbook,
  type OfficeWorkbookCopy,
} from "../office-workbooks";
import {
  OfficeWorkbookFileError,
  officeRunFiles,
  publishWorkbookCopy,
  workbookCopyScope,
} from "../office-workbook-files";
import { officeWorkbookRelayFor } from "../routes/office-workbooks";

export const EXCEL_RUN_MAX_CODE_CHARS = 200_000;
export const EXCEL_RUN_MAX_FILES = 5;
const MAX_RESULT_CHARS = 40_000;

export { excelAddin, type ExcelAddin };

const DESCRIPTION = [
  "Run Office.js code live in an Excel workbook the person has open with the Excel add-in (Excel on the web, Windows or Mac).",
  "`code` is the body of an async function called inside Excel.run with `context` and `Excel`: queue operations on `context.workbook`, `load` every property you will read and `await context.sync()` before reading it, then `return` a small JSON-serializable result with only what you need. console.log output is returned too.",
  "Each `get…()` call returns a new unloaded object, so keep the one you loaded in a variable; a sheet's `name` must be loaded too, and range properties are plural (`values`, `formulas`).",
  "Changes appear in the person's workbook at once and may not be undoable, so look before you change anything and change only what was asked.",
  "A failure returns Office's error code, message and failing statement; operations synced before the failure stay applied.",
  "Omit `workbook` when one workbook is open; otherwise the error lists the open workbooks to choose from.",
  "To open chat files in Excel, pass their artifactIds in `files`: the code gets them as `files[i]` with `name` and `base64`, for `Excel.createWorkbook(files[0].base64)` (a new workbook) or `context.workbook.insertWorksheetsFromBase64(files[0].base64)` (sheets into this one).",
  "To give the person the workbook as a file, pass `saveCopyAs` with a file name: after the code runs, a copy of the whole workbook with its unsaved changes is saved to this chat as an .xlsx, and the result's `copy` gives the artifactId to link as [name](artifact:<artifactId>). `code` may then be omitted.",
  `When someone works on a spreadsheet and no workbook is connected, offer the Excel add-in: capability_authorization_request with ${EXCEL_ADDIN_CAPABILITY_ID} shows its install card.`,
].join(" ");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function textResult(value: unknown, isError = false): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function listed(workbooks: OfficeWorkbook[]): string {
  return workbooks.map((each) => `"${each.name}" (id ${each.id}, ${each.app})`).join("; ");
}

/** The workbook `wanted` names (id, or a unique name), or why there is none. */
export function chooseWorkbook(
  workbooks: OfficeWorkbook[],
  wanted: string | undefined,
  addin: ExcelAddin,
): { workbook: OfficeWorkbook } | { error: string } {
  if (workbooks.length === 0) {
    return {
      error: [
        `No Excel workbook is connected. Ask the person to open the workbook in Excel and open the ${addin.name} add-in (Home > Add-ins > ${addin.name}), then try again.`,
        addin.installUrl
          ? `If they haven't added ${addin.name} to Excel yet, give them this link, which shows how: ${addin.installUrl}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  const name = wanted?.trim();
  if (!name) {
    if (workbooks.length === 1) return { workbook: workbooks[0]! };
    return {
      error: `Several workbooks are open; pass \`workbook\` with one of: ${listed(workbooks)}.`,
    };
  }
  const byId = workbooks.find((each) => each.id === name);
  if (byId) return { workbook: byId };
  const lowered = name.toLowerCase();
  const byName = workbooks.filter(
    (each) =>
      each.name.toLowerCase() === lowered ||
      each.name.toLowerCase().replace(/\.(xlsx|xlsm|xlsb|xls|csv)$/u, "") === lowered,
  );
  if (byName.length === 1) return { workbook: byName[0]! };
  return {
    error:
      byName.length > 1
        ? `More than one open workbook is named "${name}"; pass its id: ${listed(byName)}.`
        : `No open workbook matches "${name}". Open workbooks: ${listed(workbooks)}.`,
  };
}

function boundedJson(value: unknown): { json: string; truncated: boolean } {
  let json: string;
  try {
    json = JSON.stringify(value === undefined ? null : value) ?? "null";
  } catch {
    json = JSON.stringify(String(value));
  }
  return json.length > MAX_RESULT_CHARS
    ? { json: json.slice(0, MAX_RESULT_CHARS), truncated: true }
    : { json, truncated: false };
}

/** The person whose workbooks this session's agent reaches: the human its turn works for. */
async function workbookOwner(deps: ApiRouteDeps, grant: AccessGrant, sessionId: string) {
  const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
  return {
    subjectId: attempt.initiatingHumanSubjectId ?? grant.subjectId,
    workspaceId: grant.workspaceId,
  };
}

/** Setup status of the Excel add-in tile for this session's person. */
export async function excelAddinSetup(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
): Promise<
  | { status: "ready"; action: null; detail: string }
  | { status: "authorization_required"; action: "connect"; detail: string }
  | { status: "unavailable"; action: null; detail: string }
> {
  const addin = excelAddin(deps.settings);
  if (!addin.installUrl) {
    return {
      status: "unavailable",
      action: null,
      detail: "This deployment has no Excel add-in install page configured.",
    };
  }
  const workbooks = await officeWorkbookRelayFor(deps).list(
    await workbookOwner(deps, grant, sessionId),
  );
  if (workbooks.length > 0) {
    return {
      status: "ready",
      action: null,
      detail: `Connected workbooks: ${listed(workbooks)}. Use excel_run.`,
    };
  }
  return {
    status: "authorization_required",
    action: "connect",
    detail: `No workbook is connected. The card links to ${addin.installUrl}, which shows how to add ${addin.name} to Excel; then the person opens it in their workbook (Home > Add-ins > ${addin.name}).`,
  };
}

export function registerExcelTools(input: {
  server: McpServer;
  deps: ApiRouteDeps;
  grant: AccessGrant;
  sessionId: string;
  authorize: () => Promise<void>;
}): void {
  const { server, deps, grant, sessionId, authorize } = input;
  server.registerTool(
    "excel_run",
    {
      description: DESCRIPTION,
      inputSchema: {
        code: z
          .string()
          .min(1)
          .max(EXCEL_RUN_MAX_CODE_CHARS)
          .optional()
          .describe(
            "Body of an async function (context, Excel, console, files). Use await context.sync().",
          ),
        workbook: z
          .string()
          .trim()
          .max(300)
          .optional()
          .describe("Workbook id or name. Omit when only one workbook is open."),
        files: z
          .array(z.string().uuid())
          .min(1)
          .max(EXCEL_RUN_MAX_FILES)
          .optional()
          .describe("artifactIds of chat files to hand to the code as `files`."),
        saveCopyAs: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("File name for a copy of the workbook saved to this chat after the code runs."),
      },
    },
    async ({ code, workbook: wanted, files: fileIds, saveCopyAs }) => {
      await authorize();
      if (!code && !saveCopyAs) return textResult("Pass `code`, `saveCopyAs`, or both.", true);
      const owner = await workbookOwner(deps, grant, sessionId);
      const relay = officeWorkbookRelayFor(deps);
      const addin = excelAddin(deps.settings);
      const chosen = chooseWorkbook(await relay.list(owner), wanted, addin);
      if ("error" in chosen) return textResult(chosen.error, true);
      const { workbook } = chosen;
      const extras: OfficeRunExtras = {};
      try {
        if (fileIds?.length) extras.files = await officeRunFiles(deps, grant, fileIds);
        if (saveCopyAs) {
          extras.saveCopy = {
            filename: saveCopyAs,
            scope: await workbookCopyScope(deps, grant, sessionId),
          };
        }
      } catch (error) {
        if (error instanceof OfficeWorkbookFileError) return textResult(error.message, true);
        throw error;
      }
      const outcome = await relay.run(
        owner,
        workbook.id,
        code ?? "",
        // Moving files takes longer than code alone.
        extras.files || extras.saveCopy ? OFFICE_RUN_MAX_TIMEOUT_MS : OFFICE_RUN_DEFAULT_TIMEOUT_MS,
        extras,
      );
      const where = { id: workbook.id, name: workbook.name };
      switch (outcome.kind) {
        case "ok": {
          const { json, truncated } = boundedJson(outcome.value);
          const copy = outcome.copy ? await savedCopy(outcome.copy) : null;
          return textResult(
            `{"workbook":${JSON.stringify(where)},"result":${json}${
              truncated ? ',"truncated":"the result was cut; return less"' : ""
            }${outcome.logs.length ? `,"logs":${JSON.stringify(outcome.logs)}` : ""}${
              copy ? `,"copy":${JSON.stringify(copy)}` : ""
            },"ms":${Math.round(outcome.durationMs)}}`,
          );
        }
        case "error":
          return textResult(
            {
              workbook: where,
              error: Object.fromEntries(
                Object.entries(outcome.error).filter(([, value]) => value !== null),
              ),
              ...(outcome.logs.length ? { logs: outcome.logs } : {}),
            },
            true,
          );
        case "disconnected":
          return textResult(
            `The workbook "${workbook.name}" is no longer connected. Ask the person to reopen the ${addin.name} add-in in it.`,
            true,
          );
        case "unknown":
          return textResult(
            `Outcome unknown in "${workbook.name}": ${outcome.reason} Check the workbook's state before retrying.`,
            true,
          );
      }
    },
  );

  /** The copy the add-in uploaded, published to this chat, or why there is none. */
  async function savedCopy(copy: OfficeWorkbookCopy): Promise<Record<string, unknown>> {
    if ("error" in copy) return { error: `The code ran, but no copy was saved: ${copy.error}` };
    try {
      const receipt = await publishWorkbookCopy(deps, { grant, sessionId, fileId: copy.fileId });
      return {
        artifactId: receipt.artifactId,
        filename: receipt.filename,
        sizeBytes: receipt.sizeBytes,
        whoCanOpen: receipt.access.whoCanOpen,
      };
    } catch (error) {
      if (error instanceof OfficeWorkbookFileError)
        return { error: `The code ran, but no copy was saved: ${error.message}` };
      throw error;
    }
  }
}
