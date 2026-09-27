import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsPageHeader, SettingsRow, SettingsSection } from "./settings-layout";

test("shared settings hierarchy uses one page title and labelled sections", () => {
  const html = renderToStaticMarkup(
    <>
      <SettingsPageHeader title="Models" description="Choose model access." context="Example org" />
      <SettingsSection id="model-default" title="Default model" description="For new sessions">
        <SettingsRow
          title="Model"
          description="OpenGeni credits"
          action={<button>Choose model</button>}
        />
      </SettingsSection>
    </>,
  );

  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain('aria-labelledby="model-default"');
  expect(html).toContain('id="model-default"');
  expect(html).toContain("OpenGeni credits");
  expect(html).toContain("Choose model");
});
