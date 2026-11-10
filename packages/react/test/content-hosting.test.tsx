import { afterEach, expect, test } from "bun:test";
import { useRef } from "react";
import {
  HTML_FRAME_HOST_MESSAGE,
  HTML_FRAME_HOST_SANDBOX,
  HTML_FRAME_HOST_VERSION,
} from "@opengeni/contracts/html-frame-host";
import {
  configureContentHosting,
  contentHosting,
  displayImageSrc,
  setImageProxyTicket,
} from "../src/lib/content-hosting";
import { htmlFrameHostSrc, useHtmlFrameHost } from "../src/components/artifacts/html-frame-host";
import { PublishedHtmlArtifactFrame } from "../src/components/artifacts/published-html-artifact-frame";
import { actRun, registerDom, renderComponent, renderHook } from "./render-hook";

registerDom();

afterEach(() => configureContentHosting({}));

const proxy = {
  imageProxy: {
    url: "/v1/image-proxy",
    directOrigins: ["https://acct.blob.core.windows.net"],
  },
};

test("images load directly only from listed, same-origin or inline sources", () => {
  const page = "https://app.example.com";
  expect(displayImageSrc("https://elsewhere.example/a.png", {}, page)).toBe(
    "https://elsewhere.example/a.png",
  );
  expect(displayImageSrc("https://elsewhere.example/a.png?x=1", proxy, page)).toBe(
    `/v1/image-proxy?url=${encodeURIComponent("https://elsewhere.example/a.png?x=1")}`,
  );
  expect(displayImageSrc("http://elsewhere.example/a.png", proxy, page)).toBe(
    `/v1/image-proxy?url=${encodeURIComponent("https://elsewhere.example/a.png")}`,
  );
  for (const direct of [
    "https://acct.blob.core.windows.net/c/a.png?sig=1",
    "https://app.example.com/v1/files/a.png",
    "/v1/files/a.png",
    "data:image/png;base64,AAAA",
    "blob:https://app.example.com/1",
  ]) {
    expect(displayImageSrc(direct, proxy, page)).toBe(direct);
  }
});

test("a page signed in with a bearer token adds its image proxy ticket", () => {
  const page = "https://app.example.com";
  setImageProxyTicket("t1");
  expect(contentHosting().imageProxy).toBeUndefined();
  configureContentHosting({
    imageProxy: { url: "https://api.example.com/v1/image-proxy", directOrigins: [] },
  });
  setImageProxyTicket("a.b+c");
  expect(displayImageSrc("https://elsewhere.example/a.png", contentHosting(), page)).toBe(
    `https://api.example.com/v1/image-proxy?url=${encodeURIComponent("https://elsewhere.example/a.png")}&ticket=${encodeURIComponent("a.b+c")}`,
  );
  setImageProxyTicket(null);
  expect(contentHosting().imageProxy?.ticket).toBeUndefined();
});

test("the frame host address names the embedding page as its parent", () => {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
    "https://app.example.com/workspaces/w",
  );
  const origin = window.location.origin;
  expect(origin).toBe("https://app.example.com");
  expect(htmlFrameHostSrc(null)).toBeNull();
  expect(htmlFrameHostSrc("https://og.example.site")).toBe(
    `https://og.example.site/_og/html-frame?parent=${encodeURIComponent(origin)}`,
  );
  expect(htmlFrameHostSrc("self")).toBe(
    `${origin}/_og/html-frame?parent=${encodeURIComponent(origin)}`,
  );
});

test("without content hosting an HTML artifact keeps its srcdoc frame; with it, the frame host", async () => {
  const plain = await renderComponent(<PublishedHtmlArtifactFrame html="<p>hi</p>" title="A" />);
  const before = plain.container.querySelector("iframe")!;
  expect(before.getAttribute("srcdoc")).toContain("<p>hi</p>");
  await plain.unmount();

  configureContentHosting({ htmlFrameHost: "https://og.example.site" });
  const hosted = await renderComponent(<PublishedHtmlArtifactFrame html="<p>hi</p>" title="A" />);
  const frame = hosted.container.querySelector("iframe")!;
  expect(frame.getAttribute("srcdoc")).toBeNull();
  expect(frame.getAttribute("src")).toStartWith("https://og.example.site/_og/html-frame?parent=");
  expect(frame.getAttribute("sandbox")).toBe(HTML_FRAME_HOST_SANDBOX);
  expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  await hosted.unmount();
});

test("sends the HTML once, only to its own opaque-origin frame, and reports its load", async () => {
  const posted: Array<{ message: unknown; target: string }> = [];
  const frameWindow = {
    postMessage: (message: unknown, target: string) => posted.push({ message, target }),
  };
  const other = { postMessage: () => undefined };
  let loaded = 0;
  const hook = await renderHook(() => {
    const frameRef = useRef({ contentWindow: frameWindow } as unknown as HTMLIFrameElement);
    return useHtmlFrameHost({
      frameRef,
      enabled: true,
      html: "<p>agent</p>",
      mode: "interactive",
      onLoaded: () => {
        loaded += 1;
      },
    });
  }, undefined);
  const send = (source: unknown, origin: string, type: string) =>
    actRun(() => {
      const event = new MessageEvent("message", {
        data: { type, version: HTML_FRAME_HOST_VERSION },
        origin,
      });
      Object.defineProperty(event, "source", { value: source });
      window.dispatchEvent(event);
    });

  // Another window, or a named origin, is ignored.
  await send(other, "null", HTML_FRAME_HOST_MESSAGE.ready);
  await send(frameWindow, "https://evil.example", HTML_FRAME_HOST_MESSAGE.ready);
  expect(posted).toHaveLength(0);

  await send(frameWindow, "null", HTML_FRAME_HOST_MESSAGE.ready);
  expect(posted).toEqual([
    {
      message: {
        type: HTML_FRAME_HOST_MESSAGE.render,
        version: HTML_FRAME_HOST_VERSION,
        mode: "interactive",
        html: "<p>agent</p>",
      },
      target: "*",
    },
  ]);
  // A second ready (the HTML navigating its frame to a page that claims to
  // be the loader) never gets the HTML again.
  await send(frameWindow, "null", HTML_FRAME_HOST_MESSAGE.ready);
  expect(posted).toHaveLength(1);
  expect(hook.result.current.onFrameLoad()).toBe(false);
  await send(frameWindow, "null", HTML_FRAME_HOST_MESSAGE.loaded);
  expect(loaded).toBe(1);
  expect(hook.result.current.onFrameLoad()).toBe(true);
  await hook.unmount();
});
