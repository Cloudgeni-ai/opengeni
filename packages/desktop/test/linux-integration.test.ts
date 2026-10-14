import { describe, expect, test } from "bun:test";

import {
  appImageDesktopEntry,
  appImageEntryName,
  desktopExecQuote,
} from "../src/main/linux-integration";

describe("AppImage desktop entry", () => {
  test("quotes the path for the Exec line", () => {
    expect(desktopExecQuote("/home/a b/App.AppImage")).toBe('"/home/a b/App.AppImage"');
    expect(desktopExecQuote('/x/$HOME/"q"/`c`\\d')).toBe('"/x/\\$HOME/\\"q\\"/\\`c\\`\\\\d"');
  });

  test("registers the URL scheme, icon and window class", () => {
    const entry = appImageDesktopEntry({
      productName: "Product",
      scheme: "product",
      appImagePath: "/home/person/Apps/Product.AppImage",
      iconName: appImageEntryName("product"),
      windowClass: "Product",
    });
    expect(entry).toContain('Exec="/home/person/Apps/Product.AppImage" %U\n');
    expect(entry).toContain("MimeType=x-scheme-handler/product;\n");
    expect(entry).toContain("Icon=product-appimage\n");
    expect(entry).toContain("StartupWMClass=Product\n");
    expect(entry.startsWith("[Desktop Entry]\n")).toBe(true);
  });
});
