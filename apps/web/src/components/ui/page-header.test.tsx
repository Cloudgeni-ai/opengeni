import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PageHeader, PageHeaderStyleProvider } from "./page-header";

const icon = <svg data-icon="schedules" />;

describe("PageHeader", () => {
  test("shows the icon by default and hides it inside a settings provider", () => {
    expect(renderToStaticMarkup(<PageHeader title="Schedules" icon={icon} />)).toContain(
      'data-icon="schedules"',
    );
    const settings = renderToStaticMarkup(
      <PageHeaderStyleProvider icon="hide">
        <PageHeader title="Variable sets" icon={icon} />
      </PageHeaderStyleProvider>,
    );
    expect(settings).not.toContain("data-icon");
    expect(settings).toContain("Variable sets");
  });

  test("showIcon overrides the provider, and the large variant never shows an icon", () => {
    const forced = renderToStaticMarkup(
      <PageHeaderStyleProvider icon="hide">
        <PageHeader title="Knowledge" icon={icon} showIcon />
      </PageHeaderStyleProvider>,
    );
    expect(forced).toContain('data-icon="schedules"');

    const large = renderToStaticMarkup(
      <PageHeaderStyleProvider variant="large">
        <PageHeader title="General" icon={icon} showIcon />
      </PageHeaderStyleProvider>,
    );
    expect(large).not.toContain("data-icon");
    expect(large).toContain('data-variant="large"');
    expect(large).toContain("text-2xl");
  });

  test("nested providers inherit what they don't set", () => {
    const html = renderToStaticMarkup(
      <PageHeaderStyleProvider variant="large">
        <PageHeaderStyleProvider icon="show">
          <PageHeader title="People" icon={icon} />
        </PageHeaderStyleProvider>
      </PageHeaderStyleProvider>,
    );
    expect(html).toContain('data-variant="large"');
    expect(html).not.toContain("data-icon");
  });

  test("the hairline sits under the header unless tabs replace it", () => {
    const plain = renderToStaticMarkup(<PageHeader title="Schedules" />);
    expect(plain).toContain("border-b");

    const tabbed = renderToStaticMarkup(
      <PageHeader title="Knowledge" tabs={<div data-tabs="knowledge" />} />,
    );
    expect(tabbed).not.toContain("border-b");
    expect(tabbed).toContain('data-tabs="knowledge"');
  });

  test("renders one h1 with context, description and actions in their slots", () => {
    const html = renderToStaticMarkup(
      <PageHeader
        title="People"
        context="Acme Robotics"
        description="Everyone in Acme Robotics."
        actions={<button type="button">Invite people</button>}
      />,
    );
    expect(html.match(/<h1/g)?.length).toBe(1);
    expect(html).toContain('data-slot="page-header-context"');
    expect(html).toContain("Everyone in Acme Robotics.");
    expect(html).toMatch(/data-slot="page-header-actions"[^>]*shrink-0/);
  });
});
