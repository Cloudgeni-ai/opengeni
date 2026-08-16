import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { CompanyBrainExportButton } from "./company-brain-export";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

describe("Company Brain export control", () => {
  test("is keyboard-operable, responsive, and announces successful export", async () => {
    const exportCompanyBrainOkf = mock(async () => ({
      content: "# package",
      contentType: "text/markdown; charset=utf-8",
      filename: "company-brain.okf.md",
    }));
    const save = mock(() => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CompanyBrainExportButton
          client={{ exportCompanyBrainOkf }}
          workspaceId="00000000-0000-4000-8000-000000000001"
          save={save}
        />,
      );
    });

    const button = container.querySelector("button");
    expect(button?.type).toBe("button");
    expect(button?.getAttribute("aria-busy")).toBe("false");
    expect(button?.className).toContain("min-h-11");
    expect(container.firstElementChild?.className).toContain("sm:items-end");
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain(
      "authorized guidance bodies",
    );

    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(exportCompanyBrainOkf).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
    expect(save).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("downloaded");

    await act(async () => root.unmount());
    container.remove();
  });

  test("keeps transport errors visible without claiming a download", async () => {
    const save = mock(() => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CompanyBrainExportButton
          client={{
            exportCompanyBrainOkf: mock(async () => {
              throw new Error("permission changed");
            }),
          }}
          workspaceId="00000000-0000-4000-8000-000000000001"
          save={save}
        />,
      );
    });
    await act(async () => {
      container.querySelector("button")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(save).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain(
      "permission changed",
    );
    await act(async () => root.unmount());
    container.remove();
  });
});
