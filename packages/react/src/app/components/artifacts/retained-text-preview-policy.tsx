export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
const extensions = new Set([
  "txt",
  "md",
  "markdown",
  "patch",
  "diff",
  "json",
  "csv",
  "ts",
  "tsx",
  "js",
  "jsx",
  "css",
  "html",
  "htm",
  "xml",
  "yaml",
  "yml",
  "py",
  "sh",
  "sql",
  "toml",
]);
const contentTypes = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/x-diff",
  "text/x-patch",
  "application/json",
  "application/xml",
  "text/xml",
  "text/html",
  "text/css",
  "text/javascript",
  "application/javascript",
  "application/yaml",
]);

export function isRetainedTextPreview(contentType: string, filename = ""): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  return (
    contentTypes.has(mime ?? "") ||
    (mime === "application/octet-stream" &&
      extensions.has(filename.split(".").pop()?.toLowerCase() ?? ""))
  );
}

export function decodeRetainedText(bytes: Uint8Array): string {
  if (bytes.byteLength > TEXT_PREVIEW_MAX_BYTES)
    throw new Error("This file is too large for inline preview (256 KiB limit).");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("This file is not UTF-8 text. Download it to open it.");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text))
    throw new Error("This file contains binary or control data. Download it to open it.");
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines.length > 5000 || lines.some((line) => line.length > 10000))
    throw new Error("This file exceeds the inline text layout limit. Download it to open it.");
  return text;
}
