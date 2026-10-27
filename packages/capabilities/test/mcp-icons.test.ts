import { describe, expect, test } from "bun:test";

import { MAX_LOGO_BYTES, decodeDataUriIcon, mcpServerIcons, rankMcpServerIcons } from "../src";

describe("mcpServerIcons", () => {
  test("keeps https and data image icons and normalizes their facts", () => {
    expect(
      mcpServerIcons({
        name: "messages",
        version: "1.0.0",
        icons: [
          { src: "https://example.com/logo.svg", mimeType: "Image/SVG+XML; charset=utf-8" },
          { src: " data:image/png;base64,AAAA ", sizes: ["48x48", "128x96"], theme: "dark" },
          { src: "https://example.com/any.png", sizes: ["any"], theme: "purple" },
        ],
      }),
    ).toEqual([
      { src: "https://example.com/logo.svg", mimeType: "image/svg+xml", size: null, theme: null },
      { src: "data:image/png;base64,AAAA", mimeType: null, size: 128, theme: "dark" },
      {
        src: "https://example.com/any.png",
        mimeType: null,
        size: Number.POSITIVE_INFINITY,
        theme: null,
      },
    ]);
  });

  test("drops insecure, non-image, malformed and oversized entries", () => {
    expect(
      mcpServerIcons({
        icons: [
          { src: "http://example.com/logo.png" },
          { src: "javascript:alert(1)" },
          { src: "data:text/html,<script></script>" },
          { src: 42 },
          null,
          "https://example.com/logo.png",
          { src: `data:image/png;base64,${"A".repeat(MAX_LOGO_BYTES * 2)}` },
        ],
      }),
    ).toEqual([]);
    expect(mcpServerIcons(undefined)).toEqual([]);
    expect(mcpServerIcons({ icons: "https://example.com/logo.png" })).toEqual([]);
  });
});

describe("rankMcpServerIcons", () => {
  test("prefers theme-neutral, then vector, then large raster, and favicons last", () => {
    const icons = mcpServerIcons({
      icons: [
        { src: "https://example.com/favicon.ico" },
        { src: "https://example.com/small.png", sizes: ["32x32"] },
        { src: "https://example.com/dark.svg", theme: "dark" },
        { src: "https://example.com/large.png", sizes: ["256x256"] },
        { src: "https://example.com/medium.png", sizes: ["64x64"] },
        { src: "https://example.com/light.svg", theme: "light" },
        { src: "data:image/svg+xml;base64,PHN2Zy8+" },
      ],
    });
    expect(rankMcpServerIcons(icons).map((icon) => icon.src)).toEqual([
      "data:image/svg+xml;base64,PHN2Zy8+",
      "https://example.com/large.png",
      "https://example.com/medium.png",
      "https://example.com/small.png",
      "https://example.com/favicon.ico",
      "https://example.com/light.svg",
      "https://example.com/dark.svg",
    ]);
  });

  test("keeps the server's order between equally good icons", () => {
    const icons = mcpServerIcons({
      icons: [
        { src: "https://example.com/a.svg", sizes: ["any"] },
        { src: "https://example.com/b.svg", sizes: ["any"] },
      ],
    });
    expect(rankMcpServerIcons(icons).map((icon) => icon.src)).toEqual([
      "https://example.com/a.svg",
      "https://example.com/b.svg",
    ]);
  });
});

describe("decodeDataUriIcon", () => {
  test("decodes base64 and percent-encoded payloads", () => {
    const base64 = decodeDataUriIcon("data:image/png;base64,iVBO Rw0K");
    expect(base64?.contentType).toBe("image/png");
    expect(Array.from(base64?.bytes ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const text = decodeDataUriIcon("data:image/svg+xml,%3Csvg%2F%3E");
    expect(text?.contentType).toBe("image/svg+xml");
    expect(new TextDecoder().decode(text?.bytes)).toBe("<svg/>");
  });

  test("rejects payloads that are not data URIs or do not decode", () => {
    expect(decodeDataUriIcon("https://example.com/logo.png")).toBeNull();
    expect(decodeDataUriIcon("data:image/svg+xml,%E0%A4%A")).toBeNull();
  });
});
