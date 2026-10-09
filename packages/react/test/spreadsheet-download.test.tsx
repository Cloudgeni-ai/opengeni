import { expect, test } from "bun:test";
import type {
  EditableArtifactSession,
  EditableArtifactSyncView,
} from "@opengeni/sdk/editable-artifacts";
import { SpreadsheetDownloadButton } from "../src/components/artifacts/spreadsheet-download";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

function fixture() {
  let view: EditableArtifactSyncView = {
    artifactId: "a",
    modality: "spreadsheet",
    state: "live",
    cursor: 1,
    headSequence: 1,
    writable: false,
    pendingTransactions: 0,
    blockedPending: [],
    queuedMessages: 0,
    reconnectAttempt: 0,
    lastError: null,
  };
  let listener: (view: EditableArtifactSyncView) => void = () => {};
  return {
    session: {
      getView: () => view,
      subscribe: (next: typeof listener) => {
        listener = next;
        return () => {};
      },
    } as EditableArtifactSession,
    update: (patch: Partial<EditableArtifactSyncView>, notify = true) => {
      view = { ...view, ...patch };
      if (notify) listener(view);
    },
  };
}

test("allows read-only synced export, blocks duplicate clicks and saves the XLSX filename", async () => {
  const { session } = fixture();
  let resolve!: (blob: Blob) => void;
  let count = 0;
  const oldCreate = URL.createObjectURL;
  const oldRevoke = URL.revokeObjectURL;
  const oldClick = HTMLAnchorElement.prototype.click;
  const saved: string[] = [];
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {
    saved.push(this.download);
  };
  const mounted = await renderComponent(
    <SpreadsheetDownloadButton
      session={session}
      title="Forecast/2026.xlsx"
      download={() => {
        count++;
        return new Promise((yes) => {
          resolve = yes;
        });
      }}
    />,
  );
  try {
    const button = mounted.container.querySelector("button")!;
    await actRun(() => {
      button.click();
      button.click();
    });
    expect(count).toBe(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Preparing");
    await actRun(() => resolve(new Blob(["xlsx"])));
    await flush();
    expect(saved).toEqual(["Forecast_2026.xlsx"]);
    expect(button.disabled).toBe(false);
  } finally {
    await mounted.unmount();
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
    HTMLAnchorElement.prototype.click = oldClick;
  }
});

test("guards pending edits, blocked sync and stale click state", async () => {
  const f = fixture();
  let count = 0;
  const mounted = await renderComponent(
    <SpreadsheetDownloadButton
      session={f.session}
      title="Workbook"
      download={async () => {
        count++;
        return new Blob();
      }}
    />,
  );
  const button = mounted.container.querySelector("button")!;
  try {
    f.update({ pendingTransactions: 1 }, false);
    await actRun(() => button.click());
    expect(count).toBe(0);
    for (const patch of [
      { pendingTransactions: 1 },
      { pendingTransactions: 0, state: "reconnecting" as const },
      { state: "live" as const, authoringBlockedReason: "prior_writer" as const },
    ]) {
      await actRun(() => f.update(patch));
      expect(button.disabled).toBe(true);
    }
  } finally {
    await mounted.unmount();
  }
});

test("failure is visible and retryable, teardown aborts outstanding work", async () => {
  const { session } = fixture();
  let signal!: AbortSignal;
  let calls = 0;
  const mounted = await renderComponent(
    <SpreadsheetDownloadButton
      session={session}
      title="Workbook"
      download={async (input) => {
        signal = input;
        if (++calls === 1) throw new Error("Denied");
        return new Promise(() => {});
      }}
    />,
  );
  const button = mounted.container.querySelector("button")!;
  await actRun(() => button.click());
  await flush();
  expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
  expect(button.disabled).toBe(false);
  await actRun(() => button.click());
  await mounted.unmount();
  expect(signal.aborted).toBe(true);
});
