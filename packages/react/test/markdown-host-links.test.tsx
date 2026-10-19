import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "../src/components/markdown";
import {
  OpenGeniLinkProvider,
  type OpenGeniHostLink,
  type OpenGeniLinkRenderer,
} from "../src/components/open-geni-links";

const FILE = "33333333-3333-4333-8333-333333333333";

function recording(draw: (link: OpenGeniHostLink) => ReturnType<OpenGeniLinkRenderer>) {
  const seen: Array<{ href: string; standalone: boolean }> = [];
  const renderLink: OpenGeniLinkRenderer = (link) => {
    seen.push({ href: link.href, standalone: link.standalone });
    return draw(link);
  };
  return { seen, renderLink };
}

function hostChip(link: OpenGeniHostLink) {
  return link.href.startsWith("myapp:") ? (
    <span data-host-chip={link.href} data-standalone={String(link.standalone)}>
      {link.children}
    </span>
  ) : undefined;
}

describe("host-owned links in agent Markdown", () => {
  test("the host draws its own scheme from the exact authored href", () => {
    const { seen, renderLink } = recording(hostChip);
    const html = renderToStaticMarkup(
      <Markdown renderLink={renderLink}>
        {"Opened [order 42](myapp:order/42?tab=lines) for you."}
      </Markdown>,
    );
    expect(seen).toEqual([{ href: "myapp:order/42?tab=lines", standalone: false }]);
    expect(html).toContain('data-host-chip="myapp:order/42?tab=lines"');
    expect(html).toContain(">order 42</span>");
    expect(html).not.toContain("<a ");
  });

  test("a link alone in a paragraph or list item is standalone and its paragraph is a block", () => {
    const { seen, renderLink } = recording(hostChip);
    const html = renderToStaticMarkup(
      <Markdown renderLink={renderLink}>
        {[
          "[Order 42](myapp:order/42)",
          "",
          "- [Order 43](myapp:order/43)",
          "- see [order 44](myapp:order/44) too",
          "",
          "**[Order 45](myapp:order/45)**",
        ].join("\n")}
      </Markdown>,
    );
    expect(seen).toEqual([
      { href: "myapp:order/42", standalone: true },
      { href: "myapp:order/43", standalone: true },
      { href: "myapp:order/44", standalone: false },
      { href: "myapp:order/45", standalone: false },
    ]);
    expect(html).toContain(
      '<div class="my-2.5 leading-7 first:mt-0 last:mb-0"><span data-host-chip="myapp:order/42"',
    );
    expect(html).not.toContain("data-og-standalone");
  });

  test("undefined keeps the default link, which is still sanitized", () => {
    const { renderLink } = recording(() => undefined);
    const html = renderToStaticMarkup(
      <Markdown renderLink={renderLink}>
        {"[Docs](https://example.com/docs) and [bad](javascript:alert(1)) and [own](myapp:x)"}
      </Markdown>,
    );
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("myapp:");
    expect(html.match(/\(link unavailable\)/g)).toHaveLength(2);
  });

  test("without a renderer, unknown schemes stay unavailable and paragraphs stay paragraphs", () => {
    const html = renderToStaticMarkup(<Markdown>{"[Order](myapp:order/42)"}</Markdown>);
    expect(html).not.toContain("myapp:");
    expect(html).toContain("(link unavailable)");
    expect(html).toContain("<p ");
    expect(html).not.toContain("data-og-standalone");
  });

  test("Opengeni object links never reach the host renderer", () => {
    const { seen, renderLink } = recording(() => <span>host</span>);
    const html = renderToStaticMarkup(
      <Markdown renderLink={renderLink} artifactHref={(id) => `/download/${id}`}>
        {`[Export](artifact:${FILE})`}
      </Markdown>,
    );
    expect(seen).toEqual([]);
    expect(html).toContain(`href="/download/${FILE}"`);
  });

  test("a provider renderer applies below it, and the Markdown prop is asked first", () => {
    const outer = recording((link) => <span data-outer={link.href}>{link.children}</span>);
    const viaProvider = renderToStaticMarkup(
      <OpenGeniLinkProvider renderLink={outer.renderLink}>
        <Markdown>{"[Page](/projects/7)"}</Markdown>
      </OpenGeniLinkProvider>,
    );
    expect(viaProvider).toContain('data-outer="/projects/7"');

    const inner = recording(hostChip);
    const both = renderToStaticMarkup(
      <OpenGeniLinkProvider renderLink={outer.renderLink}>
        <Markdown renderLink={inner.renderLink}>{"[A](myapp:a) [B](/b)"}</Markdown>
      </OpenGeniLinkProvider>,
    );
    expect(both).toContain('data-host-chip="myapp:a"');
    expect(both).toContain('data-outer="/b"');
  });
});
