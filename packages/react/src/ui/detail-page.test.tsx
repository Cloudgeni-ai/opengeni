import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DetailSection } from "./detail-sheet";
import {
  DetailAside,
  DetailAsideItem,
  DetailMeta,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "./detail-page";

describe("DetailPage anatomy", () => {
  test("renders the back link, a focusable h1, chips, the joined meta line and tabs", () => {
    const html = renderToStaticMarkup(
      <DetailPage back={{ label: "Variable sets", onClick: () => {} }}>
        <DetailPageHeader
          title="AWS production"
          chips={<span data-chip="">Organization</span>}
          meta={["4 variables", null, "updated 3 days ago"]}
          actions={<button type="button">Add variable</button>}
          tabs={<nav data-tabs="" />}
        />
      </DetailPage>,
    );
    expect(html).toContain("Variable sets");
    expect(html).toMatch(/<h1 tabindex="-1"[^>]*>AWS production<\/h1>/);
    expect(html).toContain("data-chip");
    expect(html).toContain("data-tabs");
    // Two parts survive (null is dropped), so exactly one separator.
    expect(html.match(/·/g)?.length).toBe(1);
  });

  test("DetailMeta skips empty parts", () => {
    const html = renderToStaticMarkup(
      <DetailMeta>{["by Maja", "", false, "in Design"]}</DetailMeta>,
    );
    expect(html).toContain("by Maja");
    expect(html).toContain("in Design");
    expect(html.match(/·/g)?.length).toBe(1);
  });

  test("sections inside the body render as page sections, and the aside is labelled", () => {
    const html = renderToStaticMarkup(
      <DetailPage>
        <DetailPageBody
          aside={
            <DetailAside label="About AWS production">
              <DetailAsideItem label="Created by">Maja Berg</DetailAsideItem>
            </DetailAside>
          }
        >
          <DetailSection title="Variables">rows</DetailSection>
        </DetailPageBody>
      </DetailPage>,
    );
    expect(html).toContain("<h2 id=");
    expect(html).toContain('aria-label="About AWS production"');
    expect(html).toContain("Created by");
  });
});
