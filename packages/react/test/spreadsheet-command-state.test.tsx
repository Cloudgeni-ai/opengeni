import { describe, expect, test } from "bun:test";

import { SparseSpreadsheetCellIndex } from "../src/components/artifacts/spreadsheet-canvas";
import {
  SpreadsheetProjectionGrid,
  type SpreadsheetCommit,
  type SpreadsheetGridProjection,
  type SpreadsheetRangeCommit,
} from "../src/components/artifacts/spreadsheet-grid";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

function projection(
  revision = 1,
  values: readonly string[] = ["before", "other"],
): SpreadsheetGridProjection {
  const cells = values.map((value, col) => ({ row: 0, col, value, formula: null, format: {} }));
  return {
    sheetId: "data",
    generationId: "generation",
    sheetName: "Data",
    revision,
    rowCount: 20,
    columnCount: 6,
    cells: new SparseSpreadsheetCellIndex(cells),
    valueAt: (cell) => cell.value,
    readCell: (row, col) =>
      row === 0 && values[col] !== undefined
        ? { value: values[col], input: values[col]!, format: {} }
        : null,
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function key(target: Element, name: string) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
  );
}

async function enter(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Formula or value"]')!;
  await actRun(() => input.focus());
  await actRun(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  });
  await actRun(() => key(input, "Enter"));
  await flush();
}

function paste(target: Element, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { types: ["text/plain"], getData: () => text },
  });
  target.dispatchEvent(event);
}

