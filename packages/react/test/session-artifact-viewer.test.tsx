import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  OPENGENI_API_CONTRACT_REVISION,
  OpenGeniClient,
  SESSION_SCOPE_HEADER,
  type ClientConfig,
} from "@opengeni/sdk";
import type { EditableArtifactResource } from "@opengeni/sdk/artifacts";
import * as editableSdk from "@opengeni/sdk/editable-artifacts";
import type {
  CreateBrowserEditableArtifactSessionOptions,
  EditableArtifactSession,
  EditableArtifactSyncView,
} from "@opengeni/sdk/editable-artifacts";
import { StrictMode } from "react";

import {
  EditableArtifactView,
  type EditableArtifactRuntimes,
  type OpenedEditableArtifact,
} from "../src/components/artifacts/editable-artifact-view";
import { SessionArtifactViewer } from "../src/components/artifacts/session-artifact-viewer";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const ARTIFACT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const baseUrl = new URL("https://host.example/proxy/");
const runtime = {
  kernelVersion: "test",
  modelSchemaVersion: 1,
  protocolVersion: 1,
  commandVersion: 1,
  wasmGlueUrl: "https://assets.example/kernel.js",
  wasmBinaryUrl: "https://assets.example/kernel.wasm",
} satisfies EditableArtifactRuntimes["document"];
const runtimes: EditableArtifactRuntimes = {
  document: runtime,
  spreadsheet: runtime,
  presentation: runtime,
  workerUrl: "https://assets.example/worker.js",
};
const capability: NonNullable<ClientConfig["artifacts"]> = {
  editableLiveUrl: "wss://api.example/v1/editable-artifacts/live",
  cachePartition: {
    accountId: "account",
    principalId: "principal-a",
    authorizationEpoch: "epoch-1",
  },
};

class TestSession {
  readonly artifactId = ARTIFACT_ID;
  readonly modality = "document";
  closeCalls = 0;
  start(): void {}
  async whenReady(): Promise<void> {}
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
  getView(): EditableArtifactSyncView {
    return {
      artifactId: this.artifactId,
      modality: this.modality,
      state: "live",
      cursor: 0,
      headSequence: 0,
      writable: false,
      pendingTransactions: 0,
      blockedPending: [],
      queuedMessages: 0,
      reconnectAttempt: 0,
      lastError: null,
    };
  }
  subscribe(): () => void {
    return () => undefined;
  }
  async queryDocument(): Promise<never> {
    throw new Error("fixture projection unavailable");
  }
}

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function mockSessions() {
  const created: { options: CreateBrowserEditableArtifactSessionOptions; session: TestSession }[] =
    [];
  const factory = spyOn(editableSdk, "createBrowserEditableArtifactSession").mockImplementation(
    (options) => {
      const session = new TestSession();
      created.push({ options, session });
      return session as unknown as EditableArtifactSession;
    },
  );
  restores.push(() => factory.mockRestore());
  return created;
}

function artifact(title = "Draft"): EditableArtifactResource {
  return { id: ARTIFACT_ID, title, modality: "document" } as EditableArtifactResource;
}

function opened(title = "Draft"): OpenedEditableArtifact {
  return {
    artifact: artifact(title),
    authority: {
      deploymentOrigin: baseUrl.origin,
      workspaceId: WORKSPACE_ID,
      ...capability.cachePartition,
    },
    replicaId: "1111111111111111",
  };
}

function clientFixture(name: string, config: () => Promise<ClientConfig | Response>) {
  const requests: { path: string; sessionId: string | null; replicaId: string | null }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://host.example/proxy",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        path: url.pathname,
        sessionId: new Headers(init?.headers).get(SESSION_SCOPE_HEADER),
        replicaId: url.searchParams.get("replicaId"),
      });
      if (url.pathname.endsWith("/config/client")) {
        const value = await config();
        return value instanceof Response ? value : Response.json(value);
      }
      if (url.pathname.endsWith(`/editable-artifacts/${ARTIFACT_ID}`)) {
        return Response.json(artifact(`Draft ${name}`));
      }
      return Response.json({});
    },
  });
  return { client, requests };
}

function configWith(artifacts: ClientConfig["artifacts"] | null = capability): ClientConfig {
  return {
    apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
    ...(artifacts ? { artifacts } : {}),
  } as ClientConfig;
}

function viewer(client: OpenGeniClient, sessionId = SESSION_ID, workspaceId = WORKSPACE_ID) {
  return (
    <SessionArtifactViewer
      client={client}
      workspaceId={workspaceId}
      sessionId={sessionId}
      target={{ kind: "editable-artifact", artifactId: ARTIFACT_ID }}
      editableRuntimes={runtimes}
      onClose={() => undefined}
    />
  );
}

