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

/**
 * Copy text that is still being prepared, such as a command around a freshly
 * minted URL. Safari only allows a clipboard write during the click itself, so
 * hand the pending text to a `ClipboardItem` where supported; otherwise wait
 * for it and copy. Resolves false when the text failed or nothing was copied.
 */
export async function copyPendingTextToClipboard(text: Promise<string>): Promise<boolean> {
  if (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  ) {
    const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
    // The caller observes a failed `text`; never leave this copy unhandled.
    blob.catch(() => {});
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    } catch {
      // Fall through: some browsers reject promised clipboard items.
    }
  }
  try {
    return await copyTextToClipboard(await text);
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
