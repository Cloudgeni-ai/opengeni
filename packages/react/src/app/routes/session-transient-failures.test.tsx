/* ----------------------------------------------------------------------------
   The session page during an API rolling deploy or a network blip: no
   "Failed to load session" / "Event stream disconnected" toast and no failure
   panel while transient failures are retried quietly; one toast and a
   "Try again" panel only when the failure persists; recovery on its own.
   Definitive errors stay exactly as visible as before.
   -------------------------------------------------------------------------- */
import { describe, expect, mock, test } from "bun:test";
import { OpenGeniApiError, type AccessContext, type Session } from "@opengeni/sdk";
import { act, type ReactNode } from "react";
import * as SonnerPackage from "sonner";

import { flush, registerDom, renderComponent } from "../../../test/render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "../../../test/fake-client";
import { DEFAULT_TRANSIENT_READ_RETRY } from "../../hooks/internal";
import { SERVICE_UPDATING_CALM_WINDOW_MS } from "../../lib/transient-retry";
import { useSession } from "../../hooks/use-session";
import { useSessionEvents } from "../../hooks/use-session-events";
import { AppContext, type AppContextValue } from "../app-context";
import { AppHostProvider, type AppHost } from "../lib/app-host";
import type { PageHost } from "../lib/navigation";

const toastError = mock((_message: string, _data?: unknown) => undefined);
mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    { ...SonnerPackage.toast, error: toastError },
  ),
}));

const { useSessionFailureToasts } = await import("../lib/session-failure-toasts");
const { SessionUnavailableRoute } = await import("./session-unavailable");
const { default: SessionRouteAuxiliary } =
  await import("../components/session/session-tenancy-control");

registerDom({ clock: "virtual" });

const session = {
  id: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  lastSequence: 0,
  title: "Deploy-safe",
  titleSource: "user",
} as Session;

const unavailable = () => new OpenGeniApiError(503, "", { mutation: false });

function toastTitles(): string[] {
  return toastError.mock.calls.map(([message]) => message);
}

/** The session page's read hooks plus its failure toasts. */
function SessionPageReads(props: { client: ReturnType<typeof fakeClient> }) {
  const events = useSessionEvents(SESSION_ID, { client: props.client, workspaceId: WORKSPACE_ID });
  const detail = useSession(SESSION_ID, {
    client: props.client,
    workspaceId: WORKSPACE_ID,
    events: events.events,
  });
  useSessionFailureToasts(detail.error, events.error);
  return <p>{detail.session?.title ?? (detail.error ? "failed" : "loading")}</p>;
}

function RouteProviders(props: { host: AppHost; value: AppContextValue; children: ReactNode }) {
  return (
    <AppHostProvider host={props.host}>
      <AppContext.Provider value={props.value}>{props.children}</AppContext.Provider>
    </AppHostProvider>
  );
}

function liveStream(): ReturnType<typeof fakeClient>["streamEvents"] {
  return (_workspaceId, _sessionId, options = {}) =>
    (async function* () {
      options.onOpen?.();
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    })();
}

