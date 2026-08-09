import { describe, expect, test } from "bun:test";
import type {
  EditableArtifactModality,
  EditableArtifactSession,
  EditableArtifactSyncListener,
  EditableArtifactSyncView,
} from "@opengeni/sdk/editable-artifacts";

import {
  EditableArtifactWorkbench,
  EditableArtifactWorkbenchHost,
} from "../src/components/artifacts/editable-artifact-workbench";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const ARTIFACT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

class FailingProjectionSession {
  readonly artifactId = ARTIFACT_ID;
  closeCalls = 0;
  private readonly listeners = new Set<EditableArtifactSyncListener>();

  constructor(readonly modality: EditableArtifactModality) {}

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
  subscribe(listener: EditableArtifactSyncListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async querySpreadsheetMetadata(): Promise<never> {
    throw new Error("fixture projection unavailable");
  }
  subscribeSpreadsheetMetadata(): () => void {
    return () => undefined;
  }
  async queryDocument(): Promise<never> {
    throw new Error("fixture projection unavailable");
  }
  async queryPresentation(): Promise<never> {
    throw new Error("fixture projection unavailable");
  }
  async queryPresentationSlideCatalog(): Promise<never> {
    throw new Error("fixture projection unavailable");
  }
  async queryPresentationEditorSlide(): Promise<never> {
    throw new Error("fixture projection unavailable");
  }
}

function session(modality: EditableArtifactModality): FailingProjectionSession {
  return new FailingProjectionSession(modality);
}

function asSession(value: FailingProjectionSession): EditableArtifactSession {
  return value as unknown as EditableArtifactSession;
}

describe("editable artifact workbench", () => {
  test("dispatches every modality through the same public workbench", async () => {
    for (const modality of ["document", "spreadsheet", "presentation"] as const) {
      const rendered = await renderComponent(
        <EditableArtifactWorkbench session={asSession(session(modality))} />,
      );
      await flush(10);
      expect(
        rendered.container.querySelector(`[data-og-artifact-modality="${modality}"]`),
      ).not.toBeNull();
      await rendered.unmount();
    }
  });

  test("fills its bounded host", async () => {
    const rendered = await renderComponent(
      <EditableArtifactWorkbench session={asSession(session("spreadsheet"))} />,
    );
    await flush(10);
    const surface = rendered.container.querySelector('[data-og-artifact-modality="spreadsheet"]');
    expect(surface?.classList.contains("h-full")).toBe(true);
    await rendered.unmount();
  });

  test("keeps one active SDK session per authority key and closes every replacement", async () => {
    const first = session("document");
    const second = session("presentation");
    let firstCreates = 0;
    let secondCreates = 0;
    const rendered = await renderComponent(
      <EditableArtifactWorkbenchHost
        sessionKey="artifact-a:authority-1"
        createSession={() => {
          firstCreates += 1;
          return asSession(first);
        }}
      />,
    );
    await flush(10);
    expect(firstCreates).toBe(1);

    await rendered.rerender(
      <EditableArtifactWorkbenchHost
        sessionKey="artifact-a:authority-1"
        createSession={() => {
          throw new Error("a new closure alone must not replace authority");
        }}
      />,
    );
    await flush();
    expect(firstCreates).toBe(1);
    expect(first.closeCalls).toBe(0);

    await rendered.rerender(
      <EditableArtifactWorkbenchHost
        sessionKey="artifact-b:authority-2"
        createSession={() => {
          secondCreates += 1;
          return asSession(second);
        }}
      />,
    );
    await flush(10);
    expect(first.closeCalls).toBe(1);
    expect(secondCreates).toBe(1);

    await rendered.unmount();
    expect(second.closeCalls).toBe(1);
  });

  test("surfaces synchronous setup failures and retries with the latest factory", async () => {
    const recovered = session("spreadsheet");
    let shouldFail = true;
    const createSession = () => {
      if (shouldFail) throw new Error("WASM assets do not match this deployment");
      return asSession(recovered);
    };
    const rendered = await renderComponent(
      <EditableArtifactWorkbenchHost
        sessionKey="artifact-a:authority-1"
        createSession={createSession}
      />,
    );
    await flush();
    expect(rendered.container.textContent).toContain("WASM assets do not match this deployment");

    shouldFail = false;
    const retry = rendered.container.querySelector<HTMLButtonElement>("button")!;
    await actRun(() => retry.click());
    await flush(10);
    expect(
      rendered.container.querySelector('[data-og-artifact-modality="spreadsheet"]'),
    ).not.toBeNull();

    await rendered.unmount();
    expect(recovered.closeCalls).toBe(1);
  });
});
