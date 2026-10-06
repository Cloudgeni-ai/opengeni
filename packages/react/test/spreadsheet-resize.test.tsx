import { describe, expect, test } from "bun:test";

import { SparseSpreadsheetCellIndex } from "../src/components/artifacts/spreadsheet-canvas";
import {
  SpreadsheetProjectionGrid,
  type SpreadsheetDimensionCommit,
  type SpreadsheetGridProjection,
} from "../src/components/artifacts/spreadsheet-grid";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const SHEET_ID = "resizable-sheet";
const EMPTY_CELLS = new SparseSpreadsheetCellIndex([]);

function projection(
  revision = 1,
  columnWidths: readonly (readonly [number, number])[] = [],
  rowHeights: readonly (readonly [number, number])[] = [],
): SpreadsheetGridProjection {
  return {
    sheetId: SHEET_ID,
    sheetName: "Data",
    generationId: "generation",
    revision,
    dimensionRevision: revision,
    rowCount: 20,
    columnCount: 6,
    cells: EMPTY_CELLS,
    columnWidths,
    rowHeights,
    valueAt: () => null,
    readCell: () => null,
  };
}

function pointer(type: string, position: number, axis: "row" | "column" = "column") {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: axis === "column" ? position : 0,
    clientY: axis === "row" ? position : 0,
  });
}

function keyboard(type: string, key: string, repeat = false) {
  return new KeyboardEvent(type, { key, repeat, bubbles: true, cancelable: true });
}

function columnWidth(container: HTMLElement): string {
  return container.querySelector<HTMLElement>('[role="columnheader"][aria-colindex="1"]')!.style
    .width;
}

