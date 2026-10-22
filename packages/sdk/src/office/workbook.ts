import { excel, office } from "./host";

/** What an add-in reports about the workbook it is open in. */
export type OfficeWorkbookInfo = {
  name: string;
  /** "Excel on the web", "Excel for Mac", "Excel for Windows"... */
  app: string;
  /** Office build, for diagnostics. */
  version: string | null;
  /** Highest supported ExcelApi requirement set, such as "1.17". */
  excelApi: string | null;
};

/** What this Office host reports about the open workbook. */
export async function describeWorkbook(): Promise<OfficeWorkbookInfo> {
  const Office = office();
  let name: string | null = null;
  try {
    name = await excel().run(async (context) => {
      const workbook = (context as { workbook: { name: string; load(p: string): void } }).workbook;
      workbook.load("name");
      await (context as { sync(): Promise<void> }).sync();
      return workbook.name;
    });
  } catch {
    name = null;
  }
  if (!name) {
    const url = Office.context.document?.url ?? "";
    name = decodeURIComponent(url.split(/[\\/]/u).pop()?.split("?")[0] ?? "") || null;
  }
  const diagnostics = Office.context.diagnostics;
  const platform = diagnostics?.platform ?? Office.context.platform ?? "";
  const app =
    platform === "OfficeOnline"
      ? "Excel on the web"
      : platform === "Mac"
        ? "Excel for Mac"
        : platform === "PC"
          ? "Excel for Windows"
          : platform === "iOS"
            ? "Excel for iPad"
            : "Excel";
  const versions = ["1.20", "1.19", "1.18", "1.17", "1.16", "1.15", "1.14", "1.13", "1.12"];
  const excelApi =
    versions.find((version) => Office.context.requirements.isSetSupported("ExcelApi", version)) ??
    null;
  return {
    name: name ?? "Untitled workbook",
    app,
    version: diagnostics?.version ?? null,
    excelApi,
  };
}

/**
 * The per-message context naming the connected workbook, so the agent knows
 * which workbook "here" is. `addinName` is the add-in as the person knows it.
 */
export function workbookContextItem(input: {
  workbook: OfficeWorkbookInfo;
  connectionId: string;
  addinName: string;
}): { id: string; text: string } {
  return {
    id: "excel-workbook",
    text: `The person is writing from the ${input.addinName} add-in in their open Excel workbook "${input.workbook.name}" (${input.workbook.app}). To read or change it, call excel_run with workbook "${input.connectionId}".`,
  };
}
