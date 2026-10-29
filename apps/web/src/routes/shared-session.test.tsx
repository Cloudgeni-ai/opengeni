import { afterEach, describe, expect, test } from "bun:test";
import type { SharedSession } from "@opengeni/sdk";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { fetchSharedSession, SharedSessionView } from "./shared-session";

const shared: SharedSession = {
  title: "Birthday dinner plan",
  sharedAt: "2026-10-26T12:00:00.000Z",
  omittedMessageCount: 0,
  messages: [
    { role: "user", text: "Can you plan a birthday dinner?", sender: "Olav Berg" },
    { role: "assistant", text: "Here is a **plan**." },
    { role: "user", text: "Add a cake.", sender: "Kari Berg" },
    { role: "user", text: "An older message without a name." },
  ],
};

/** The page's markup, with apostrophes as written. */
function render(element: ReactElement): string {
  return renderToStaticMarkup(element).replaceAll("&#x27;", "'");
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("shared conversation page", () => {
  test("shows each person's messages under their name, and the replies", () => {
    const html = render(<SharedSessionView load={{ kind: "ready", shared }} />);
    expect(html).toContain("Birthday dinner plan");
    const senders = [...html.matchAll(/data-shared-sender="">([^<]*)</gu)].map((match) => match[1]);
    expect(senders).toEqual(["Olav Berg", "Kari Berg"]);
    expect(html).toContain("Olav Berg wrote: ");
    expect(html).toContain("Kari Berg wrote: ");
    // A message without a name still reads, just without a label.
    expect(html).toContain("They wrote: ");
    expect(html).toMatch(/<strong[^>]*>plan<\/strong>/u);
    expect(html.match(/data-shared-message="user"/gu)).toHaveLength(3);
    expect(html.match(/data-shared-message="assistant"/gu)).toHaveLength(1);
  });

  test("says when earlier messages are left out, and when there were none", () => {
    expect(
      render(
        <SharedSessionView
          load={{ kind: "ready", shared: { ...shared, omittedMessageCount: 4 } }}
        />,
      ),
    ).toContain("Earlier messages aren't included.");
    expect(
      render(<SharedSessionView load={{ kind: "ready", shared: { ...shared, messages: [] } }} />),
    ).toContain("There were no messages yet when this was shared.");
  });

  test("a stopped link and a failed read each say what happened", () => {
    expect(render(<SharedSessionView load={{ kind: "gone" }} />)).toContain(
      "This link doesn't open anymore",
    );
    const busy = render(<SharedSessionView load={{ kind: "busy" }} onRetry={() => undefined} />);
    expect(busy).toContain("Too many requests just now.");
    expect(busy).toContain("Try again");
    expect(render(<SharedSessionView load={{ kind: "failed" }} />)).toContain(
      "Check your connection and try again.",
    );
  });

  test("reads the link without credentials and maps each answer to a state", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const answers = [
      new Response(JSON.stringify(shared), { status: 200 }),
      new Response("gone", { status: 404 }),
      new Response("slow down", { status: 429 }),
      new Response("broken", { status: 500 }),
    ];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return answers.shift()!;
    }) as typeof fetch;
    expect(await fetchSharedSession("abc/def")).toEqual({ kind: "ready", shared });
    expect(await fetchSharedSession("abc")).toEqual({ kind: "gone" });
    expect(await fetchSharedSession("abc")).toEqual({ kind: "busy" });
    expect(await fetchSharedSession("abc")).toEqual({ kind: "failed" });
    expect(requests[0]!.url).toEndWith("/v1/shared-sessions/abc%2Fdef");
    expect(requests.every((request) => request.init?.credentials === "omit")).toBe(true);

    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await fetchSharedSession("abc")).toEqual({ kind: "failed" });
  });
});
