import { expect, test } from "bun:test";
import { isRetainedImageContentType } from "../src/timeline/retained-image";

test("retained image previews have a closed MIME allowlist", () => {
  for (const type of [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/svg+xml",
  ]) {
    expect(isRetainedImageContentType(type)).toBe(true);
  }
  for (const type of [
    "text/html",
    "application/pdf",
    "image/tiff",
    "image/png; charset=utf-8",
    "image/png\n",
    "",
  ]) {
    expect(isRetainedImageContentType(type)).toBe(false);
  }
});
