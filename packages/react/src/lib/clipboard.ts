/**
 * Copy plain text to the clipboard. Prefers the async Clipboard API; falls
 * back to a short-lived textarea for older embeds / denied permissions.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const value = text.replace(/\u00a0/g, " ");
  if (value.length === 0) {
    return false;
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to execCommand path.
  }
  if (typeof document === "undefined") {
    return false;
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    area.style.top = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** Serialize an HTML table to tab-separated values (spreadsheet-friendly). */
export function tableElementToTsv(table: HTMLTableElement | null | undefined): string {
  if (!table) {
    return "";
  }
  const rows = Array.from(table.querySelectorAll("tr"));
  return rows
    .map((row) =>
      Array.from(row.querySelectorAll("th,td"))
        .map((cell) => {
          const raw = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
          if (/[\t\n"]/.test(raw)) {
            return `"${raw.replace(/"/g, '""')}"`;
          }
          return raw;
        })
        .join("\t"),
    )
    .filter((line) => line.length > 0)
    .join("\n");
}
