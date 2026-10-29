import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { BOOT_RECOVERY_SCRIPT, bootRecoveryPlugin } from "./vite-boot-recovery";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

type Listener = (event: { target: unknown }) => void;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

/** Runs the guard as the page would, against a window whose reload is counted. */
function boot(storage: Storage | null, options: { dark?: boolean } = {}) {
  const listeners = new Map<string, Listener>();
  let reloads = 0;
  const win = {
    get sessionStorage(): Storage {
      if (!storage) throw new Error("storage is off");
      return storage;
    },
    location: { reload: () => void (reloads += 1) },
    matchMedia: () => ({ matches: options.dark === true }),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  new Function("window", BOOT_RECOVERY_SCRIPT)(win);
  const entry = document.createElement("script");
  entry.type = "module";
  entry.src = "/assets/index-abc123.js";
  return {
    get reloads() {
      return reloads;
    },
    failEntry: () => listeners.get("error")?.({ target: entry }),
    failOther: (target: unknown) => listeners.get("error")?.({ target }),
    load: () => listeners.get("load")?.({ target: win }),
    message: () => document.querySelector<HTMLElement>("[data-og-boot-error]"),
  };
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-og-theme");
  document.documentElement.removeAttribute("style");
  document.body.innerHTML = '<div id="root"></div>';
});

describe("boot guard for code that fails to download", () => {
  test("the first failure reloads the page once", () => {
    const storage = memoryStorage();
    const page = boot(storage);
    page.failEntry();
    expect(page.reloads).toBe(1);
    expect(page.message()).toBeNull();
  });

  test("a second failure after that reload shows a message with Reload", () => {
    const storage = memoryStorage();
    boot(storage).failEntry();
    const again = boot(storage);
    again.failEntry();
    expect(again.reloads).toBe(0);
    const message = again.message();
    expect(message?.getAttribute("role")).toBe("alert");
    expect(message?.textContent).toContain("This page didn't load.");
    expect(message?.textContent).toContain("Check your connection, then reload.");
    const reload = message?.querySelector("button");
    expect(reload?.textContent).toBe("Reload");
    reload?.click();
    expect(again.reloads).toBe(1);
  });

  test("a page that loads clears the attempt, so a later failure retries again", () => {
    const storage = memoryStorage();
    boot(storage).failEntry();
    boot(storage).load();
    const later = boot(storage);
    later.failEntry();
    expect(later.reloads).toBe(1);
  });

  test("without session storage it shows the message instead of risking a reload loop", () => {
    const page = boot(null);
    page.failEntry();
    expect(page.reloads).toBe(0);
    expect(page.message()).not.toBeNull();
  });

  test("the message follows the dark appearance", () => {
    const page = boot(null, { dark: true });
    page.failEntry();
    expect(document.documentElement.style.colorScheme).toBe("dark");
    document.documentElement.dataset.ogTheme = "light";
    document.body.innerHTML = '<div id="root"></div>';
    boot(null, { dark: true }).failEntry();
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  test("it ignores other failures and anything after the app has rendered", () => {
    const storage = memoryStorage();
    const page = boot(storage);
    page.failOther(document.createElement("img"));
    const classic = document.createElement("script");
    classic.src = "/analytics.js";
    page.failOther(classic);
    expect(page.reloads).toBe(0);

    document.getElementById("root")?.append(document.createElement("main"));
    page.failEntry();
    expect(page.reloads).toBe(0);
    expect(page.message()).toBeNull();
  });

  test("both the web app and the Excel pane get the guard in their HTML", async () => {
    const plugin = bootRecoveryPlugin();
    const transform = plugin.transformIndexHtml as () => Array<{
      tag: string;
      children: string;
      injectTo: string;
    }>;
    expect(transform()).toEqual([
      expect.objectContaining({ tag: "script", children: BOOT_RECOVERY_SCRIPT, injectTo: "head" }),
    ]);
    const pluginNames = (config: { plugins?: unknown[] }) =>
      (config.plugins ?? [])
        .flat(5)
        .map((candidate) => (candidate as { name?: string } | null)?.name);
    const web = (await import("./vite.config")).default as { plugins?: unknown[] };
    const pane = (await import("./vite.office.config")).default as { plugins?: unknown[] };
    expect(pluginNames(web)).toContain(plugin.name);
    expect(pluginNames(pane)).toContain(plugin.name);
  });
});
