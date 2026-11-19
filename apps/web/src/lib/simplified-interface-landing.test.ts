import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { APPEARANCE_KEY } from "@opengeni/react/app/lib/appearance";
import {
  SIMPLIFIED_INTERFACE_KEY,
  interfaceProductName,
  parseSimplifiedInterface,
} from "@opengeni/react/app/lib/simplified-interface";
import {
  SIMPLIFIED_INTERFACE_ICON,
  applyInterfaceIcons,
  interfacePageTitle,
  retainLandingSimplifiedInterface,
} from "./simplified-interface-landing";

function landing(href: string, stored: Record<string, string> = {}) {
  const replaced: string[] = [];
  const storage = new Map(Object.entries(stored));
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  };
  const target = {
    location: { href },
    history: {
      state: { key: "router-state" },
      replaceState: (state: unknown, _title: string, url: string) => {
        expect(state).toEqual({ key: "router-state" });
        replaced.push(url);
      },
    },
    localStorage,
  } as unknown as Window;
  return { target, replaced, storage, localStorage };
}

describe("simplified interface flag carried by the landing URL", () => {
  test("arriving from Geni keeps the flag, picks the light look and cleans the URL", () => {
    const { target, replaced, storage } = landing(
      "https://app.opengeni.ai/?mode=signup&simplified_interface=1&utm_source=gogeni#top",
    );
    expect(retainLandingSimplifiedInterface(target)).toBe(true);
    expect(storage.get(SIMPLIFIED_INTERFACE_KEY)).toBe("on");
    expect(storage.get(APPEARANCE_KEY)).toBe("light");
    expect(replaced).toEqual(["/?mode=signup&utm_source=gogeni#top"]);
  });

  test("an appearance the person already chose is left alone", () => {
    const { target, storage } = landing("https://app.opengeni.ai/?simplified_interface=on", {
      [APPEARANCE_KEY]: "dark",
    });
    expect(retainLandingSimplifiedInterface(target)).toBe(true);
    expect(storage.get(APPEARANCE_KEY)).toBe("dark");
  });

  test("the URL can clear the flag without touching the appearance", () => {
    const { target, storage } = landing("https://app.opengeni.ai/?simplified_interface=0", {
      [SIMPLIFIED_INTERFACE_KEY]: "on",
    });
    expect(retainLandingSimplifiedInterface(target)).toBe(false);
    expect(storage.get(SIMPLIFIED_INTERFACE_KEY)).toBe("off");
    expect(storage.has(APPEARANCE_KEY)).toBe(false);
  });

  test("an unknown value changes nothing but is still removed from the URL", () => {
    const { target, replaced, storage } = landing(
      "https://app.opengeni.ai/sessions?simplified_interface=maybe",
      { [SIMPLIFIED_INTERFACE_KEY]: "on" },
    );
    expect(retainLandingSimplifiedInterface(target)).toBeNull();
    expect(storage.get(SIMPLIFIED_INTERFACE_KEY)).toBe("on");
    expect(replaced).toEqual(["/sessions"]);
  });

  test("a URL without the parameter is not rewritten", () => {
    const { target, replaced, storage } = landing("https://app.opengeni.ai/?mode=signup");
    expect(retainLandingSimplifiedInterface(target)).toBeNull();
    expect(replaced).toEqual([]);
    expect(storage.size).toBe(0);
  });

  test("blocked storage never breaks startup", () => {
    const { target } = landing("https://app.opengeni.ai/?simplified_interface=1");
    (target as unknown as { localStorage: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(retainLandingSimplifiedInterface(target)).toBeNull();
  });
});

describe("flag values and product names", () => {
  test("only on and off values parse", () => {
    for (const value of ["1", "on"]) expect(parseSimplifiedInterface(value)).toBe(true);
    for (const value of ["0", "off"]) expect(parseSimplifiedInterface(value)).toBe(false);
    for (const value of [null, undefined, "", "true", "geni"]) {
      expect(parseSimplifiedInterface(value)).toBeNull();
    }
  });

  test("the page title names the product the interface shows, both ways", () => {
    expect(interfaceProductName(true)).toBe("Geni");
    expect(interfaceProductName(false)).toBe("Opengeni");
    expect(interfacePageTitle("Opengeni", true)).toBe("Geni");
    expect(interfacePageTitle("(1) Quarterly report - Opengeni", true)).toBe(
      "(1) Quarterly report - Geni",
    );
    expect(interfacePageTitle("Geni", false)).toBe("Opengeni");
    // Already right: "Geni" inside "Opengeni" is not a separate word.
    expect(interfacePageTitle("Opengeni", false)).toBe("Opengeni");
    expect(interfacePageTitle("Geni", true)).toBe("Geni");
  });
});

// The inline bootstrap in index.html applies the same rules before first paint.
describe("simplified interface before first paint", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const bootstrap = html.match(
    /<script id="opengeni-appearance-bootstrap">([\s\S]*?)<\/script>/,
  )![1]!;

  function boot(search: string, stored: Record<string, string> = {}) {
    const { localStorage, storage } = landing("https://app.opengeni.ai/", stored);
    const root = { dataset: {} as Record<string, string>, classList: { toggle: () => {} } };
    runInNewContext(bootstrap, {
      document: { documentElement: root },
      location: { search },
      localStorage,
      matchMedia: () => ({ matches: true }),
      URLSearchParams,
    });
    return { root, storage };
  }

  test("arriving from Geni paints the simplified interface in the light look", () => {
    const { root, storage } = boot("?simplified_interface=1");
    expect(root.dataset.ogSimplifiedInterface).toBe("");
    expect(root.dataset.ogTheme).toBe("light");
    expect(storage.get(SIMPLIFIED_INTERFACE_KEY)).toBe("on");
    expect(storage.get(APPEARANCE_KEY)).toBe("light");
  });

  test("a returning browser paints it and keeps its own appearance", () => {
    const { root } = boot("", { [SIMPLIFIED_INTERFACE_KEY]: "on", [APPEARANCE_KEY]: "dark" });
    expect(root.dataset.ogSimplifiedInterface).toBe("");
    expect(root.dataset.ogTheme).toBe("dark");
  });

  test("turning it off in the URL paints the full interface", () => {
    const { root, storage } = boot("?simplified_interface=0", { [SIMPLIFIED_INTERFACE_KEY]: "on" });
    expect(root.dataset.ogSimplifiedInterface).toBeUndefined();
    expect(storage.get(SIMPLIFIED_INTERFACE_KEY)).toBe("off");
  });

  test("everyone else paints Opengeni exactly as before", () => {
    const { root, storage } = boot("?simplified_interface=maybe");
    expect(root.dataset.ogSimplifiedInterface).toBeUndefined();
    expect(root.dataset.ogTheme).toBe("dark");
    expect(storage.size).toBe(0);
  });
});

describe("page icon", () => {
  function iconLinks(...links: Record<string, string>[]) {
    const elements = links.map((attributes) => {
      const values = new Map(Object.entries(attributes));
      return {
        values,
        getAttribute: (name: string) => values.get(name) ?? null,
        setAttribute: (name: string, value: string) => void values.set(name, value),
        removeAttribute: (name: string) => void values.delete(name),
      };
    });
    return {
      elements,
      doc: {
        querySelectorAll: (selector: string) => {
          expect(selector).toBe('link[rel="icon"]');
          return elements;
        },
      },
    };
  }

  test("shows the Geni tile while simplified and restores the Opengeni icons after", () => {
    const original: Record<string, string>[] = [
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
    ];
    const { doc, elements } = iconLinks(...original.map((link) => ({ ...link })));
    applyInterfaceIcons(doc, true);
    applyInterfaceIcons(doc, true);
    for (const element of elements) {
      expect(element.getAttribute("href")).toBe(SIMPLIFIED_INTERFACE_ICON);
      expect(element.getAttribute("type")).toBe("image/svg+xml");
    }
    applyInterfaceIcons(doc, false);
    expect(elements.map((element) => Object.fromEntries(element.values))).toEqual(original);
  });

  test("leaves the full interface's icons alone", () => {
    const { doc, elements } = iconLinks({ rel: "icon", href: "/favicon.svg" });
    applyInterfaceIcons(doc, false);
    expect(Object.fromEntries(elements[0]!.values)).toEqual({ rel: "icon", href: "/favicon.svg" });
  });
});
