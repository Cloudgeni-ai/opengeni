import { expect, test } from "bun:test";
import { categories, selectionText } from "./options";
test("every use case has alternatives and distinct identifiers", () => {
  expect(new Set(categories.map((item) => item.id)).size).toBe(categories.length);
  for (const category of categories) {
    expect(category.options.length).toBeGreaterThanOrEqual(2);
    expect(new Set(category.options.map((option) => option.id)).size).toBe(category.options.length);
  }
});
test("selection summary does not infer approval or choose unselected categories", () => {
  const result = selectionText(
    { rows: "comfortable", multiple: "disclosed" },
    "Keep Insights unchanged",
  );
  expect(result).toContain("Settings rows: Comfortable rows");
  expect(result).toContain("Resource lists: Not selected");
  expect(result).toContain("Multiple selection: Expandable checklist");
  expect(result).toContain("not implementation approval");
  expect(result).toContain("Keep Insights unchanged");
});
