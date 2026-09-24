import { expect, test } from "bun:test";
import { act, useState, type ComponentProps } from "react";
import { SessionSearchPreview } from "./session-search-dialog";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import {
  registerDom,
  renderComponent,
  flush,
} from "../../../../../packages/react/test/render-hook";

registerDom();

test("context denial hides the title and passage, signals the parent, and aborts SDK reads", async () => {
  type Props = ComponentProps<typeof SessionSearchPreview>;
  const signals: AbortSignal[] = [];
  const selectedReads: Array<{ after?: number; before?: number; payloadMode?: string }> = [];
  let denied = 0;
  const client = {
    listEvents: async (
      _workspace: string,
      _session: string,
      options: { signal: AbortSignal; after?: number; before?: number; payloadMode?: string },
    ) => {
      signals.push(options.signal);
      selectedReads.push(options);
      throw new OpenGeniApiError(403, "private diagnostics");
    },
  } as unknown as Props["client"];
  const search = {
    page: {
      matches: [
        {
          eventId: "e",
          sequence: 7,
          messageMatchOffset: 0,
          role: "user",
          snippet: { text: "secret passage" },
        },
      ],
      hasMore: false,
    },
    loading: false,
    error: null,
    pageIndex: 0,
  } as unknown as Props["search"];
  const view = await renderComponent(
    <SessionSearchPreview
      client={client}
      authority="a"
      workspaceId="w"
      sessionId="s"
      title="secret title"
      query="secret"
      enabled
      search={search}
      index={0}
      setIndex={() => {}}
      scrollPosition={{ current: 0 }}
      onOpen={() => {}}
      onBack={() => {}}
      onAccessDenied={() => denied++}
    />,
  );
  await flush(150);
  expect(denied).toBe(1);
  expect(view.container.textContent).not.toContain("secret title");
  expect(view.container.textContent).not.toContain("secret passage");
  expect(view.container.textContent).not.toContain("private diagnostics");
  expect(signals).toHaveLength(3);
  expect(signals[0]).toBe(signals[1]);
  expect(signals[0]).toBe(signals[2]);
  expect(selectedReads[2]).toMatchObject({ after: 6, before: 8, payloadMode: "summary" });
  await view.unmount();
  expect(signals[0]!.aborted).toBe(true);
});

test("previous preview batch lands on its last occurrence, then moves backward normally", async () => {
  type Props = ComponentProps<typeof SessionSearchPreview>;
  let opened: unknown;
  const matches = Array.from({ length: 3 }, (_, index) => ({
    eventId: `event-${index}`,
    sequence: index + 1,
    messageMatchOffset: index,
    role: "user",
    snippet: { text: `needle ${index}` },
  }));
  const client = { listEvents: async () => [] } as unknown as Props["client"];
  function Preview() {
    const [pageIndex, setPage] = useState(1);
    const [index, setIndex] = useState(0);
    const search = {
      page: {
        matches: pageIndex === 1 ? [matches[0]] : matches,
        hasMore: pageIndex === 0,
        matchedOccurrenceCount: pageIndex === 1 ? 4 : 3,
      },
      pageIndex,
      loading: false,
      error: null,
      previous: () => setPage(0),
      next: () => setPage(1),
      retry: () => {},
    } as unknown as Props["search"];
    return (
      <SessionSearchPreview
        client={client}
        authority="a"
        workspaceId="w"
        sessionId="s"
        title="Session"
        query="needle"
        enabled
        onOpen={(match) => {
          opened = match;
        }}
        onBack={() => {}}
        search={search}
        index={index}
        setIndex={setIndex}
        scrollPosition={{ current: 0 }}
      />
    );
  }
  const view = await renderComponent(<Preview />);
  await flush(150);
  await act(async () =>
    view.container
      .querySelector<HTMLButtonElement>('[aria-label="Previous match in preview"]')!
      .click(),
  );
  await flush(150);
  expect(view.container.textContent).toContain("Match 3 of 3");
  await act(async () =>
    view.container
      .querySelector<HTMLButtonElement>('[aria-label="Previous match in preview"]')!
      .click(),
  );
  await flush(150);
  expect(view.container.textContent).toContain("Match 2 of 3");
  expect(opened).toBeUndefined();
  await view.unmount();
});
