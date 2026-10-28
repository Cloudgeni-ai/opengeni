import { expect, test } from "bun:test";
import { nameContainsWords } from "../src/locator-name";

test("a locator name matches whole words of an accessible name, in any case and spacing", () => {
  expect(nameContainsWords("Save as draft", "Save")).toBe(true);
  expect(nameContainsWords("Save as draft", "as  DRAFT")).toBe(true);
  expect(nameContainsWords("Ask in plain language", "plain language")).toBe(true);
  expect(nameContainsWords("OK", "ok")).toBe(true);
  expect(nameContainsWords("Next →", "Next")).toBe(true);
  expect(nameContainsWords("Download (2 files)", "(2 files)")).toBe(true);
  expect(nameContainsWords("e-mail address", "mail")).toBe(true);
  expect(nameContainsWords("Lagre utkast", "lagre")).toBe(true);
  expect(nameContainsWords("anything", "")).toBe(true);

  expect(nameContainsWords("Watch it happen in the workbook.", "OK")).toBe(false);
  expect(nameContainsWords("Address", "Add")).toBe(false);
  expect(nameContainsWords("Saved", "Save")).toBe(false);
  expect(nameContainsWords("Lagre utkast", "agre")).toBe(false);
  expect(nameContainsWords("Ökonomie", "konomie")).toBe(false);
  expect(nameContainsWords(null, "OK")).toBe(false);
  // A later occurrence can still be a whole word.
  expect(nameContainsWords("Bookings: book now", "book")).toBe(true);
});

test("scripts without spaces between words match any part of a name", () => {
  expect(nameContainsWords("保存草稿", "保存")).toBe(true);
  expect(nameContainsWords("ファイルを開く", "開く")).toBe(true);
  expect(nameContainsWords("บันทึกร่าง", "ร่าง")).toBe(true);
});
