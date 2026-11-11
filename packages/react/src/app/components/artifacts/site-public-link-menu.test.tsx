import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { SitePublicationLinkLoad } from "./site-public-link";

// The Published menu with the real dropdown (no mocks): opening, closing and
// where focus goes, which the mocked suites can't see.
let module: typeof import("./site-public-link");
let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  module = await import("./site-public-link");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
  if (previousActEnvironment)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const url = "https://newsletter-4k9x.sites.example/";
const published: SitePublicationLinkLoad = {
  state: "ready",
  link: { siteId: "site", hostname: "newsletter-4k9x.sites.example", url, status: "active" },
};

let mounted: { root: Root; host: HTMLElement } | null = null;
afterEach(async () => {
  if (!mounted) return;
  const { root, host } = mounted;
  await act(async () => root.unmount());
  host.remove();
  mounted = null;
  document.body.innerHTML = "";
});

/** As in the Site view: the form replaces the control and focuses its title. */
function WithPublishing({ openExternal }: { openExternal: (url: string) => boolean }) {
  const [publishing, setPublishing] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (publishing) title.current?.focus();
  }, [publishing]);
  return (
    <>
      <div hidden={publishing}>
        <module.SitePublicationControl
          load={published}
          canPublish
          onOpenPublishing={() => setPublishing(true)}
          openExternal={openExternal}
        />
      </div>
      {publishing ? (
        <h1 ref={title} tabIndex={-1} data-form-title="">
          Web address
        </h1>
      ) : null}
    </>
  );
}

async function render(props: { openExternal?: (url: string) => boolean }) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () =>
    root.render(<WithPublishing openExternal={props.openExternal ?? (() => false)} />),
  );
  return host.querySelector<HTMLButtonElement>("[data-site-publication='published']")!;
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

async function openMenu(trigger: HTMLButtonElement) {
  trigger.focus();
  await act(
    async () =>
      void trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  await settle();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  return document.querySelector<HTMLElement>("[role='menu']")!;
}

function item(menu: HTMLElement, name: string): HTMLElement {
  const found = [...menu.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No menu item ${name}`);
  return found;
}

/** Click, reporting whether the component cancelled it (and never navigating). */
async function click(target: HTMLElement): Promise<boolean> {
  let prevented: boolean | null = null;
  const record = (event: Event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", record, { once: true });
  await act(
    async () =>
      void target.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
      ),
  );
  await settle();
  return prevented === true;
}

test("Open on the desktop opens the address there and closes the menu", async () => {
  const opened: string[] = [];
  const trigger = await render({
    openExternal: (next) => {
      opened.push(next);
      return true;
    },
  });
  const menu = await openMenu(trigger);
  expect(await click(item(menu, "Open"))).toBe(true);
  expect(opened).toEqual([url]);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector("[role='menu']")).toBeNull();
});

test("Open on the web follows the link and closes the menu", async () => {
  const trigger = await render({});
  const menu = await openMenu(trigger);
  const open = item(menu, "Open");
  expect(open.getAttribute("href")).toBe(url);
  expect(await click(open)).toBe(false);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("Escape closes the menu and returns focus to its button", async () => {
  const trigger = await render({});
  await openMenu(trigger);
  await act(
    async () =>
      void document
        .querySelector("[role='menu']")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await settle();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

test("Publishing settings leaves focus in the form, not on the hidden menu button", async () => {
  const trigger = await render({});
  const menu = await openMenu(trigger);
  await click(item(menu, "Publishing settings"));
  expect(document.querySelector("[role='menu']")).toBeNull();
  expect(document.activeElement?.hasAttribute("data-form-title")).toBe(true);
});

test("the copy status is announced beside the menu, never inside it", async () => {
  const trigger = await render({});
  const menu = await openMenu(trigger);
  expect(menu.querySelector("[role='status']")).toBeNull();
  expect(document.querySelector("[role='status']")).not.toBeNull();
});
