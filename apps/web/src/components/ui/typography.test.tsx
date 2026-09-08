import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PersonalWorkspaceBadge } from "../personal-workspace-badge";
import { FormField } from "./content-layout";

test("form labels share the standard small-text size without enlarging hints", () => {
  const html = renderToStaticMarkup(
    <FormField label="Name" hint="A descriptive name">
      <input />
    </FormField>,
  );
  expect(html).toContain("text-sm font-medium");
  expect(html).toContain("text-2xs font-normal leading-4");
});

test("Personal uses the existing metadata size and preserves accessible text", () => {
  const html = renderToStaticMarkup(<PersonalWorkspaceBadge />);
  expect(html).toContain("text-2xs font-medium");
  expect(html).not.toContain("text-[10px]");
  expect(html).not.toContain("leading-none");
  expect(html).toContain("Personal workspace");
});
