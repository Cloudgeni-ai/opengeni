import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Section, SectionStack } from "./section";

function headingId(html: string): string | undefined {
  return html.match(/<h[23] id="([^"]+)"/)?.[1];
}

describe("Section", () => {
  test("is labelled by its heading, at the requested level", () => {
    const html = renderToStaticMarkup(
      <Section title="Agent activity" headingLevel={3}>
        <div>Running</div>
      </Section>,
    );
    const id = headingId(html);
    expect(id).toBeTruthy();
    expect(html).toContain(`aria-labelledby="${id}"`);
    expect(html).toContain("<h3");
  });

  test("inherits the variant from SectionStack; its own prop wins", () => {
    const html = renderToStaticMarkup(
      <SectionStack variant="group">
        <Section title="Workspace">
          <div>Name</div>
        </Section>
        <Section title="Delete workspace" variant="open" />
      </SectionStack>,
    );
    expect(html).toContain('data-slot="section" data-variant="group"');
    expect(html).toContain('data-slot="section" data-variant="open"');
    // Boxed sections are spaced, not ruled.
    expect(html).toMatch(/data-slot="section-stack" data-variant="group" class="[^"]*gap-8/);
  });

  test("open stacks are divided by hairlines by default", () => {
    const html = renderToStaticMarkup(
      <SectionStack>
        <Section title="Workspace" />
        <Section title="Agent activity" />
      </SectionStack>,
    );
    expect(html).toMatch(/data-slot="section-stack"[^>]*divide-y/);
  });

  test("renders no rows container without children, and one with them", () => {
    expect(renderToStaticMarkup(<Section title="Delete workspace" />)).not.toContain(
      "section-content",
    );
    const html = renderToStaticMarkup(
      <Section title="Workspace" variant="tiles">
        <div>Name</div>
      </Section>,
    );
    expect(html).toMatch(/data-slot="section-content"[^>]*\[&amp;&gt;\*\]:rounded-\[14px\]/);
  });

  test("puts the action next to the title, centred on the title line", () => {
    const html = renderToStaticMarkup(
      <Section title="Used by" action={<button type="button">Add to a schedule</button>} />,
    );
    expect(html).toMatch(/data-slot="section-action" class="[^"]*h-5[^"]*items-center/);
  });

  test("on narrow widths the description clears an action that overhangs the title line", () => {
    const withAction = renderToStaticMarkup(
      <Section
        title="Used by"
        description="What turns on AWS production today."
        action={<button type="button">Add to a schedule</button>}
      />,
    );
    expect(withAction).toMatch(
      /data-slot="section-description" class="[^"]*col-span-2 mt-2\.5 @md\/section-header:col-span-1 @md\/section-header:mt-1/,
    );
    const plain = renderToStaticMarkup(
      <Section title="Workspace" description="The name people see." />,
    );
    expect(plain).toMatch(/data-slot="section-description" class="[^"]*mt-1/);
    expect(plain).not.toContain("mt-2.5");
  });
});
