// The embedded session app's isolation seams: in-memory navigation that never
// touches the page, overlays that stay in their own app, and per-app requests.
import { expect, test } from "bun:test";
import { Popover } from "radix-ui";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useMemoryNavigation } from "../src/app/embed/memory-navigation";
import {
  consumeSessionComposerFocusIntent,
  requestSessionComposerFocus,
} from "../src/app/lib/session-focus";
import { containedPortal, PortalContainerProvider } from "../src/ui/portal-container";
import { actRun, registerDom, renderHook } from "./render-hook";

registerDom();

const SESSIONS = "/workspaces/w1/sessions";

function navigationOptions(overrides: { openUrl?: (url: string) => void } = {}) {
  const opened: string[] = [];
  const locations: string[] = [];
  return {
    opened,
    locations,
    options: {
      initialPath: SESSIONS,
      consoleOrigin: "https://app.example.com",
      handles: (pathname: string) => pathname.startsWith(SESSIONS),
      openUrl: overrides.openUrl ?? ((url: string) => void opened.push(url)),
      openTab: () => null,
      onLocationChange: (location: { pathname: string }) => void locations.push(location.pathname),
    },
  };
}

test("memory navigation keeps handled paths in the app and sends the rest to openUrl", async () => {
  const pageHref = window.location.href;
  const { opened, locations, options } = navigationOptions();
  const rendered = await renderHook(() => useMemoryNavigation(options), undefined);
  const page = rendered.result.current.page;

  await actRun(() => page.assign(`${SESSIONS}/s1`));
  expect(new URL(page.href()).pathname).toBe(`${SESSIONS}/s1`);
  expect(locations).toEqual([`${SESSIONS}/s1`]);

  await actRun(() => page.assign("/workspaces/w1/settings"));
  page.open("/files/report.pdf");
  expect(opened).toEqual([
    "https://app.example.com/workspaces/w1/settings",
    "https://app.example.com/files/report.pdf",
  ]);
  expect(page.openTab()).toBeNull();
  expect(new URL(page.href()).pathname).toBe(`${SESSIONS}/s1`);
  expect(window.location.href).toBe(pageHref);
  await rendered.unmount();
});

test("memory navigation replaces its own query, never the page's", async () => {
  const pageHref = window.location.href;
  const { options } = navigationOptions();
  const rendered = await renderHook(() => useMemoryNavigation(options), undefined);
  const page = rendered.result.current.page;
  await actRun(() => page.assign(`${SESSIONS}?connect=github`));
  expect(page.readQuery().get("connect")).toBe("github");
  await actRun(() => page.replaceQuery(new URLSearchParams()));
  expect(page.readQuery().size).toBe(0);
  expect(window.location.href).toBe(pageHref);
  await rendered.unmount();
});

const ContainedPopoverPortal = containedPortal(Popover.Portal);

test("overlays render inside their own app's container", async () => {
  const first = document.createElement("div");
  const second = document.createElement("div");
  document.body.append(first, second);
  const root = createRoot(document.createElement("div"));
  const app = (container: HTMLElement, label: string) => (
    <PortalContainerProvider container={container}>
      <Popover.Root open>
        <Popover.Trigger>{label}</Popover.Trigger>
        <ContainedPopoverPortal>
          <Popover.Content data-app={label}>{label}</Popover.Content>
        </ContainedPopoverPortal>
      </Popover.Root>
    </PortalContainerProvider>
  );
  await act(async () => {
    root.render(
      <>
        {app(first, "first")}
        {app(second, "second")}
      </>,
    );
  });
  expect(first.querySelector("[data-app=first]")).not.toBeNull();
  expect(second.querySelector("[data-app=second]")).not.toBeNull();
  expect(first.querySelector("[data-app=second]")).toBeNull();
  await act(async () => root.unmount());
  first.remove();
  second.remove();
});

test("a composer focus request reaches only the app that made it", () => {
  const first = new EventTarget();
  const second = new EventTarget();
  let secondSignalled = false;
  second.addEventListener("opengeni:focus-session-composer", () => {
    secondSignalled = true;
  });
  requestSessionComposerFocus(first, "w1", "s1");
  expect(secondSignalled).toBe(false);
  expect(consumeSessionComposerFocusIntent(second, "w1", "s1")).toBeNull();
  expect(consumeSessionComposerFocusIntent(first, "w1", "s1")?.sessionId).toBe("s1");
});
