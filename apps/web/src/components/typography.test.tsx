import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FormField } from "@opengeni/react/ui/content-layout";

test("form labels share the standard small-text size without enlarging hints", () => {
  const html = renderToStaticMarkup(
    <FormField label="Name" hint="A descriptive name">
      <input />
    </FormField>,
  );
  expect(html).toContain("text-sm font-medium");
  expect(html).toContain("text-2xs font-normal leading-4");
});