describe("session page failure toasts", () => {
  test("a transient outage that recovers raises no toast", async () => {
    toastError.mockClear();
    let failing = true;
    const client = fakeClient({
      getSession: async () => {
        if (failing) throw new TypeError("Failed to fetch");
        return session;
      },
      listEvents: async () => {
        if (failing) throw unavailable();
        return [];
      },
      streamEvents: liveStream(),
    });
    const rendered = await renderComponent(<SessionPageReads client={client} />);
    try {
      await flush(8_000);
      expect(rendered.container.textContent).toBe("loading");
      failing = false;
      await flush(8_000);
      expect(rendered.container.textContent).toBe("Deploy-safe");
      expect(toastTitles()).toEqual([]);
    } finally {
      await rendered.unmount();
    }
  });

  test("a persistent transient outage toasts each failure once, after the update window", async () => {
    toastError.mockClear();
    const client = fakeClient({
      getSession: async () => {
        throw unavailable();
      },
      listEvents: async () => {
        throw new TypeError("Failed to fetch");
      },
      streamEvents: liveStream(),
    });
    const rendered = await renderComponent(<SessionPageReads client={client} />);
    try {
      await flush(DEFAULT_TRANSIENT_READ_RETRY.quietWindowMs - 3_000);
      expect(toastTitles()).toEqual([]);
      // The reads surface their error after the quiet window, but a normal
      // update can still be underway: no toast yet.
      await flush(DEFAULT_TRANSIENT_READ_RETRY.backgroundDelayMs * 4);
      expect(rendered.container.textContent).toBe("failed");
      expect(toastTitles()).toEqual([]);
      // Outlasting the update window makes it a real problem: one toast each.
      await flush(SERVICE_UPDATING_CALM_WINDOW_MS);
      expect(toastTitles().sort()).toEqual(["Event stream disconnected", "Failed to load session"]);
      await flush(DEFAULT_TRANSIENT_READ_RETRY.backgroundDelayMs * 8);
      expect(toastTitles()).toHaveLength(2);
    } finally {
      await rendered.unmount();
    }
  });

  test("a long maintenance window never toasts and recovers on its own", async () => {
    toastError.mockClear();
    let parked = true;
    const maintenance = () =>
      new OpenGeniApiError(503, JSON.stringify({ error: "maintenance" }), { mutation: false });
    const client = fakeClient({
      getSession: async () => {
        if (parked) throw maintenance();
        return session;
      },
      listEvents: async () => {
        if (parked) throw maintenance();
        return [];
      },
      streamEvents: liveStream(),
    });
    const rendered = await renderComponent(<SessionPageReads client={client} />);
    try {
      await flush(10 * 60_000);
      expect(rendered.container.textContent).toBe("loading");
      expect(toastTitles()).toEqual([]);
      parked = false;
      await flush(10_000);
      expect(rendered.container.textContent).toBe("Deploy-safe");
      expect(toastTitles()).toEqual([]);
    } finally {
      await rendered.unmount();
    }
  });

  test("a definitive error toasts at once, and a 404 does not toast", async () => {
    toastError.mockClear();
    const forbidden = fakeClient({
      getSession: async () => {
        throw new OpenGeniApiError(403, "", { mutation: false });
      },
      listEvents: async () => [],
      streamEvents: liveStream(),
    });
    const first = await renderComponent(<SessionPageReads client={forbidden} />);
    await flush(10);
    expect(toastTitles()).toEqual(["Failed to load session"]);
    await first.unmount();

    toastError.mockClear();
    const missing = fakeClient({
      getSession: async () => {
        throw new OpenGeniApiError(404, "", { mutation: false });
      },
      listEvents: async () => [],
      streamEvents: liveStream(),
    });
    const second = await renderComponent(<SessionPageReads client={missing} />);
    await flush(10);
    expect(toastTitles()).toEqual([]);
    await second.unmount();
  });
});

