import { expect, test } from "bun:test";
import { act, useState, type ComponentProps } from "react";
import { SessionSearchPreview } from "./session-search-dialog";
import {
  registerDom,
  renderComponent,
  flush,
} from "../../../../../packages/react/test/render-hook";

registerDom();

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