describe("spreadsheet dimension gestures", () => {
  test("previews drag motion without writes and commits once while cell input remains available", async () => {
    const changes: SpreadsheetDimensionCommit[] = [];
    const cellInputs: string[] = [];
    let resolveSave!: () => void;
    const saving = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const resize = (change: SpreadsheetDimensionCommit) => {
      changes.push(change);
      return saving;
    };
    const commit = (change: { input: string }) => {
      cellInputs.push(change.input);
    };
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid projection={projection()} resize={resize} commit={commit} />,
    );
    const handle = rendered.container.querySelector<HTMLElement>('[aria-label="Resize column A"]')!;
    await actRun(() => {
      handle.dispatchEvent(pointer("pointerdown", 96));
      for (let position = 100; position <= 144; position += 4) {
        handle.dispatchEvent(pointer("pointermove", position));
      }
    });
    await flush(20);
    expect(columnWidth(rendered.container)).toBe("144px");
    expect(changes).toHaveLength(0);

    await actRun(() => handle.dispatchEvent(pointer("pointerup", 144)));
    expect(changes).toEqual([{ sheetId: SHEET_ID, axis: "column", index: 0, size: 144 }]);
    expect(columnWidth(rendered.container)).toBe("144px");
    expect(rendered.container.querySelector('[role="grid"]')?.getAttribute("aria-busy")).toBe(
      "true",
    );
    const formula = rendered.container.querySelector<HTMLInputElement>(
      '[aria-label="Formula or value"]',
    )!;
    expect(formula.readOnly).toBe(false);
    await actRun(() => {
      formula.focus();
      formula.value = "=1+2";
      formula.dispatchEvent(new InputEvent("input", { bubbles: true, data: "=1+2" }));
    });
    await actRun(() => formula.dispatchEvent(keyboard("keydown", "Enter")));
    expect(cellInputs).toEqual(["=1+2"]);

    await actRun(() => resolveSave());
    await rendered.rerender(
      <SpreadsheetProjectionGrid
        projection={projection(2, [[0, 144]])}
        resize={resize}
        commit={commit}
      />,
    );
    expect(columnWidth(rendered.container)).toBe("144px");
    expect(rendered.container.querySelector('[role="grid"]')?.hasAttribute("aria-busy")).toBe(
      false,
    );
    await rendered.unmount();
  });

  test("coalesces held keyboard arrows into one resize and Home restores the default", async () => {
    const changes: SpreadsheetDimensionCommit[] = [];
    const resize = (change: SpreadsheetDimensionCommit) => {
      changes.push(change);
    };
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid projection={projection()} resize={resize} commit={() => {}} />,
    );
    const handle = rendered.container.querySelector<HTMLElement>('[aria-label="Resize column A"]')!;
    await actRun(() => {
      handle.dispatchEvent(keyboard("keydown", "ArrowRight"));
      handle.dispatchEvent(keyboard("keydown", "ArrowRight", true));
      handle.dispatchEvent(keyboard("keydown", "ArrowRight", true));
    });
    await flush(20);
    expect(columnWidth(rendered.container)).toBe("120px");
    expect(changes).toHaveLength(0);
    await actRun(() => handle.dispatchEvent(keyboard("keyup", "ArrowRight")));
    expect(changes).toEqual([{ sheetId: SHEET_ID, axis: "column", index: 0, size: 120 }]);
    await rendered.rerender(
      <SpreadsheetProjectionGrid
        projection={projection(2, [[0, 120]])}
        resize={resize}
        commit={() => {}}
      />,
    );
    await actRun(() => {
      handle.dispatchEvent(keyboard("keydown", "Home"));
      handle.dispatchEvent(keyboard("keyup", "Home"));
    });
    expect(changes[1]?.size).toBe(96);
    await rendered.unmount();
  });

  test("cancels pointer and keyboard previews without saving or changing selection", async () => {
    const changes: SpreadsheetDimensionCommit[] = [];
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid
        projection={projection()}
        resize={(change) => {
          changes.push(change);
        }}
        commit={() => {}}
      />,
    );
    const handle = rendered.container.querySelector<HTMLElement>('[aria-label="Resize column A"]')!;
    const selected = rendered.container.querySelector('[aria-label="Selected range"]')?.textContent;
    await actRun(() => {
      handle.dispatchEvent(pointer("pointerdown", 96));
      handle.dispatchEvent(pointer("pointermove", 192));
    });
    await flush(20);
    await actRun(() => handle.dispatchEvent(pointer("pointercancel", 192)));
    expect(columnWidth(rendered.container)).toBe("96px");
    await actRun(() => {
      handle.dispatchEvent(keyboard("keydown", "ArrowRight"));
      handle.dispatchEvent(keyboard("keydown", "Escape"));
      handle.dispatchEvent(keyboard("keyup", "ArrowRight"));
    });
    expect(columnWidth(rendered.container)).toBe("96px");
    expect(changes).toHaveLength(0);
    expect(rendered.container.querySelector('[aria-label="Selected range"]')?.textContent).toBe(
      selected,
    );
    await rendered.unmount();
  });

  test("resizes row heights independently and clamps abusive pointer motion", async () => {
    const changes: SpreadsheetDimensionCommit[] = [];
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid
        projection={projection()}
        resize={(change) => {
          changes.push(change);
        }}
        commit={() => {}}
      />,
    );
    const handle = rendered.container.querySelector<HTMLElement>('[aria-label="Resize row 1"]')!;
    await actRun(() => {
      handle.dispatchEvent(pointer("pointerdown", 24, "row"));
      handle.dispatchEvent(pointer("pointermove", 72, "row"));
      handle.dispatchEvent(pointer("pointerup", 72, "row"));
    });
    expect(changes).toEqual([{ sheetId: SHEET_ID, axis: "row", index: 0, size: 72 }]);
    expect(handle.getAttribute("aria-valuenow")).toBe("72");
    await actRun(() => {
      handle.dispatchEvent(pointer("pointerdown", 72, "row"));
      handle.dispatchEvent(pointer("pointermove", 1_000_000, "row"));
      handle.dispatchEvent(pointer("pointerup", 1_000_000, "row"));
    });
    expect(changes[1]?.size).toBe(4_096);
    await rendered.unmount();
  });

  test("pointer resizing owns focus so Escape cancels the drag before release", async () => {
    const changes: SpreadsheetDimensionCommit[] = [];
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid
        projection={projection()}
        resize={(change) => {
          changes.push(change);
        }}
        commit={() => {}}
      />,
    );
    const grid = rendered.container.querySelector<HTMLElement>('[role="grid"]')!;
    const handle = rendered.container.querySelector<HTMLElement>('[aria-label="Resize column A"]')!;
    await actRun(() => grid.focus());
    await actRun(() => {
      handle.dispatchEvent(pointer("pointerdown", 96));
      handle.dispatchEvent(pointer("pointermove", 160));
    });
    await flush(20);
    expect(document.activeElement).toBe(handle);
    await actRun(() => document.activeElement!.dispatchEvent(keyboard("keydown", "Escape")));
    await actRun(() => handle.dispatchEvent(pointer("pointerup", 160)));
    expect(changes).toHaveLength(0);
    expect(columnWidth(rendered.container)).toBe("96px");
    await rendered.unmount();
  });

  test("rolls back failed resize previews and provides a working retry", async () => {
    let calls = 0;
    const resize = () => {
      calls += 1;
      if (calls === 1) throw new Error("Resize was not saved");
    };
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid projection={projection()} resize={resize} commit={() => {}} />,
    );
    const handle = rendered.container.querySelector<HTMLElement>('[aria-label="Resize column A"]')!;
    await actRun(() => {
      handle.dispatchEvent(pointer("pointerdown", 96));
      handle.dispatchEvent(pointer("pointermove", 160));
      handle.dispatchEvent(pointer("pointerup", 160));
    });
    expect(columnWidth(rendered.container)).toBe("96px");
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Resize was not saved",
    );
    const retry = rendered.container.querySelector<HTMLButtonElement>('[role="alert"] button')!;
    await actRun(() => retry.click());
    expect(calls).toBe(2);
    expect(columnWidth(rendered.container)).toBe("160px");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    await rendered.unmount();
  });

  test("removes handles and stale previews when write authority changes", async () => {
    let rejectSave!: (cause: Error) => void;
    const saving = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    const resize = () => saving;
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid projection={projection()} resize={resize} commit={() => {}} />,
    );
    const handle = rendered.container.querySelector<HTMLElement>('[aria-label="Resize column A"]')!;
    await actRun(() => {
      handle.dispatchEvent(pointer("pointerdown", 96));
      handle.dispatchEvent(pointer("pointermove", 144));
      handle.dispatchEvent(pointer("pointerup", 144));
    });
    await rendered.rerender(
      <SpreadsheetProjectionGrid
        projection={projection()}
        readOnly
        resize={resize}
        commit={() => {}}
      />,
    );
    expect(rendered.container.querySelector('[role="separator"]')).toBeNull();
    expect(columnWidth(rendered.container)).toBe("96px");
    await actRun(() => rejectSave(new Error("Permission changed")));
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    await rendered.unmount();
  });

  test("keeps an independent failed resize visible while another dimension succeeds", async () => {
    const changes: SpreadsheetDimensionCommit[] = [];
    const resize = (change: SpreadsheetDimensionCommit) => {
      changes.push(change);
      if (changes.length === 1) throw new Error("Column A failed");
    };
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid projection={projection()} resize={resize} commit={() => {}} />,
    );
    const column = rendered.container.querySelector<HTMLElement>('[aria-label="Resize column A"]')!;
    await actRun(() => {
      column.dispatchEvent(keyboard("keydown", "ArrowRight"));
      column.dispatchEvent(keyboard("keyup", "ArrowRight"));
    });
    const row = rendered.container.querySelector<HTMLElement>('[aria-label="Resize row 1"]')!;
    await actRun(() => {
      row.dispatchEvent(keyboard("keydown", "ArrowDown"));
      row.dispatchEvent(keyboard("keyup", "ArrowDown"));
    });
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Column A failed",
    );
    await actRun(() =>
      rendered.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    expect(changes[2]).toEqual({ sheetId: SHEET_ID, axis: "column", index: 0, size: 104 });
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    await rendered.unmount();
  });

  test("does not mask later authoritative dimensions with an acknowledged local preview", async () => {
    const resize = () => {};
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid projection={projection()} resize={resize} commit={() => {}} />,
    );
    const handle = rendered.container.querySelector<HTMLElement>('[aria-label="Resize column A"]')!;
    await actRun(() => {
      handle.dispatchEvent(pointer("pointerdown", 96));
      handle.dispatchEvent(pointer("pointermove", 144));
      handle.dispatchEvent(pointer("pointerup", 144));
    });
    await rendered.rerender(
      <SpreadsheetProjectionGrid
        projection={projection(2, [[0, 144]])}
        resize={resize}
        commit={() => {}}
      />,
    );
    await rendered.rerender(
      <SpreadsheetProjectionGrid
        projection={projection(3, [[0, 220]])}
        resize={resize}
        commit={() => {}}
      />,
    );
    expect(columnWidth(rendered.container)).toBe("220px");
    await rendered.unmount();
  });
});
