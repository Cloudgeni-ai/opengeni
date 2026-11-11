import { afterAll, afterEach, beforeAll, describe, expect, jest, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { clickDownloadLink, saveBlob, SAVED_OBJECT_URL_LIFETIME_MS } from "./save-blob";

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
let listeners = new AbortController();

beforeAll(() => {
  GlobalRegistrator.register();
});

afterEach(() => {
  jest.useRealTimers();
  listeners.abort();
  listeners = new AbortController();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  document.body.replaceChildren();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function recordClicks() {
  const clicks: { href: string; download: string; attached: boolean }[] = [];
  document.addEventListener(
    "click",
    (event) => {
      const anchor = event.target as HTMLAnchorElement;
      clicks.push({
        href: anchor.getAttribute("href") ?? "",
        download: anchor.download,
        attached: anchor.isConnected && document.body.contains(anchor),
      });
      event.preventDefault();
    },
    { capture: true, signal: listeners.signal },
  );
  return clicks;
}

describe("saveBlob", () => {
  test("keeps the object URL alive well past the click, then revokes it", async () => {
    jest.useFakeTimers();
    const revoke = mock((_url: string) => undefined);
    const created: Blob[] = [];
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      created.push(blob as Blob);
      return "blob:saved-file";
    };
    URL.revokeObjectURL = revoke;
    const clicks = recordClicks();

    saveBlob(new Blob(["hello"], { type: "text/plain" }), "notes.txt");

    expect(created).toHaveLength(1);
    expect(created[0]!.type).toBe("text/plain");
    expect(await created[0]!.text()).toBe("hello");
    expect(clicks).toEqual([{ href: "blob:saved-file", download: "notes.txt", attached: true }]);
    expect(document.body.querySelector("a")).toBeNull();

    expect(revoke).not.toHaveBeenCalled();
    jest.advanceTimersByTime(SAVED_OBJECT_URL_LIFETIME_MS - 1);
    expect(revoke).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:saved-file");
  });

  test("still schedules the revoke and removes the anchor when the click throws", () => {
    jest.useFakeTimers();
    const revoke = mock((_url: string) => undefined);
    URL.createObjectURL = () => "blob:failed-click";
    URL.revokeObjectURL = revoke;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = () => {
      throw new Error("blocked");
    };
    try {
      expect(() => saveBlob(new Blob(["x"]), "x.bin")).toThrow("blocked");
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
    expect(document.body.querySelector("a")).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    jest.advanceTimersByTime(SAVED_OBJECT_URL_LIFETIME_MS);
    expect(revoke).toHaveBeenCalledWith("blob:failed-click");
  });
});

describe("clickDownloadLink", () => {
  test("clicks an attached download anchor and removes it afterwards", () => {
    const clicks = recordClicks();
    clickDownloadLink("https://files.example/report.pdf", "report.pdf");
    expect(clicks).toEqual([
      { href: "https://files.example/report.pdf", download: "report.pdf", attached: true },
    ]);
    expect(document.body.querySelector("a")).toBeNull();
  });
});
