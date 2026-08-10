import { z } from "zod";

export const editableArtifactOfficeMimeType = z.enum([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export const editableArtifactReceiptText = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.trim() === value &&
      isWellFormedEditableArtifactText(value) &&
      new TextEncoder().encode(value).byteLength <= 512,
  );

export function editableArtifactOfficeMimeTypeFor(
  modality: "document" | "spreadsheet" | "presentation",
): z.infer<typeof editableArtifactOfficeMimeType> {
  return modality === "document"
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : modality === "spreadsheet"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}

export function isWellFormedEditableArtifactText(value: string): boolean {
  if (value.includes("\0")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
