import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LogoTile, LogoTileSizeProvider, logoMonogram } from "./logo-tile";

describe("LogoTile", () => {
  test("monograms take the first letter or digit", () => {
    expect(logoMonogram("GitHub automation")).toBe("G");
    expect(logoMonogram("  3Min API")).toBe("3");
    expect(logoMonogram("ødegaard")).toBe("Ø");
    expect(logoMonogram(undefined)).toBe("?");
  });

  test("is decorative unless it has a label", () => {
    expect(renderToStaticMarkup(<LogoTile name="Slack" />)).toContain('aria-hidden="true"');
    const labelled = renderToStaticMarkup(<LogoTile name="Slack" label="Slack" />);
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="Slack"');
  });

  test("a glyph wins over the monogram, and an explicit size wins over the container", () => {
    const html = renderToStaticMarkup(
      <LogoTileSizeProvider size="sm">
        <LogoTile name="Variable set" icon={<svg data-glyph="" />} />
        <LogoTile name="Codex" monogram="C" size="lg" />
      </LogoTileSizeProvider>,
    );
    expect(html).toContain("data-glyph");
    expect(html).not.toContain(">V<");
    expect(html.match(/data-size="(\w+)"/g)).toEqual(['data-size="sm"', 'data-size="lg"']);
  });

  test("logos render as images with an empty alt; padded marks sit on a light plate", () => {
    const cover = renderToStaticMarkup(<LogoTile src="/slack.png" fit="cover" name="Slack" />);
    expect(cover).toContain('src="/slack.png"');
    expect(cover).toContain('alt=""');
    expect(cover).toContain("object-cover");
    expect(cover).toContain('data-fit="cover"');
    const contain = renderToStaticMarkup(<LogoTile src="/gmail.ico" fit="contain" name="Gmail" />);
    expect(contain).toContain("object-contain");
    expect(contain).toContain("bg-surface dark:bg-fg");
  });

  test("by default an image stays hidden until it is measured, so it never jumps", () => {
    const html = renderToStaticMarkup(<LogoTile src="/unmeasured.png" name="Unmeasured" />);
    expect(html).toContain('data-fit="pending"');
    expect(html).toContain("opacity-0");
  });
});