describe("session artifact viewer", () => {
  test("StrictMode teardown leaves only the current editor active", async () => {
    const created = mockSessions();
    const fixture = clientFixture("A", async () => configWith());
    const rendered = await renderComponent(<StrictMode>{viewer(fixture.client)}</StrictMode>);
    await flush();
    expect(created.length).toBeGreaterThan(0);
    expect(created.filter((entry) => entry.session.closeCalls === 0)).toHaveLength(1);
    await created.at(-1)!.options.transport!.fetch!(
      new URL(
        `v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${ARTIFACT_ID}/live-ticket`,
        baseUrl,
      ),
      { method: "POST", body: JSON.stringify({ replicaId: "1111111111111111" }) },
    );
    expect(fixture.requests.at(-1)?.path.endsWith("/live-ticket")).toBe(true);
    await rendered.unmount();
    expect(created.every((entry) => entry.session.closeCalls === 1)).toBe(true);
  });

  test("closes client A's live session and reads the same artifact with client B", async () => {
    const created = mockSessions();
    const a = clientFixture("A", async () => configWith());
    const b = clientFixture("B", async () => configWith());
    const rendered = await renderComponent(viewer(a.client));
    await flush();
    expect(created).toHaveLength(1);
    expect(rendered.container.textContent).toContain("Draft A");

    await rendered.rerender(viewer(b.client));
    await flush();
    expect(created[0]!.session.closeCalls).toBe(1);
    expect(created).toHaveLength(2);
    expect(
      b.requests.some((request) => request.path.endsWith(`/editable-artifacts/${ARTIFACT_ID}`)),
    ).toBe(true);
    expect(b.requests.every((request) => request.sessionId === SESSION_ID)).toBe(true);
    expect(rendered.container.textContent).toContain("Draft B");
    expect(rendered.container.textContent).not.toContain("Draft A");

    await created[1]!.options.transport!.fetch!(
      new URL(
        `v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${ARTIFACT_ID}/live-ticket`,
        baseUrl,
      ),
      { method: "POST", body: JSON.stringify({ replicaId: "1111111111111111" }) },
    );
    expect(b.requests.at(-1)?.path.endsWith("/live-ticket")).toBe(true);
    expect(a.requests.some((request) => request.path.endsWith("/live-ticket"))).toBe(false);
    expect(b.requests.at(-2)?.replicaId).toBe("1111111111111111");
    await rendered.unmount();
    expect(created[1]!.session.closeCalls).toBe(1);
  });

  test("reopens for session and workspace replacement", async () => {
    const created = mockSessions();
    const fixture = clientFixture("A", async () => configWith());
    const rendered = await renderComponent(viewer(fixture.client));
    await flush();
    const secondSession = "33333333-3333-4333-8333-333333333333";
    await rendered.rerender(viewer(fixture.client, secondSession));
    await flush();
    expect(created[0]!.session.closeCalls).toBe(1);
    expect(created).toHaveLength(2);
    expect(fixture.requests.at(-1)?.sessionId).toBe(secondSession);
    expect(
      fixture.requests.filter(
        (request) => request.path.endsWith("/config/client") && request.sessionId === secondSession,
      ),
    ).toHaveLength(1);
    const secondWorkspace = "44444444-4444-4444-8444-444444444444";
    await rendered.rerender(viewer(fixture.client, secondSession, secondWorkspace));
    await flush();
    expect(created[1]!.session.closeCalls).toBe(1);
    expect(created[2]!.options.storageAuthority.workspaceId).toBe(secondWorkspace);
    await rendered.unmount();
  });

  test("a reconnect revalidates current authority and reopens under a changed principal", async () => {
    const created = mockSessions();
    let currentCapability = capability;
    const fixture = clientFixture("A", async () => configWith(currentCapability));
    const rendered = await renderComponent(viewer(fixture.client));
    await flush();
    const oldFetch = created[0]!.options.transport!.fetch!;
    currentCapability = {
      ...capability,
      cachePartition: {
        ...capability.cachePartition,
        principalId: "principal-b",
        authorizationEpoch: "epoch-2",
      },
    };
    await actRun(async () => {
      await expect(
        oldFetch(
          new URL(
            `v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${ARTIFACT_ID}/live-ticket`,
            baseUrl,
          ),
          { method: "POST", body: JSON.stringify({ replicaId: "1111111111111111" }) },
        ),
      ).rejects.toThrow();
    });
    await flush();
    expect(created[0]!.session.closeCalls).toBe(1);
    expect(created).toHaveLength(2);
    expect(created[1]!.options.storageAuthority.principalId).toBe("principal-b");
    expect(created[1]!.options.storageAuthority.authorizationEpoch).toBe("epoch-2");
    expect(fixture.requests.some((request) => request.path.endsWith("/live-ticket"))).toBe(false);
    await rendered.unmount();
  });

  test("a retired client's reconnect cannot read or mint a ticket", async () => {
    const created = mockSessions();
    const a = clientFixture("A", async () => configWith());
    const b = clientFixture("B", async () => configWith());
    const rendered = await renderComponent(viewer(a.client));
    await flush();
    const oldFetch = created[0]!.options.transport!.fetch!;
    const oldReadCount = a.requests.length;
    await rendered.rerender(viewer(b.client));
    await flush();
    await expect(
      oldFetch(
        new URL(
          `v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${ARTIFACT_ID}/live-ticket`,
          baseUrl,
        ),
        { method: "POST", body: JSON.stringify({ replicaId: "1111111111111111" }) },
      ),
    ).rejects.toThrow();
    expect(a.requests).toHaveLength(oldReadCount);
    await rendered.unmount();
  });

  test("missing capability is non-retryable and does not read an artifact", async () => {
    const created = mockSessions();
    const fixture = clientFixture("A", async () => configWith(null));
    const rendered = await renderComponent(viewer(fixture.client));
    await flush();
    expect(rendered.container.textContent).toContain("Artifact viewing isn't enabled");
    expect(rendered.container.textContent).not.toContain("Try again");
    expect(fixture.requests).toHaveLength(1);
    expect(created).toHaveLength(0);
    await rendered.unmount();
  });

  test("transient config failure offers retry and recovers to the editor", async () => {
    const created = mockSessions();
    let attempts = 0;
    const fixture = clientFixture("Recovered", async () => {
      if (++attempts === 1) throw new Error("temporary network failure");
      return configWith();
    });
    const rendered = await renderComponent(viewer(fixture.client));
    await flush();
    expect(rendered.container.textContent).toContain("A temporary problem");
    expect(rendered.container.textContent).not.toContain("Artifact viewing isn't enabled");
    const retry = [...rendered.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Try again"),
    );
    expect(retry).toBeDefined();
    await actRun(() => retry!.click());
    await flush();
    expect(attempts).toBe(2);
    expect(created).toHaveLength(1);
    expect(rendered.container.textContent).toContain("Draft Recovered");
    expect(
      rendered.container.querySelector('[data-og-artifact-modality="document"]'),
    ).not.toBeNull();
    await rendered.unmount();
  });

  test("retryable HTTP config errors keep the support reference", async () => {
    const fixture = clientFixture("A", async () => {
      return Response.json(
        {
          error: {
            message: "Unavailable",
            code: "temporary",
            retryable: true,
            requestId: "support-reference",
          },
        },
        { status: 503 },
      );
    });
    const rendered = await renderComponent(viewer(fixture.client));
    await flush();
    expect(rendered.container.textContent).toContain("Try again");
    expect(rendered.container.textContent).toContain("support-reference");
    await rendered.unmount();
  });
});

