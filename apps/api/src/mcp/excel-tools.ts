// `excel_run`: Office.js code, live in a workbook the person has open with the
// Opengeni add-in (office-workbooks.ts). The agent acts as the person its turn
// works for and reaches only that person's workbooks.
import type { AccessGrant } from "@opengeni/contracts";
import { requireLiveAgentAttemptAuthorization, type ApiRouteDeps } from "@opengeni/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { OFFICE_RUN_DEFAULT_TIMEOUT_MS, type OfficeWorkbook } from "../office-workbooks";
import { officeWorkbookRelayFor } from "../routes/office-workbooks";

export const EXCEL_RUN_MAX_CODE_CHARS = 200_000;
const MAX_RESULT_CHARS = 40_000;

const DESCRIPTION = [
  "Run Office.js code live in an Excel workbook the person has open with the Opengeni add-in (Excel on the web, Windows or Mac).",
  "`code` is the body of an async function called inside Excel.run with `context` and `Excel`: queue operations on `context.workbook`, `load` every property you will read and `await context.sync()` before reading it, then `return` a small JSON-serializable result with only what you need. console.log output is returned too.",
  "Each `get…()` call returns a new unloaded object, so keep the one you loaded in a variable; a sheet's `name` must be loaded too, and range properties are plural (`values`, `formulas`).",
  "Changes appear in the person's workbook at once and may not be undoable, so look before you change anything and change only what was asked.",
  "A failure returns Office's error code, message and failing statement; operations synced before the failure stay applied.",
  "Omit `workbook` when one workbook is open; otherwise the error lists the open workbooks to choose from.",
].join(" ");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function textResult(value: unknown, isError = false): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function listed(workbooks: OfficeWorkbook[]): string {
  return workbooks.map((each) => `"${each.name}" (id ${each.id}, ${each.app})`).join("; ");
}

/** Where this deployment's web app shows how to add the Excel add-in. */
export function excelAddinInstallUrl(webBaseUrl: string | null | undefined): string | null {
  return webBaseUrl ? `${webBaseUrl.replace(/\/+$/u, "")}/excel` : null;
}

/** The workbook `wanted` names (id, or a unique name), or why there is none. */
export function chooseWorkbook(
  workbooks: OfficeWorkbook[],
  wanted: string | undefined,
  installUrl?: string | null,
): { workbook: OfficeWorkbook } | { error: string } {
  if (workbooks.length === 0) {
    return {
      error: [
        "No Excel workbook is connected. Ask the person to open the workbook in Excel and open the Opengeni add-in (Home > Add-ins > Opengeni), then try again.",
        installUrl
          ? `If they haven't added Opengeni to Excel yet, give them this link, which shows how for Excel on the web, Mac, Windows or their whole organization: ${installUrl}`
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
          .describe("Body of an async function (context, Excel). Use await context.sync()."),
        workbook: z
          .string()
          .trim()
          .max(300)
          .optional()
          .describe("Workbook id or name. Omit when only one workbook is open."),
      },
    },
    async ({ code, workbook: wanted }) => {
      await authorize();
      const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
      const person = attempt.initiatingHumanSubjectId ?? grant.subjectId;
      const relay = officeWorkbookRelayFor(deps);
      const chosen = chooseWorkbook(
        await relay.list(person),
        wanted,
        excelAddinInstallUrl(deps.settings.webBaseUrl ?? deps.settings.publicBaseUrl),
      );
      if ("error" in chosen) return textResult(chosen.error, true);
      const { workbook } = chosen;
      const outcome = await relay.run(person, workbook.id, code, OFFICE_RUN_DEFAULT_TIMEOUT_MS);
      const where = { id: workbook.id, name: workbook.name };
      switch (outcome.kind) {
        case "ok": {
          const { json, truncated } = boundedJson(outcome.value);
          return textResult(
            `{"workbook":${JSON.stringify(where)},"result":${json}${
              truncated ? ',"truncated":"the result was cut; return less"' : ""
            }${outcome.logs.length ? `,"logs":${JSON.stringify(outcome.logs)}` : ""},"ms":${Math.round(outcome.durationMs)}}`,
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
            `The workbook "${workbook.name}" is no longer connected. Ask the person to reopen the Opengeni add-in in it.`,
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
}