describe("session load failure panel", () => {
  test("a persistent transient failure offers Try again instead of a dead end", async () => {
    const onRetry = mock(() => undefined);
    const rendered = await renderComponent(
      <SessionRouteAuxiliary
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        loadError={unavailable()}
        onRetry={onRetry}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("Temporarily unavailable");
      expect(rendered.container.textContent).toContain("Retrying automatically.");
      expect(rendered.container.textContent).not.toContain("Unable to open session");
      const button = [...rendered.container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Try again",
      );
      await act(async () => button?.click());
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("a definitive failure keeps the existing panel", async () => {
    const rendered = await renderComponent(
      <SessionRouteAuxiliary
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        loadError={new OpenGeniApiError(403, "", { mutation: false })}
        onRetry={() => undefined}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("Unable to open session");
      expect(rendered.container.querySelector("a")?.textContent).toBe("Back to sessions");
      expect(rendered.container.textContent).not.toContain("Try again");
    } finally {
      await rendered.unmount();
    }
  });
});

describe("SessionUnavailableRoute", () => {
  const otherWorkspaceId = "33333333-3333-4333-8333-333333333333";
  const accessContext = {
    subjectId: "subject-a",
    defaultWorkspaceId: WORKSPACE_ID,
    accountGrants: [],
    workspaceGrants: [WORKSPACE_ID, otherWorkspaceId].map((workspaceId) => ({
      workspaceId,
      accountId: "account-a",
      subjectId: "subject-a",
      permissions: ["sessions:read"],
    })),
  } as unknown as AccessContext;
  const workspaces = [
    { id: WORKSPACE_ID, accountId: "account-a" },
    { id: otherWorkspaceId, accountId: "account-a" },
  ];

  function renderRoute(getSession: () => Promise<Session>) {
    const assigned: string[] = [];
    const page = {
      href: () => `https://app.example.test/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}`,
      origin: () => "https://app.example.test",
      readQuery: () => new URLSearchParams(),
      replaceQuery: () => undefined,
      assign: (url: string) => void assigned.push(url),
      opensBeside: false,
    } as unknown as PageHost;
    const value = {
      accessContext,
      workspaces,
      client: { getSession },
    } as unknown as AppContextValue;
    const host = { navigation: { page } } as unknown as AppHost;
    const tree = (node: ReactNode) => (
      <RouteProviders host={host} value={value}>
        {node}
      </RouteProviders>
    );
    return { assigned, tree };
  }

  test("keeps looking through a transient failure, then shows Try again, then recovers", async () => {
    let failing = true;
    let reads = 0;
    const route = renderRoute(async () => {
      reads += 1;
      if (failing) throw unavailable();
      return session;
    });
    const rendered = await renderComponent(
      route.tree(<SessionUnavailableRoute workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />),
    );
    try {
      await flush(DEFAULT_TRANSIENT_READ_RETRY.quietWindowMs - 3_000);
      expect(reads).toBeGreaterThan(2);
      expect(rendered.container.textContent).toContain("Looking for this session");
      expect(rendered.container.textContent).not.toContain("Session unavailable");

      await flush(8_000);
      expect(rendered.container.textContent).toContain("Temporarily unavailable");
      const tryAgain = [...rendered.container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Try again",
      );
      expect(tryAgain).toBeDefined();

      failing = false;
      await act(async () => tryAgain?.click());
      await flush(10);
      expect(route.assigned).toEqual([`/workspaces/${otherWorkspaceId}/sessions/${SESSION_ID}`]);
    } finally {
      await rendered.unmount();
    }
  });

  test("a definitive server error keeps the existing Session unavailable panel", async () => {
    let reads = 0;
    const route = renderRoute(async () => {
      reads += 1;
      throw new OpenGeniApiError(500, "", { mutation: false });
    });
    const rendered = await renderComponent(
      route.tree(<SessionUnavailableRoute workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />),
    );
    try {
      await flush(10);
      expect(rendered.container.textContent).toContain("Session unavailable");
      await flush(60_000);
      expect(reads).toBe(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("a hidden page defers its retries and looks again when it returns", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    const setVisibility = async (next: DocumentVisibilityState) => {
      visibility = next;
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    };
    let failing = true;
    let reads = 0;
    const route = renderRoute(async () => {
      reads += 1;
      if (failing) throw unavailable();
      return session;
    });
    const rendered = await renderComponent(
      route.tree(<SessionUnavailableRoute workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />),
    );
    try {
      await flush(5_000);
      await setVisibility("hidden");
      await flush(10_000);
      const hiddenReads = reads;
      await flush(120_000);
      expect(reads).toBe(hiddenReads);

      failing = false;
      await setVisibility("visible");
      await flush(10);
      expect(reads).toBe(hiddenReads + 1);
      expect(route.assigned).toEqual([`/workspaces/${otherWorkspaceId}/sessions/${SESSION_ID}`]);
    } finally {
      await rendered.unmount();
      if (originalVisibility) {
        Object.defineProperty(document, "visibilityState", originalVisibility);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
    }
  });
});
