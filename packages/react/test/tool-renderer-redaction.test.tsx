import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEvent, ToolActionReview } from "@opengeni/sdk";
import { act, type ReactNode } from "react";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";
import type { ToolCallItem } from "../src/timeline/types";

registerDom();

// Radix picks its layout-effect implementation at import time: load after the DOM exists.
const { ActivityRail } = await import("../src/timeline");
const { BASE_ENTRIES, defaultToolRegistry } = await import("../src/timeline/tool-renderers");
const { ToolReviewHistoryProvider } = await import("../src/components/tool-review-history");

/* ----------------------------------------------------------------------------
   Every tool renderer, built-in or a consumer's, receives the call with its
   credentials already hidden: the timeline redacts at the one place it hands a
   tool call to a renderer. This renders every registered renderer with a call
   whose arguments, output and provider item hold a signed link and repeat its
   signature bare, expands every row, and checks the signature never reaches
   the page, as text or in an attribute.
   -------------------------------------------------------------------------- */

const SECRET = "Q9xVt3Lm7Rk2Wp8Zs4Nb6Hy1";
const SIGNED = `https://store.example.com/exports/report.json?sv=2024-11-04&sp=r&sig=${SECRET}`;
const PROSE = `Saved report.json from ${SIGNED}. The signature on its own: ${SECRET}`;
/* Credentials under plain names, too short to look like one by shape: only
   their names say what they are. */
const PASSWORD = "hunter2pw";
const TOKEN = "opensesame";
const LETTERS_TOKEN = "abcdefghijklmnopqrstuvwx";
const NAMED = [
  `export TOKEN=${TOKEN} && PASSWORD=${PASSWORD} ./migrate --password ${PASSWORD}`,
  `{"password": "${PASSWORD}", "token": "${TOKEN}", "secret": "${TOKEN}"}`,
  `secret: ${PASSWORD}`,
  `curl -H 'Authorization: Bearer ${LETTERS_TOKEN}' https://api.example.com`,
].join("\n");
/* Secret-named fields a renderer may print itself, such as write_stdin's input. */
const KEYED = {
  access_token: TOKEN,
  api_key: TOKEN,
  password: PASSWORD,
  headers: { "X-Api-Key": TOKEN, Authorization: `Bearer ${LETTERS_TOKEN}` },
  cookies: [{ name: "auth_token", value: TOKEN }],
};
const HIDDEN_VALUES = [SECRET, PASSWORD, TOKEN, LETTERS_TOKEN];

const ARGUMENTS = {
  cmd: `curl -o report.json '${SIGNED}' && echo ${SECRET}\n${NAMED}`,
  command: `curl -o report.json '${SIGNED}'\n${NAMED}`,
  chars: `curl '${SIGNED}'\n${NAMED}\n`,
  ...KEYED,
  session_id: 3,
  input: `*** Begin Patch\n*** Add File: notes.md\n+${PROSE}\n*** End Patch`,
  patch: `*** Begin Patch\n*** Add File: notes.md\n+${PROSE}\n*** End Patch`,
  query: PROSE,
  q: PROSE,
  url: SIGNED,
  initialUrl: SIGNED,
  path: SIGNED,
  title: PROSE,
  name: PROSE,
  text: PROSE,
  content: PROSE,
  message: PROSE,
  prompt: PROSE,
  summary: `${PROSE}\n${NAMED}`,
  value: SECRET,
  questions: [{ id: "q1", kind: "text", prompt: PROSE, helpText: PROSE }],
};

const RESULT = {
  ok: true,
  title: PROSE,
  text: PROSE,
  output: `${PROSE}\n${NAMED}`,
  ...KEYED,
  content: [{ type: "text", text: PROSE }],
  url: SIGNED,
  path: SIGNED,
  results: [{ title: PROSE, snippet: PROSE, url: SIGNED, text: PROSE, path: SIGNED, score: 1 }],
  items: [{ title: PROSE, snippet: PROSE, url: SIGNED, text: PROSE }],
  entry: { title: PROSE, body: PROSE },
};

const OUTPUTS: ReadonlyArray<[string, unknown]> = [
  ["text output", `Process exited with code 0\nOutput:\n${PROSE}\n${NAMED}`],
  ["JSON output", JSON.stringify(RESULT)],
  ["structured output", RESULT],
];

function call(entry: (typeof BASE_ENTRIES)[number], output: unknown): ToolCallItem {
  const name = entry.match === "name" ? entry.name : "provider_tool";
  const raw =
    entry.match === "rawType"
      ? {
          type: entry.type,
          ...ARGUMENTS,
          operation: { type: "create_file", path: "notes.md", diff: `+${PROSE}` },
          action: { type: "type", text: PROSE },
          output: PROSE,
        }
      : undefined;
  return {
    kind: "tool-call",
    id: `tool-${name}`,
    turnId: "turn-1",
    callId: "call-1",
    name,
    arguments: ARGUMENTS,
    output,
    raw,
    status: "complete",
    occurredAt: "2026-10-29T00:00:00.000Z",
  };
}

