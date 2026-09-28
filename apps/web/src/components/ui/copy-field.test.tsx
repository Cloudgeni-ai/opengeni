import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { CopyField, truncateMiddle } from "./copy-field";

describe("truncateMiddle", () => {
  test("keeps the start and end people compare", () => {
    expect(truncateMiddle("9f1c2d4e-7a3b-4c5d-8e6f-0a1b2c3d4e5f", 21)).toBe(
      "9f1c2d4e-7…1b2c3d4e5f",
    );
    expect(truncateMiddle("9f1c2d4e-7a3b-4c5d-8e6f-0a1b2c3d4e5f", 21)).toHaveLength(21);
    expect(truncateMiddle("ogk_d591f5ad", 24)).toBe("ogk_d591f5ad");
    expect(truncateMiddle("abcdef", 3)).toBe("abcdef");
  });
});

describe("CopyField", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeAll(() => {
    GlobalRegistrator.register();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  afterAll(() => GlobalRegistrator.unregister());

  const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

  test("copies the full value even when it shows a shortened one", async () => {
    const copy = mock(async () => true);
    const copied = mock();
    await act(async () =>
      root.render(
        <CopyField
          value="9f1c2d4e-7a3b-4c5d-8e6f-0a1b2c3d4e5f"
          truncate="middle"
          maxLength={21}
          label="workspace ID"
          copy={copy}
          onCopied={copied}
        />,
      ),
    );
    expect(container.textContent).toContain("9f1c2d4e-7…1b2c3d4e5f");
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Copy workspace ID");
    await act(async () => {
      button.click();
      await flush();
    });
    expect(copy).toHaveBeenCalledWith("9f1c2d4e-7a3b-4c5d-8e6f-0a1b2c3d4e5f");
    expect(copied).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-label")).toBe("Copied workspace ID");
    expect(container.querySelector('[role="status"]')!.textContent).toBe("Copied");
  });

  test("when the clipboard is blocked, the field explains and selects the value", async () => {
    await act(async () =>
      root.render(
        <CopyField
          variant="field"
          value="5b0e2f4a-9c1d"
          label="organization ID"
          copy={async () => false}
        />,
      ),
    );
    const input = container.querySelector("input")!;
    await act(async () => {
      container.querySelector("button")!.click();
      await flush();
    });
    expect(container.textContent).toContain("Couldn't copy. The value is selected");
    expect(
      document.getElementById(input.getAttribute("aria-describedby")!.split(" ").at(-1)!),
    ).not.toBeNull();
    expect(input.readOnly).toBe(true);
    expect(document.activeElement).toBe(input);
  });
});
