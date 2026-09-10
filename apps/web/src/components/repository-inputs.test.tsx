import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";

import { ManualRepositoryEditor } from "@/components/manual-repository-editor";
import { RepositoryRefInput } from "@/components/repository-ref-input";
import {
  actRun,
  flush,
  registerDom,
  renderComponent,
} from "../../../../packages/react/test/render-hook";

registerDom();

function keyDownHandler(
  element: Element,
): (event: { key: string; target: EventTarget; preventDefault: () => void }) => void {
  const reactPropsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  return (
    element as unknown as Record<
      string,
      {
        onKeyDown?: (event: {
          key: string;
          target: EventTarget;
          preventDefault: () => void;
        }) => void;
      }
    >
  )[reactPropsKey!]!.onKeyDown!;
}

describe("manual repository editor keyboard behavior", () => {
  test("submits Enter from text inputs without intercepting button activation", async () => {
    const onAttach = mock(async () => {});
    const rendered = await renderComponent(
      createElement(ManualRepositoryEditor, {
        repository: {
          id: 1,
          url: "https://github.com/acme/app",
          ref: "main",
          attached: false,
        },
        mounted: false,
        pending: false,
        onUpdate: () => {},
        onRemove: () => {},
        onAttach,
      }),
    );

    const url = rendered.container.querySelector<HTMLInputElement>(
      'input[aria-label="Repository URL"]',
    )!;
    const editor = url.closest<HTMLDivElement>(".space-y-2")!;
    const onKeyDown = keyDownHandler(editor);
    await actRun(() => onKeyDown({ key: "Enter", target: url, preventDefault: () => {} }));
    await flush();
    expect(onAttach).toHaveBeenCalledTimes(1);

    const remove = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Remove",
    )!;
    await actRun(() => onKeyDown({ key: "Enter", target: remove, preventDefault: () => {} }));
    await flush();
    expect(onAttach).toHaveBeenCalledTimes(1);
    await rendered.unmount();
  });
});

describe("repository ref branch suggestions", () => {
  test("remain open while keyboard focus moves from the input into the branch list", async () => {
    const onChange = mock((_value: string) => {});
    const rendered = await renderComponent(
      createElement(RepositoryRefInput, {
        value: "",
        defaultRef: "main",
        label: "Repository ref",
        onChange,
        loadBranches: async () => [
          { name: "main", isDefault: true },
          { name: "release", isDefault: false },
        ],
      }),
    );

    const input = rendered.container.querySelector<HTMLInputElement>(
      'input[aria-label="Repository ref"]',
    )!;
    await actRun(() => input.focus());
    await flush();
    const release = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("release"),
    )!;
    expect(release).toBeDefined();

    await actRun(() => release.focus());
    expect(rendered.container.contains(release)).toBe(true);
    await actRun(() => release.click());
    expect(onChange).toHaveBeenCalledWith("release");
    await rendered.unmount();
  });
});
