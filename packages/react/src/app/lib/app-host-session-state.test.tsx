import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";

import { registerDom, renderComponent } from "../../../test/render-hook";
import {
  AppHostProvider,
  useReportSessionState,
  type AppHost,
  type SessionViewState,
} from "./app-host";

registerDom();

const SESSION = "22222222-2222-4222-8222-222222222222";
const NO_EVENTS: readonly SessionEvent[] = [];
const ONE_EVENT = [{ sequence: 1, type: "user.message" }] as unknown as readonly SessionEvent[];

function Reporter(props: SessionViewState) {
  useReportSessionState(props);
  return null;
}

describe("useReportSessionState", () => {
  test("tells the host each change of the open chat, and nothing when unchanged", async () => {
    const seen: SessionViewState[] = [];
    const host = { onSessionState: (state) => void seen.push(state) } as AppHost;
    const view = (state: SessionViewState) => (
      <AppHostProvider host={host}>
        <Reporter {...state} />
      </AppHostProvider>
    );
    const loading = { sessionId: SESSION, status: null, events: NO_EVENTS, initialLoading: true };
    const rendered = await renderComponent(view(loading));
    try {
      await rendered.rerender(view(loading));
      const running = {
        sessionId: SESSION,
        status: "running",
        events: ONE_EVENT,
        initialLoading: false,
      } as const;
      await rendered.rerender(view(running));
      expect(seen).toEqual([loading, running]);
    } finally {
      await rendered.unmount();
    }
  });

  test("a host without a listener is fine", async () => {
    const rendered = await renderComponent(
      <AppHostProvider host={{} as AppHost}>
        <Reporter sessionId={SESSION} status={null} events={NO_EVENTS} initialLoading />
      </AppHostProvider>,
    );
    await rendered.unmount();
  });
});
