import { describe, expect, test } from "bun:test";
import {
  Document,
  DocumentTextRun,
  type DocumentTextStyle,
} from "@opengeni/artifact-tool/reference";
import { useState } from "react";

import {
  DocumentArtifactSurface,
  DocumentEditor,
  DocumentProjectionEditor,
  type DocumentCommit,
  type DocumentEditorProjection,
  type DocumentSelection,
} from "../src/artifacts-document";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

describe("artifact document surface", () => {
  test("virtualizes large paginated and continuous documents to bounded DOM", async () => {
    const document = Document.create();
    for (let index = 0; index < 2_500; index += 1) {
      document.blocks.addParagraph(
        `Paragraph ${index + 1}: bounded projection keeps long documents responsive without changing their model.`,
      );
    }

    const rendered = await renderComponent(
      <DocumentEditor document={document} viewportHeight={360} overscanPages={1} />,
    );
    await flush(20);

    const viewport = rendered.container.querySelector('[role="document"]') as HTMLElement;
    expect(viewport).toBeTruthy();
    expect(rendered.container.querySelectorAll("[data-og-document-page]").length).toBeLessThan(6);
    expect(rendered.container.querySelectorAll("[data-og-document-block]").length).toBeLessThan(
      100,
    );
    expect(rendered.container.querySelector('[data-og-document-page="1"]')).toBeTruthy();

    viewport.scrollTop = 40_000;
    await actRun(() => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
    await flush(20);
    expect(rendered.container.querySelector('[data-og-document-page="1"]')).toBeNull();
    expect(rendered.container.querySelectorAll("[data-og-document-block]").length).toBeLessThan(
      100,
    );

    const continuous = rendered.container.querySelector(
      'button[aria-label="Continuous layout"]',
    ) as HTMLButtonElement;
    await actRun(() => continuous.click());
    await flush();
    expect(
      rendered.container
        .querySelector("[data-og-document-editor]")
        ?.getAttribute("data-og-document-layout"),
    ).toBe("continuous");
    expect(continuous.getAttribute("aria-pressed")).toBe("true");
    expect(rendered.container.querySelectorAll("[data-og-document-block]").length).toBeLessThan(
      100,
    );

    await rendered.unmount();
  });

  test("defaults narrow hosts to readable continuous layout but honors explicit pagination", async () => {
    const document = Document.create();
    document.blocks.addParagraph("Readable on a narrow embedded surface");
    const responsive = await renderComponent(<DocumentEditor document={document} />);
    const responsiveViewport =
      responsive.container.querySelector<HTMLElement>('[role="document"]')!;
    Object.defineProperties(responsiveViewport, {
      clientWidth: { configurable: true, value: 390 },
      clientHeight: { configurable: true, value: 700 },
    });
    await actRun(() => window.dispatchEvent(new Event("resize")));
    await flush();
    expect(
      responsive.container
        .querySelector("[data-og-document-editor]")
        ?.getAttribute("data-og-document-layout"),
    ).toBe("continuous");
    await responsive.unmount();

    const paginated = await renderComponent(
      <DocumentEditor document={document} defaultLayout="paginated" />,
    );
    const paginatedViewport = paginated.container.querySelector<HTMLElement>('[role="document"]')!;
    Object.defineProperties(paginatedViewport, {
      clientWidth: { configurable: true, value: 390 },
      clientHeight: { configurable: true, value: 700 },
    });
    await actRun(() => window.dispatchEvent(new Event("resize")));
    await flush();
    expect(
      paginated.container
        .querySelector("[data-og-document-editor]")
        ?.getAttribute("data-og-document-layout"),
    ).toBe("paginated");
    const page = paginated.container.querySelector<HTMLElement>("[data-og-document-page]")!;
    expect(Number.parseFloat(page.style.width)).toBeLessThanOrEqual(358);
    expect(page.firstElementChild?.getAttribute("style")).toContain("scale(");
    await paginated.unmount();
  });

  test("remeasures pages in both directions without moving the visible page", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const resizeCallbacks: ResizeObserverCallback[] = [];
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const document = Document.create();
      document.blocks.addParagraph("Page one");
      document.blocks.addPageBreak();
      document.blocks.addTable(
        Array.from({ length: 50 }, (_, index) => [`Estimated row ${index + 1}`, "Value"]),
      );
      document.blocks.addPageBreak();
      document.blocks.addParagraph("Page three anchor");
      document.blocks.addPageBreak();
      document.blocks.addParagraph("Page four");

      const rendered = await renderComponent(
        <DocumentEditor document={document} viewportHeight={300} overscanPages={1} />,
      );
      await flush();
      const viewport = rendered.container.querySelector<HTMLElement>('[role="document"]')!;
      expect(viewport.className).toContain("[overflow-anchor:none]");

      viewport.scrollTop = 1_200;
      await actRun(() => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
      await flush(20);
      const initialPageTwo = rendered.container.querySelector<HTMLElement>(
        '[data-og-document-page="2"]',
      )!;
      const initialPageThree = rendered.container.querySelector<HTMLElement>(
        '[data-og-document-page="3"]',
      )!;
      const estimatedPageTwoHeight = Number.parseFloat(initialPageTwo.style.height);
      const initialPageThreeTop = Number.parseFloat(initialPageThree.style.top);
      expect(estimatedPageTwoHeight).toBeGreaterThan(1_400);

      const anchorOffset = 100;
      viewport.scrollTop = initialPageThreeTop + anchorOffset;
      await actRun(() => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
      await flush(20);

      const pageTwo = rendered.container.querySelector<HTMLElement>('[data-og-document-page="2"]')!;
      const measuredBody = pageTwo.firstElementChild as HTMLElement;
      expect(measuredBody.className).not.toContain("min-h-full");
      expect(
        pageTwo.querySelector<HTMLElement>('[data-og-block-kind="table"]')?.style.minHeight,
      ).toBe("");
      let intrinsicHeight = 1_400;
      Object.defineProperty(measuredBody, "clientHeight", {
        configurable: true,
        get: () => intrinsicHeight,
      });
      Object.defineProperty(measuredBody, "scrollHeight", {
        configurable: true,
        get: () => intrinsicHeight,
      });
      const notifyResize = () => {
        for (const callback of resizeCallbacks) {
          callback([], {} as ResizeObserver);
        }
      };

      await actRun(notifyResize);
      let currentPageTwo = rendered.container.querySelector<HTMLElement>(
        '[data-og-document-page="2"]',
      )!;
      let currentPageThree = rendered.container.querySelector<HTMLElement>(
        '[data-og-document-page="3"]',
      )!;
      expect(Number.parseFloat(currentPageTwo.style.height)).toBe(1_400);
      expect(viewport.scrollTop - Number.parseFloat(currentPageThree.style.top)).toBe(anchorOffset);

      intrinsicHeight = 1_650;
      await actRun(notifyResize);
      currentPageTwo = rendered.container.querySelector<HTMLElement>(
        '[data-og-document-page="2"]',
      )!;
      currentPageThree = rendered.container.querySelector<HTMLElement>(
        '[data-og-document-page="3"]',
      )!;
      expect(Number.parseFloat(currentPageTwo.style.height)).toBe(1_650);
      expect(viewport.scrollTop - Number.parseFloat(currentPageThree.style.top)).toBe(anchorOffset);

      intrinsicHeight = 1_250;
      await actRun(notifyResize);
      currentPageTwo = rendered.container.querySelector<HTMLElement>(
        '[data-og-document-page="2"]',
      )!;
      currentPageThree = rendered.container.querySelector<HTMLElement>(
        '[data-og-document-page="3"]',
      )!;
      expect(Number.parseFloat(currentPageTwo.style.height)).toBe(1_250);
      expect(viewport.scrollTop - Number.parseFloat(currentPageThree.style.top)).toBe(anchorOffset);

      await rendered.unmount();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  test("retains the first intrinsic measurement after a layout projection changes", async () => {
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    )!;
    const ownScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    const scrollHeightDescriptor =
      ownScrollHeightDescriptor ??
      Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!;
    let intrinsicPageHeight = 1_200;
    const measuredHeight = function (this: HTMLElement, fallback: PropertyDescriptor): number {
      return this.parentElement?.hasAttribute("data-og-document-page")
        ? intrinsicPageHeight
        : (fallback.get?.call(this) ?? 0);
    };
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return measuredHeight.call(this, clientHeightDescriptor);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return measuredHeight.call(this, scrollHeightDescriptor);
      },
    });

    try {
      const document = Document.create();
      document.blocks.addParagraph("A short paragraph with deliberately different projections.");
      const rendered = await renderComponent(
        <DocumentEditor document={document} viewportHeight={400} overscanPages={0} />,
      );
      await flush();
      expect(
        Number.parseFloat(
          rendered.container.querySelector<HTMLElement>("[data-og-document-page]")!.style.height,
        ),
      ).toBe(1_200);

      // A newly mounted projection reports during its layout effect. A later
      // passive scope reset must not erase this first authoritative measure.
      intrinsicPageHeight = 340;
      await actRun(() =>
        rendered.container
          .querySelector<HTMLButtonElement>('button[aria-label="Continuous layout"]')!
          .click(),
      );
      await flush();
      expect(
        Number.parseFloat(
          rendered.container.querySelector<HTMLElement>("[data-og-document-page]")!.style.height,
        ),
      ).toBe(340);

      await rendered.unmount();
    } finally {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
      if (ownScrollHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", ownScrollHeightDescriptor);
      } else {
        delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      }
    }
  });

  test("projects headings, real lists, tables, comments, and tracked changes", async () => {
    const document = Document.create();
    document.blocks.addHeading("Quarterly brief", 1);
    const numbered = document.blocks.addParagraph("First decision", {
      list: { kind: "number" },
    });
    document.blocks.addParagraph("Second decision", {
      list: { kind: "number" },
    });
    document.blocks.addParagraph("Supporting detail", {
      list: { kind: "bullet", level: 1 },
    });
    document.blocks.addTable(
      [
        ["Owner", "Status"],
        ["Taylor", "Ready"],
      ],
      { headerRows: 1, columnWidthsPt: [180, 120], cellPaddingPt: 7 },
    );
    document.comments.setSelf({ displayName: "Reviewer" });
    document.comments.addThread({ block: numbered, start: 0, end: 5 }, "Confirm this owner.");
    const resolved = document.comments.addThread(
      { block: numbered, start: 6, end: 14 },
      "Already addressed.",
    );
    resolved.resolve();
    document.changes.add({ block: numbered, start: 6, end: 14 }, "insert", "Editor");

    const rendered = await renderComponent(
      <DocumentArtifactSurface
        document={document}
        title="Quarterly brief"
        layout="continuous"
        viewportHeight={500}
        readOnly
      />,
    );
    await flush();

    expect(rendered.container.querySelector("h1")?.textContent).toBe("Quarterly brief");
    expect(rendered.container.querySelector("table")).toBeTruthy();
    expect(rendered.container.textContent).toContain("1.");
    expect(rendered.container.textContent).toContain("•");
    expect(rendered.container.querySelector('[data-og-commented="true"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-og-change="insert"]')).toBeTruthy();
    expect(
      rendered.container.querySelector('[role="document"]')?.getAttribute("aria-readonly"),
    ).toBe("true");

    const comment = rendered.container.querySelector(
      'button[aria-label="1 unresolved comment"]',
    ) as HTMLButtonElement;
    await actRun(() => comment.click());
    await flush();
    expect(
      rendered.container.querySelector('[aria-label="Comment thread"]')?.textContent,
    ).toContain("Confirm this owner.");
    expect(
      rendered.container.querySelector('[aria-label="Comment thread"]')?.textContent,
    ).toContain("Already addressed.");

    await rendered.unmount();
  });

  test("honors section page geometry and expands an oversized block instead of clipping it", async () => {
    const document = Document.create();
    document.blocks.addParagraph("Portrait section");
    document.sections.add({
      page: {
        widthPt: 792,
        heightPt: 612,
        marginTopPt: 54,
        marginRightPt: 54,
        marginBottomPt: 54,
        marginLeftPt: 54,
      },
    });
    document.blocks.addParagraph("Landscape section");
    document.blocks.addTable(
      Array.from({ length: 50 }, (_, index) => [`Row ${index + 1}`, "Value"]),
      { columnWidthsPt: [220, 120] },
    );

    const rendered = await renderComponent(
      <DocumentEditor document={document} viewportHeight={4_000} overscanPages={0} />,
    );
    await flush();
    const pages = rendered.container.querySelectorAll<HTMLElement>("[data-og-document-page]");
    expect(pages.length).toBe(3);
    expect(pages[0]?.getAttribute("data-og-page-width-pt")).toBe("612");
    expect(pages[1]?.getAttribute("data-og-page-width-pt")).toBe("792");
    expect(Number.parseFloat(pages[2]?.style.height ?? "0")).toBeGreaterThan(816);
    expect(pages[2]?.querySelector("table")).toBeTruthy();

    await rendered.unmount();
  });

  test("edits the authoritative paragraph, preserves runs, and reports range formatting", async () => {
    const document = Document.create();
    const paragraph = document.blocks.addParagraph([
      new DocumentTextRun("Alpha", { italic: true }),
      new DocumentTextRun(" beta"),
    ]);
    const commits: DocumentCommit[] = [];
    const selections: DocumentSelection[] = [];
    const rendered = await renderComponent(
      <DocumentEditor
        document={document}
        layout="continuous"
        viewportHeight={300}
        onCommit={(commit) => commits.push(commit)}
        onSelectionChange={(selection) => selections.push(selection)}
      />,
    );
    await flush();

    const editor = rendered.container.querySelector(
      `[data-og-paragraph="${paragraph.id}"]`,
    ) as HTMLElement;
    await actRun(() => editor.focus());
    editor.textContent = "Alpha beta!";
    await actRun(() => editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: "!" })));
    expect(paragraph.text).toBe("Alpha beta!");
    expect(paragraph.runs[0]?.style.italic).toBe(true);
    expect(commits.at(-1)).toMatchObject({
      kind: "text",
      blockId: paragraph.id,
      text: "Alpha beta!",
    });

    await actRun(() => selectText(editor, 6, 10));
    await actRun(() => editor.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    await flush();
    expect(selections.at(-1)).toEqual({
      blockId: paragraph.id,
      start: 6,
      end: 10,
    });
    const bold = rendered.container.querySelector('button[aria-label="Bold"]') as HTMLButtonElement;
    expect(bold.disabled).toBe(false);
    const revisionBeforeFormat = document.revision;
    await actRun(() => bold.click());
    await flush();

    expect(document.revision).toBe(revisionBeforeFormat + 1);
    expect(styleAt(paragraph, 7).bold).toBe(true);
    expect(styleAt(paragraph, 1).bold).not.toBe(true);
    expect(commits.at(-1)).toMatchObject({
      kind: "format",
      blockId: paragraph.id,
      range: { start: 6, end: 10 },
      style: { bold: true },
    });

    await actRun(() => selectText(editor, 0, 5));
    await actRun(() =>
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "i",
          ctrlKey: true,
          bubbles: true,
        }),
      ),
    );
    await flush();
    expect(styleAt(paragraph, 1).italic).toBe(false);
    expect(commits.at(-1)).toMatchObject({
      kind: "format",
      range: { start: 0, end: 5 },
      style: { italic: false },
    });

    await actRun(() => editor.blur());
    await rendered.unmount();
  });

  test("read-only mode leaves selection and layout usable but rejects mutations", async () => {
    const document = Document.create();
    const paragraph = document.blocks.addParagraph("Locked text");
    const revision = document.revision;
    const commits: DocumentCommit[] = [];
    const rendered = await renderComponent(
      <DocumentEditor
        document={document}
        readOnly
        viewportHeight={280}
        onCommit={(commit) => commits.push(commit)}
      />,
    );
    await flush();

    const editor = rendered.container.querySelector(
      `[data-og-paragraph="${paragraph.id}"]`,
    ) as HTMLElement;
    expect(editor.getAttribute("contenteditable")).toBe("false");
    editor.textContent = "Attempted edit";
    await actRun(() => editor.dispatchEvent(new InputEvent("input", { bubbles: true })));
    expect(paragraph.text).toBe("Locked text");
    expect(document.revision).toBe(revision);
    expect(commits).toEqual([]);
    expect(
      (rendered.container.querySelector('button[aria-label="Bold"]') as HTMLButtonElement).disabled,
    ).toBe(true);

    await rendered.unmount();
  });

  test("routes text edits through authoritative annotation rebasing exactly once", async () => {
    const document = Document.create();
    const paragraph = document.blocks.addParagraph("Alpha beta");
    const comment = document.comments.addThread(
      { block: paragraph, start: 6, end: 10 },
      "Keep this term",
    );
    const change = document.changes.add(
      { block: paragraph, start: 6, end: 10 },
      "insert",
      "Editor",
    );
    const rendered = await renderComponent(
      <DocumentEditor document={document} layout="continuous" viewportHeight={260} />,
    );
    await flush();
    const editor = rendered.container.querySelector(
      `[data-og-paragraph="${paragraph.id}"]`,
    ) as HTMLElement;
    const revision = document.revision;
    await actRun(() => editor.focus());
    editor.textContent = "Alpha! beta";
    await actRun(() => editor.dispatchEvent(new InputEvent("input", { bubbles: true })));

    expect(document.revision).toBe(revision + 1);
    expect({ start: comment.start, end: comment.end }).toEqual({
      start: 7,
      end: 11,
    });
    expect({ start: change.start, end: change.end }).toEqual({
      start: 7,
      end: 11,
    });

    await actRun(() => editor.blur());
    await rendered.unmount();
  });

  test("keeps the active caret leaf stable across host rerenders and buffers IME", async () => {
    const document = Document.create();
    const paragraph = document.blocks.addParagraph("Draft");

    function RerenderingHost() {
      const [commits, setCommits] = useState(0);
      return (
        <div data-host-commits={commits}>
          <DocumentEditor
            document={document}
            layout="continuous"
            viewportHeight={260}
            onCommit={() => setCommits((current) => current + 1)}
          />
        </div>
      );
    }

    const rendered = await renderComponent(<RerenderingHost />);
    await flush();
    const editor = rendered.container.querySelector(
      `[data-og-paragraph="${paragraph.id}"]`,
    ) as HTMLElement;
    await actRun(() => editor.focus());
    editor.textContent = "Draft one";
    await actRun(() => selectText(editor, 9, 9));
    await actRun(() => editor.dispatchEvent(new InputEvent("input", { bubbles: true })));
    await flush();

    expect(paragraph.text).toBe("Draft one");
    expect(
      rendered.container.querySelector("[data-host-commits]")?.getAttribute("data-host-commits"),
    ).toBe("1");
    expect(rendered.container.querySelector(`[data-og-paragraph="${paragraph.id}"]`)).toBe(editor);
    expect(
      globalThis.getSelection()?.anchorNode &&
        editor.contains(globalThis.getSelection()!.anchorNode),
    ).toBe(true);

    await actRun(() =>
      editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "二" })),
    );
    editor.textContent = "Draft one二";
    await actRun(() => selectText(editor, 10, 10));
    await actRun(() =>
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true })),
    );
    expect(paragraph.text).toBe("Draft one");
    await actRun(() =>
      editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "二" })),
    );
    await actRun(() => editor.dispatchEvent(new InputEvent("input", { bubbles: true })));
    await flush();
    expect(paragraph.text).toBe("Draft one二");
    expect(rendered.container.querySelector(`[data-og-paragraph="${paragraph.id}"]`)).toBe(editor);

    await actRun(() => selectText(editor, 10, 10));
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await flush();
    expect(paragraph.text).toBe("Draft one二\n");
    expect(rendered.container.querySelector(`[data-og-paragraph="${paragraph.id}"]`)).toBe(editor);

    await actRun(() => editor.blur());
    await rendered.unmount();
  });

  test("suppresses rich clipboard and drop defaults while accepting bounded plain text", async () => {
    const document = Document.create();
    const paragraph = document.blocks.addParagraph("Safe");
    const rendered = await renderComponent(
      <DocumentEditor document={document} layout="continuous" viewportHeight={240} />,
    );
    await flush();
    const editor = rendered.container.querySelector<HTMLElement>(
      `[data-og-paragraph="${paragraph.id}"]`,
    )!;
    await actRun(() => editor.focus());
    await actRun(() => selectText(editor, 4, 4));

    const htmlOnly = clipboardEvent("paste", "", '<img src="https://attacker.invalid/pixel">');
    await actRun(() => editor.dispatchEvent(htmlOnly));
    expect(htmlOnly.defaultPrevented).toBe(true);
    expect(editor.querySelector("img, a")).toBeNull();
    expect(paragraph.text).toBe("Safe");

    const plain = clipboardEvent("paste", " text", '<a href="https://attacker.invalid">text</a>');
    await actRun(() => editor.dispatchEvent(plain));
    expect(plain.defaultPrevented).toBe(true);
    expect(editor.querySelector("img, a")).toBeNull();
    expect(paragraph.text).toBe("Safe text");

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { getData: () => '<img src="https://attacker.invalid/drop">' },
    });
    await actRun(() => editor.dispatchEvent(drop));
    expect(drop.defaultPrevented).toBe(true);
    expect(editor.querySelector("img, a")).toBeNull();
    expect(paragraph.text).toBe("Safe text");
    await rendered.unmount();
  });

  test("projection edits stay external, expose pending state, reconcile, and retry failures", async () => {
    const makeProjection = (revision: number, text: string): DocumentEditorProjection => ({
      revision,
      page: {
        widthPt: 612,
        heightPt: 792,
        marginTopPt: 72,
        marginRightPt: 72,
        marginBottomPt: 72,
        marginLeftPt: 72,
      },
      blocks: [
        {
          kind: "paragraph",
          id: "host-paragraph-1",
          runs: [{ text, style: { italic: true } }],
        },
      ],
    });
    const original = makeProjection(7, "Before");
    const commits: DocumentCommit[] = [];
    let attempt = 0;
    let resolveCommit: (() => void) | undefined;
    const rendered = await renderComponent(
      <DocumentProjectionEditor
        projection={original}
        layout="continuous"
        viewportHeight={240}
        commit={(command) => {
          commits.push(command);
          attempt += 1;
          if (attempt === 1) return Promise.reject(new Error("Connection lost"));
          return new Promise<void>((resolve) => {
            resolveCommit = resolve;
          });
        }}
      />,
    );
    await flush();
    const editor = rendered.container.querySelector<HTMLElement>(
      '[data-og-paragraph="host-paragraph-1"]',
    )!;
    await actRun(() => editor.focus());
    editor.textContent = "After";
    await actRun(() => editor.dispatchEvent(new InputEvent("input", { bubbles: true })));
    await flush();

    expect(original.blocks[0]?.kind === "paragraph" && original.blocks[0].runs[0]?.text).toBe(
      "Before",
    );
    expect(commits[0]).toMatchObject({
      kind: "text",
      blockId: "host-paragraph-1",
      text: "After",
      revision: 7,
    });
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Connection lost",
    );
    expect(
      rendered.container
        .querySelector("[data-og-document-editor]")
        ?.getAttribute("data-og-command-state"),
    ).toBe("error");

    await actRun(() =>
      rendered.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    await flush();
    expect(commits).toHaveLength(2);
    expect(
      rendered.container
        .querySelector("[data-og-document-editor]")
        ?.getAttribute("data-og-command-state"),
    ).toBe("pending");
    await actRun(() => resolveCommit?.());
    await flush();
    await rendered.rerender(
      <DocumentProjectionEditor
        projection={makeProjection(8, "After")}
        layout="continuous"
        viewportHeight={240}
        commit={() => {}}
      />,
    );
    await flush();
    expect(
      rendered.container.querySelector('[data-og-paragraph="host-paragraph-1"]')?.textContent,
    ).toBe("After");
    expect(
      rendered.container
        .querySelector("[data-og-document-editor]")
        ?.getAttribute("data-og-command-state"),
    ).toBe("idle");
    await rendered.unmount();
  });

  test("an older rejected save cannot overwrite a newer edit state", async () => {
    const projection: DocumentEditorProjection = {
      revision: 1,
      page: {
        widthPt: 612,
        heightPt: 792,
        marginTopPt: 72,
        marginRightPt: 72,
        marginBottomPt: 72,
        marginLeftPt: 72,
      },
      blocks: [{ kind: "paragraph", id: "paragraph", runs: [{ text: "Initial" }] }],
    };
    const rejectors: Array<(cause: Error) => void> = [];
    const rendered = await renderComponent(
      <DocumentProjectionEditor
        projection={projection}
        layout="continuous"
        viewportHeight={240}
        commit={() =>
          new Promise<void>((_resolve, reject) => {
            rejectors.push(reject);
          })
        }
      />,
    );
    await flush();
    const editor = rendered.container.querySelector<HTMLElement>(
      '[data-og-paragraph="paragraph"]',
    )!;

    editor.textContent = "First";
    await actRun(() => editor.dispatchEvent(new InputEvent("input", { bubbles: true })));
    editor.textContent = "Second";
    await actRun(() => editor.dispatchEvent(new InputEvent("input", { bubbles: true })));
    await flush();

    await actRun(() => rejectors[0]?.(new Error("obsolete failure")));
    await flush();
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    expect(
      rendered.container
        .querySelector("[data-og-document-editor]")
        ?.getAttribute("data-og-command-state"),
    ).toBe("pending");

    await actRun(() => rejectors[1]?.(new Error("current failure")));
    await flush();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "current failure",
    );
    await rendered.unmount();
  });
});

function clipboardEvent(type: "paste", plain: string, html: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData(format: string) {
        return format === "text/plain" ? plain : format === "text/html" ? html : "";
      },
    },
  });
  return event;
}

function selectText(root: HTMLElement, start: number, end: number): void {
  const startPoint = pointAt(root, start);
  const endPoint = pointAt(root, end);
  if (!startPoint || !endPoint) throw new Error("Could not locate test selection");
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  const selection = globalThis.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function pointAt(root: HTMLElement, target: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = target;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  return null;
}

function styleAt(
  paragraph: {
    runs: ReadonlyArray<{ text: string; style: DocumentTextStyle }>;
  },
  offset: number,
): DocumentTextStyle {
  let cursor = 0;
  for (const run of paragraph.runs) {
    if (offset < cursor + run.text.length) return run.style;
    cursor += run.text.length;
  }
  return {};
}
