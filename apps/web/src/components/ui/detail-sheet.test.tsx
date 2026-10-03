import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import type { Root } from "react-dom/client";

// Radix picks its layout-effect hook when it is first imported, so the DOM
// has to exist before the sheet's modules load; otherwise portals never mount.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const {
  DetailBody,
  DetailFooterConfirm,
  DetailHeader,
  DetailSheet,
  DetailSheetContent,
  DetailSheetPreview,
} = await import("./detail-sheet");

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function mount(node: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return { container, root };
}

function RowOpensSheet() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="row" onClick={() => setOpen(true)}>
        AWS production
      </button>
      <DetailSheet open={open} onOpenChange={setOpen}>
        <DetailSheetContent>
          <DetailHeader title="AWS production" subtitle="Read-only IAM credentials." />
          <DetailBody>
            <p>Variables</p>
          </DetailBody>
        </DetailSheetContent>
      </DetailSheet>
    </>
  );
}

describe("DetailSheet", () => {
  test("opened from a row without a trigger, it lands on the sheet and gives focus back on close", async () => {
    const { container, root } = await mount(<RowOpensSheet />);
    const row = container.querySelector<HTMLButtonElement>('[data-testid="row"]')!;
    row.focus();
    await act(async () => row.click());
    const sheet = document.querySelector('[data-slot="detail-sheet"]');
    expect(sheet).not.toBeNull();
    expect(document.activeElement).toBe(sheet);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.querySelector('[data-slot="detail-sheet"]')).toBeNull();
    expect(document.activeElement).toBe(row);
    await act(async () => root.unmount());
    container.remove();
  });

  test("the footer confirm names the object and ties the consequence to the question", () => {
    const html = renderToStaticMarkup(
      <DetailSheetPreview label="ops@acme.dev">
        <DetailFooterConfirm
          title="Disconnect ops@acme.dev?"
          description="New work moves to research@acme.dev."
          confirmLabel="Disconnect"
        />
      </DetailSheetPreview>,
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    const group = container.querySelector('[role="group"]')!;
    const title = container.querySelector(`[id="${group.getAttribute("aria-labelledby")}"]`);
    const description = container.querySelector(`[id="${group.getAttribute("aria-describedby")}"]`);
    expect(title?.textContent).toBe("Disconnect ops@acme.dev?");
    expect(description?.textContent).toBe("New work moves to research@acme.dev.");
    const buttons = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Cancel", "Disconnect"]);
    // Previews never steal focus from the page.
    expect(html).not.toContain("autofocus");
  });
});