describe("editable artifact view authority", () => {
  test("authorityKey replacement closes and recreates even with identical returned authority and replica", async () => {
    const created = mockSessions();
    const value = opened();
    const opens: string[] = [];
    const fetchA = Object.assign(async () => Response.json({ principal: "A" }), {
      preconnect: globalThis.fetch.preconnect,
    });
    const fetchB = Object.assign(async () => Response.json({ principal: "B" }), {
      preconnect: globalThis.fetch.preconnect,
    });
    const view = (authorityKey: string, fetch: typeof globalThis.fetch) => (
      <EditableArtifactView
        baseUrl={baseUrl}
        workspaceId={WORKSPACE_ID}
        artifactId={ARTIFACT_ID}
        authorityKey={authorityKey}
        transport={{ fetch }}
        runtimes={runtimes}
        open={async () => {
          opens.push(authorityKey);
          return value;
        }}
      />
    );
    const rendered = await renderComponent(view("principal-a:epoch-1", fetchA));
    await flush();
    await rendered.rerender(view("principal-b:epoch-2", fetchB));
    await flush();
    expect(opens).toEqual(["principal-a:epoch-1", "principal-b:epoch-2"]);
    expect(created[0]!.session.closeCalls).toBe(1);
    expect(created).toHaveLength(2);
    expect(created[0]!.options.transport?.fetch).toBe(fetchA);
    expect(created[1]!.options.transport?.fetch).toBe(fetchB);
    await rendered.unmount();
  });

  test("a superseded open cannot restore client A's metadata", async () => {
    const created = mockSessions();
    let resolveA!: (value: OpenedEditableArtifact) => void;
    let signalA!: AbortSignal;
    const view = (
      authorityKey: string,
      open: (signal: AbortSignal) => Promise<OpenedEditableArtifact>,
    ) => (
      <EditableArtifactView
        baseUrl={baseUrl}
        workspaceId={WORKSPACE_ID}
        artifactId={ARTIFACT_ID}
        authorityKey={authorityKey}
        runtimes={runtimes}
        open={open}
      />
    );
    const rendered = await renderComponent(
      view("A", (signal) => {
        signalA = signal;
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      }),
    );
    await rendered.rerender(view("B", async () => opened("Draft B")));
    await flush();
    expect(signalA.aborted).toBe(true);
    await actRun(() => resolveA(opened("Draft A")));
    await flush();
    expect(created).toHaveLength(1);
    expect(rendered.container.textContent).toContain("Draft B");
    expect(rendered.container.textContent).not.toContain("Draft A");
    await rendered.unmount();
  });
});