describe("spreadsheet command state", () => {
  test("Enter displays the submitted input immediately, then rolls back a rejected edit", async () => {
    const save = deferred();
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid projection={projection()} commit={() => save.promise} />,
    );
    await enter(rendered.container, "after");
    const cell = rendered.container.querySelector('[data-og-cell="A1"]')!;
    expect(cell.textContent).toBe("after");
    expect(cell.getAttribute("aria-label")).toContain("pending");
    await actRun(() => save.reject(new Error("Not accepted")));
    expect(cell.textContent).toBe("before");
    expect(cell.getAttribute("aria-label")).not.toContain("pending");
    await rendered.unmount();
  });

  test("a pending formula shows its input, never the previous computed value", async () => {
    const save = deferred();
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid projection={projection()} commit={() => save.promise} />,
    );
    await enter(rendered.container, "=1+2");
    expect(rendered.container.querySelector('[data-og-cell="A1"]')?.textContent).toBe("=1+2");
    expect(
      rendered.container.querySelector('[data-og-cell="A1"]')?.getAttribute("aria-label"),
    ).toContain("awaiting calculation");
    await actRun(() => save.resolve());
    await rendered.rerender(
      <SpreadsheetProjectionGrid
        projection={{
          ...projection(2, ["3"]),
          readCell: () => ({ value: 3, input: "=1+2", format: {} }),
        }}
        commit={() => {}}
      />,
    );
    expect(rendered.container.querySelector('[data-og-cell="A1"]')?.textContent).toBe("3");
    await rendered.unmount();
  });

  test("refocusing pending input preserves the newest draft until the canonical projection catches up", async () => {
    const save = deferred();
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid projection={projection()} commit={() => save.promise} />,
    );
    await enter(rendered.container, "first pending");
    const input = rendered.container.querySelector<HTMLInputElement>(
      '[aria-label="Formula or value"]',
    )!;
    await actRun(() => input.focus());
    expect(input.value).toBe("first pending");
    await actRun(() => key(input, "Escape"));
    await actRun(() => save.resolve());
    await actRun(() => input.focus());
    expect(input.value).toBe("first pending");
    await actRun(() => key(input, "Escape"));
    await rendered.rerender(
      <SpreadsheetProjectionGrid
        projection={projection(2, ["first pending", "other"])}
        commit={() => {}}
      />,
    );
    expect(input.value).toBe("first pending");
    await rendered.unmount();
  });

  test("an older independent failure stays visible and retry does not overwrite the active cell draft", async () => {
    const saves = [deferred(), deferred(), deferred()];
    const changes: SpreadsheetCommit[] = [];
    const commit = (change: SpreadsheetCommit) => {
      changes.push(change);
      return saves[changes.length - 1]!.promise;
    };
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid projection={projection()} commit={commit} />,
    );
    await enter(rendered.container, "A pending");
    const grid = rendered.container.querySelector('[role="grid"]')!;
    await actRun(() => key(grid, "ArrowRight"));
    await enter(rendered.container, "B pending");
    await actRun(() => saves[1]!.resolve());
    await actRun(() => saves[0]!.reject(new Error("A failed")));
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("A failed");
    const input = rendered.container.querySelector<HTMLInputElement>(
      '[aria-label="Formula or value"]',
    )!;
    await actRun(() => input.focus());
    expect(input.value).toBe("B pending");
    await actRun(() =>
      rendered.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    expect(changes[2]?.cell).toEqual({ row: 0, col: 0 });
    expect(changes[2]?.input).toBe("A pending");
    expect(input.value).toBe("B pending");
    await actRun(() => saves[2]!.resolve());
    await rendered.unmount();
  });

  test("a superseded same-cell failure does not roll back or replay over a newer edit", async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const commit = () => (++calls === 1 ? first.promise : second.promise);
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid projection={projection()} commit={commit} />,
    );
    await enter(rendered.container, "old intent");
    await enter(rendered.container, "new intent");
    expect(rendered.container.querySelector('[data-og-cell="A1"]')?.textContent).toBe("new intent");
    await actRun(() => first.reject(new Error("old failure")));
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    expect(rendered.container.querySelector('[data-og-cell="A1"]')?.textContent).toBe("new intent");
    const input = rendered.container.querySelector<HTMLInputElement>(
      '[aria-label="Formula or value"]',
    )!;
    await actRun(() => input.focus());
    expect(input.value).toBe("new intent");
    await actRun(() => second.resolve());
    await rendered.unmount();
  });

  test("a partially overlapped failed paste cannot be retried over newer cells", async () => {
    const save = deferred();
    const changes: SpreadsheetRangeCommit[] = [];
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid
        projection={projection()}
        commit={() => {}}
        commitRange={(change) => {
          changes.push(change);
          return save.promise;
        }}
      />,
    );
    const grid = rendered.container.querySelector('[role="grid"]')!;
    await actRun(() => paste(grid, "A pasted\tB pasted"));
    await enter(rendered.container, "new B");
    await actRun(() => save.reject(new Error("Paste failed")));
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Paste failed",
    );
    expect(rendered.container.querySelector('[role="alert"] button')).toBeNull();
    expect(changes).toHaveLength(1);
    await rendered.unmount();
  });

  test("server acknowledgement controls saving status without blocking input", async () => {
    const commit = () => {};
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid
        projection={projection()}
        commit={commit}
        pendingTransactions={1}
        syncStatus="Saved"
      />,
    );
    expect(
      rendered.container.querySelector('[aria-label="Spreadsheet sync status"]')?.textContent,
    ).toBe("Saving…");
    expect(
      rendered.container.querySelector<HTMLInputElement>('[aria-label="Formula or value"]')
        ?.readOnly,
    ).toBe(false);
    await enter(rendered.container, "still usable");
    await rendered.rerender(
      <SpreadsheetProjectionGrid
        projection={projection()}
        commit={commit}
        pendingTransactions={1}
        syncStatus="Reconnecting…"
      />,
    );
    expect(
      rendered.container.querySelector('[aria-label="Spreadsheet sync status"]')?.textContent,
    ).toBe("Reconnecting…");
    await rendered.rerender(
      <SpreadsheetProjectionGrid
        projection={projection()}
        commit={commit}
        pendingTransactions={0}
        syncStatus="Saved"
      />,
    );
    expect(
      rendered.container.querySelector('[aria-label="Spreadsheet sync status"]')?.textContent,
    ).toBe("Saved");
    await rendered.unmount();
  });

  for (const action of ["clear", "paste"] as const) {
    test(`a newer ${action} does not resurrect an older pending cell draft`, async () => {
      const save = deferred();
      const commit = () => save.promise;
      const rendered = await renderComponent(
        <SpreadsheetProjectionGrid
          projection={projection()}
          commit={commit}
          clear={() => {}}
          commitRange={() => {}}
        />,
      );
      await enter(rendered.container, "older pending");
      const grid = rendered.container.querySelector('[role="grid"]')!;
      await actRun(() => (action === "clear" ? key(grid, "Delete") : paste(grid, "pasted")));
      const next = action === "clear" ? "" : "pasted";
      await rendered.rerender(
        <SpreadsheetProjectionGrid
          projection={projection(2, [next, "other"])}
          commit={commit}
          clear={() => {}}
          commitRange={() => {}}
        />,
      );
      await actRun(() => save.resolve());
      const input = rendered.container.querySelector<HTMLInputElement>(
        '[aria-label="Formula or value"]',
      )!;
      await actRun(() => input.focus());
      expect(input.value).toBe(next);
      await rendered.unmount();
    });
  }

  test("retrying a failed paste keeps its original anchor after navigation", async () => {
    const saves = [deferred(), deferred()];
    const changes: SpreadsheetRangeCommit[] = [];
    const commitRange = (change: SpreadsheetRangeCommit) => {
      changes.push(change);
      return saves[changes.length - 1]!.promise;
    };
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid
        projection={projection()}
        commit={() => {}}
        commitRange={commitRange}
      />,
    );
    const grid = rendered.container.querySelector('[role="grid"]')!;
    await actRun(() => paste(grid, "original A"));
    await actRun(() => key(grid, "ArrowRight"));
    await actRun(() => saves[0]!.reject(new Error("paste failed")));
    await actRun(() =>
      rendered.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    expect(changes[1]?.anchor).toEqual({ row: 0, col: 0 });
    await actRun(() => saves[1]!.resolve());
    await rendered.unmount();
  });

  test("a valid new action replaces invalid paste preflight feedback", async () => {
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid
        projection={projection()}
        commit={() => {}}
        commitRange={() => {}}
      />,
    );
    const grid = rendered.container.querySelector('[role="grid"]')!;
    await actRun(() => paste(grid, "a\tb\tc\td\te\tf\tg"));
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "does not fit",
    );
    await enter(rendered.container, "valid input");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    await rendered.unmount();
  });

  test("a resize clears invalid paste feedback without hiding an independent authored failure", async () => {
    const save = deferred();
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid
        projection={projection()}
        commit={() => save.promise}
        commitRange={() => {}}
        resize={() => {}}
      />,
    );
    const grid = rendered.container.querySelector('[role="grid"]')!;
    await actRun(() => paste(grid, "a\tb\tc\td\te\tf\tg"));
    const resize = rendered.container.querySelector('[aria-label="Resize column A"]')!;
    await actRun(() => key(resize, "ArrowRight"));
    await actRun(() =>
      resize.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true })),
    );
    await flush();
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    await enter(rendered.container, "pending");
    await actRun(() => save.reject(new Error("Cell failed")));
    await actRun(() => key(resize, "ArrowRight"));
    await actRun(() =>
      resize.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true })),
    );
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Cell failed",
    );
    await rendered.unmount();
  });
});
