import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BookOpenIcon } from "lucide-react";
import { CapabilityCatalogRow } from "../src/capability-catalog-row";

test("catalog rows have one action and an accessible decorative state", () => {
  for (const status of ["available", "added", "loading"] as const) {
    const html = renderToStaticMarkup(
      <CapabilityCatalogRow
        name="Research"
        description="Find and summarize project knowledge."
        icon={<BookOpenIcon aria-hidden="true" />}
        status={status}
        onOpen={() => {}}
      />,
    );
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain('class="og-capability-catalog-sr-only"');
    expect(html).not.toContain("og-capability-catalog-notice");
    expect(html).toContain("Find and summarize project knowledge.");
  }
});

test("exception states stay visible and do not imply an available connection", () => {
  for (const status of ["attention", "unavailable"] as const) {
    const html = renderToStaticMarkup(
      <CapabilityCatalogRow
        name="Notion"
        status={status}
        statusLabel="Reconnect required"
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('class="og-capability-catalog-notice"');
    expect(html).toContain("Reconnect required");
    expect(html).not.toContain("lucide-plus");
    expect(html).not.toContain("lucide-check");
  }
});

test("rows without descriptions do not invent metadata and preserve host accessibility", () => {
  const html = renderToStaticMarkup(
    <CapabilityCatalogRow
      name="Research"
      aria-label="Review Research"
      disabled
      onOpen={() => {}}
    />,
  );
  expect(html).toContain('aria-label="Review Research"');
  expect(html).toContain('disabled=""');
  expect(html).toContain("<strong>Research</strong></span>");
  expect(html).not.toContain("skills");
});