let mounted: RenderedComponent | null = null;
afterEach(async () => {
  const current = mounted;
  mounted = null;
  await current?.unmount();
});

/** Render, open every collapsed row (twice, for rows nested in rows), and return the page. */
async function renderOpened(node: ReactNode): Promise<HTMLElement> {
  mounted = await renderComponent(node);
  await flush(20);
  for (let round = 0; round < 2; round++) {
    const closed = mounted.container.querySelectorAll<HTMLElement>('[aria-expanded="false"]');
    for (const toggle of closed) {
      await act(async () => {
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }
    await flush(20);
  }
  return mounted.container;
}

/** Every text and attribute value on the page. */
function shown(container: HTMLElement): string {
  const parts = [container.textContent ?? ""];
  for (const element of container.querySelectorAll("*")) {
    for (const attribute of element.attributes) parts.push(attribute.value);
  }
  return parts.join("\n");
}

describe("every tool renderer only sees credentials hidden", () => {
  const cases = BASE_ENTRIES.map(
    (entry) => [entry.match === "name" ? entry.name : `raw ${entry.type}`, entry] as const,
  );
  // The generic fallback, for any tool no entry matches.
  const fallback = {
    match: "name" as const,
    name: "acme__export_report",
    render: defaultToolRegistry.fallback,
  };

  let rowsShowingAPlaceholder = 0;
  for (const [label, output] of OUTPUTS) {
    test.each([...cases, ["generic fallback", fallback] as const])(
      `%s, ${label}`,
      async (_name, entry) => {
        const page = shown(await renderOpened(<ActivityRail items={[call(entry, output)]} bare />));
        for (const value of HIDDEN_VALUES) expect(page).not.toContain(value);
        if (page.includes("hidden]")) rowsShowingAPlaceholder++;
      },
    );
  }

  test("the fixtures reach the page, so the checks above can fail", () => {
    expect(rowsShowingAPlaceholder).toBeGreaterThan(10);
  });

  test("a consumer renderer receives the redacted call", async () => {
    const seen: ToolCallItem[] = [];
    function ConsumerRenderer(props: { item: ToolCallItem }) {
      seen.push(props.item);
      return <pre>{JSON.stringify(props.item)}</pre>;
    }
    const registry = { fallback: ConsumerRenderer, resolve: () => ConsumerRenderer };
    const page = shown(
      await renderOpened(
        <ActivityRail
          items={[
            call({ match: "name", name: "acme__export_report", render: registry.fallback }, PROSE),
          ]}
          toolRegistry={registry}
          bare
        />,
      ),
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const value of HIDDEN_VALUES) expect(JSON.stringify(seen)).not.toContain(value);
    // Field names stay, so the step still says what it held.
    expect(JSON.stringify(seen)).toContain('"password":"[hidden]"');
    expect(JSON.stringify(seen)).toContain('"X-Api-Key":"[hidden]"');
    expect(page).toContain("report.json?[signature hidden]");
    expect(page).not.toContain(SECRET);
  });

  test("an approval card from the review history hides the credential", async () => {
    const review = {
      version: 1,
      id: "call-1",
      actionDigest: "digest",
      revision: "revision-1",
      status: "approved",
      title: `Export ${SIGNED}`,
      effects: [],
      samples: [],
      fields: [
        { label: "Link", path: "url", preview: SIGNED },
        { label: "Note", path: "note", preview: `signature ${SECRET}` },
      ],
      moreFields: 0,
      reason: PROSE,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      approveLabel: "Approve",
      availableActions: [],
      detailsAvailable: false,
    } as unknown as ToolActionReview;
    const events = [
      {
        type: "session.requiresAction",
        sequence: 1,
        payload: { approvals: [{ callId: "call-1", name: "acme__export_report" }] },
      },
    ] as unknown as SessionEvent[];
    const page = await renderOpened(
      <ToolReviewHistoryProvider
        events={events}
        load={async () => review}
        onViewDetails={() => undefined}
      >
        <ActivityRail
          items={[
            call(
              { match: "name", name: "acme__export_report", render: defaultToolRegistry.fallback },
              PROSE,
            ),
          ]}
          bare
        />
      </ToolReviewHistoryProvider>,
    );
    expect(page.querySelector('[data-review-origin="history"]')).not.toBeNull();
    expect(shown(page)).toContain("[signature hidden]");
    expect(shown(page)).not.toContain(SECRET);
  });
});
