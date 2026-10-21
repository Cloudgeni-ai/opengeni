import { describe, expect, test } from "bun:test";

import {
  appImageDesktopEntry,
  appImageEntryName,
  desktopExecQuote,
} from "../src/main/linux-integration";

describe("AppImage desktop entry", () => {
  test("quotes the Exec path only when it needs it", () => {
    expect(desktopExecQuote("/home/user/Apps/App-1.0_x86_64.AppImage")).toBe(
      "/home/user/Apps/App-1.0_x86_64.AppImage",
    );
    expect(desktopExecQuote("/home/user/My Apps/App.AppImage")).toBe(
      '"/home/user/My Apps/App.AppImage"',
    );
    expect(desktopExecQuote('/x/$HOME/"q"/`c`\\d')).toBe('"/x/\\$HOME/\\"q\\"/\\`c\\`\\\\d"');
  });

  test("registers the URL scheme, icon and window class", () => {
    const entry = appImageDesktopEntry({
      productName: "Product",
      scheme: "product",
      appImagePath: "/home/user/Apps/Product.AppImage",
      iconName: appImageEntryName("product"),
      windowClass: "product",
    });
    expect(entry).toContain("Exec=/home/user/Apps/Product.AppImage %U\n");
    expect(entry).toContain("MimeType=x-scheme-handler/product;\n");
    expect(entry).toContain("Icon=product-appimage\n");
    expect(entry).toContain("StartupWMClass=product\n");
    expect(entry.startsWith("[Desktop Entry]\n")).toBe(true);
  });
});
