import { describe, expect, test } from "bun:test";

import {
  createMessageContextStore,
  createWithOpeningContext,
  withOpeningContext,
} from "./message-context";

const workbook = { id: "workbook", text: "In Budget.xlsx." };
const selection = (label: string) => ({
  id: "selection",
  label,
  detail: `${label} in Budget.xlsx`,
  text: `Selected ${label}.`,
});

describe("createMessageContextStore", () => {
  test("sends every item and shows only labeled ones", () => {
    const store = createMessageContextStore([workbook, selection("A1")]);
    expect(store.forSend()).toBe("In Budget.xlsx.\n\nSelected A1.");
    expect(store.pills()).toEqual([
      { id: "selection", label: "A1", detail: "A1 in Budget.xlsx", excluded: false },
    ]);
  });

  test("leaves an excluded pill out until its label changes", () => {
    const store = createMessageContextStore([workbook, selection("A1")]);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.exclude("selection");
    expect(store.forSend()).toBe("In Budget.xlsx.");
    expect(store.pills()[0]?.excluded).toBe(true);
    // The same selection with new values stays left out.
    store.set([workbook, { ...selection("A1"), text: "Selected A1, now 42." }]);
    expect(store.forSend()).toBe("In Budget.xlsx.");
    // A new selection comes back.
    store.set([workbook, selection("B2:C3")]);
    expect(store.forSend()).toBe("In Budget.xlsx.\n\nSelected B2:C3.");
    expect(store.pills()[0]?.excluded).toBe(false);
    expect(notified).toBe(2);
  });

  test("brings an excluded pill back on include", () => {
    const store = createMessageContextStore([selection("A1")]);
    store.exclude("selection");
    expect(store.forSend()).toBeUndefined();
    store.include("selection");
    expect(store.forSend()).toBe("Selected A1.");
  });

  test("keeps pills stable when nothing visible changes", () => {
    const store = createMessageContextStore([workbook, selection("A1")]);
    const before = store.pills();
    store.set([workbook, { ...selection("A1"), text: "Selected A1 again." }]);
    expect(store.pills()).toBe(before);
  });

  test("accepts text, an unlabeled item that can't be excluded, and a function", () => {
    expect(createMessageContextStore("  On the billing page. ").forSend()).toBe(
      "On the billing page.",
    );
    const quiet = createMessageContextStore(workbook);
    quiet.exclude("workbook");
    expect(quiet.forSend()).toBe("In Budget.xlsx.");
    let reads = 0;
    const lazy = createMessageContextStore(() => {
      reads += 1;
      return `read ${reads}`;
    });
    expect(lazy.pills()).toEqual([]);
    expect(lazy.forSend()).toBe("read 1");
    expect(lazy.forSend()).toBe("read 2");
    expect(createMessageContextStore(undefined).forSend()).toBeUndefined();
  });

  test("names the tools of the context it sends, once each, without excluded items", () => {
    const bound = { ...workbook, tools: ["excel_run"] };
    const store = createMessageContextStore([
      bound,
      { ...selection("A1"), tools: ["excel_run", "files_read"] },
    ]);
    expect(store.toolsForSend()).toEqual(["excel_run", "files_read"]);
    store.exclude("selection");
    expect(store.toolsForSend()).toEqual(["excel_run"]);
    expect(createMessageContextStore([workbook, selection("A1")]).toolsForSend()).toBeUndefined();
    expect(createMessageContextStore("On the billing page.").toolsForSend()).toBeUndefined();
    expect(createMessageContextStore(() => "lazy").toolsForSend()).toBeUndefined();
  });

  test("a new chat's create request carries the tools only with their context", () => {
    const request = { initialMessage: "Sum column B" };
    expect(withOpeningContext(request, "In Budget.xlsx.", ["excel_run"])).toEqual({
      initialMessage: "Sum column B",
      modelContext: "In Budget.xlsx.",
      modelContextTools: ["excel_run"],
    });
    expect(withOpeningContext(request, "In Budget.xlsx.", undefined)).toEqual({
      initialMessage: "Sum column B",
      modelContext: "In Budget.xlsx.",
    });
    expect(withOpeningContext(request, undefined, ["excel_run"])).toBe(request);
  });

  test("an older session proxy that refuses the tools still creates the chat with its context", async () => {
    const request = { initialMessage: "Sum column B" };
    const sent: object[] = [];
    const olderProxy = async (body: object) => {
      sent.push(body);
      if ("modelContextTools" in body)
        throw Object.assign(new Error("refused"), {
          status: 400,
          code: "create_field_not_allowed",
        });
      return "created";
    };
    await expect(
      createWithOpeningContext(olderProxy, request, "In Budget.xlsx.", ["excel_run"]),
    ).resolves.toBe("created");
    expect(sent).toEqual([
      { ...request, modelContext: "In Budget.xlsx.", modelContextTools: ["excel_run"] },
      { ...request, modelContext: "In Budget.xlsx." },
    ]);
    // Any other refusal, or one without tools, is the caller's to handle.
    const failing = async () => {
      throw Object.assign(new Error("denied"), { status: 403, code: "forbidden" });
    };
    await expect(
      createWithOpeningContext(failing, request, "In Budget.xlsx.", ["excel_run"]),
    ).rejects.toThrow("denied");
    sent.length = 0;
    await expect(
      createWithOpeningContext(olderProxy, request, "In Budget.xlsx.", undefined),
    ).resolves.toBe("created");
    expect(sent).toHaveLength(1);
  });
});
