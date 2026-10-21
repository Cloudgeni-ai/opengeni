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

  test("logos render as images with an empty alt, on the surface when padded", () => {
    const cover = renderToStaticMarkup(<LogoTile src="/slack.png" name="Slack" />);
    expect(cover).toContain('src="/slack.png"');
    expect(cover).toContain('alt=""');
    expect(cover).toContain("object-cover");
    const contain = renderToStaticMarkup(<LogoTile src="/gmail.ico" fit="contain" name="Gmail" />);
    expect(contain).toContain("object-contain");
    expect(contain).toContain("bg-surface ");
  });
});
