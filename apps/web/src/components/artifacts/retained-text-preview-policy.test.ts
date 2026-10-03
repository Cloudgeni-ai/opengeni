import { expect, test } from "bun:test";
import {
  decodeRetainedText,
  isRetainedTextPreview,
  TEXT_PREVIEW_MAX_BYTES,
} from "./retained-text-preview-policy";

test("text selection is finite and filename fallback is only for historical octet streams", () => {
  for (const type of ["text/plain", "text/x-patch", "application/json", "text/html; charset=utf-8"])
    expect(isRetainedTextPreview(type)).toBe(true);
  expect(isRetainedTextPreview("application/octet-stream", "FIX.PATCH")).toBe(true);
  for (const type of [
    "text/unknown",
    "image/svg+xml",
    "application/pdf",
    "image/png",
    "application/zip",
  ])
    expect(isRetainedTextPreview(type, "file.txt")).toBe(false);
  expect(isRetainedTextPreview("application/octet-stream", "file.exe")).toBe(false);
});

test("strict bounded decoding preserves inert source and rejects binary/controls", () => {
  const source = "<script>alert(1)</script>\n[link](javascript:alert(1))\n\tUnicode: λ";
  expect(decodeRetainedText(new TextEncoder().encode(source))).toBe(source);
  expect(decodeRetainedText(new Uint8Array())).toBe("");
  for (const bytes of [
    new Uint8Array([0xff]),
    new Uint8Array([0]),
    new Uint8Array([27]),
    new TextEncoder().encode("\u0085"),
  ])
    expect(() => decodeRetainedText(bytes)).toThrow();
  expect(() => decodeRetainedText(new Uint8Array(TEXT_PREVIEW_MAX_BYTES + 1))).toThrow("256 KiB");
  for (const text of ["a".repeat(10001), "\n".repeat(5000), "\r".repeat(5000)])
    expect(() => decodeRetainedText(new TextEncoder().encode(text))).toThrow("layout limit");
  expect(decodeRetainedText(new TextEncoder().encode("a".repeat(10000)))).toHaveLength(10000);
});
